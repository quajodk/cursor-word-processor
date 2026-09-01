/**
 * Real edit scenarios for the anchor engine.
 *
 * These are OUT-OF-SESSION edits: the shape of change that arrives when someone edited the
 * `.md` in vim, or a git merge landed, or a colleague's PR was pulled. In-session edits never
 * reach the anchor engine at all (doc-model/aid.ts tracks them exactly), so simulating
 * ProseMirror transactions here would test nothing.
 *
 * Everything is derived from the corpus document itself - reworded text is built from the
 * document's own vocabulary, splits happen at the document's own sentence boundaries - so no
 * scenario is tuned to a file and none of them can be passed by pattern-matching a fixture.
 *
 * Each scenario returns the mutated block list plus GROUND TRUTH: for every resulting block,
 * the aid it should be recognised as, or null if it is genuinely new.
 */

import type { BlockSignalInput } from "../src/anchor.ts";

export interface Scenario {
  name: string;
  blocks: BlockSignalInput[];
  /** Expected aid per resulting block; null means "this block is new". */
  truth: Array<string | null>;
  /** Aids that were deliberately removed and must NOT be matched to anything. */
  removed: string[];
  /** A second acceptable aid per block, used by merges where either half may dominate. */
  altTruth?: Array<string | null>;
}

/** Deterministic PRNG - mulberry32. Tests must produce the same numbers on every machine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickIndices(n: number, fraction: number, rand: () => number, minLen: (i: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (minLen(i) && rand() < fraction) out.push(i);
  return out;
}

/** The document's own vocabulary, so replacement words are plausible for this document. */
function vocabulary(blocks: readonly BlockSignalInput[]): string[] {
  const seen = new Set<string>();
  for (const b of blocks) {
    for (const t of b.text.split(/\s+/)) {
      const w = t.replace(/[^\p{L}\p{N}]/gu, "");
      if (w.length >= 4) seen.add(w);
      if (seen.size > 4000) break;
    }
  }
  return [...seen];
}

/**
 * Reword a fraction of the words in a block: substitute, drop and duplicate, the way a real
 * revision pass changes a sentence rather than replacing it.
 */
function reword(text: string, strength: number, vocab: string[], rand: () => number): string {
  const words = text.split(/(\s+)/);
  const out: string[] = [];
  for (const w of words) {
    if (/^\s*$/.test(w) || w.length < 3 || rand() >= strength) { out.push(w); continue; }
    const r = rand();
    if (r < 0.6 && vocab.length > 0) out.push(vocab[Math.floor(rand() * vocab.length)]!);
    else if (r < 0.8) { /* drop the word */ }
    else out.push(`${w} ${w}`);
  }
  const s = out.join("").replace(/\s+/g, " ").trim();
  return s.length > 0 ? s : text;
}

const clone = (b: BlockSignalInput): BlockSignalInput => ({ ...b });

/** Light copy-edit: a few words changed in a fifth of the paragraphs. */
export function scenarioReword(base: readonly BlockSignalInput[], aids: readonly string[], seed: number, fraction = 0.2, strength = 0.15): Scenario {
  const rand = rng(seed);
  const vocab = vocabulary(base);
  const blocks: BlockSignalInput[] = [];
  const truth: Array<string | null> = [];
  const targets = new Set(pickIndices(base.length, fraction, rand, (i) => base[i]!.text.length > 40));
  for (let i = 0; i < base.length; i++) {
    const b = clone(base[i]!);
    if (targets.has(i)) b.text = reword(b.text, strength, vocab, rand);
    blocks.push(b);
    truth.push(aids[i]!);
  }
  return { name: `reword ${Math.round(fraction * 100)}%@${Math.round(strength * 100)}%`, blocks, truth, removed: [] };
}

/** Heavy rewrite: half the words in half the paragraphs. Anchors are expected to fail some. */
export function scenarioRewrite(base: readonly BlockSignalInput[], aids: readonly string[], seed: number): Scenario {
  const s = scenarioReword(base, aids, seed, 0.5, 0.5);
  return { ...s, name: "rewrite 50%@50%" };
}

/** Split paragraphs in two at a sentence boundary - the classic "this paragraph is too long". */
export function scenarioSplit(base: readonly BlockSignalInput[], aids: readonly string[], seed: number, fraction = 0.15): Scenario {
  const rand = rng(seed);
  const blocks: BlockSignalInput[] = [];
  const truth: Array<string | null> = [];
  let splits = 0;
  for (let i = 0; i < base.length; i++) {
    const b = base[i]!;
    const boundaries: number[] = [];
    const re = /[.!?]\s+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b.text)) !== null) boundaries.push(m.index + m[0].length);
    const usable = boundaries.filter((p) => p > 30 && p < b.text.length - 30);
    if (usable.length > 0 && rand() < fraction) {
      const cut = usable[Math.floor(rand() * usable.length)]!;
      blocks.push({ ...clone(b), text: b.text.slice(0, cut).trim() });
      truth.push(aids[i]!);
      blocks.push({ ...clone(b), text: b.text.slice(cut).trim() });
      truth.push(aids[i]!);
      splits++;
    } else {
      blocks.push(clone(b));
      truth.push(aids[i]!);
    }
  }
  return { name: `split x${splits}`, blocks, truth, removed: [] };
}

/**
 * Merge adjacent paragraphs. Ground truth follows the design's rule: the surviving block keeps
 * the dominant anchor's properties. Either aid is accepted as correct here, because "dominant"
 * is exactly the judgement under test - what must not happen is a THIRD paragraph's aid.
 */
