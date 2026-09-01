/**
 * Sentence alignment between two revisions of a document.
 *
 * The pipeline, in order, because each stage exists to make the next one cheap and correct:
 *
 *  1. **Unique anchors (patience).** Sentences whose normalised text occurs exactly once on
 *     each side and is identical are near-certain matches. The longest increasing subsequence
 *     of those pairs gives a skeleton that no amount of rewording can confuse.
 *  2. **Gap alignment.** Between consecutive anchors, recurse on the same unique-anchor trick;
 *     when the region is small enough, run a Needleman–Wunsch alignment scored by sentence
 *     similarity so that *reworded* sentences pair up with the sentence they were reworded from.
 *  3. **Split / merge.** One old sentence against a run of new ones (and the reverse). Writers
 *     split and merge sentences constantly; a differ that calls that "delete + insert" is lying.
 *  4. **Moves.** Whatever is still unpaired is matched globally, ignoring position. An exact
 *     normalised match is a clean move; a high-similarity match is a move plus a rewording.
 *     This is the stage that fixes the thing that keeps writers off git: a relocated paragraph
 *     shows as one move, not as a giant delete followed by a giant insert.
 *
 * Everything here is pure and synchronous.
 */

import type { Sentence } from "./segment";
import { sentenceSimilarity, words } from "./tokens";

export interface AlignedPair {
  /** Old sentence indices, ascending. More than one only for a merge. */
  old: number[];
  /** New sentence indices, ascending. More than one only for a split. */
  new: number[];
  similarity: number;
  /** True when the pair is out of document order relative to its neighbours. */
  moved: boolean;
}

export interface Alignment {
  pairs: AlignedPair[];
  /** Old sentences with no counterpart at all. */
  deleted: number[];
  /** New sentences with no counterpart at all. */
  inserted: number[];
}

export interface AlignOptions {
  locale?: string;
  /** Minimum similarity for two in-place sentences to count as a rewording. Default 0.34. */
  rewriteThreshold?: number;
  /** Minimum similarity for an out-of-place pair to count as a move. Default 0.60. */
  moveThreshold?: number;
  /** Minimum similarity for a split/merge to be recognised. Default 0.65. */
  splitThreshold?: number;
  /** Largest region (old × new) that gets the full quadratic alignment. Default 40000. */
  maxRegionCells?: number;
}

interface Ctx {
  a: Sentence[];
  b: Sentence[];
  aw: string[][];
  bw: string[][];
  opts: Required<AlignOptions>;
}

const DEFAULTS: Required<AlignOptions> = {
  locale: "en",
  rewriteThreshold: 0.34,
  moveThreshold: 0.6,
  splitThreshold: 0.65,
  maxRegionCells: 40000,
};

function sim(ctx: Ctx, i: number, j: number): number {
  const a = ctx.a[i]!;
  const b = ctx.b[j]!;
  if (a.norm === b.norm) return 1;
  const wa = ctx.aw[i]!;
  const wb = ctx.bw[j]!;
  // A short-circuit that is also a correctness guard: sentences of wildly different length
  // are not rewordings of each other.
  const ratio = Math.min(wa.length, wb.length) / Math.max(1, Math.max(wa.length, wb.length));
  if (ratio < 0.2 && Math.max(wa.length, wb.length) > 8) return 0;
  return sentenceSimilarity(a.text, b.text, ctx.opts.locale);
}

/** Longest increasing subsequence over the `n` field of position pairs sorted by `o`. */
function lis(pairs: { o: number; n: number }[]): { o: number; n: number }[] {
  if (pairs.length === 0) return [];
  const tailsIdx: number[] = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    const v = pairs[i]!.n;
    let lo = 0;
    let hi = tailsIdx.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tailsIdx[mid]!]!.n < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tailsIdx[lo - 1]!;
    if (lo === tailsIdx.length) tailsIdx.push(i);
    else tailsIdx[lo] = i;
  }
  const out: { o: number; n: number }[] = [];
  let k = tailsIdx[tailsIdx.length - 1]!;
  while (k !== -1) {
    out.push(pairs[k]!);
    k = prev[k]!;
  }
  out.reverse();
  return out;
}

