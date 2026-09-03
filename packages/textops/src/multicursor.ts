import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { OffsetMap } from "@scriv/doc-model";

/**
 * Multiple cursors.
 *
 * ProseMirror has no multiple-selection model: `state.selection` is one range, and every
 * command, every input rule and every mark operation assumes that. There are two ways to add
 * multi-cursor to it, and the choice matters more than the code.
 *
 * A custom `Selection` subclass holding N ranges is the "proper" answer, and it breaks
 * everything downstream — `prosemirror-view` draws one native selection, `baseKeymap` reads
 * `$from`/`$to`, the input rules and the schema's mark logic all take the primary range. Every
 * one of those becomes a special case.
 *
 * So: the PRIMARY cursor stays a real `TextSelection` and nothing downstream changes. The
 * SECONDARY cursors live in plugin state as positions, drawn as decorations, and mapped
 * through every transaction. A multi-cursor command runs the underlying edit once per range,
 * back to front so earlier positions stay valid.
 *
 * The honest limits of that trade, because they are real:
 *   - Typing is not automatically multiplexed. Only commands wrapped in `forEachCursor` apply
 *     everywhere; a raw keypress edits the primary cursor. Wrapping text input means
 *     intercepting `handleTextInput`, which is done here, but IME composition is NOT — a
 *     composed character lands only at the primary cursor.
 *   - Undo groups all ranges into one step, which is what you want, but redo of a partially
 *     failed multi-edit is all-or-nothing.
 *   - Secondary cursors do not extend to selections beyond what `addNextOccurrence` creates.
 */

export const multiCursorKey = new PluginKey<MultiCursorState>("scriv-multicursor");

export interface CursorRange {
  from: number;
  to: number;
}

export interface MultiCursorState {
  /** Secondary ranges only. The primary is `state.selection`. */
  ranges: CursorRange[];
}

const EMPTY: MultiCursorState = { ranges: [] };

interface Meta {
  kind: "set" | "clear";
  ranges?: CursorRange[];
}

/** Every range, primary first, in document order. */
export function allRanges(state: EditorState): CursorRange[] {
  const secondary = multiCursorKey.getState(state)?.ranges ?? [];
  const sel = state.selection;
  const all = [{ from: sel.from, to: sel.to }, ...secondary];
  return all.sort((a, b) => a.from - b.from);
}

export function cursorCount(state: EditorState): number {
  return 1 + (multiCursorKey.getState(state)?.ranges.length ?? 0);
}

