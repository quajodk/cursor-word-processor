import type { Diagnostic, DiagnoseRequest, DiagnosticProvider } from "./types";

/**
 * Incremental linting over the document's blocks.
 *
 * WHY THIS EXISTS, in one measurement: linting a 40,000-word document as a single string
 * takes 7,846 ms. The budget in ARCHITECTURE.md §5 is 150 ms. Every keystroke re-sent the
 * whole document, so the checker never finished before the next request arrived and the
 * squiggles on a long document effectively never updated.
 *
 * The observation that fixes it: a writer edits ONE paragraph at a time, and a paragraph's
 * diagnostics depend only on that paragraph. Linting a single block of the same document
 * takes 18 ms. So the work per keystroke is one block, not one document — and the other 493
 * blocks come back from a cache keyed by their own text.
 *
 * THE SPLIT IS TEXTUAL, NOT STRUCTURAL. The segments are whatever lies between the newline
 * separators already present in the text the caller sent. That is deliberate: it means the
 * offsets this returns are offsets into exactly the string that was passed in, with no
 * second opinion about where ProseMirror thinks a block starts. A structural split would
 * have to agree with `Node.textBetween`'s separator placement in nested lists, tables and
 * blockquotes, and any disagreement would put every squiggle in a document at the wrong
 * character.
 *
 * WHAT IS LOST: a rule that spans a block boundary. Harper's rules are sentence-scoped and
 * a paragraph break already ends a sentence, so the expectation is that nothing is lost —
 * but expectation is not evidence, so `test/incremental.test.ts` checks the incremental
 * result against the whole-document result on real corpus prose and fails on any difference.
 */

/** Keyed by language and segment text: identical text lints identically, wherever it moved to. */
interface CacheEntry {
  /** Offsets are LOCAL to the segment. Rebased on every use, never stored rebased. */
  diagnostics: Diagnostic[];
}

export interface IncrementalOptions {
  /**
   * Segments held. At ~500 blocks per long document this keeps several documents resident;
   * beyond it the least-recently-used segment goes, which for a writer is the part of the
   * document they are not in.
   */
  maxSegments?: number;
  /**
   * Wall-clock spent linting before yielding to the event loop. The yield is what makes a
   * long lint CANCELLABLE: a worker that never yields cannot receive the message telling it
   * the text has changed, so it finishes computing an answer to a question nobody is asking
   * any more while the next four keystrokes queue behind it.
   */
  sliceMs?: number;
}

export interface IncrementalProgress {
  diagnostics: Diagnostic[];
  /** Segments actually run through the checker this pass. */
  linted: number;
  /** Segments answered from cache. The ratio is the whole point of the class. */
  cached: number;
  /** Segments not yet reached. Non-zero on a partial result. */
  pending: number;
  done: boolean;
}

const DEFAULTS = { maxSegments: 4000, sliceMs: 60 };

export class IncrementalLinter {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxSegments: number;
  private readonly sliceMs: number;

  constructor(private readonly provider: DiagnosticProvider, opts: IncrementalOptions = {}) {
    this.maxSegments = opts.maxSegments ?? DEFAULTS.maxSegments;
    this.sliceMs = opts.sliceMs ?? DEFAULTS.sliceMs;
  }

  /** Segments currently held. Exposed so the bench can assert a cold run really was cold. */
  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }

  /**
   * Lint `req.text`, reusing per-segment results.
   *
   * `onProgress` is called with a partial result whenever a time slice ends, so a document
   * that takes seconds in total shows its first squiggles in tens of milliseconds instead of
   * staying blank until the end. `isStale` is consulted at the same points: returning true
   * abandons the pass, which is how a newer keystroke preempts an older document scan.
   */
  async run(
    req: DiagnoseRequest,
    hooks: { onProgress?: (p: IncrementalProgress) => void; isStale?: () => boolean } = {},
  ): Promise<IncrementalProgress> {
    const segments = splitSegments(req.text);
    const lang = req.language ?? "";
    const out: Diagnostic[] = [];
    let linted = 0;
    let cached = 0;
    let sliceStart = now();

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (seg.text.length === 0) { cached++; continue; }

      const key = `${lang} ${seg.text}`;
      let entry = this.cache.get(key);
      if (entry) {
        // Re-insert so the map's insertion order stays the LRU order.
        this.cache.delete(key);
        this.cache.set(key, entry);
        cached++;
      } else {
        const local = await this.provider.diagnose({ version: req.version, text: seg.text, language: req.language });
        entry = { diagnostics: local };
        this.remember(key, entry);
        linted++;
      }

      for (const d of entry.diagnostics) out.push({ ...d, from: d.from + seg.start, to: d.to + seg.start });

      if (now() - sliceStart >= this.sliceMs && i + 1 < segments.length) {
        hooks.onProgress?.({ diagnostics: out.slice(), linted, cached, pending: segments.length - i - 1, done: false });
        // A macrotask, not a microtask: `postMessage` deliveries are macrotasks, so only
        // this lets a newer request actually arrive.
        await yieldToEventLoop();
        if (hooks.isStale?.()) {
          return { diagnostics: out, linted, cached, pending: segments.length - i - 1, done: false };
        }
        sliceStart = now();
      }
    }

    return { diagnostics: out, linted, cached, pending: 0, done: true };
  }

  private remember(key: string, entry: CacheEntry): void {
    this.cache.set(key, entry);
    while (this.cache.size > this.maxSegments) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}

export interface Segment { text: string; start: number }

/**
 * Split on the newline separator, keeping each piece's offset into the original string.
 *
 * The separator itself is not part of any segment, so `start + local` is always an offset
 * into the caller's text. Do not "improve" this into a regex that also splits on sentence
 * ends: a segment must be big enough that the checker sees whole sentences, or every rule
 * that needs two clauses stops firing.
 */
export function splitSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl < 0) { out.push({ text: text.slice(start), start }); break; }
    out.push({ text: text.slice(start, nl), start });
    start = nl + 1;
  }
  return out;
}

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Number(Date.now());

const yieldToEventLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
