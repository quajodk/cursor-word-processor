import { schema } from "@scriv/doc-model";
import { redo, undo } from "prosemirror-history";
import type { Command as PMCommand } from "prosemirror-state";
import { getPrefs, setPrefs } from "../app/prefs";
import {
  bulletList,
  clearFormatting,
  insertRule,
  insertTable,
  orderedList,
  run,
  setCodeBlock,
  setHeading,
  setLink,
  setParagraph,
  table,
  toggle,
  toggleBlockquote,
} from "../editor/commands";
import type { EditorController } from "../editor/controller";
import { specimenDoc } from "../editor/specimen";
import { BINDINGS } from "@scriv/textops";
import { accept as acceptInlineEdit, inlineEditKey, reject as rejectInlineEdit } from "../editor/inline-edit";
import { applyFirstFix } from "../editor/diagnostics";
import { registerCommands, type Command, type CommandContext } from "./registry";

/**
 * Every user-facing action in the app, in one list.
 *
 * This file is the house rule made mechanical: a feature that is not here has no binding and
 * does not appear in the palette, so adding it here is not documentation of the feature — it is
 * the feature being reachable at all.
 *
 * Bindings follow the word-processor conventions rather than the code-editor ones where they
 * disagree. ⌘B is bold, not "toggle sidebar"; a writer's hands already know that.
 */

const withEditor = (ctx: CommandContext) => ctx.view !== null;
/** Editing commands only fire globally while the caret is actually in the document. */
const inEditor = (ctx: CommandContext) => ctx.view !== null && ctx.view.hasFocus();

function editorCommand(
  id: string,
  title: string,
  keybinding: string | string[] | undefined,
  command: PMCommand,
  category = "Format",
): Command {
  return {
    id,
    title,
    category,
    ...(keybinding ? { keybinding } : {}),
    when: inEditor,
    run: (ctx) => {
      run(ctx.view, command);
    },
  };
}

/**
 * Every text operation, taken from the binding table itself.
 *
 * `BINDINGS` is exported from @scriv/textops "as data so the command palette can render it",
 * and until now nothing imported it — so all thirty text operations had a key but no palette
 * entry. Two of them (paragraph motion on Ctrl-Up/Down) collide with Mission Control and App
 * Exposé on a stock Mac, which made them unreachable by any means at all. Deriving the
 * palette from the table means a new binding cannot be added without also becoming
 * discoverable, which is what "keyboard-first" has to mean beyond "has a shortcut".
 */
function textOpCommands(): Command[] {
  return BINDINGS.map((b) => ({
    id: b.id,
    title: b.label,
    category: categoryFor(b.id),
    keybinding: b.key,
    when: inEditor,
    run: (ctx: CommandContext) => { run(ctx.view, b.command); },
  }));
}

function categoryFor(id: string): string {
  const prefix = id.split(".")[0] ?? "";
  return { cursor: "Cursor", selection: "Selection", motion: "Motion", edit: "Edit" }[prefix] ?? "Edit";
}

