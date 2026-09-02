/**
 * Anchors: re-attaching OOXML properties to blocks we did not watch change.
 *
 * DOCX-FIDELITY.md 3. Two regimes, and conflating them is the mistake:
 *
 *   in-session   - exact. `aid` rides ProseMirror's position mapping (doc-model/aid.ts).
 *                  Nothing here runs. Nothing here is needed.
 *   out-of-session - fuzzy. The `.md` was edited by vim, a git merge, someone's PR. This file.
 *
 * This is a SEQUENCE ALIGNMENT problem, not a hashing problem. Hashing asks "which stored block
 * is this one?" independently per block, which is exactly wrong for a document: the strongest
 * evidence that paragraph 40 is anchor 40 is that paragraph 39 was anchor 39. Boilerplate that
 * is textually identical in six places is resolved by its neighbours or not at all.
 *
 * So: constrained Needleman-Wunsch with affine gaps over (stored anchors x current blocks).
 *
 *   - **Constrained** by waypoints. Unique exact content matches form a monotone skeleton
 *     (longest increasing subsequence over them); the DP band follows the piecewise-linear path
 *     through that skeleton rather than the naive diagonal. A 300-paragraph insertion at the top
 *     of the document therefore costs nothing, where a diagonal band would lose everything after it.
 *   - **Affine gaps** so a run of inserted paragraphs costs one opening plus cheap extensions,
 *     not N independent mismatches. Writers add sections, not scattered lines.
 *   - **Splits and merges are alignment operations**, not failures: the DP has transitions
 *     (i-1, j-2) and (i-2, j-1) with their own evidence functions.
 *   - **Moves** are not expressible in any alignment - a move is a delete plus an insert to NW.
 *     They are recovered afterwards by exact content matching among the leftovers, which is
 *     precisely the property the design table claims for `contentHash`.
 *
 * And the rule that matters most (DOCX-FIDELITY.md 3, "the refusal to guess"): below the
 * confidence threshold we DROP the OOXML properties and record it in the ledger. A dropped
 * style is a formatting bug the user can see; a misapplied one corrupts a document they trusted.
 */

import { fnv1a64, hamming64, popcount32, sha256Hex, u64FromHex, u64Hex, type U64 } from "./hash";
import { Ledger, type LedgerEntry } from "./ledger";
import type { BlockKind } from "./sidecar";

/* ------------------------------------------------------------------ the anchor */

/**
 * The stored fingerprint of one block. Multi-signal by design: each row of the table in
 * DOCX-FIDELITY.md 3 fails on a different kind of edit, so no edit takes them all out at once.
 *
 * | signal        | survives              | fails on            |
 * |---------------|-----------------------|---------------------|
 * | ordinal       | edits                 | insertions above    |
 * | contentHash   | moves                 | any edit            |
 * | simhash       | small edits           | rewrites            |
 * | head/tail     | mid-block edits       | edits at the edges  |
 * | structPath    | reordering elsewhere  | section renames     |
 * | kind + level  | text edits            | structural change   |
 *
 * Everything is a string or a number: this lands in the sidecar and must survive JSON.
 */
export interface Anchor {
  aid: string;
  /** Position in the document when the anchor was stored. */
  ordinal: number;
  kind: BlockKind;
  /** Heading level, or null. */
  level: number | null;
  /** Sidecar numbering ref this block belonged to, or null. */
  listRef: string | null;
  listLevel: number | null;
  styleId: string | null;

  /** UTF-16 code units of normalized text. */
  textLen: number;
  tokenCount: number;
  /** sha256 (16 hex) of the normalized text. Exact identity; survives moves, dies on any edit. */
  contentHash: string;
  /** 64-bit simhash over token unigrams + bigrams, 16 hex. */
  simhash: string;
  /** 64-bit hash of the first 3 tokens, 16 hex. Empty string when there are none. */
  headShingle: string;
  /** 64-bit hash of the last 3 tokens. */
  tailShingle: string;
  /** `H1 title > H2 title #k` - section context plus ordinal within the section. */
  structPath: string;
}

/** What the caller knows about a block currently in the document. */
export interface BlockSignalInput {
  kind: BlockKind;
  text: string;
  level?: number | null;
  listRef?: string | null;
  listLevel?: number | null;
  styleId?: string | null;
  /** Current aid, if any. Only used for reporting. */
  aid?: string | null;
}

/* ------------------------------------------------------------------ signal computation */

const WS = /\s+/g;

/** Normalized text: the thing all textual signals are computed on. */
export function normalizeText(s: string): string {
  return s.normalize("NFC").replace(WS, " ").trim();
}

const TOKEN = /[\p{L}\p{N}]+/gu;

export function tokenize(s: string): string[] {
  const out: string[] = [];
  const lower = s.toLowerCase();
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(lower)) !== null) out.push(m[0]);
  return out;
}

/**
 * 64-bit simhash over token unigrams and bigrams.
 *
 * Bigrams are what make this resistant to reordering-as-rewriting: two paragraphs with the same
 * words in a different order share unigrams but few bigrams, and should not be confused.
 * Unigrams alone would also make every paragraph in a technical document look alike.
 */
