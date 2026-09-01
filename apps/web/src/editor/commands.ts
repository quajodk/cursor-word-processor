import { schema } from "@scriv/doc-model";
import { lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import type { MarkType, NodeType } from "prosemirror-model";
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import { TextSelection, type Command, type EditorState } from "prosemirror-state";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
  mergeCells,
  splitCell,
  toggleHeaderRow,
} from "prosemirror-tables";
import type { EditorView } from "prosemirror-view";

/**
 * Editor commands, expressed as ProseMirror `Command`s so they compose and so they report
 * whether they applied. The registry wraps each of them; nothing here knows about the palette.
 */

const N = schema.nodes;
const M = schema.marks;

export function run(view: EditorView | null, command: Command): boolean {
  if (!view) return false;
  const applied = command(view.state, view.dispatch, view);
  view.focus();
  return applied;
}

export function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  return empty ? !!type.isInSet(state.storedMarks || $from.marks()) : state.doc.rangeHasMark(from, to, type);
}

export const toggle = {
  strong: toggleMark(M.strong!),
  em: toggleMark(M.em!),
  underline: toggleMark(M.underline!),
  strike: toggleMark(M.strike!),
  code: toggleMark(M.code!),
  superscript: toggleMark(M.superscript!),
  subscript: toggleMark(M.subscript!),
} as const;

export function setHeading(level: number): Command {
  return setBlockType(N.heading!, { level });
}

export const setParagraph: Command = setBlockType(N.paragraph!);
export const setCodeBlock: Command = setBlockType(N.code_block!);

/** Wrap in a blockquote, or lift out of one if we are already inside. */
export const toggleBlockquote: Command = (state, dispatch, view) => {
  if (blockAncestor(state, N.blockquote!)) return lift(state, dispatch);
  return wrapIn(N.blockquote!)(state, dispatch, view);
};

export function toggleList(type: NodeType): Command {
  return (state, dispatch, view) => {
    if (blockAncestor(state, type)) return liftListItem(N.list_item!)(state, dispatch, view);
    return wrapInList(type)(state, dispatch, view);
  };
}

export const bulletList = toggleList(N.bullet_list!);
export const orderedList = toggleList(N.ordered_list!);

export const insertRule: Command = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(N.horizontal_rule!.create()).scrollIntoView());
  return true;
};

/** Strip every mark from the selection. The escape hatch after a bad paste. */
export const clearFormatting: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection;
  if (empty) return false;
  if (dispatch) {
    let tr = state.tr;
    for (const type of Object.values(schema.marks)) tr = tr.removeMark(from, to, type);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

export function setLink(href: string): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (empty) return false;
    if (dispatch) {
      const tr = state.tr.removeMark(from, to, M.link!);
      if (href) tr.addMark(from, to, M.link!.create({ href }));
      dispatch(tr);
    }
    return true;
  };
}

/**
 * A 3×3 table with a header row, and the caret placed in the first header cell so the next
 * thing typed lands somewhere sensible.
 */
export function insertTable(rows = 3, cols = 3): Command {
  return (state, dispatch) => {
    const emptyCell = (header: boolean) => (header ? N.table_header! : N.table_cell!).create(null, N.paragraph!.create());
    const body = [];
    for (let r = 0; r < rows; r++) {
      const cells = [];
      for (let c = 0; c < cols; c++) cells.push(emptyCell(r === 0));
      body.push(N.table_row!.create(null, cells));
    }
    const table = N.table!.create(null, body);
    if (dispatch) {
      const tr = state.tr.replaceSelectionWith(table);
      const pos = tr.selection.from - table.nodeSize + 3;
      dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(1, pos)))).scrollIntoView());
    }
    return true;
  };
}

export const table = {
  addRowBefore,
  addRowAfter,
  addColumnBefore,
  addColumnAfter,
  deleteRow,
  deleteColumn,
  deleteTable,
  mergeCells,
  splitCell,
  toggleHeaderRow,
  isInTable,
};

function blockAncestor(state: EditorState, type: NodeType): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type === type) return true;
  }
  return false;
}