export function registerDefaultCommands(controller: EditorController): () => void {
  return registerCommands([
    ...textOpCommands(),
    // ---------------------------------------------------------------- file
    {
      id: "file.quickOpen",
      whenTyping: true,
      title: "Open file…",
      category: "File",
      keybinding: "Mod-p",
      run: (ctx) => ctx.ui.openQuickOpen(),
    },
    {
      id: "file.save",
      whenTyping: true,
      title: "Save",
      category: "File",
      keybinding: "Mod-s",
      when: withEditor,
      run: (ctx) => ctx.ui.saveFile(),
    },
    {
      id: "file.saveAs",
      title: "Save as…",
      category: "File",
      keybinding: "Mod-Shift-s",
      when: withEditor,
      run: async (ctx) => {
        const suggestion = ctx.filePath ? ctx.filePath.slice(ctx.root.length + 1) : "untitled.md";
        const name = await ctx.ui.prompt("Save as, relative to the workspace root", suggestion);
        if (!name) return;
        const path = name.startsWith("/") ? name : `${ctx.root}/${name}`;
        await controller.saveAs(path);
        ctx.ui.notify(`Saved ${name}`);
        ctx.ui.revealInTree(path);
      },
    },
    {
      id: "file.new",
      title: "New file…",
      category: "File",
      keybinding: "Mod-n",
      run: (ctx) => ctx.ui.newFile(),
    },
    {
      id: "file.revert",
      title: "Revert to saved",
      category: "File",
      when: (ctx) => ctx.filePath !== null,
      run: (ctx) => ctx.ui.reloadFromDisk(),
    },
    {
      id: "file.rename",
      title: "Rename this file…",
      category: "File",
      when: (ctx) => ctx.filePath !== null,
      run: async (ctx) => {
        const current = ctx.filePath!.slice(ctx.root.length + 1);
        const next = await ctx.ui.prompt("Rename to", current);
        if (!next || next === current) return;
        const target = next.startsWith("/") ? next : `${ctx.root}/${next}`;
        await ctx.host.fs.rename(ctx.filePath!, target);
        await ctx.ui.openFile(target);
        ctx.ui.notify(`Renamed to ${next}`);
      },
    },
    {
      id: "file.reveal",
      title: "Reveal in file tree",
      category: "File",
      keybinding: "Mod-Shift-e",
      when: (ctx) => ctx.filePath !== null,
      run: (ctx) => ctx.ui.revealInTree(ctx.filePath!),
    },
    {
      id: "file.copyPath",
      title: "Copy path of this file",
      category: "File",
      when: (ctx) => ctx.filePath !== null,
      run: async (ctx) => {
        await navigator.clipboard.writeText(ctx.filePath!);
        ctx.ui.notify("Path copied");
      },
    },

    // ---------------------------------------------------------------- view
    {
      id: "view.commandPalette",
      whenTyping: true,
      title: "Show all commands",
      category: "View",
      keybinding: ["Mod-Shift-p", "F1"],
      run: (ctx) => ctx.ui.openPalette(),
    },
    {
      id: "view.toggleSidebar",
      whenTyping: true,
      title: "Toggle sidebar",
      category: "View",
      keybinding: "Mod-\\",
      run: (ctx) => ctx.ui.toggleSidebar(),
    },
    {
      id: "view.focusTree",
      title: "Focus file tree",
      category: "View",
      keybinding: "Mod-Shift-1",
      run: (ctx) => ctx.ui.focusTree(),
    },
    {
      id: "view.focusEditor",
      title: "Focus editor",
      category: "View",
      keybinding: "Mod-Shift-2",
      run: (ctx) => ctx.ui.focusEditor(),
    },
    {
      id: "view.search",
      title: "Search the workspace",
      category: "View",
      keybinding: "Mod-Shift-f",
      run: () => setPrefs({ sidebar: true, pane: "search" }),
    },
    {
      id: "view.cycleTheme",
      title: "Cycle theme (light / dark / system)",
      category: "View",
      // NOT Mod-Alt-d (the Dock) and NOT Mod-Alt-t: that is "Insert table", registered later
      // in this same file, and later registration wins. Cycling the theme was therefore dead
      // for the entire time the caret was in the document — which is every time you would
      // want it. Found by an audit reading the binding table, not by pressing the key: the
      // collision is invisible unless you look at both registrations at once.
      keybinding: "Mod-Alt-y",
      run: (ctx) => ctx.ui.cycleTheme(),
    },
    {
      id: "view.comments",
      title: "Show comments",
      category: "View",
      // NOT Mod-Shift-c: that is "Clear formatting", registered later in this same file, and
      // later registrations win — so this would have been a binding that silently did
      // something else. Mod-Alt-c is taken too.
      keybinding: "Mod-Shift-m",
      run: (ctx) => {
        setPrefs({ sidebar: true, pane: "comments" });
        ctx.ui.focusComments();
      },
    },
    {
      id: "agent.rename",
      title: "Agent: rename a term across the workspace",
      category: "AI",
      keybinding: "Mod-Shift-r",
      run: (ctx) => ctx.ui.toggleAgent(),
    },
    {
      // The fourth pillar was the only one outside the command system: ⌘⇧G was a hand-rolled
      // `window` keydown in App.tsx. That made it invisible in three ways at once — no palette
      // entry, so the whole diff-and-blame feature could not be found without already knowing
      // the chord; invisible to `apps/web/test/bindings.test.ts`, which reads this file, so a
      // collision with it could never be caught; and it ignored `whenTyping`, so it fired while
      // you were typing "G" into a field with ⌘⇧ held.
      id: "view.toggleDiff",
      title: "Changes: diff and blame against git",
      category: "View",
      keybinding: "Mod-Shift-g",
      run: (ctx) => ctx.ui.toggleDiff(),
    },
    {
      id: "view.fidelity",
      title: "Fidelity: what this document loses",
      category: "View",
      keybinding: "Mod-Alt-f",
      run: (ctx) => ctx.ui.toggleFidelity(),
    },
    {
      id: "view.diagnosticFloor",
      title: "Show style hints as well as errors",
      category: "View",
      keybinding: "Mod-Alt-i",
      run: (ctx) => {
        const showingAll = getPrefs().diagnosticFloor === "hint";
        setPrefs({ diagnosticFloor: showingAll ? "warning" : "hint" });
        ctx.ui.notify(
          showingAll
            ? "Style hints hidden. Spelling and grammar still marked."
            : "Style hints shown — readability, word choice, regionalisms.",
        );
        // The floor is read when a result is built, so the change lands on the next refresh.
        // Nudging the editor makes that refresh happen now rather than at the next keystroke.
        ctx.view?.dispatch(ctx.view.state.tr);
      },
    },
    {
      id: "view.paragraphStyle",
      title: "Toggle paragraph style (indented / spaced)",
      category: "View",
      keybinding: "Mod-Alt-p",
      run: (ctx) => {
        const next = getPrefs().paragraph === "book" ? "spaced" : "book";
        setPrefs({ paragraph: next });
        ctx.ui.notify(next === "book" ? "Paragraphs: indented" : "Paragraphs: spaced");
      },
    },
    {
      id: "view.justification",
      title: "Toggle justification",
      category: "View",
      keybinding: "Mod-Alt-j",
      run: (ctx) => {
        const next = getPrefs().alignment === "ragged" ? "justify" : "ragged";
        setPrefs({ alignment: next });
        ctx.ui.notify(next === "justify" ? "Justified, hyphenated" : "Ragged right");
      },
    },

    // ---------------------------------------------------------------- edit
    { ...editorCommand("edit.undo", "Undo", "Mod-z", undo, "Edit") },
    { ...editorCommand("edit.redo", "Redo", ["Mod-Shift-z", "Mod-y"], redo, "Edit") },

    // ---------------------------------------------------------------- marks
    editorCommand("format.bold", "Bold", "Mod-b", toggle.strong),
    editorCommand("format.italic", "Italic", "Mod-i", toggle.em),
    editorCommand("format.underline", "Underline", "Mod-u", toggle.underline),
    editorCommand("format.strike", "Strikethrough", "Mod-Shift-x", toggle.strike),
    editorCommand("format.code", "Inline code", "Mod-e", toggle.code),
    // Mod-. is the quick-fix binding everywhere a programmer has ever used one, and a writer
    // reaches for a spelling correction far more often than for a superscript. Super- and
    // subscript move up one modifier; both stay in the palette.
    editorCommand("format.superscript", "Superscript", "Mod-Shift-.", toggle.superscript),
    editorCommand("format.subscript", "Subscript", "Mod-Shift-,", toggle.subscript),
    editorCommand("format.clear", "Clear formatting", "Mod-Shift-c", clearFormatting),
    {
      id: "format.link",
      // Mod-k is the conventional link binding in a word processor AND the conventional
      // AI-rewrite binding in an IDE. This is an IDE for writing, and the rewrite is the
      // feature people reach for by reflex, so it wins Mod-k and the link moves one key over.
      // Both remain in the palette, which is where a binding conflict should be settled.
      title: "Add or edit link…",
      category: "Format",
      keybinding: "Mod-Shift-k",
      when: inEditor,
      run: async (ctx) => {
        const href = await ctx.ui.prompt("Link target", "https://");
        if (href === null) return;
        run(ctx.view, setLink(href));
      },
    },

    // ---------------------------------------------------------------- blocks
    editorCommand("block.paragraph", "Body text", "Mod-Alt-0", setParagraph, "Paragraph"),
    ...[1, 2, 3, 4, 5, 6].map((level) =>
      editorCommand(`block.heading${level}`, `Heading ${level}`, `Mod-Alt-${level}`, setHeading(level), "Paragraph"),
    ),
    editorCommand("block.blockquote", "Block quotation", "Mod-Alt-q", toggleBlockquote, "Paragraph"),
    editorCommand("block.bulletList", "Bulleted list", "Mod-Shift-8", bulletList, "Paragraph"),
    editorCommand("block.orderedList", "Numbered list", "Mod-Shift-7", orderedList, "Paragraph"),
    editorCommand("block.codeBlock", "Code block", "Mod-Alt-c", setCodeBlock, "Paragraph"),
    editorCommand("block.rule", "Insert horizontal rule", "Mod-Alt-r", insertRule, "Paragraph"),

    // ---------------------------------------------------------------- tables
    editorCommand("table.insert", "Insert table (3 × 3)", "Mod-Alt-t", insertTable(3, 3), "Table"),
    editorCommand("table.rowBefore", "Insert row above", undefined, table.addRowBefore, "Table"),
    editorCommand("table.rowAfter", "Insert row below", "Mod-Alt-Enter", table.addRowAfter, "Table"),
    editorCommand("table.colBefore", "Insert column left", undefined, table.addColumnBefore, "Table"),
    editorCommand("table.colAfter", "Insert column right", undefined, table.addColumnAfter, "Table"),
    editorCommand("table.deleteRow", "Delete row", undefined, table.deleteRow, "Table"),
    editorCommand("table.deleteCol", "Delete column", undefined, table.deleteColumn, "Table"),
    editorCommand("table.merge", "Merge cells", undefined, table.mergeCells, "Table"),
    editorCommand("table.split", "Split cell", undefined, table.splitCell, "Table"),
    editorCommand("table.headerRow", "Toggle header row", undefined, table.toggleHeaderRow, "Table"),
    editorCommand("table.delete", "Delete table", undefined, table.deleteTable, "Table"),

    // ---------------------------------------------------------------- document
    {
      id: "document.specimen",
      title: "Open the typographic specimen",
      category: "Document",
      when: withEditor,
      run: (ctx) => {
        if (controller.dirty) {
          ctx.ui.notify("Unsaved changes — save or revert first.", "error");
          return;
        }
        controller.setDocument(null, specimenDoc(), null, "");
        ctx.ui.notify("Specimen loaded — built from the schema, not from a file.");
      },
    },
    {
      id: "document.blank",
      title: "Close document",
      category: "Document",
      when: withEditor,
      run: (ctx) => {
        if (controller.dirty) {
          ctx.ui.notify("Unsaved changes — save or revert first.", "error");
          return;
        }
        controller.setDocument(null, schema.nodes.doc!.create(null, [schema.nodes.paragraph!.create()]), null, "");
      },
    },

    // ---------------------------------------------------------------- assist
    // These had bindings but no palette entry, so they were undiscoverable and — for anyone
    // whose OS eats the chord — unreachable.
    {
      id: "ai.rewrite",
      title: "Rewrite selection with AI…",
      category: "Assist",
      keybinding: "Mod-k",
      when: (ctx) => ctx.view !== null && !ctx.view.state.selection.empty,
      run: (ctx) => {
        const view = ctx.view;
        if (!view) return;
        const { from, to } = view.state.selection;
        view.dispatch(view.state.tr.setMeta(inlineEditKey, {
          kind: "prompt", from, to,
          original: view.state.doc.textBetween(from, to, "\n"),
          revId: `ai-${Date.now().toString(36)}`,
        }));
      },
    },
    {
      id: "ai.accept",
      title: "Accept AI suggestion",
      category: "Assist",
      keybinding: "Mod-Enter",
      when: (ctx) => ctx.view !== null,
      run: (ctx) => { if (ctx.view) acceptInlineEdit(ctx.view); },
    },
    {
      id: "ai.reject",
      title: "Reject AI suggestion",
      category: "Assist",
      keybinding: "Mod-Backspace",
      when: (ctx) => ctx.view !== null,
      run: (ctx) => { if (ctx.view) rejectInlineEdit(ctx.view); },
    },
    {
      id: "diagnostics.quickFix",
      title: "Apply suggestion at cursor",
      category: "Assist",
      keybinding: "Mod-.",
      when: inEditor,
      run: (ctx) => { if (ctx.view) applyFirstFix(ctx.view); },
    },

    // ---------------------------------------------------------------- host
    {
      id: "host.ai",
      title: "Report AI provider status",
      category: "Host",
      run: async (ctx) => {
        const [available, name] = await Promise.all([ctx.host.ai.available(), ctx.host.ai.providerName()]);
        ctx.ui.notify(
          available
            ? `AI provider: ${name}`
            : "No AI key is set. Everything except AI works, and nothing is sent anywhere.",
        );
      },
    },
    {
      id: "host.root",
      title: "Report the workspace root",
      category: "Host",
      run: async (ctx) => ctx.ui.notify(await ctx.host.root()),
    },
  ]);
}
