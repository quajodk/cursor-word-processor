import { keymap } from "prosemirror-keymap";
import type { Command, Plugin } from "prosemirror-state";
import { expandSelection, shrinkSelection } from "./selection";
import { moveSentence, moveParagraph, toSentenceEdge, smartHome } from "./motion";
import {
  killLine, killToSentenceEnd, yank, yankPop, transposeChars, transposeWords,
  joinForward, duplicateBlock, moveBlock, deleteWord,
} from "./edit";

/**
 * The binding table, as DATA.
 *
 * Exported as a list rather than baked into a keymap so the command palette can render it,
 * a settings surface can rebind it, and the collision notes below travel with the bindings
 * instead of living in someone's memory.
 */
export interface Binding {
  /** ProseMirror key name. */
  key: string;
  /** Stable command id, also the palette's identifier. */
  id: string;
  /** Palette label. Sentence case, names what happens. */
  label: string;
  command: Command;
  /** Known conflict on macOS, if any. Empty when the binding is free. */
  conflict?: string;
}

export const BINDINGS: Binding[] = [
  // --- selection ---
  // ⌃⇧⌘→ / ⌃⇧⌘← — what VS Code and Cursor use on macOS, so the hand already knows it.
  // The obvious ⌘⌃↑ is unusable: macOS Mission Control takes it before the page sees it,
  // which was found by pressing it in the running app and watching nothing happen.
  { key: "Shift-Mod-Ctrl-ArrowRight", id: "selection.expand", label: "Expand selection", command: expandSelection },
  { key: "Shift-Mod-Ctrl-ArrowLeft", id: "selection.shrink", label: "Shrink selection", command: shrinkSelection },

  // --- motions ---
  { key: "Mod-Alt-ArrowRight", id: "motion.sentenceForward", label: "Next sentence", command: moveSentence(1) },
  { key: "Mod-Alt-ArrowLeft", id: "motion.sentenceBack", label: "Previous sentence", command: moveSentence(-1) },
  { key: "Shift-Mod-Alt-ArrowRight", id: "motion.sentenceForwardExtend", label: "Extend to next sentence", command: moveSentence(1, true) },
  { key: "Shift-Mod-Alt-ArrowLeft", id: "motion.sentenceBackExtend", label: "Extend to previous sentence", command: moveSentence(-1, true) },
  { key: "Ctrl-ArrowDown", id: "motion.paragraphForward", label: "Next paragraph", command: moveParagraph(1) },
  { key: "Ctrl-ArrowUp", id: "motion.paragraphBack", label: "Previous paragraph", command: moveParagraph(-1) },
  { key: "Mod-Alt-ArrowUp", id: "motion.sentenceStart", label: "Start of sentence", command: toSentenceEdge("start") },
  { key: "Mod-Alt-ArrowDown", id: "motion.sentenceEnd", label: "End of sentence", command: toSentenceEdge("end") },
  { key: "Home", id: "motion.smartHome", label: "Start of line", command: smartHome() },
  { key: "Shift-Home", id: "motion.smartHomeExtend", label: "Select to start of line", command: smartHome(true) },

  // --- edits ---
  { key: "Ctrl-k", id: "edit.killLine", label: "Kill to end of line", command: killLine },
  { key: "Alt-k", id: "edit.killSentence", label: "Kill to end of sentence", command: killToSentenceEnd },
  { key: "Ctrl-y", id: "edit.yank", label: "Yank", command: yank },
  { key: "Alt-y", id: "edit.yankPop", label: "Yank previous", command: yankPop },
  { key: "Ctrl-t", id: "edit.transposeChars", label: "Transpose characters", command: transposeChars },
  { key: "Alt-t", id: "edit.transposeWords", label: "Transpose words", command: transposeWords },
  { key: "Mod-Shift-j", id: "edit.join", label: "Join with next paragraph", command: joinForward },
  { key: "Mod-Shift-d", id: "edit.duplicate", label: "Duplicate paragraph", command: duplicateBlock },
  { key: "Alt-ArrowUp", id: "edit.moveUp", label: "Move paragraph up", command: moveBlock(-1) },
  { key: "Alt-ArrowDown", id: "edit.moveDown", label: "Move paragraph down", command: moveBlock(1) },
  { key: "Alt-Backspace", id: "edit.deleteWordBack", label: "Delete word backward", command: deleteWord(-1) },
  { key: "Alt-Delete", id: "edit.deleteWordForward", label: "Delete word forward", command: deleteWord(1) },
];

/**
 * Collisions, stated rather than discovered.
 *
 * `Ctrl-k`, `Ctrl-y` and `Ctrl-t` are macOS text-system bindings (kill, yank, transpose) that
 * a web page shadows anyway, so taking them restores the behaviour a writer already expects
 * rather than stealing anything. `Mod-Ctrl-Arrow` is free on macOS but is a Spaces gesture on
 * some Linux desktops, which is why expansion is also in the palette and rebindable.
 */
export const KNOWN_CONFLICTS: Record<string, string> = {
  "Ctrl-k": "macOS text system 'delete to end of paragraph' — replaced with the same idea.",
  "Ctrl-y": "macOS text system 'yank' — same idea, same key.",
  "Ctrl-t": "macOS text system 'transpose characters' — same idea, same key.",
  "Alt-ArrowUp": "Free on macOS; some Linux window managers bind Super-Arrow, not Alt-Arrow.",
};

/**
 * Bindings the OS eats before the page can see them. Verified by pressing them in the running
 * app, not by reading a table: `Mod-Ctrl-ArrowUp` looked ideal for expand-selection and is
 * silently swallowed by Mission Control on macOS. Anything added here needs the same check.
 */
export const UNUSABLE_ON_MACOS = ["Mod-Ctrl-ArrowUp", "Mod-Ctrl-ArrowDown", "Ctrl-ArrowLeft", "Ctrl-ArrowRight"];

export function textopsKeymap(): Plugin {
  const map: Record<string, Command> = {};
  for (const b of BINDINGS) map[b.key] = b.command;
  return keymap(map);
}