export function simhash(tokens: readonly string[]): U64 {
  const v = new Int32Array(64);
  const bump = (h: U64, weight: number): void => {
    for (let b = 0; b < 32; b++) v[b]! += (h.lo >>> b) & 1 ? weight : -weight;
    for (let b = 0; b < 32; b++) v[32 + b]! += (h.hi >>> b) & 1 ? weight : -weight;
  };
  for (let i = 0; i < tokens.length; i++) {
    bump(fnv1a64(tokens[i]!), 1);
    if (i + 1 < tokens.length) bump(fnv1a64(`${tokens[i]!}${tokens[i + 1]!}`), 2);
  }
  let hi = 0, lo = 0;
  for (let b = 0; b < 32; b++) if (v[b]! > 0) lo |= 1 << b;
  for (let b = 0; b < 32; b++) if (v[32 + b]! > 0) hi |= 1 << b;
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

function shingleAt(tokens: readonly string[], from: number, n = 3): string {
  if (tokens.length === 0) return "";
  const slice = tokens.slice(Math.max(0, from), Math.max(0, from) + n);
  if (slice.length === 0) return "";
  return u64Hex(fnv1a64(slice.join("")));
}

/** Set of all 3-gram hashes in the block. Used as membership evidence for merges. */
function shingleSet(tokens: readonly string[]): Set<string> {
  const s = new Set<string>();
  if (tokens.length === 0) return s;
  const n = Math.min(3, tokens.length);
  for (let i = 0; i + n <= tokens.length; i++) s.add(u64Hex(fnv1a64(tokens.slice(i, i + n).join(""))));
  return s;
}

/**
 * `structPath` for each block: the heading trail above it, plus its ordinal inside its section.
 *
 * Headings normalize to their own text so that "reordering elsewhere" leaves a section's path
 * untouched, which is the property the design claims for this signal.
 */
export function structPaths(blocks: readonly BlockSignalInput[]): string[] {
  const out: string[] = new Array(blocks.length);
  const trail: string[] = [];
  let within = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind === "heading") {
      const lvl = Math.max(1, Math.min(9, b.level ?? 1));
      trail.length = Math.min(trail.length, lvl - 1);
      while (trail.length < lvl - 1) trail.push("");
      trail[lvl - 1] = normalizeText(b.text).slice(0, 48);
      within = 0;
      out[i] = `${trail.join(" > ")}#h`;
    } else {
      out[i] = `${trail.join(" > ")}#${within++}`;
    }
  }
  return out;
}

/** Everything derived from a current block, computed once. */
export interface PreparedBlock {
  index: number;
  input: BlockSignalInput;
  kind: BlockKind;
  level: number | null;
  listRef: string | null;
  listLevel: number | null;
  styleId: string | null;
  norm: string;
  tokens: string[];
  textLen: number;
  contentHash: string;
  sim: U64;
  simhashHex: string;
  head: string;
  tail: string;
  shingles: Set<string>;
  structPath: string;
}

export function prepareBlocks(blocks: readonly BlockSignalInput[]): PreparedBlock[] {
  const paths = structPaths(blocks);
  return blocks.map((b, index) => {
    const norm = normalizeText(b.text);
    const tokens = tokenize(norm);
    const sim = simhash(tokens);
    return {
      index,
      input: b,
      kind: b.kind,
      level: b.level ?? null,
      listRef: b.listRef ?? null,
      listLevel: b.listLevel ?? null,
      styleId: b.styleId ?? null,
      norm,
      tokens,
      textLen: norm.length,
      contentHash: sha256Hex(norm).slice(0, 16),
      sim,
      simhashHex: u64Hex(sim),
      head: shingleAt(tokens, 0),
      tail: shingleAt(tokens, tokens.length - 3),
      shingles: shingleSet(tokens),
      structPath: paths[index]!,
    };
  });
}

/** Build the stored anchor for one prepared block. */
export function anchorOf(p: PreparedBlock, aid: string): Anchor {
  return {
    aid,
    ordinal: p.index,
    kind: p.kind,
    level: p.level,
    listRef: p.listRef,
    listLevel: p.listLevel,
    styleId: p.styleId,
    textLen: p.textLen,
    tokenCount: p.tokens.length,
    contentHash: p.contentHash,
    simhash: p.simhashHex,
    headShingle: p.head,
    tailShingle: p.tail,
    structPath: p.structPath,
  };
}

/** Convenience: anchors for a whole document, in order, given the aid of each block. */
export function buildAnchors(blocks: readonly BlockSignalInput[], aids: readonly string[]): Anchor[] {
  const prepared = prepareBlocks(blocks);
  return prepared.map((p, i) => anchorOf(p, aids[i] ?? `#${i}`));
}

/* ------------------------------------------------------------------ similarity */

export interface SignalWeights {
  text: number;
  kind: number;
  level: number;
  style: number;
  list: number;
  struct: number;
  ordinal: number;
}

