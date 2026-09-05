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
 *
 * IT MUST AGREE WITH `Node.textBetween` EXACTLY, because that is what produced the text the
 * offsets were computed against. It did not, and the bug was invisible: the walk emitted a
 * separator for every BLOCK, while `textBetween` emits one only before a TEXTBLOCK. A
 * blockquote wrapping a paragraph is two blocks and one textblock; a bullet list with four
 * items is nine blocks and four textblocks. So in any document containing a list — which is
 * most documents — the map drifted by one position per extra wrapper, and every diagnostic,
 * every AI hunk and every extra cursor after the first list landed on the wrong word. Nothing
 * threw. `test/prose-text.test.ts` and `test/offset.test.ts` now check the agreement
 * character by character against real documents.
 *
 * The `leafText` and `blockSeparator` options exist for the same reason: a caller that passes
 * them to `textBetween` must pass the same ones here, or the two disagree again.
 */

export interface OffsetMapOptions {
  /** Must match the `blockSeparator` passed to `textBetween`. Default "\n". */
  blockSeparator?: string;
  /** Must match the `leafText` passed to `textBetween`. Default: the node type's own. */
  leafText?: string;
}

export class OffsetMap {
  private readonly offsets: number[] = [];
  private readonly positions: number[] = [];

  constructor(doc: PMNode, from: number, to: number, opts: OffsetMapOptions = {}) {
    const separator = opts.blockSeparator ?? "\n";
    let offset = 0;
    let first = true;

    const push = (o: number, p: number) => { this.offsets.push(o); this.positions.push(p); };

    doc.nodesBetween(from, to, (node, pos) => {
      const nodeText = node.isText
        ? node.text!.slice(Math.max(from, pos) - pos, to - pos)
        : node.isLeaf
          ? leafTextFor(node, opts.leafText)
          : "";

      // The separator rule, copied from prosemirror-model's Fragment.textBetween: before
      // every textblock, and before a leaf block that contributes text, except the first.
      if (separator && node.isBlock && ((node.isLeaf && nodeText.length > 0) || node.isTextblock)) {
        if (first) first = false;
        else { push(offset, pos); offset += separator.length; }
      }

      if (node.isText) {
        if (nodeText.length > 0) { push(offset, Math.max(pos, from)); offset += nodeText.length; }
        return false;
      }
      if (nodeText.length > 0) { push(offset, pos); offset += nodeText.length; }
      return true;
    });

    push(offset, to);
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

/** What `textBetween` contributes for a leaf node, given the caller's `leafText`. */
function leafTextFor(node: PMNode, leafText: string | undefined): string {
  if (leafText !== undefined) return leafText;
  const spec = (node.type.spec as { leafText?: (n: PMNode) => string }).leafText;
  return spec ? spec(node) : "";
}
