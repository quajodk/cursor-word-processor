import type { Node as PMNode } from "prosemirror-model";

/**
 * Reserved attribute namespace.
 *
 * The doc-model schema is shaped for OOXML, not for Markdown, so a handful of Markdown-only
 * facts have nowhere of their own to live (`listItem.checked`, table column alignment, verbatim
 * HTML). Rather than edit `@scriv/doc-model` (out of scope) or silently drop them, this package
 * parks them in an explicitly reserved `md:` namespace on existing opaque `*Ref` / `styleId`
 * attributes.
 *
 * Contract for every other package: **any `styleId`, `tcPrRef` or `rPrRef` value beginning with
 * `md:` is owned by `@scriv/md` and is not a key into the fidelity sidecar.** `@scriv/ooxml`
 * must skip them rather than look them up.
 *
 * See the schema-addition proposal in this package's report; once doc-model grows
 * `list_item.checked`, a cell `align` attribute and `html_block` / `html_inline` nodes, every
 * use of this namespace disappears.
 */
export const MD_NS = "md:";

/** `styleId` sentinels on blocks. */
export const MD_STYLE = {
  /** `code_block` holding a verbatim HTML block. */
  htmlBlock: "md:html",
  /** `code_block` holding a verbatim link reference definition. */
  definition: "md:definition",
  /** `code_block` holding any other unmodeled block, re-emitted byte-for-byte. */
  raw: "md:raw",
  /** `list_item` that is a GFM task list item. */
  taskChecked: "md:task=checked",
  taskUnchecked: "md:task=unchecked",
} as const;

/** `rPrRef` sentinel: the text node's content is verbatim Markdown, not prose. */
export const MD_RAW_INLINE = "md:raw";

/** `tcPrRef` sentinel prefix for GFM column alignment. */
export const MD_ALIGN = "md:align=";

// ---------------------------------------------------------------------------------------------

export interface Frontmatter {
  /** `---` (YAML) or `+++` (TOML). Only YAML is structurally parsed. */
  fence: "---" | "+++";
  /** Everything between the fences, verbatim. Authoritative for serialization. */
  raw: string;
  /** The whole block including fences and its trailing newline, verbatim. */
  block: string;
  /**
   * Best-effort structured view of `raw`. A deliberately small YAML subset: block maps,
   * block sequences, quoted and plain scalars, nesting by indentation. Anything it does not
   * understand is left out of `data` — `raw` never loses it.
   */
  data: Record<string, unknown>;
}

/**
 * How the source file was written. Detected at parse time from real byte positions in the
 * source, and replayed on serialize so that `serialize(parse(x))` stays close to `x` instead
 * of rewriting every bullet, fence and emphasis marker in the file.
 *
 * These are document-wide majority votes: mdast-util-to-markdown takes global options, not
 * per-node ones. A file that mixes `*` and `-` bullets is normalized to whichever it uses more.
 */
export interface StyleProfile {
  bullet: "*" | "+" | "-";
  bulletOrdered: "." | ")";
  emphasis: "*" | "_";
  strong: "*" | "_";
  fence: "`" | "~";
  /** false → indented code blocks where legal. */
  fences: boolean;
  rule: "*" | "-" | "_";
  ruleRepetition: number;
  ruleSpaces: boolean;
  /** true → `Title\n=====` for h1/h2. */
  setext: boolean;
  /** true → `## Title ##`. */
  closeAtx: boolean;
  listItemIndent: "one" | "tab" | "mixed";
  incrementListMarker: boolean;
  quote: '"' | "'";
  /** true → always `[text](url)`, never `<url>`. */
  resourceLink: boolean;
  /** Hard line break style: a trailing backslash or two trailing spaces. */
  hardBreak: "backslash" | "spaces";
  /** Trailing newline at end of file. */
  finalNewline: boolean;
}

export const DEFAULT_STYLE: StyleProfile = {
  bullet: "-",
  bulletOrdered: ".",
  emphasis: "_",
  strong: "*",
  fence: "`",
  fences: true,
  rule: "-",
  ruleRepetition: 3,
  ruleSpaces: false,
  setext: false,
  closeAtx: false,
  listItemIndent: "one",
  incrementListMarker: true,
  quote: '"',
  resourceLink: false,
  hardBreak: "backslash",
  finalNewline: true,
};

/** A CriticMarkup comment: `{>>body<<}`. The body lives in the Markdown; the thread does not. */
export interface CriticComment {
  anchorId: string;
  body: string;
}

/** A tracked change discovered in the Markdown. */
export interface CriticRevision {
  revId: string;
  kind: "insertion" | "deletion";
  /** Set when the revision came from a `{~~a~>b~~}` substitution. */
  substitution: boolean;
  text: string;
}

/**
 * Everything about a Markdown file that the ProseMirror document cannot hold.
 *
 * This is the same shape of thing as the docx fidelity sidecar: the `.md` remains complete and
 * hand-editable on its own, and this is the derived map that lets us put it back exactly.
 * Callers that keep a document open should keep its `DocMeta` beside it (it belongs in
 * `.scriv/<file>.md.fidelity.json`) and hand it back to {@link serializeMarkdown}.
 */
export interface DocMeta {
  frontmatter: Frontmatter | null;
  style: StyleProfile;
  /** Comment bodies keyed by anchor id, for the sidecar to hang threads off. */
  comments: CriticComment[];
  /** Revisions found in the Markdown, for the sidecar to hang authorship off. */
  revisions: CriticRevision[];
}

export interface ParseResult {
  doc: PMNode;
  meta: DocMeta;
}