export const DEFAULT_WEIGHTS: SignalWeights = {
  text: 0.55, kind: 0.12, level: 0.06, style: 0.07, list: 0.05, struct: 0.08, ordinal: 0.07,
};

export interface SignalBreakdown {
  text: number;
  simhash: number;
  edges: number;
  length: number;
  kind: number;
  level: number;
  style: number;
  list: number;
  struct: number;
  ordinal: number;
  exact: boolean;
  /** Too few tokens for the textual signals to mean anything; structure carries the decision. */
  weakText: boolean;
}

const PARAGRAPHISH = new Set<BlockKind>(["paragraph", "heading", "list_item", "blockquote"]);

/** Rescaled simhash agreement. 32/64 bits agreeing is what random strings score, so it is zero. */
function simhashSim(a: U64, b: U64): number {
  const agree = 64 - hamming64(a, b);
  return Math.max(0, (agree - 32) / 32);
}

function ratio(a: number, b: number): number {
  const hi = Math.max(a, b);
  if (hi === 0) return 1;
  return Math.min(a, b) / hi;
}

function sectionOf(path: string): string {
  const h = path.lastIndexOf("#");
  return h < 0 ? path : path.slice(0, h);
}

export function similarity(
  a: Anchor,
  b: PreparedBlock,
  ordScale: number,
  weights: SignalWeights = DEFAULT_WEIGHTS,
): { score: number; signals: SignalBreakdown } {
  const exact = a.contentHash === b.contentHash;
  const weakText = a.tokenCount < 3 && b.tokens.length < 3;

  const sh = simhashSim(u64FromHex(a.simhash), b.sim);
  const headM = a.headShingle !== "" && a.headShingle === b.head ? 1 : 0;
  const tailM = a.tailShingle !== "" && a.tailShingle === b.tail ? 1 : 0;
  const edges = (headM + tailM) / 2;
  const len = ratio(a.textLen, b.textLen);
  const text = exact ? 1 : 0.55 * sh + 0.25 * edges + 0.20 * len;

  const kind = a.kind === b.kind ? 1 : PARAGRAPHISH.has(a.kind) && PARAGRAPHISH.has(b.kind) ? 0.6 : 0;
  const level = a.level === b.level ? 1 : 0.3;
  const style = a.styleId === b.styleId ? 1 : a.styleId === null || b.styleId === null ? 0.5 : 0.35;
  const list = a.listRef === b.listRef ? 1 : 0.4;
  const struct = a.structPath === b.structPath ? 1 : sectionOf(a.structPath) === sectionOf(b.structPath) ? 0.7 : 0.2;
  const ordinal = 1 - Math.min(1, Math.abs(a.ordinal - b.index) / ordScale);

  // With too little text, the textual signals are noise dressed as agreement (every empty
  // paragraph has the same hash). Shift the weight onto structure rather than pretending.
  let w = weights;
  if (weakText) {
    const freed = weights.text * 0.7;
    const rest = weights.kind + weights.level + weights.style + weights.list + weights.struct + weights.ordinal;
    const k = (rest + freed) / rest;
    w = {
      text: weights.text - freed,
      kind: weights.kind * k, level: weights.level * k, style: weights.style * k,
      list: weights.list * k, struct: weights.struct * k, ordinal: weights.ordinal * k,
    };
  }

  const score =
    w.text * text + w.kind * kind + w.level * level + w.style * style +
    w.list * list + w.struct * struct + w.ordinal * ordinal;

  return {
    score: Math.max(0, Math.min(1, score)),
    signals: { text, simhash: sh, edges, length: len, kind, level, style, list, struct, ordinal, exact, weakText },
  };
}

/**
 * Evidence that one stored anchor became these two adjacent blocks.
 *
 * Uses only signals the anchor actually stores. The concatenation's simhash IS computable here
 * because both halves are in front of us; the anchor's head shingle should sit at the head of
 * the first half and its tail shingle at the tail of the second; and the lengths should add up.
 */
function splitEvidence(a: Anchor, b1: PreparedBlock, b2: PreparedBlock): number {
  const joined = normalizeText(`${b1.norm} ${b2.norm}`);
  if (a.contentHash === sha256Hex(joined).slice(0, 16)) return 1;
  const tokens = b1.tokens.concat(b2.tokens);
  const sh = simhashSim(u64FromHex(a.simhash), simhash(tokens));
  const headM = a.headShingle !== "" && a.headShingle === b1.head ? 1 : 0;
  const tailM = a.tailShingle !== "" && a.tailShingle === b2.tail ? 1 : 0;
  const len = ratio(a.textLen, b1.textLen + b2.textLen + 1);
  const kindOk = a.kind === b1.kind || PARAGRAPHISH.has(a.kind) && PARAGRAPHISH.has(b1.kind) ? 1 : 0.4;
  return kindOk * (0.45 * sh + 0.20 * headM + 0.15 * tailM + 0.20 * len);
}

