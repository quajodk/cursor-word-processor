import { aidPlugin, schema } from "@scriv/doc-model";
import { baseKeymap, chainCommands, createParagraphNear, exitCode, liftEmptyBlock, newlineInCode, splitBlock } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import { undoInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { Node as PMNode } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { EditorState, Plugin, type Command } from "prosemirror-state";
import { columnResizing, goToNextCell, tableEditing } from "prosemirror-tables";
import { Decoration, DecorationSet } from "prosemirror-view";
import { scrivInputRules } from "./inputrules";

/**
 * The plugin stack.
 *
 * Only *text-editing primitives* are bound here — Enter, Tab, Backspace, undo. Everything a
 * writer would call a feature (bold, headings, save, open) is a command in the registry, bound
 * once, and therefore visible in the palette by construction. Two keymaps would mean two places
 * a binding can hide.
 */

const listItem = schema.nodes.list_item!;
const hardBreak = schema.nodes.hard_break!;

const insertHardBreak: Command = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView());
  return true;
};

export function editorPlugins(): Plugin[] {
  return [
    // Identity first: it appends transactions, and it must see the user's transaction before
    // anything else rewrites positions.
    aidPlugin(),

    scrivInputRules(),
    history(),

    keymap({
      "Mod-z": undo,
      "Mod-y": redo,
      "Mod-Shift-z": redo,

      Enter: chainCommands(newlineInCode, splitListItem(listItem), createParagraphNear, liftEmptyBlock, splitBlock),
      "Shift-Enter": chainCommands(exitCode, insertHardBreak),
      "Mod-Enter": exitCode,

      Tab: chainCommands(goToNextCell(1), sinkListItem(listItem)),
      "Shift-Tab": chainCommands(goToNextCell(-1), liftListItem(listItem)),

      // One Backspace undoes an input rule that has just fired; the second deletes, via
      // baseKeymap. Without this, typing `1. ` and changing your mind traps you in a list.
      Backspace: undoInputRule,
    }),
    keymap(baseKeymap),

    // Tables: resizing must be installed before tableEditing.
    columnResizing({ cellMinWidth: 48 }),
    tableEditing({ allowTableNodeSelection: true }),

    gapCursor(),
    dropCursor({ color: "var(--accent)", width: 2 }),
    placeholderPlugin("Start writing. ⌘⇧P for every command."),
  ];
}

/**
 * The empty-document prompt as a decoration rather than a node: it never enters the document,
 * never reaches the codec, and never has to be deleted before the first character is typed.
 */
function placeholderPlugin(text: string): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const doc = state.doc;
        const empty = doc.childCount === 1 && doc.firstChild?.type.name === "paragraph" && doc.firstChild.content.size === 0;
        if (!empty) return null;
        return DecorationSet.create(doc, [
          Decoration.node(0, doc.firstChild!.nodeSize, { class: "is-empty", "data-placeholder": text }),
        ]);
      },
    },
  });
}

export function createEditorState(doc: PMNode): EditorState {
  return EditorState.create({ doc, plugins: editorPlugins() });
}

export function emptyDoc(): PMNode {
  return schema.nodes.doc!.create(null, [schema.nodes.paragraph!.create()]);
}
