import { sentences, words } from "@scriv/textops";

/**
 * Diffing a rewrite, at the granularity a reader can actually review.
 *
 * A character diff of prose is unreadable — it shreds words into fragments. A line diff is
 * worse, because a rewritten paragraph is one line and the whole thing reads as replaced.
 * The useful granularity is the one the writer thinks in: align SENTENCES, then diff WORDS
 * inside the sentences that actually changed. A reworded clause then shows as a reworded
 * clause, and an untouched sentence shows as nothing at all.
 */

export interface Hunk {
  /** Offsets into the original text. `from === to` for a pure insertion. */
  from: number;
  to: number;
  /** The original text in [from, to). */
  removed: string;
  /** What replaces it. Empty for a pure deletion. */
  added: string;
  /**
   * Unchanged text bridging two hunks that were coalesced into one. Kept so the merged hunk
   * still describes a contiguous replacement rather than silently dropping what sat between.
   */
  fromText?: string;
}

/** Longest common subsequence over arbitrary tokens, as index pairs. */
function lcs<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean): [number, number][] {
  const n = a.length, m = b.length;
  // Row-wise DP: prose selections are short enough that O(nm) is fine, and the exact answer
  // matters more than the speed here — this runs once per AI edit, not per keystroke.
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = eq(a[i]!, b[j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (eq(a[i]!, b[j]!)) { out.push([i, j]); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

interface Span { text: string; start: number; end: number }

/**
 * Sentence spans that TILE the input: every character belongs to exactly one span.
 *
 * `sentences()` deliberately excludes trailing whitespace from a range, so that repeatedly
 * expanding a selection does not creep forward. For diffing that is exactly wrong — the gaps
 * between sentences then belong to no span, so an inserted sentence lands with no space
 * before the next one and a deleted sentence leaves its separator behind. Each span here
 * therefore runs to the start of the next, and the leading text runs from zero.
 */
function sentenceSpans(text: string): Span[] {
  const rs = sentences(text);
  if (rs.length === 0) return [{ text, start: 0, end: text.length }];
  const out: Span[] = [];
  for (let i = 0; i < rs.length; i++) {
    const start = i === 0 ? 0 : rs[i]!.start;
    const end = i === rs.length - 1 ? text.length : rs[i + 1]!.start;
    out.push({ text: text.slice(start, end), start, end });
  }
  return out;
}

/**
 * Word and gap tokens that TILE the text: words alternate with the whitespace and punctuation
 * runs between them, and every character belongs to exactly one token.
 *
 * An earlier version attached each gap to the word that followed it, which reads more tidily
 * — deleting a word took its spacing with it — but it makes reconstruction WRONG. If the
 * model returns "a few  because" with the doubled space its deletion left behind, the diff
 * has to reproduce that, not quietly tidy it. Applying a diff must yield exactly the revision
 * it describes; anything else silently rewrites what the writer is being asked to approve.
 *
 * Gaps are separate tokens, so they are matched, inserted and deleted on their own terms.
 */
function tokenSpans(text: string, base: number): Span[] {
  const out: Span[] = [];
  let cursor = 0;
  for (const w of words(text)) {
    if (w.start > cursor) {
      out.push({ text: text.slice(cursor, w.start), start: base + cursor, end: base + w.start });
    }
    out.push({ text: text.slice(w.start, w.end), start: base + w.start, end: base + w.end });
    cursor = w.end;
  }
  if (cursor < text.length) {
    out.push({ text: text.slice(cursor), start: base + cursor, end: base + text.length });
  }
  return out.length > 0 ? out : [{ text, start: base, end: base + text.length }];
}

/** Merge hunks separated by nothing, so a reworded clause is one hunk rather than five. */
function coalesce(hunks: Hunk[], gap = 12): Hunk[] {
  const out: Hunk[] = [];
  for (const h of hunks) {
    const prev = out[out.length - 1];
    if (prev && h.from - prev.to <= gap) {
      // Everything between the two hunks is unchanged text that has to be carried along.
      prev.added += (h.fromText ?? "") + h.added;
      prev.removed += (h.fromText ?? "") + h.removed;
      prev.to = h.to;
      continue;
    }
    out.push({ ...h });
  }
  return out;
}

/**
 * Hunks describing how to turn `original` into `revised`.
 *
 * Offsets are into `original`, ascending, non-overlapping.
 */
export function diffProse(original: string, revised: string): Hunk[] {
  if (original === revised) return [];

  const a = sentenceSpans(original);
  const b = sentenceSpans(revised);
  // Exact equality, not normalised. A sentence whose spacing changed HAS changed, and
  // treating it as unchanged loses that difference on reconstruction. Sentences that differ
  // only slightly still pair up one-to-one below and are refined at word level, so exactness
  // here costs nothing in readability.
  const common = lcs(a, b, (x, y) => x.text === y.text);

  const hunks: Hunk[] = [];
  let ai = 0, bi = 0;

  const emitRange = (aFrom: number, aTo: number, bFrom: number, bTo: number): void => {
    const removedSpans = a.slice(aFrom, aTo);
    const addedSpans = b.slice(bFrom, bTo);
    if (removedSpans.length === 0 && addedSpans.length === 0) return;

    const from = removedSpans[0]?.start ?? (a[aFrom]?.start ?? a[aFrom - 1]?.end ?? original.length);
    const to = removedSpans[removedSpans.length - 1]?.end ?? from;
    const removed = original.slice(from, to);
    const added = addedSpans.map((s) => s.text).join("");

    // One sentence replaced by one sentence is the case worth refining: diff its words so the
    // reader sees which words moved, not a wall of red beside a wall of green.
    if (removedSpans.length === 1 && addedSpans.length === 1) {
      hunks.push(...wordLevel(removed, added, from));
      return;
    }
    hunks.push({ from, to, removed, added });
  };

  for (const [ca, cb] of common) {
    if (ca > ai || cb > bi) emitRange(ai, ca, bi, cb);
    ai = ca + 1;
    bi = cb + 1;
  }
  if (ai < a.length || bi < b.length) emitRange(ai, a.length, bi, b.length);

  return hunks.filter((h) => h.removed !== h.added);
}

/** Word-level diff of one sentence against its replacement. */
function wordLevel(removed: string, added: string, base: number): Hunk[] {
  const aw = tokenSpans(removed, base);
  const bw = tokenSpans(added, 0);
  const common = lcs(aw, bw, (x, y) => x.text === y.text);

  const out: Hunk[] = [];
  let ai = 0, bi = 0;
  const emit = (aFrom: number, aTo: number, bFrom: number, bTo: number): void => {
    if (aFrom === aTo && bFrom === bTo) return;
    const rSpans = aw.slice(aFrom, aTo);
    const from = rSpans[0]?.start ?? (aw[aFrom]?.start ?? base + removed.length);
    const to = rSpans[rSpans.length - 1]?.end ?? from;
    out.push({
      from,
      to,
      removed: removed.slice(from - base, to - base),
      added: bw.slice(bFrom, bTo).map((s) => s.text).join(""),
    });
  };
  for (const [ca, cb] of common) {
    if (ca > ai || cb > bi) emit(ai, ca, bi, cb);
    ai = ca + 1;
    bi = cb + 1;
  }
  if (ai < aw.length || bi < bw.length) emit(ai, aw.length, bi, bw.length);

  // Carry the unchanged text between nearby hunks so coalescing does not lose it.
  for (let i = 1; i < out.length; i++) {
    out[i]!.fromText = removed.slice(out[i - 1]!.to - base, out[i]!.from - base);
  }
  return coalesce(out).map(({ from, to, removed: r, added }) => ({ from, to, removed: r, added }));
}
