import { AllSelection, Plugin, PluginKey, TextSelection, type Command, type EditorState, type Selection } from "prosemirror-state";
import { blockAt, offsetOf, posOf } from "./text";
import { sentences, words } from "./segment";

/**
 * Expand and shrink selection.
 *
 * Expansion walks a ladder — word, sentence, paragraph, section, document — and shrinking
 * walks back down it. Shrinking is not the inverse computed from scratch: it replays a
 * recorded stack, because the inverse is genuinely ambiguous. From a selected paragraph
 * there is no way to know WHICH sentence you expanded from, and guessing "the one under the
 * caret" is wrong exactly when the writer expanded from the last word of the first sentence.
 */

export const expandKey = new PluginKey<ExpandState>("scriv-expand");

interface Ring { from: number; to: number; all?: boolean }
export interface ExpandState {
  /** Ranges passed through on the way up, innermost first. */
  stack: Ring[];
}

export function expandPlugin(): Plugin<ExpandState> {
  return new Plugin<ExpandState>({
    key: expandKey,
    state: {
      init: () => ({ stack: [] }),
      apply(tr, value, _old, newState) {
        const meta = tr.getMeta(expandKey) as ExpandState | undefined;
        if (meta) return meta;
        if (!tr.docChanged && !tr.selectionSet) return value;
        // Any selection the user made themselves invalidates the ladder: the stack only
        // describes the path taken by expand, and a click is a new starting point.
        if (tr.selectionSet && value.stack.length > 0) {
          const top = value.stack[value.stack.length - 1];
          const sel = newState.selection;
          if (!top || top.from !== sel.from || top.to !== sel.to) return { stack: [] };
        }
        return value;
      },
    },
  });
}

/** The section a position belongs to: from the nearest preceding heading to the next one. */
function sectionRange(state: EditorState, pos: number): Ring | null {
  const doc = state.doc;
  let start = 0, end = doc.content.size, seenStart = false;
  let last = 0;
  doc.forEach((node, offset) => {
    const nodeEnd = offset + node.nodeSize;
    if (node.type.name === "heading") {
      if (offset <= pos) { start = offset; seenStart = true; }
      else if (seenStart && offset > pos) { end = Math.min(end, offset); }
      else if (!seenStart && offset > pos) { end = Math.min(end, offset); }
    }
    last = nodeEnd;
  });
  if (end > last) end = last;
  if (start >= end) return null;
  // Convert node offsets to positions INSIDE inline content. A block offset sits between
  // nodes, and a TextSelection endpoint there is invalid — ProseMirror warns and clamps.
  const from = start + 1;
  const to = Math.max(from, end - 1);
  return from < to ? { from, to } : null;
}

/**
 * The next range up the ladder, or null at the top.
 *
 * Every candidate must STRICTLY CONTAIN the current selection. Without that guard the ladder
 * oscillates: once a selection spans two paragraphs, `blockAt` still resolves to the first
 * one, and offering that block as the next rung walks the selection back down instead of up.
 */
function grows(candidate: Ring, sel: { from: number; to: number }): boolean {
  return candidate.from <= sel.from && candidate.to >= sel.to &&
    (candidate.from < sel.from || candidate.to > sel.to);
}

function nextRange(state: EditorState): Ring | null {
  const sel = state.selection;
  const block = blockAt(sel.$from);

  if (block) {
    const text = block.text;
    const a = offsetOf(block, sel.from);
    const b = offsetOf(block, sel.to);

    // word
    if (sel.empty || (b - a) < 1) {
      for (const w of words(text)) {
        if (a < w.start || a > w.end) continue;
        const r = { from: posOf(block, w.start), to: posOf(block, w.end) };
        if (grows(r, sel)) return r;
      }
    }
    // sentence
    for (const s of sentences(text)) {
      const r = { from: posOf(block, s.start), to: posOf(block, s.end) };
      if (grows(r, sel)) return r;
    }
    // paragraph
    const para = { from: block.start, to: block.end };
    if (grows(para, sel)) return para;
  }

  // section
  const section = sectionRange(state, sel.from);
  if (section && grows(section, sel)) return section;

  // document — position 0 sits before the first block rather than inside inline content, so
  // the top of the ladder is an AllSelection, not a TextSelection over [0, size].
  const all = new AllSelection(state.doc);
  const r = { from: all.from, to: all.to, all: true };
  if (grows(r, sel)) return r;
  return null;
}

export const expandSelection: Command = (state, dispatch) => {
  const next = nextRange(state);
  if (!next) return false;
  if (dispatch) {
    const sel = state.selection;
    const prev = expandKey.getState(state)?.stack ?? [];
    const selection: Selection = next.all
      ? new AllSelection(state.doc)
      : TextSelection.create(state.doc, next.from, next.to);
    const tr = state.tr.setSelection(selection);
    tr.setMeta(expandKey, { stack: [...prev, { from: sel.from, to: sel.to }] });
    dispatch(tr.scrollIntoView());
  }
  return true;
};

export const shrinkSelection: Command = (state, dispatch) => {
  const stack = expandKey.getState(state)?.stack ?? [];
  const top = stack[stack.length - 1];
  if (!top) return false;
  if (dispatch) {
    const tr = state.tr.setSelection(TextSelection.create(state.doc, top.from, top.to));
    tr.setMeta(expandKey, { stack: stack.slice(0, -1) });
    dispatch(tr.scrollIntoView());
  }
  return true;
};
