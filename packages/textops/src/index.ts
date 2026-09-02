export { handleSurround, surroundWith, type SurroundOptions } from "./surround";
export { sentences, words, sentenceAt, wordAt, type Range } from "./segment";
export {
  blockString, blockAt, blockAtPos, offsetOf, posOf, siblingBlock,
  marksAllowed, isLiteralContext, graphemeSegmenter, graphemeStep,
  type BlockText,
} from "./text";
