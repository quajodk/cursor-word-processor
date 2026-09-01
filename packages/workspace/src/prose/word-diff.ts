/**
 * Word-level diff inside a single sentence pair.
 *
 * A sentence-granular diff that only said "this sentence changed" would be a smaller
 * version of the same problem line diffs have. Once two sentences are aligned we run a
 * proper Myers O(ND) diff over their word tokens so the reader sees exactly which words
 * moved, with character ranges into both sides for highlighting.
 */

import { tokenize, type Token } from "./tokens";

export type WordRunKind = "equal" | "insert" | "delete";

export interface WordRun {
  kind: WordRunKind;
  /** Text of the run, taken from the side it exists on. */
  text: string;
  /** Character range within the old sentence, for `equal` and `delete`. */
  oldRange?: [number, number];
  /** Character range within the new sentence, for `equal` and `insert`. */
  newRange?: [number, number];
}

export interface WordDiff {
  runs: WordRun[];
  /** Fraction of word-like tokens that survived unchanged, 0..1. */
  similarity: number;
  /** Number of word-like tokens added and removed. */
  added: number;
  removed: number;
}

/** Comparison key: word tokens fold case, everything else compares exactly. */
function key(t: Token): string {
  return t.wordLike ? t.text.toLowerCase() : t.text.replace(/\s+/gu, " ");
}

/**
 * Myers' O(ND) diff, greedy forward pass with a recorded trace so we can backtrack the
 * actual edit script. `a` and `b` are comparison keys.
 */
function myers(a: string[], b: string[]): { kind: WordRunKind; ai: number; bi: number }[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const size = 2 * max + 1;
  const v = new Int32Array(size);
  const trace: Int32Array[] = [];

  let d = 0;
  outer: for (; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)) x = v[k + 1 + offset]!;
      else x = v[k - 1 + offset]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  // Backtrack.
  const script: { kind: WordRunKind; ai: number; bi: number }[] = [];
  let x = n;
  let y = m;
  for (let dd = Math.min(d, trace.length - 1); dd >= 0; dd--) {
    const vv = trace[dd]!;
    const k = x - y;
    let prevK: number;
    if (k === -dd || (k !== dd && vv[k - 1 + offset]! < vv[k + 1 + offset]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[prevK + offset]!;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      script.push({ kind: "equal", ai: x - 1, bi: y - 1 });
      x--;
      y--;
    }
    if (dd === 0) break;
    if (x === prevX) {
      script.push({ kind: "insert", ai: -1, bi: y - 1 });
      y--;
    } else {
      script.push({ kind: "delete", ai: x - 1, bi: -1 });
      x--;
    }
  }
  script.reverse();
  return script;
}

/** Diff two sentences at word granularity. Offsets are relative to each sentence's text. */
export function diffWords(oldText: string, newText: string, locale = "en"): WordDiff {
  const ta = tokenize(oldText, locale);
  const tb = tokenize(newText, locale);
  const script = myers(ta.map(key), tb.map(key));

  const runs: WordRun[] = [];
  let added = 0;
  let removed = 0;

  for (const step of script) {
    const last = runs[runs.length - 1];
    if (step.kind === "equal") {
      const at = ta[step.ai]!;
      const bt = tb[step.bi]!;
      if (last && last.kind === "equal" && last.oldRange![1] === at.start && last.newRange![1] === bt.start) {
        last.text += bt.text;
        last.oldRange![1] = at.end;
        last.newRange![1] = bt.end;
      } else {
        runs.push({ kind: "equal", text: bt.text, oldRange: [at.start, at.end], newRange: [bt.start, bt.end] });
      }
    } else if (step.kind === "delete") {
      const at = ta[step.ai]!;
      if (at.wordLike) removed++;
      if (last && last.kind === "delete" && last.oldRange![1] === at.start) {
        last.text += at.text;
        last.oldRange![1] = at.end;
      } else {
        runs.push({ kind: "delete", text: at.text, oldRange: [at.start, at.end] });
      }
    } else {
      const bt = tb[step.bi]!;
      if (bt.wordLike) added++;
      if (last && last.kind === "insert" && last.newRange![1] === bt.start) {
        last.text += bt.text;
        last.newRange![1] = bt.end;
      } else {
        runs.push({ kind: "insert", text: bt.text, newRange: [bt.start, bt.end] });
      }
    }
  }

  const totalWords = ta.filter((t) => t.wordLike).length + tb.filter((t) => t.wordLike).length;
  const changed = added + removed;
  const similarity = totalWords === 0 ? 1 : Math.max(0, 1 - changed / totalWords);
  return { runs, similarity, added, removed };
}