/**
 * Evidence that these two stored anchors became one block.
 *
 * Harder than a split: we have no text for either anchor, only fingerprints. What is available
 * and exact is positional - the merged block should begin the way the first anchor began and end
 * the way the second ended - plus membership of each anchor's edge shingles in the block, plus
 * lengths adding up. That is enough to be confident, and where it is not, confidence says so.
 */
function mergeEvidence(a1: Anchor, a2: Anchor, b: PreparedBlock, ordScale: number, w: SignalWeights): number {
  const s1 = similarity(a1, b, ordScale, w).score;
  const s2 = similarity(a2, b, ordScale, w).score;
  const headM = a1.headShingle !== "" && a1.headShingle === b.head ? 1 : 0;
  const tailM = a2.tailShingle !== "" && a2.tailShingle === b.tail ? 1 : 0;
  const memb =
    ((a1.tailShingle !== "" && b.shingles.has(a1.tailShingle)) ? 0.5 : 0) +
    ((a2.headShingle !== "" && b.shingles.has(a2.headShingle)) ? 0.5 : 0);
  const len = ratio(a1.textLen + a2.textLen + 1, b.textLen);
  return 0.28 * Math.max(s1, s2) + 0.12 * Math.min(s1, s2) + 0.18 * headM + 0.18 * tailM + 0.09 * memb + 0.15 * len;
}

/* ------------------------------------------------------------------ alignment */

export interface ReanchorOptions {
  /** Below this confidence, OOXML properties are dropped rather than misapplied. */
  threshold?: number;
  /** Half-width of the DP band around the constrained path. */
  band?: number;
  /** Score for a perfect match is `matchScale + matchBias`; for sim=0.5 it is 0. */
  matchScale?: number;
  matchBias?: number;
  gapOpen?: number;
  gapExtend?: number;
  splitPenalty?: number;
  mergePenalty?: number;
  allowSplitMerge?: boolean;
  weights?: SignalWeights;
  /** Try to recover moved blocks by exact content match after alignment. Default true. */
  recoverMoves?: boolean;
}

export const DEFAULT_OPTIONS: Required<Omit<ReanchorOptions, "weights">> & { weights: SignalWeights } = {
  threshold: 0.55,
  band: 128,
  matchScale: 2.0,
  matchBias: -1.0,
  gapOpen: -0.9,
  gapExtend: -0.15,
  splitPenalty: -0.35,
  mergePenalty: -0.45,
  allowSplitMerge: true,
  recoverMoves: true,
  weights: DEFAULT_WEIGHTS,
};

export type AnchorOp = "match" | "split" | "merge" | "insert" | "move";

export interface BlockAssignment {
  blockIndex: number;
  /** null when nothing was matched: a genuinely new block, or one we refused to guess about. */
  aid: string | null;
  op: AnchorOp;
  confidence: number;
  /**
   * THE decision. False means: do not apply this anchor's OOXML properties to this block.
   * The splice engine must treat `applyProps === false` as "synthesize a plain paragraph",
   * never as "close enough".
   */
  applyProps: boolean;
  /** For `split`: which half this is (0 or 1). */
  part?: number;
  /** For `merge`: aids folded into this block and retired. */
  absorbed?: string[];
  /** Margin over the runner-up candidate. Small margins are what ambiguity means. */
  margin?: number;
  signals?: SignalBreakdown;
}

export interface ReanchorResult {
  /** One entry per current block, in document order. */
  assignments: BlockAssignment[];
  /** Stored anchors that matched nothing. Their properties, comments and revisions are orphaned. */
  lost: { aid: string; ordinal: number; reason: "deleted" | "low-confidence" }[];
  /** Anchors folded into a surviving block by a merge. */
  retired: { aid: string; intoAid: string | null; blockIndex: number }[];
  ledger: LedgerEntry[];
  stats: {
    anchors: number;
    blocks: number;
    matched: number;
    exact: number;
    split: number;
    merged: number;
    moved: number;
    inserted: number;
    lost: number;
    lowConfidence: number;
    /** Mean confidence over blocks that got an aid. */
    meanConfidence: number;
    waypoints: number;
    bandCells: number;
  };
}

const NEG = -1e9;

/**
 * Monotone skeleton of unique exact matches, used to constrain the band.
 *
 * Only content hashes that occur exactly once on each side are eligible: a hash that appears
 * three times is not evidence of anything. The longest increasing subsequence over the
 * survivors is the largest set of them that could all be true simultaneously under an
 * order-preserving alignment.
 */
