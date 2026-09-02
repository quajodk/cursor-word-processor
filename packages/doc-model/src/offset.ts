import type { Node as PMNode } from "prosemirror-model";

/**
 * Maps offsets in the flattened text of a range back to document positions.
 *
 * Lives here rather than in a feature package because every feature that receives offsets
 * from outside the editor needs it: an AI rewrite arrives as text offsets, and so does a
 * diagnostic from a language server. Two copies of this would drift.
 *
 * Built once per suggestion rather than per hunk: the walk is O(range), and doing it inside
 * the hunk loop would make a fifty-hunk rewrite quadratic.
 */
export class OffsetMap {
  private readonly offsets: number[] = [];
  private readonly positions: number[] = [];

  constructor(doc: PMNode, from: number, to: number) {
    let offset = 0;
    doc.nodesBetween(from, to, (node, pos) => {
      if (node.isText) {
        const start = Math.max(pos, from);
        const end = Math.min(pos + node.nodeSize, to);
        if (end > start) {
          this.offsets.push(offset);
          this.positions.push(start);
          offset += end - start;
        }
        return false;
      }
      // A block boundary contributes the "\n" that `textBetween` inserts between blocks.
      if (node.isBlock && pos > from && pos < to) {
        this.offsets.push(offset);
        this.positions.push(pos);
        offset += 1;
      }
      return true;
    });
    this.offsets.push(offset);
    this.positions.push(to);
  }

  /** Document position for a text offset. */
  pos(offset: number): number {
    let lo = 0, hi = this.offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    const base = this.offsets[lo]!;
    const pos = this.positions[lo]!;
    const next = this.positions[lo + 1];
    const candidate = pos + (offset - base);
    return next === undefined ? candidate : Math.min(candidate, next);
  }
}

