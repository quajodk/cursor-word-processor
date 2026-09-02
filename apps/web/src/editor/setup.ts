import { aidPlugin, schema } from "@scriv/doc-model";
import { expandPlugin, handleSurround, killRingPlugin, textopsKeymap } from "@scriv/textops";
import { completionPlugin } from "./completion";
import { inlineEditPlugin } from "./inline-edit";
import { applyFirstFix, diagnosticsPlugin } from "./diagnostics";
import type { WorkspaceSymbols } from "./workspace-symbols";
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

/**
 * Selection-aware surrounds, wired to `handleTextInput`.
 *
 * It must sit ahead of the input rules: both look at typed characters, and a surround is the
 * more specific interpretation. `handleTextInput` runs before ProseMirror's default
 * insertion, which is exactly the hook a surround needs — it replaces the insertion rather
 * than repairing it afterwards, so undo sees one step, not two.
 */
function surroundPlugin(locale: string): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        const tr = handleSurround(view.state, from, to, text, { locale });
        if (!tr) return false;
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}

export interface PluginOptions {
  locale?: string;
  /** Document language for the checker. Omitted in tests, where no worker exists. */
  language?: () => string;
  onDiagnostics?: (elapsedMs: number, count: number) => void;
  /** Supplies completions. Omitted in tests and benches, where the popup is not wanted. */
  symbols?: WorkspaceSymbols;
  currentPath?: () => string | null;
}

export function editorPlugins(opts: PluginOptions = {}): Plugin[] {
  const locale = opts.locale ?? (typeof navigator !== "undefined" ? navigator.language : "en");
  return [
    // Identity first: it appends transactions, and it must see the user's transaction before
    // anything else rewrites positions.
    aidPlugin(),

    surroundPlugin(locale),
    // Text ops before the base keymap so a sentence motion wins over the character motion
    // bound to the same arrow, and after history so undo still sees one step per edit.
    expandPlugin(),
    killRingPlugin(),
    // Before the text ops: while a suggestion is under review, Cmd-Enter and Escape belong
    // to the review, not to the document.
    inlineEditPlugin(),
    // Diagnostics only when a language is supplied: bun's test runner has no Worker, and a
    // plugin that constructs one unconditionally would make the doc-model tests need a DOM.
    ...(opts.language
      ? [diagnosticsPlugin({ language: opts.language, onTiming: opts.onDiagnostics })]
      : []),
    // Completion before the text-op keymap: while the popup is open, Up/Down/Enter belong to
    // the list, not to the document.
    ...(opts.symbols ? [completionPlugin(opts.symbols.index, opts.currentPath ?? (() => null))] : []),
    textopsKeymap(),
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
      // Quick-fix at the caret. Keyboard-first: a fix must never require the mouse.
      "Mod-.": (_s, _d, view) => (view ? applyFirstFix(view) : false),
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

export function createEditorState(doc: PMNode, opts: PluginOptions = {}): EditorState {
  return EditorState.create({ doc, plugins: editorPlugins(opts) });
}

export function emptyDoc(): PMNode {
  return schema.nodes.doc!.create(null, [schema.nodes.paragraph!.create()]);
}