export function multiCursorPlugin(): Plugin<MultiCursorState> {
  return new Plugin<MultiCursorState>({
    key: multiCursorKey,
    state: {
      init: () => EMPTY,
      apply(tr, value) {
        const meta = tr.getMeta(multiCursorKey) as Meta | undefined;
        if (meta?.kind === "clear") return EMPTY;
        if (meta?.kind === "set") return { ranges: meta.ranges ?? [] };
        if (value.ranges.length === 0) return value;

        if (tr.docChanged) {
          const mapped = value.ranges
            .map((r) => ({ from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) }))
            .filter((r) => r.to >= r.from);
          return { ranges: dedupe(mapped) };
        }
        // A plain click collapses back to one cursor: it is how every editor with this
        // feature behaves, and without it stale cursors accumulate invisibly.
        if (tr.selectionSet && !tr.getMeta("scriv-multicursor-keep")) return EMPTY;
        return value;
      },
    },
    props: {
      decorations(state) {
        const ranges = multiCursorKey.getState(state)?.ranges ?? [];
        if (ranges.length === 0) return DecorationSet.empty;
        const decos = ranges.map((r) =>
          r.from === r.to
            ? Decoration.widget(r.from, caret, { side: -1, key: `c${r.from}` })
            : Decoration.inline(r.from, r.to, { class: "scriv-cursor-range" }),
        );
        return DecorationSet.create(state.doc, decos);
      },
      handleTextInput(view, from, to, text) {
        const ranges = multiCursorKey.getState(view.state)?.ranges ?? [];
        if (ranges.length === 0) return false;
        // Type at every cursor at once. Back to front so earlier positions stay valid.
        const all = [...ranges, { from, to }].sort((a, b) => b.from - a.from);
        const tr = view.state.tr;
        for (const r of all) tr.insertText(text, r.from, r.to);
        const next = all
          .slice()
          .sort((a, b) => a.from - b.from)
          .map((r) => ({ from: tr.mapping.map(r.from, 1) + 0, to: tr.mapping.map(r.from, 1) }));
        // The primary keeps its identity as the range the user was typing in.
        const primary = next.find((r) => r.from >= from) ?? next[next.length - 1]!;
        tr.setSelection(TextSelection.create(tr.doc, primary.from));
        tr.setMeta(multiCursorKey, { kind: "set", ranges: next.filter((r) => r !== primary) });
        tr.setMeta("scriv-multicursor-keep", true);
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}

function caret(): HTMLElement {
  const el = document.createElement("span");
  el.className = "scriv-cursor";
  el.setAttribute("aria-hidden", "true");
  return el;
}

function dedupe(ranges: CursorRange[]): CursorRange[] {
  const seen = new Set<string>();
  const out: CursorRange[] = [];
  for (const r of ranges) {
    const key = `${r.from}:${r.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Text of a range, for occurrence matching. */
function textOf(state: EditorState, r: CursorRange): string {
  return state.doc.textBetween(r.from, r.to, "\n");
}

/**
 * Add the next occurrence of the selection as another cursor. The Cmd-D everyone knows.
 *
 * With an empty selection it selects the word first, which is what every editor with this
 * feature does and what the hand expects.
 */
export const addNextOccurrence: Command = (state, dispatch, view) => {
  const sel = state.selection;
  const existing = multiCursorKey.getState(state)?.ranges ?? [];

  if (sel.empty) {
    // Select the word under the caret; the next press starts adding occurrences.
    const $pos = state.doc.resolve(sel.from);
    const text = $pos.parent.textBetween(0, $pos.parent.content.size, "\n", " ");
    const offset = sel.from - $pos.start();
    let a = offset, b = offset;
    while (a > 0 && /[\p{L}\p{N}_-]/u.test(text[a - 1] ?? "")) a--;
    while (b < text.length && /[\p{L}\p{N}_-]/u.test(text[b] ?? "")) b++;
    if (b <= a) return false;
    if (dispatch) {
      dispatch(state.tr.setSelection(TextSelection.create(state.doc, $pos.start() + a, $pos.start() + b)));
    }
    return true;
  }

  const needle = textOf(state, { from: sel.from, to: sel.to });
  if (needle.trim().length === 0) return false;

  const taken = new Set(allRanges(state).map((r) => `${r.from}:${r.to}`));
  const next = findOccurrence(state, needle, Math.max(sel.to, ...existing.map((r) => r.to)), taken)
    ?? findOccurrence(state, needle, 0, taken);
  if (!next) return false;

  if (dispatch) {
    const tr = state.tr.setMeta(multiCursorKey, { kind: "set", ranges: [...existing, next] });
    tr.setMeta("scriv-multicursor-keep", true);
    dispatch(tr);
    view?.dispatch(view.state.tr.scrollIntoView());
  }
  return true;
};

/** Select every occurrence of the current selection at once. */
export const selectAllOccurrences: Command = (state, dispatch) => {
  const sel = state.selection;
  if (sel.empty) return false;
  const needle = textOf(state, { from: sel.from, to: sel.to });
  if (needle.trim().length === 0) return false;

  const found: CursorRange[] = [];
  let cursor = 0;
  for (;;) {
    const hit = findOccurrence(state, needle, cursor, new Set());
    if (!hit || found.length > 500) break;
    found.push(hit);
    cursor = hit.to;
  }
  const secondary = found.filter((r) => !(r.from === sel.from && r.to === sel.to));
  if (secondary.length === 0) return false;

  if (dispatch) {
    const tr = state.tr.setMeta(multiCursorKey, { kind: "set", ranges: secondary });
    tr.setMeta("scriv-multicursor-keep", true);
    dispatch(tr);
  }
  return true;
};

/** Add a cursor on the line above or below the last one. */
export function addCursorVertical(dir: 1 | -1): Command {
  return (state, dispatch, view) => {
    if (!view) return false;
    const existing = multiCursorKey.getState(state)?.ranges ?? [];
    const anchor = existing.length > 0
      ? existing.reduce((a, b) => (dir === 1 ? (b.from > a.from ? b : a) : (b.from < a.from ? b : a)))
      : { from: state.selection.from, to: state.selection.to };

    const coords = view.coordsAtPos(anchor.from);
    // Step by a line box rather than a fixed number: the document has mixed type sizes, and
    // a constant would drift out of a heading into the wrong paragraph.
    const lineHeight = Math.max(12, coords.bottom - coords.top);
    const target = view.posAtCoords({ left: coords.left, top: coords.top + dir * lineHeight * 1.2 });
    if (!target) return false;
    const pos = target.pos;
    if (allRanges(state).some((r) => r.from === pos)) return false;

    if (dispatch) {
      const tr = state.tr.setMeta(multiCursorKey, { kind: "set", ranges: [...existing, { from: pos, to: pos }] });
      tr.setMeta("scriv-multicursor-keep", true);
      dispatch(tr);
    }
    return true;
  };
}

export const clearCursors: Command = (state, dispatch) => {
  if ((multiCursorKey.getState(state)?.ranges.length ?? 0) === 0) return false;
  if (dispatch) dispatch(state.tr.setMeta(multiCursorKey, { kind: "clear" }));
  return true;
};

function findOccurrence(state: EditorState, needle: string, after: number, taken: Set<string>): CursorRange | null {
  const text = state.doc.textBetween(0, state.doc.content.size, "\n", " ");
  const map = new OffsetMap(state.doc, 0, state.doc.content.size);
  let idx = text.indexOf(needle, offsetForPos(state, after));
  while (idx >= 0) {
    const from = map.pos(idx);
    const to = map.pos(idx + needle.length);
    if (!taken.has(`${from}:${to}`)) return { from, to };
    idx = text.indexOf(needle, idx + 1);
  }
  return null;
}

/**
 * Flat-text offset for a document position.
 *
 * The inverse uses `OffsetMap` from the document model rather than a binary search over
 * `textBetween`. A search returns the smallest position whose prefix is long enough, and that
 * position can sit BEFORE a paragraph rather than at its first character — so an occurrence at
 * the very start of a block resolved one short of the primary selection, failed to match it,
 * and got added as a duplicate cursor. Every "select all occurrences" was off by one.
 */
function offsetForPos(state: EditorState, pos: number): number {
  return state.doc.textBetween(0, Math.min(pos, state.doc.content.size), "\n", " ").length;
}

/**
 * Run a command at every cursor.
 *
 * Back to front, so a command that changes document length does not invalidate the positions
 * of the cursors that have not run yet. This is the wrapper that turns a single-range command
 * into a multi-cursor one; anything not wrapped in it affects the primary cursor only, which
 * is a limit worth knowing rather than discovering.
 */
export function forEachCursor(command: Command): Command {
  return (state, dispatch, view) => {
    const ranges = allRanges(state);
    if (ranges.length <= 1) return command(state, dispatch, view);
    if (!dispatch) return command(state, undefined, view);

    let working = state;
    const collected: Transaction[] = [];
    for (const r of [...ranges].sort((a, b) => b.from - a.from)) {
      const at = working.apply(working.tr.setSelection(TextSelection.create(working.doc, r.from, r.to)));
      let produced: Transaction | null = null;
      command(at, (tr) => { produced = tr; }, view);
      if (!produced) continue;
      collected.push(produced);
      working = at.apply(produced);
    }
    if (collected.length === 0) return false;

    // Replay onto the original state as one transaction so undo sees a single step.
    const tr = state.tr;
    for (const c of collected) for (const step of c.steps) tr.step(step.map(tr.mapping) ?? step);
    tr.setMeta("scriv-multicursor-keep", true);
    dispatch(tr.scrollIntoView());
    return true;
  };
}