/** Pairs whose normalised text is unique on both sides within the given ranges. */
function uniqueAnchors(ctx: Ctx, a0: number, a1: number, b0: number, b1: number): { o: number; n: number }[] {
  const aCount = new Map<string, number[]>();
  for (let i = a0; i < a1; i++) {
    const k = ctx.a[i]!.norm;
    const arr = aCount.get(k);
    if (arr) arr.push(i);
    else aCount.set(k, [i]);
  }
  const bCount = new Map<string, number[]>();
  for (let j = b0; j < b1; j++) {
    const k = ctx.b[j]!.norm;
    const arr = bCount.get(k);
    if (arr) arr.push(j);
    else bCount.set(k, [j]);
  }
  const pairs: { o: number; n: number }[] = [];
  for (const [k, av] of aCount) {
    if (av.length !== 1) continue;
    const bv = bCount.get(k);
    if (!bv || bv.length !== 1) continue;
    if (k === "") continue;
    pairs.push({ o: av[0]!, n: bv[0]! });
  }
  pairs.sort((x, y) => x.o - y.o);
  return lis(pairs);
}

/** Needleman–Wunsch over similarity, with a threshold baked into the match score. */
function alignRegion(ctx: Ctx, a0: number, a1: number, b0: number, b1: number, out: { o: number; n: number; s: number }[]): void {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0 || m === 0) return;
  if (n * m > ctx.opts.maxRegionCells) {
    // Too large for the quadratic pass: fall back to a greedy diagonal sweep, which is
    // what a region this big (thousands of consecutive unmatched sentences) deserves.
    const k = Math.min(n, m);
    for (let d = 0; d < k; d++) {
      const s = sim(ctx, a0 + d, b0 + d);
      if (s >= ctx.opts.rewriteThreshold) out.push({ o: a0 + d, n: b0 + d, s });
    }
    return;
  }

  const t = ctx.opts.rewriteThreshold;
  const w = m + 1;
  const score = new Float32Array((n + 1) * w);
  const back = new Uint8Array((n + 1) * w); // 0 = stop, 1 = diag, 2 = up (delete), 3 = left (insert)

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = sim(ctx, a0 + i - 1, b0 + j - 1);
      // Below threshold a pairing is worse than two gaps, so it never wins.
      const diag = score[(i - 1) * w + (j - 1)]! + (s - t);
      const up = score[(i - 1) * w + j]!;
      const left = score[i * w + (j - 1)]!;
      let best = diag;
      let dir = 1;
      if (up > best) {
        best = up;
        dir = 2;
      }
      if (left > best) {
        best = left;
        dir = 3;
      }
      score[i * w + j] = best;
      back[i * w + j] = dir;
    }
  }

  let i = n;
  let j = m;
  const local: { o: number; n: number; s: number }[] = [];
  while (i > 0 && j > 0) {
    const dir = back[i * w + j]!;
    if (dir === 1) {
      const s = sim(ctx, a0 + i - 1, b0 + j - 1);
      if (s >= t) local.push({ o: a0 + i - 1, n: b0 + j - 1, s });
      i--;
      j--;
    } else if (dir === 2) i--;
    else j--;
  }
  local.reverse();
  for (const p of local) out.push(p);
}

/** Recursive patience-style alignment of `[a0,a1) × [b0,b1)`. */
function alignRange(ctx: Ctx, a0: number, a1: number, b0: number, b1: number, out: { o: number; n: number; s: number }[], depth: number): void {
  if (a0 >= a1 || b0 >= b1) return;
  const anchors = depth < 6 ? uniqueAnchors(ctx, a0, a1, b0, b1) : [];
  if (anchors.length === 0) {
    alignRegion(ctx, a0, a1, b0, b1, out);
    return;
  }
  let ai = a0;
  let bi = b0;
  for (const an of anchors) {
    alignRange(ctx, ai, an.o, bi, an.n, out, depth + 1);
    out.push({ o: an.o, n: an.n, s: 1 });
    ai = an.o + 1;
    bi = an.n + 1;
  }
  alignRange(ctx, ai, a1, bi, b1, out, depth + 1);
}