export function scenarioMerge(base: readonly BlockSignalInput[], aids: readonly string[], seed: number, fraction = 0.15): Scenario {
  const rand = rng(seed);
  const blocks: BlockSignalInput[] = [];
  const truth: Array<string | null> = [];
  const alt: string[] = [];
  const removed: string[] = [];
  let i = 0;
  while (i < base.length) {
    const a = base[i]!, b = base[i + 1];
    const mergeable = b !== undefined && a.kind === b.kind && a.kind !== "table"
      && a.text.length > 20 && b.text.length > 20 && a.listRef === b.listRef;
    if (mergeable && rand() < fraction) {
      blocks.push({ ...clone(a), text: `${a.text} ${b.text}` });
      truth.push(aids[i]!);
      alt.push(aids[i + 1]!);
      i += 2;
    } else {
      blocks.push(clone(a));
      truth.push(aids[i]!);
      alt.push("");
      i += 1;
    }
  }
  return { name: "merge", blocks, truth, removed, altTruth: alt.map((x) => (x === "" ? null : x)) };
}

/** Move a contiguous section elsewhere in the document. Alignment cannot express this; the
 *  exact-content recovery pass must. */
export function scenarioMove(base: readonly BlockSignalInput[], aids: readonly string[], seed: number): Scenario {
  const rand = rng(seed);
  const n = base.length;
  if (n < 20) return { name: "move (skipped, too short)", blocks: base.map(clone), truth: [...aids], removed: [] };
  const len = Math.max(3, Math.floor(n * 0.1));
  const from = Math.floor(rand() * (n - len - 1));
  const rest: Array<{ b: BlockSignalInput; aid: string }> = [];
  const moved: Array<{ b: BlockSignalInput; aid: string }> = [];
  for (let i = 0; i < n; i++) {
    const e = { b: clone(base[i]!), aid: aids[i]! };
    if (i >= from && i < from + len) moved.push(e); else rest.push(e);
  }
  let to = Math.floor(rand() * rest.length);
  if (Math.abs(to - from) < len) to = (to + Math.floor(rest.length / 2)) % rest.length;
  const out = [...rest.slice(0, to), ...moved, ...rest.slice(to)];
  return { name: `move ${len} blocks`, blocks: out.map((e) => e.b), truth: out.map((e) => e.aid), removed: [] };
}

/** Insert brand-new paragraphs in runs, the way a writer adds a section. */
export function scenarioInsert(base: readonly BlockSignalInput[], aids: readonly string[], seed: number, runs = 4, runLen = 5): Scenario {
  const rand = rng(seed);
  const vocab = vocabulary(base);
  const blocks: BlockSignalInput[] = [];
  const truth: Array<string | null> = [];
  const at = new Set<number>();
  for (let k = 0; k < runs; k++) at.add(Math.floor(rand() * Math.max(1, base.length)));
  const novel = (): string => {
    const words: string[] = [];
    const len = 12 + Math.floor(rand() * 30);
    for (let i = 0; i < len; i++) words.push(vocab.length ? vocab[Math.floor(rand() * vocab.length)]! : `w${i}`);
    // Prefix with a nonce so the text is genuinely new rather than an accidental duplicate.
    return `${Math.floor(rand() * 1e9).toString(36)} ${words.join(" ")}`;
  };
  for (let i = 0; i < base.length; i++) {
    if (at.has(i)) {
      for (let k = 0; k < runLen; k++) { blocks.push({ kind: "paragraph", text: novel() }); truth.push(null); }
    }
    blocks.push(clone(base[i]!));
    truth.push(aids[i]!);
  }
  return { name: `insert ${runs}x${runLen}`, blocks, truth, removed: [] };
}

/** Delete runs of paragraphs. Their anchors must be reported lost, not attached elsewhere. */
export function scenarioDelete(base: readonly BlockSignalInput[], aids: readonly string[], seed: number, runs = 3, runLen = 4): Scenario {
  const rand = rng(seed);
  const drop = new Set<number>();
  for (let k = 0; k < runs; k++) {
    const start = Math.floor(rand() * Math.max(1, base.length - runLen));
    for (let i = 0; i < runLen; i++) drop.add(start + i);
  }
  const blocks: BlockSignalInput[] = [];
  const truth: Array<string | null> = [];
  const removed: string[] = [];
  for (let i = 0; i < base.length; i++) {
    if (drop.has(i)) { removed.push(aids[i]!); continue; }
    blocks.push(clone(base[i]!));
    truth.push(aids[i]!);
  }
  return { name: `delete ${runs}x${runLen}`, blocks, truth, removed };
}

/** Everything at once, which is what a real week of editing looks like. */
export function scenarioCombined(base: readonly BlockSignalInput[], aids: readonly string[], seed: number): Scenario {
  let s: Scenario = { name: "combined", blocks: base.map(clone), truth: [...aids], removed: [] };
  const step = (next: Scenario): void => { s = { name: "combined", blocks: next.blocks, truth: next.truth, removed: [...s.removed, ...next.removed] }; };
  const aidsOf = (x: Scenario): string[] => x.truth.map((t) => t ?? "");
  step(scenarioReword(s.blocks, aidsOf(s), seed + 1, 0.25, 0.2));
  step(scenarioSplit(s.blocks, aidsOf(s), seed + 2, 0.08));
  step(scenarioInsert(s.blocks, aidsOf(s), seed + 3, 3, 4));
  step(scenarioDelete(s.blocks, aidsOf(s), seed + 4, 2, 3));
  step(scenarioMove(s.blocks, aidsOf(s), seed + 5));
  // Inserted blocks carry "" as their pseudo-aid through the chain; restore null.
  s.truth = s.truth.map((t) => (t === "" ? null : t));
  s.removed = s.removed.filter((x) => x !== "");
  return s;
}