function waypoints(anchors: readonly Anchor[], blocks: readonly PreparedBlock[]): Array<[number, number]> {
  const aCount = new Map<string, number>();
  const bCount = new Map<string, number>();
  for (const a of anchors) if (a.tokenCount >= 3) aCount.set(a.contentHash, (aCount.get(a.contentHash) ?? 0) + 1);
  for (const b of blocks) if (b.tokens.length >= 3) bCount.set(b.contentHash, (bCount.get(b.contentHash) ?? 0) + 1);

  const bIndex = new Map<string, number>();
  for (let j = 0; j < blocks.length; j++) {
    const h = blocks[j]!.contentHash;
    if (bCount.get(h) === 1) bIndex.set(h, j);
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < anchors.length; i++) {
    const h = anchors[i]!.contentHash;
    if (aCount.get(h) !== 1) continue;
    const j = bIndex.get(h);
    if (j === undefined) continue;
    pairs.push([i, j]);
  }
  // pairs is already sorted by i; take the LIS on j.
  const n = pairs.length;
  if (n === 0) return [];
  const tails: number[] = [];
  const tailIdx: number[] = [];
  const prev: number[] = new Array(n).fill(-1);
  for (let k = 0; k < n; k++) {
    const j = pairs[k]![1];
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid]! < j) lo = mid + 1; else hi = mid;
    }
    tails[lo] = j;
    tailIdx[lo] = k;
    prev[k] = lo > 0 ? tailIdx[lo - 1]! : -1;
  }
  const out: Array<[number, number]> = [];
  for (let k = tailIdx[tailIdx.length - 1]!; k >= 0; k = prev[k]!) {
    out.push(pairs[k]!);
    if (prev[k] === -1) break;
  }
  out.reverse();
  return out;
}

/** Band centre for each anchor row, interpolated through the waypoint skeleton. */
function bandCentres(m: number, n: number, wps: Array<[number, number]>): Float64Array {
  const c = new Float64Array(m + 1);
  const pts: Array<[number, number]> = [[0, 0], ...wps.map(([i, j]) => [i + 1, j + 1] as [number, number]), [m, n]];
  // Enforce monotone non-decreasing, dropping any point that would go backwards.
  const clean: Array<[number, number]> = [pts[0]!];
  for (let k = 1; k < pts.length; k++) {
    const p = pts[k]!;
    const q = clean[clean.length - 1]!;
    if (p[0] >= q[0] && p[1] >= q[1]) clean.push(p);
  }
  if (clean[clean.length - 1]![0] !== m) clean.push([m, n]);
  let seg = 0;
  for (let i = 0; i <= m; i++) {
    while (seg + 1 < clean.length && clean[seg + 1]![0] < i) seg++;
    const [i0, j0] = clean[seg]!;
    const [i1, j1] = clean[Math.min(seg + 1, clean.length - 1)]!;
    c[i] = i1 === i0 ? j1 : j0 + ((i - i0) * (j1 - j0)) / (i1 - i0);
  }
  return c;
}

/**
 * Re-anchor stored anchors onto the blocks currently in the document.
 *
 * The result is per-block and total: every current block gets exactly one assignment, and every
 * stored anchor is either matched, merged away, or reported lost. Nothing disappears quietly.
 */