/** Concatenated normalised text of a run of sentences. */
function runText(list: Sentence[], from: number, count: number): string {
  let s = "";
  for (let i = 0; i < count; i++) {
    if (i > 0) s += " ";
    s += list[from + i]!.text;
  }
  return s;
}

export function alignSentences(a: Sentence[], b: Sentence[], options: AlignOptions = {}): Alignment {
  const opts = { ...DEFAULTS, ...options };
  const ctx: Ctx = {
    a,
    b,
    aw: a.map((s) => words(s.text, opts.locale)),
    bw: b.map((s) => words(s.text, opts.locale)),
    opts,
  };

  // Stage 1 + 2 — in-order alignment.
  const inOrder: { o: number; n: number; s: number }[] = [];
  alignRange(ctx, 0, a.length, 0, b.length, inOrder, 0);
  inOrder.sort((x, y) => x.n - y.n);

  const oldTaken = new Uint8Array(a.length);
  const newTaken = new Uint8Array(b.length);
  const pairs: AlignedPair[] = [];
  for (const p of inOrder) {
    if (oldTaken[p.o] || newTaken[p.n]) continue;
    oldTaken[p.o] = 1;
    newTaken[p.n] = 1;
    pairs.push({ old: [p.o], new: [p.n], similarity: p.s, moved: false });
  }

  // Stage 3 — split and merge, but only between neighbours, since a split is by definition
  // a local event. A "split" whose halves are pages apart is a move, and stage 4 owns that.
  const freeOld = () => {
    const r: number[] = [];
    for (let i = 0; i < a.length; i++) if (!oldTaken[i]) r.push(i);
    return r;
  };
  const freeNew = () => {
    const r: number[] = [];
    for (let j = 0; j < b.length; j++) if (!newTaken[j]) r.push(j);
    return r;
  };

  for (const o of freeOld()) {
    if (oldTaken[o]) continue;
    // Candidate new run: consecutive free new sentences near where `o` would have landed.
    const anchorNew = nearestNewPosition(pairs, o);
    for (const start of candidateStarts(newTaken, anchorNew, b.length)) {
      let bestCount = 0;
      let bestSim = 0;
      for (let count = 2; count <= 5 && start + count <= b.length; count++) {
        if (newTaken[start + count - 1]) break;
        const s = sentenceSimilarity(a[o]!.text, runText(b, start, count), opts.locale);
        if (s > bestSim) {
          bestSim = s;
          bestCount = count;
        }
      }
      if (bestCount >= 2 && bestSim >= opts.splitThreshold) {
        oldTaken[o] = 1;
        const news: number[] = [];
        for (let i = 0; i < bestCount; i++) {
          newTaken[start + i] = 1;
          news.push(start + i);
        }
        pairs.push({ old: [o], new: news, similarity: bestSim, moved: false });
        break;
      }
    }
  }

  for (const n of freeNew()) {
    if (newTaken[n]) continue;
    const anchorOld = nearestOldPosition(pairs, n);
    for (const start of candidateStarts(oldTaken, anchorOld, a.length)) {
      let bestCount = 0;
      let bestSim = 0;
      for (let count = 2; count <= 5 && start + count <= a.length; count++) {
        if (oldTaken[start + count - 1]) break;
        const s = sentenceSimilarity(runText(a, start, count), b[n]!.text, opts.locale);
        if (s > bestSim) {
          bestSim = s;
          bestCount = count;
        }
      }
      if (bestCount >= 2 && bestSim >= opts.splitThreshold) {
        newTaken[n] = 1;
        const olds: number[] = [];
        for (let i = 0; i < bestCount; i++) {
          oldTaken[start + i] = 1;
          olds.push(start + i);
        }
        pairs.push({ old: olds, new: [n], similarity: bestSim, moved: false });
        break;
      }
    }
  }

  // Stage 4 — moves. Exact normalised matches first, then similarity via an inverted index
  // so we never do a full |free old| × |free new| sweep on a long document.
  const stillOld = freeOld();
  const stillNew = freeNew();

  const byNorm = new Map<string, number[]>();
  for (const o of stillOld) {
    const arr = byNorm.get(a[o]!.norm);
    if (arr) arr.push(o);
    else byNorm.set(a[o]!.norm, [o]);
  }
  for (const n of stillNew) {
    if (newTaken[n]) continue;
    const cands = byNorm.get(b[n]!.norm);
    while (cands && cands.length > 0) {
      const o = cands.shift()!;
      if (oldTaken[o]) continue;
      oldTaken[o] = 1;
      newTaken[n] = 1;
      pairs.push({ old: [o], new: [n], similarity: 1, moved: true });
      break;
    }
  }

  const postings = new Map<string, number[]>();
  for (const o of stillOld) {
    if (oldTaken[o]) continue;
    for (const w of new Set(ctx.aw[o]!)) {
      const arr = postings.get(w);
      if (arr) arr.push(o);
      else postings.set(w, [o]);
    }
  }
  for (const n of stillNew) {
    if (newTaken[n]) continue;
    const seen = new Map<number, number>();
    for (const w of new Set(ctx.bw[n]!)) {
      const arr = postings.get(w);
      if (!arr || arr.length > 200) continue; // skip stopword-grade postings
      for (const o of arr) if (!oldTaken[o]) seen.set(o, (seen.get(o) ?? 0) + 1);
    }
    let best = -1;
    let bestSim = 0;
    for (const [o, overlap] of seen) {
      const upper = (2 * overlap) / (ctx.aw[o]!.length + ctx.bw[n]!.length);
      if (upper < opts.moveThreshold) continue;
      const s = sim(ctx, o, n);
      if (s > bestSim) {
        bestSim = s;
        best = o;
      }
    }
    if (best >= 0 && bestSim >= opts.moveThreshold) {
      oldTaken[best] = 1;
      newTaken[n] = 1;
      pairs.push({ old: [best], new: [n], similarity: bestSim, moved: true });
    }
  }

  pairs.sort((x, y) => x.new[0]! - y.new[0]!);

  // A pair flagged `moved` in stage 4 may in fact sit in order relative to its neighbours
  // (it can happen when a whole tail was rewritten). Re-derive the flag from the final
  // ordering: a pair is moved iff its old index breaks the monotone run.
  reclassifyMoves(pairs);

  const deleted: number[] = [];
  for (let i = 0; i < a.length; i++) if (!oldTaken[i]) deleted.push(i);
  const inserted: number[] = [];
  for (let j = 0; j < b.length; j++) if (!newTaken[j]) inserted.push(j);

  return { pairs, deleted, inserted };
}

