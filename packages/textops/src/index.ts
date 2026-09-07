export { handleSurround, surroundWith, type SurroundOptions } from "./surround";
export { sentences, words, sentenceAt, wordAt, type Range } from "./segment";
export { expandSelection, shrinkSelection, expandPlugin, expandKey, type ExpandState } from "./selection";
export { moveSentence, moveParagraph, toSentenceEdge, smartHome } from "./motion";
export {
  killLine, killToSentenceEnd, yank, yankPop, transposeChars, transposeWords,
  joinForward, duplicateBlock, moveBlock, deleteWord, killRingPlugin, killRingKey, type KillRing,
} from "./edit";
export {
  multiCursorPlugin, multiCursorKey, allRanges, cursorCount, forEachCursor,
  addNextOccurrence, selectAllOccurrences, addCursorVertical, clearCursors,
  type MultiCursorState, type CursorRange,
} from "./multicursor";
export { textopsKeymap, BINDINGS, KNOWN_CONFLICTS, UNUSABLE_ON_MACOS, type Binding } from "./keymap";
export {
  blockString, blockAt, blockAtPos, offsetOf, posOf, siblingBlock,
  marksAllowed, isLiteralContext, graphemeSegmenter, graphemeStep,
  type BlockText,
} from "./text";
