import { TextSelection, type Command, type EditorState } from "prosemirror-state";
import { blockAt, blockAtPos, offsetOf, posOf, siblingBlock, type BlockText } from "./text";
import { sentences } from "./segment";

/**
 * Sentence and paragraph motions.
 *
 * Every motion has a moving form and an extending form, and they are the same computation —
 * only the anchor differs. Writing them as one function parameterised by `extend` keeps the
 * pair from drifting apart, which is the usual way motion bugs arrive.
 */

function applyTo(state: EditorState, dispatch: ((tr: import("prosemirror-state").Transaction) => void) | undefined, head: number, extend: boolean): boolean {
  if (!dispatch) return true;
  const anchor = extend ? state.selection.anchor : head;
  dispatch(state.tr.setSelection(TextSelection.create(state.doc, anchor, head)).scrollIntoView());
  return true;
}

/** Sentence boundaries in a block, as document positions, ascending. */
function boundaries(block: BlockText): number[] {
  const out: number[] = [];
  for (const s of sentences(block.text)) {
    out.push(posOf(block, s.start));
    out.push(posOf(block, s.end));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export function moveSentence(dir: 1 | -1, extend = false): Command {
  return (state, dispatch) => {
    const head = state.selection.head;
    let block = blockAt(state.doc.resolve(head));
    if (!block) return false;

    const bs = boundaries(block);
    const target = dir === 1 ? bs.find((p) => p > head) : [...bs].reverse().find((p) => p < head);
    if (target !== undefined) return applyTo(state, dispatch, target, extend);

    // Past the end (or start) of this block: continue into the neighbour, so holding the
    // motion walks the document rather than stalling at a paragraph edge.
    const next = siblingBlock(state.doc, block, dir);
    if (!next) return false;
    const nb = boundaries(next);
    const fallback = dir === 1 ? (nb[0] ?? next.start) : (nb[nb.length - 1] ?? next.end);
    return applyTo(state, dispatch, fallback, extend);
  };
}

export function moveParagraph(dir: 1 | -1, extend = false): Command {
  return (state, dispatch) => {
    const head = state.selection.head;
    const block = blockAt(state.doc.resolve(head));
    if (!block) return false;
    // Within the block and not already at its edge, go to the edge first.
    if (dir === 1 && head < block.end) return applyTo(state, dispatch, block.end, extend);
    if (dir === -1 && head > block.start) return applyTo(state, dispatch, block.start, extend);
    const next = siblingBlock(state.doc, block, dir);
    if (!next) return false;
    return applyTo(state, dispatch, dir === 1 ? next.end : next.start, extend);
  };
}

export function toSentenceEdge(edge: "start" | "end", extend = false): Command {
  return (state, dispatch) => {
    const head = state.selection.head;
    const block = blockAt(state.doc.resolve(head));
    if (!block) return false;
    const off = offsetOf(block, head);
    for (const s of sentences(block.text)) {
      if (off >= s.start && off <= s.end) {
        return applyTo(state, dispatch, posOf(block, edge === "start" ? s.start : s.end), extend);
      }
    }
    return false;
  };
}

/**
 * Smart home: first non-whitespace, then the true start. A second press returns to column
 * zero, which is what every editor that has this does and what the hand expects.
 */
export function smartHome(extend = false): Command {
  return (state, dispatch) => {
    const head = state.selection.head;
    const block = blockAt(state.doc.resolve(head));
    if (!block) return false;
    const firstNonSpace = block.text.search(/\S/);
    const indented = block.start + (firstNonSpace < 0 ? 0 : firstNonSpace);
    const target = head === indented ? block.start : indented;
    return applyTo(state, dispatch, target, extend);
  };
}

/** The block under a position, for callers outside this module. */
export { blockAtPos };