export function reanchor(
  anchors: readonly Anchor[],
  blocks: readonly BlockSignalInput[],
  options: ReanchorOptions = {},
): ReanchorResult {
  const o = { ...DEFAULT_OPTIONS, ...options, weights: options.weights ?? DEFAULT_WEIGHTS };
  const prepared = prepareBlocks(blocks);
  const m = anchors.length;
  const n = prepared.length;
  const ledger = new Ledger();

  if (m === 0 || n === 0) {
    const assignments: BlockAssignment[] = prepared.map((p) => ({
      blockIndex: p.index, aid: null, op: "insert" as const, confidence: 0, applyProps: false,
    }));
    for (const a of anchors) {
      ledger.add({ code: "anchor-lost", severity: "dropped", stage: "anchor", aid: a.aid, detail: "document is empty; anchor has nothing to attach to" });
    }
    return {
      assignments,
      lost: anchors.map((a) => ({ aid: a.aid, ordinal: a.ordinal, reason: "deleted" as const })),
      retired: [],
      ledger: ledger.entries(),
      stats: { anchors: m, blocks: n, matched: 0, exact: 0, split: 0, merged: 0, moved: 0, inserted: n, lost: m, lowConfidence: 0, meanConfidence: 0, waypoints: 0, bandCells: 0 },
    };
  }

  const ordScale = Math.max(16, 0.1 * Math.max(m, n));
  const wps = waypoints(anchors, prepared);
  const centres = bandCentres(m, n, wps);

  // Band wide enough to absorb the largest un-skeletoned displacement, capped for cost.
  let band = o.band;
  const cellBudget = 12_000_000;
  while (band > 8 && (m + 1) * (2 * band + 1) > cellBudget) band >>= 1;
  const W = 2 * band + 1;

  const lo = new Int32Array(m + 1);
  const hi = new Int32Array(m + 1);
  for (let i = 0; i <= m; i++) {
    const c = Math.round(centres[i]!);
    lo[i] = Math.max(0, Math.min(n, c - band));
    hi[i] = Math.max(0, Math.min(n, c + band));
  }
  // The band must contain the corners or the alignment cannot start or finish.
  lo[0] = 0; hi[m] = n;

  const size = (m + 1) * W;
  const M = new Float32Array(size).fill(NEG);
  const X = new Float32Array(size).fill(NEG); // gap in blocks: anchor consumed, no block
  const Y = new Float32Array(size).fill(NEG); // gap in anchors: block consumed, no anchor
  const at = (i: number, j: number): number => {
    if (j < lo[i]! || j > hi[i]!) return -1;
    return i * W + (j - lo[i]!);
  };
  const get = (arr: Float32Array, i: number, j: number): number => {
    if (i < 0 || i > m || j < 0 || j > n) return NEG;
    const k = at(i, j);
    return k < 0 ? NEG : arr[k]!;
  };
  const best = (i: number, j: number): number => Math.max(get(M, i, j), get(X, i, j), get(Y, i, j));

  // Similarity is the hot inner term; memoise it per band cell so traceback is free.
  const simCache = new Float32Array(size).fill(-1);
  const simAt = (i: number, j: number): number => {
    // i, j are 1-based DP coordinates -> anchors[i-1], prepared[j-1]
    const k = at(i, j);
    if (k >= 0 && simCache[k]! >= 0) return simCache[k]!;
    const s = similarity(anchors[i - 1]!, prepared[j - 1]!, ordScale, o.weights).score;
    if (k >= 0) simCache[k] = s;
    return s;
  };
  const mscore = (s: number): number => o.matchScale * s + o.matchBias;

  const k00 = at(0, 0);
  if (k00 >= 0) M[k00] = 0;
  for (let j = Math.max(1, lo[0]!); j <= hi[0]!; j++) {
    const k = at(0, j);
    if (k < 0) continue;
    Y[k] = j === 1 ? o.gapOpen : get(Y, 0, j - 1) + o.gapExtend;
  }

  let bandCells = 0;
  for (let i = 1; i <= m; i++) {
    for (let j = lo[i]!; j <= hi[i]!; j++) {
      const k = at(i, j);
      if (k < 0) continue;
      bandCells++;
      // X: anchor i consumed against a gap.
      X[k] = Math.max(get(M, i - 1, j) + o.gapOpen, get(X, i - 1, j) + o.gapExtend);
      if (j === 0) { M[k] = NEG; Y[k] = NEG; continue; }
      // Y: block j consumed against a gap.
      Y[k] = Math.max(get(M, i, j - 1) + o.gapOpen, get(Y, i, j - 1) + o.gapExtend);
      // M: diagonal, plus split and merge as first-class transitions.
      let mv = best(i - 1, j - 1) + mscore(simAt(i, j));
      if (o.allowSplitMerge) {
        if (j >= 2) {
          const prevBest = best(i - 1, j - 2);
          if (prevBest > NEG / 2) {
            const e = splitEvidence(anchors[i - 1]!, prepared[j - 2]!, prepared[j - 1]!);
            const cand = prevBest + mscore(e) + o.splitPenalty;
            if (cand > mv) mv = cand;
          }
        }
        if (i >= 2) {
          const prevBest = best(i - 2, j - 1);
          if (prevBest > NEG / 2) {
            const e = mergeEvidence(anchors[i - 2]!, anchors[i - 1]!, prepared[j - 1]!, ordScale, o.weights);
            const cand = prevBest + mscore(e) + o.mergePenalty;
            if (cand > mv) mv = cand;
          }
        }
      }
      M[k] = mv;
    }
  }

  /* ---------------------------------------------------------------- traceback */

  interface RawOp { kind: "match" | "split" | "merge" | "insert" | "delete"; i: number; j: number; score: number }
  const ops: RawOp[] = [];
  let i = m, j = n;
  let state: "M" | "X" | "Y" = (() => {
    const mm = get(M, m, n), xx = get(X, m, n), yy = get(Y, m, n);
    return mm >= xx && mm >= yy ? "M" : xx >= yy ? "X" : "Y";
  })();

  let guard = (m + n) * 4 + 16;
  while ((i > 0 || j > 0) && guard-- > 0) {
    if (state === "X") {
      const cur = get(X, i, j);
      const fromM = get(M, i - 1, j) + o.gapOpen;
      ops.push({ kind: "delete", i, j, score: 0 });
      state = Math.abs(cur - fromM) < 1e-6 ? "M" : "X";
      i--;
      continue;
    }
    if (state === "Y") {
      const cur = get(Y, i, j);
      const fromM = get(M, i, j - 1) + o.gapOpen;
      ops.push({ kind: "insert", i, j, score: 0 });
      state = Math.abs(cur - fromM) < 1e-6 ? "M" : "Y";
      j--;
      continue;
    }
    if (i === 0 && j === 0) break;
    if (i === 0) { ops.push({ kind: "insert", i, j, score: 0 }); j--; continue; }
    if (j === 0) { ops.push({ kind: "delete", i, j, score: 0 }); i--; continue; }

    const cur = get(M, i, j);
    const s = simAt(i, j);
    const diag = best(i - 1, j - 1) + mscore(s);
    let chosen: "match" | "split" | "merge" = "match";
    let chosenScore = diag;
    let ev = s;
    if (o.allowSplitMerge && j >= 2) {
      const e = splitEvidence(anchors[i - 1]!, prepared[j - 2]!, prepared[j - 1]!);
      const c = best(i - 1, j - 2) + mscore(e) + o.splitPenalty;
      if (c > chosenScore + 1e-9) { chosen = "split"; chosenScore = c; ev = e; }
    }
    if (o.allowSplitMerge && i >= 2) {
      const e = mergeEvidence(anchors[i - 2]!, anchors[i - 1]!, prepared[j - 1]!, ordScale, o.weights);
      const c = best(i - 2, j - 1) + mscore(e) + o.mergePenalty;
      if (c > chosenScore + 1e-9) { chosen = "merge"; chosenScore = c; ev = e; }
    }
    if (Math.abs(cur - chosenScore) > 1e-4 && cur > chosenScore) {
      // Numerical drift; fall back to the plain diagonal rather than fabricate an op.
      chosen = "match"; ev = s;
    }
    ops.push({ kind: chosen, i, j, score: ev });
    if (chosen === "split") { i -= 1; j -= 2; }
    else if (chosen === "merge") { i -= 2; j -= 1; }
    else { i -= 1; j -= 1; }
    const pi = chosen === "merge" ? i : i, pj = chosen === "split" ? j : j;
    const mm = get(M, pi, pj), xx = get(X, pi, pj), yy = get(Y, pi, pj);
    state = mm >= xx && mm >= yy ? "M" : xx >= yy ? "X" : "Y";
  }
  ops.reverse();

  /* ---------------------------------------------------------------- assignments */

  const assignments: BlockAssignment[] = prepared.map((p) => ({
    blockIndex: p.index, aid: null, op: "insert" as const, confidence: 0, applyProps: false,
  }));
  const anchorUsed = new Uint8Array(m);
  const retired: ReanchorResult["retired"] = [];
  const rawScore = new Float64Array(n).fill(0);
  const opOf: AnchorOp[] = new Array(n).fill("insert");
  const anchorFor: number[] = new Array(n).fill(-1);

  for (const op of ops) {
    if (op.kind === "match") {
      const ai = op.i - 1, bj = op.j - 1;
      anchorFor[bj] = ai; opOf[bj] = "match"; rawScore[bj] = op.score;
      anchorUsed[ai] = 1;
    } else if (op.kind === "split") {
      const ai = op.i - 1, b1 = op.j - 2, b2 = op.j - 1;
      anchorFor[b1] = ai; opOf[b1] = "split"; rawScore[b1] = op.score;
      anchorFor[b2] = ai; opOf[b2] = "split"; rawScore[b2] = op.score;
      anchorUsed[ai] = 1;
      assignments[b1]!.part = 0;
      assignments[b2]!.part = 1;
    } else if (op.kind === "merge") {
      const a1 = op.i - 2, a2 = op.i - 1, bj = op.j - 1;
      // The dominant anchor's properties win (DOCX-FIDELITY.md 3); the other is retired.
      const s1 = similarity(anchors[a1]!, prepared[bj]!, ordScale, o.weights).score;
      const s2 = similarity(anchors[a2]!, prepared[bj]!, ordScale, o.weights).score;
      const dom = s1 >= s2 ? a1 : a2;
      const other = dom === a1 ? a2 : a1;
      anchorFor[bj] = dom; opOf[bj] = "merge"; rawScore[bj] = op.score;
      anchorUsed[a1] = 1; anchorUsed[a2] = 1;
      assignments[bj]!.absorbed = [anchors[other]!.aid];
      retired.push({ aid: anchors[other]!.aid, intoAid: anchors[dom]!.aid, blockIndex: bj });
    }
  }

  /* ---------------------------------------------------------------- move recovery */

  let moved = 0;
  if (o.recoverMoves) {
    const freeBlocks: number[] = [];
    for (let b = 0; b < n; b++) if (anchorFor[b]! < 0 && prepared[b]!.tokens.length >= 3) freeBlocks.push(b);
    if (freeBlocks.length > 0) {
      const freeAnchors: number[] = [];
      for (let a = 0; a < m; a++) if (!anchorUsed[a] && anchors[a]!.tokenCount >= 3) freeAnchors.push(a);
      if (freeAnchors.length > 0) {
        const byHash = new Map<string, number[]>();
        for (const a of freeAnchors) {
          const h = anchors[a]!.contentHash;
          const l = byHash.get(h);
          if (l) l.push(a); else byHash.set(h, [a]);
        }
        const claimed = new Set<number>();
        for (const b of freeBlocks) {
          const cands = byHash.get(prepared[b]!.contentHash);
          if (!cands) continue;
          const free = cands.filter((a) => !claimed.has(a));
          // Only unambiguous recoveries: one free anchor with exactly this content.
          if (free.length !== 1) continue;
          const a = free[0]!;
          claimed.add(a);
          anchorFor[b] = a; opOf[b] = "move"; rawScore[b] = 1;
          anchorUsed[a] = 1;
          moved++;
        }
      }
    }
  }

  /* ---------------------------------------------------------------- confidence */

  // Ambiguity: how much better was the chosen anchor than the best alternative in the band?
  const margin = new Float64Array(n).fill(1);
  for (let b = 0; b < n; b++) {
    const a = anchorFor[b]!;
    if (a < 0) continue;
    let second = 0;
    const from = Math.max(0, a - 24), to = Math.min(m - 1, a + 24);
    for (let k = from; k <= to; k++) {
      if (k === a) continue;
      const s = similarity(anchors[k]!, prepared[b]!, ordScale, o.weights).score;
      if (s > second) second = s;
    }
    margin[b] = Math.max(0, rawScore[b]! - second);
  }

  let lowConfidence = 0;
  let confSum = 0, confCount = 0, matched = 0, exact = 0, splitCount = 0, mergeCount = 0;

  for (let b = 0; b < n; b++) {
    const asg = assignments[b]!;
    const a = anchorFor[b]!;
    if (a < 0) {
      asg.op = "insert";
      ledger.add({
        code: "anchor-inserted", severity: "info", stage: "anchor", blockIndex: b,
        detail: "block has no stored anchor; it will get default properties",
      });
      continue;
    }
    const anchor = anchors[a]!;
    asg.aid = anchor.aid;
    asg.op = opOf[b]!;

    // Neighbour support: did the blocks either side align to the anchors either side?
    const prevOk = b > 0 && anchorFor[b - 1]! >= 0 && anchorFor[b - 1]! <= a;
    const nextOk = b + 1 < n && anchorFor[b + 1]! >= 0 && anchorFor[b + 1]! >= a;
    const support = ((prevOk ? 1 : 0) + (nextOk ? 1 : 0)) / 2;

    // Ambiguity penalty, relieved by context. This is the whole reason to align rather than
    // hash: identical boilerplate is disambiguated by its neighbours, or not at all.
    const mg = margin[b]!;
    const rawPenalty = mg >= 0.15 ? 1 : 0.55 + (mg / 0.15) * 0.45;
    const penalty = 1 - (1 - rawPenalty) * (1 - support);

    const opPenalty = asg.op === "split" ? 0.9 : asg.op === "merge" ? 0.85 : 1;
    const sig = similarity(anchor, prepared[b]!, ordScale, o.weights);
    asg.signals = sig.signals;
    asg.margin = mg;

    let conf = rawScore[b]! * penalty * opPenalty;
    if (asg.op === "move") conf = 0.95;                       // exact content, unique claimant
    if (sig.signals.exact && asg.op === "match") conf = Math.max(conf, 0.9 * penalty);
    asg.confidence = Math.max(0, Math.min(1, conf));

    if (asg.confidence < o.threshold) {
      asg.applyProps = false;
      lowConfidence++;
      ledger.add({
        code: "anchor-low-confidence", severity: "dropped", stage: "anchor",
        aid: anchor.aid, blockIndex: b, confidence: asg.confidence,
        detail: `confidence ${asg.confidence.toFixed(3)} < ${o.threshold}; OOXML properties dropped rather than misapplied`,
      });
    } else {
      asg.applyProps = true;
      matched++;
      confSum += asg.confidence; confCount++;
      if (sig.signals.exact) exact++;
      if (mg < 0.05) {
        ledger.add({
          code: "anchor-ambiguous", severity: "degraded", stage: "anchor", aid: anchor.aid,
          blockIndex: b, confidence: asg.confidence,
          detail: `runner-up anchor was within ${mg.toFixed(3)}; resolved by neighbouring alignment`,
        });
      }
    }
    if (asg.op === "split") {
      splitCount++;
      ledger.add({ code: "anchor-split", severity: "info", stage: "anchor", aid: anchor.aid, blockIndex: b, detail: "one anchor became two blocks; both inherit its paragraph properties" });
    }
    if (asg.op === "merge") {
      mergeCount++;
      ledger.add({ code: "anchor-merged", severity: "degraded", stage: "anchor", aid: anchor.aid, blockIndex: b, detail: `two anchors became one block; ${asg.absorbed?.join(",") ?? ""} retired` });
    }
  }

  const lost: ReanchorResult["lost"] = [];
  for (let a = 0; a < m; a++) {
    if (anchorUsed[a]) continue;
    lost.push({ aid: anchors[a]!.aid, ordinal: anchors[a]!.ordinal, reason: "deleted" });
    ledger.add({
      code: "anchor-lost", severity: "degraded", stage: "anchor", aid: anchors[a]!.aid,
      detail: "stored anchor matched no current block; its properties, comments and revisions are orphaned",
    });
  }

  return {
    assignments,
    lost,
    retired,
    ledger: ledger.entries(),
    stats: {
      anchors: m, blocks: n, matched, exact,
      split: splitCount / 2 | 0, merged: mergeCount, moved,
      inserted: assignments.filter((x) => x.op === "insert").length,
      lost: lost.length, lowConfidence,
      meanConfidence: confCount ? confSum / confCount : 0,
      waypoints: wps.length,
      bandCells,
    },
  };
}

/** Hamming distance between two stored simhashes. Exposed for diagnostics and tests. */
export function anchorSimhashDistance(a: Anchor, b: Anchor): number {
  return hamming64(u64FromHex(a.simhash), u64FromHex(b.simhash));
}

export { popcount32 };