/**
 * Decide which pairs are "moved" by finding the longest monotone (in old-index) subsequence
 * of pairs when read in new-document order. Pairs on that subsequence stayed put; everything
 * else moved. This is the same idea as a minimal set of transpositions, and it means a
 * paragraph moved from the top to the bottom is reported as one move rather than as
 * "everything else moved up".
 */
function reclassifyMoves(pairs: AlignedPair[]): void {
  if (pairs.length === 0) return;
  const seq = pairs.map((p, i) => ({ o: p.old[0]!, n: i }));
  const keep = new Set(lis(seq.slice().sort((x, y) => x.n - y.n)).map((p) => p.n));
  for (let i = 0; i < pairs.length; i++) pairs[i]!.moved = !keep.has(i);
}

function nearestNewPosition(pairs: AlignedPair[], oldIndex: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (const p of pairs) {
    const d = Math.abs(p.old[0]! - oldIndex);
    if (d < bestDist) {
      bestDist = d;
      best = p.new[0]! + (p.old[0]! < oldIndex ? 1 : 0);
    }
  }
  return best;
}

function nearestOldPosition(pairs: AlignedPair[], newIndex: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (const p of pairs) {
    const d = Math.abs(p.new[0]! - newIndex);
    if (d < bestDist) {
      bestDist = d;
      best = p.old[0]! + (p.new[0]! < newIndex ? 1 : 0);
    }
  }
  return best;
}

/** Free positions to try as the start of a split/merge run, nearest to `anchor` first. */
function candidateStarts(taken: Uint8Array, anchor: number, length: number): number[] {
  const out: number[] = [];
  for (let d = 0; d <= 3; d++) {
    for (const p of d === 0 ? [anchor] : [anchor - d, anchor + d]) {
      if (p >= 0 && p < length && !taken[p]) out.push(p);
    }
  }
  return out;
}
