/**
 * Prose IntelliSense.
 *
 * The diagnostics half of this has off-the-shelf answers (Harper, Vale, LanguageTool). The
 * completion half does not: there is no "symbol table" for prose the way there is for code,
 * so one has to be built out of what a document already contains.
 *
 * What makes a symbol here is the same thing that makes one in code — a name the writer has
 * committed to and will need to repeat exactly. Headings are cross-reference targets.
 * Citation keys are identifiers. A defined term is a declaration. A recurring entity name is
 * a name whose spelling must not drift on its fourth mention.
 */

export type SymbolKind =
  /** A heading: a cross-reference target. */
  | "heading"
  /** A term the document explicitly defines. */
  | "term"
  /** A citation key from a bibliography or an inline `[@key]`. */
  | "citation"
  /** A recurring proper name the writer must spell consistently. */
  | "entity"
  /** A user-defined expansion. */
  | "snippet";

export interface ProseSymbol {
  kind: SymbolKind;
  /** The text inserted on accept. */
  label: string;
  /** Where it came from, shown beside the label. */
  detail: string;
  /** Longer explanation, shown when the item is highlighted. */
  documentation?: string;
  /** Workspace-relative path of the file that defines it. */
  path: string;
  /** How many times it occurs across the workspace. Drives ranking. */
  frequency: number;
  /** Heading level, for headings only. */
  level?: number;
}

export interface CompletionItem extends ProseSymbol {
  /** Match score in [0,1]. */
  score: number;
  /** Index ranges in `label` that matched the query, for highlighting. */
  matches: [number, number][];
}

export interface CompletionContext {
  /** Text of the block the caret is in. */
  blockText: string;
  /** Caret offset within `blockText`. */
  offset: number;
  /** Path of the document being edited, so its own symbols can be ranked up. */
  path: string | null;
  /** Maximum items to return. */
  limit?: number;
}

/** What the caret is currently touching, and therefore what should be completed. */
export interface Trigger {
  /** The characters already typed that the completion replaces. */
  query: string;
  /** Offset in `blockText` where the replacement starts. */
  from: number;
  /** Kinds worth offering here. Empty means all. */
  kinds: SymbolKind[];
  /** True when the user asked explicitly (Ctrl-Space) rather than by typing a sigil. */
  explicit: boolean;
}
