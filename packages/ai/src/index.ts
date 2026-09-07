export { diffProse, type Hunk } from "./diff";
export {
  suggestRewrite, applyHunks, acceptSuggestion, rejectSuggestion, hasSuggestion,
  type SuggestOptions,
} from "./suggest";
// Re-exported for callers that already had it from here.
export { OffsetMap } from "@scriv/doc-model";
export { planRename, applyChangeSet, staleSites, summarizeChangeSet, siteKey,
  type Site, type FileChange, type ChangeSet, type ChangeSetSummary, type Confidence,
  type RenameOptions, type SourceFile, type ApplyResult } from "./agent";
export { codeSpans, frontmatterSpan, isMasked, type Span } from "./mask";
