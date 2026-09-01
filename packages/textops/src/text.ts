import type { Node as PMNode, ResolvedPos, MarkType } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";

/**
 * The one primitive everything else in this package is built on.
 *
 * Every smart text operation needs to reason about *characters* — words, sentences, brackets
 * — while ProseMirror speaks in *document positions*. `BlockText` bridges the two, and it does
 * so **scoped to a single textblock**, which is what keeps this package inside the 8 ms
 * keystroke budget on a 40 000-word document (§5). Nothing here ever walks the whole doc.
 *
 * The offset↔position mapping is exactly 1:1, deliberately:
 *   - a text node of length n occupies n positions and contributes n characters;
 *   - an inline *leaf* (only `hard_break` in our schema) occupies 1 position, and we make it
 *     contribute exactly 1 character.
 * So `pos = block.start + offset` with no arithmetic and no per-character allocation.
 */
export interface BlockText {
  /** The textblock node itself. Stable identity — safe as a `WeakMap` cache key. */
  readonly node: PMNode;
  /** Position of the node itself (`doc.resolve(start - 1).nodeAfter === node`). */
  readonly pos: number;
  /** Position of the first character of inline content. */
  readonly start: number;
  /** Position just past the last character. `end - start === text.length`. */
  readonly end: number;
  /** Flat inline text. `text[i]` lives at position `start + i`. */
  readonly text: string;
  /** Depth of the textblock in the resolved tree. */
  readonly depth: number;
}

/** Placeholder for an inline leaf that is not a line break. Exactly one UTF-16 unit. */
const LEAF = "￼";

function leafChar(leaf: PMNode): string {
  return leaf.type.name === "hard_break" ? "\n" : LEAF;
}

const textCache = new WeakMap<PMNode, string>();

/** Flat text of a textblock, cached on the (immutable) node. */
export function blockString(node: PMNode): string {
  let t = textCache.get(node);
  if (t === undefined) {
    t = node.textBetween(0, node.content.size, "\n", leafChar);
    textCache.set(node, t);
  }
  return t;
}

/**
 * The textblock containing `$pos`, or `null` if `$pos` is not inside one (e.g. a gap cursor
 * between two block nodes). O(depth), never O(doc).
 */
export function blockAt($pos: ResolvedPos): BlockText | null {
  for (let d = $pos.depth; d >= 0; d--) {
    const node = $pos.node(d);
    if (node.isTextblock) {
      const start = $pos.start(d);
      return { node, pos: start - 1, start, end: start + node.content.size, text: blockString(node), depth: d };
    }
  }
  return null;
}

/** The textblock at an absolute position. */
export function blockAtPos(doc: PMNode, pos: number): BlockText | null {
  return blockAt(doc.resolve(Math.max(0, Math.min(pos, doc.content.size))));
}

/** Character offset within the block for an absolute position. Clamped. */
export function offsetOf(block: BlockText, pos: number): number {
  return Math.max(0, Math.min(pos - block.start, block.text.length));
}

/** Absolute position for a character offset within the block. Clamped. */
export function posOf(block: BlockText, offset: number): number {
  return block.start + Math.max(0, Math.min(offset, block.text.length));
}

/**
 * The textblock before/after `block`, in document order, skipping non-textblock nodes.
 * Walks the resolved-position chain rather than the document, so cost is O(depth + gap),
 * not O(doc).
 */
export function siblingBlock(doc: PMNode, block: BlockText, dir: 1 | -1): BlockText | null {
  let pos = dir > 0 ? block.end + 1 : block.start - 1;
  const limit = dir > 0 ? doc.content.size : 0;
  // Step outward/inward until we land inside a textblock. Bounded by nesting depth plus the
  // number of intervening structural nodes (list wrappers, table cells) — small and local.
  for (let guard = 0; guard < 64; guard++) {
    if (dir > 0 ? pos > limit : pos < limit) return null;
    const b = blockAtPos(doc, pos);
    if (b && b.pos !== block.pos) return b;
    pos += dir;
  }
  return null;
}

/** True when marks may be applied at this position (false inside `code_block` / `code`). */
export function marksAllowed(state: EditorState, $pos: ResolvedPos, type: MarkType): boolean {
  const parent = $pos.parent;
  if (parent.type.spec.code) return false;
  if (!parent.type.allowsMarkType(type)) return false;
  return true;
}

/** True when the position sits inside literal/code context, where smart typography is wrong. */
export function isLiteralContext(state: EditorState, $pos: ResolvedPos): boolean {
  if ($pos.parent.type.spec.code) return true;
  const code = state.schema.marks.code;
  if (!code) return false;
  const stored = state.storedMarks;
  if (stored) return code.isInSet(stored) != null;
  return code.isInSet($pos.marks()) != null;
}

/** Grapheme-cluster boundaries. Falls back to code-point boundaries (see ./segment.ts). */
const graphemers = new Map<string, Intl.Segmenter>();
export function graphemeSegmenter(locale: string): Intl.Segmenter | null {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return null;
  let s = graphemers.get(locale);
  if (!s) {
    s = new Intl.Segmenter(locale, { granularity: "grapheme" });
    graphemers.set(locale, s);
  }
  return s;
}

/**
 * Offset of the grapheme boundary `dir` steps from `offset`.
 * Correct for combining marks ("e" + U+0301), emoji ZWJ sequences and surrogate pairs.
 */
export function graphemeStep(text: string, offset: number, dir: 1 | -1, locale = "en"): number {
  if (dir < 0 ? offset <= 0 : offset >= text.length) return offset;
  const seg = graphemeSegmenter(locale);
  if (!seg) {
    // Fallback: code points.
    if (dir > 0) return offset + (text.codePointAt(offset)! > 0xffff ? 2 : 1);
    const prev = text.codePointAt(offset - 2);
    return offset - (prev !== undefined && prev > 0xffff ? 2 : 1);
  }
  // Segment only the local neighbourhood: graphemes are bounded in practice, and a 64-unit
  // window is far more than any real cluster while keeping this O(1) rather than O(block).
  const winStart = Math.max(0, offset - 64);
  const winEnd = Math.min(text.length, offset + 64);
  const window = text.slice(winStart, winEnd);
  const bounds: number[] = [];
  for (const g of seg.segment(window)) bounds.push(winStart + g.index);
  bounds.push(winEnd);
  if (dir > 0) {
    for (const b of bounds) if (b > offset) return b;
    return text.length;
  }
  let prev = winStart;
  for (const b of bounds) {
    if (b >= offset) break;
    prev = b;
  }
  return prev;
}
