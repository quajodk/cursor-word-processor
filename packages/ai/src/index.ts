export { diffProse, type Hunk } from "./diff";
export {
  suggestRewrite, applyHunks, acceptSuggestion, rejectSuggestion, hasSuggestion,
  type SuggestOptions,
} from "./suggest";
// Re-exported for callers that already had it from here.
export { OffsetMap } from "@scriv/doc-model";
