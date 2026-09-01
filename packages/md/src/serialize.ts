import { toMarkdown } from "mdast-util-to-markdown";
import { gfmToMarkdown } from "mdast-util-gfm";
import type { Node as PMNode } from "prosemirror-model";
import { toMdastRoot } from "./to-mdast";
import { criticToMarkdown } from "./critic";
import type { DocMeta } from "./types";
import { DEFAULT_STYLE } from "./types";

/**
 * doc-model → Markdown text. The inverse of `parseMarkdown`.
 *
 * `meta` is the {@link DocMeta} a prior `parseMarkdown` produced (or `DEFAULT_STYLE` /
 * `{frontmatter:null, comments:[], revisions:[]}` for a document authored fresh in the
 * editor with no source file yet). Style options are document-wide in
 * `mdast-util-to-markdown` — there is no per-node override — so a file is serialized in
 * whichever bullet/emphasis/fence/etc. convention it was detected to already use.
 */
export function serializeMarkdown(doc: PMNode, meta: DocMeta = { frontmatter: null, style: DEFAULT_STYLE, comments: [], revisions: [] }): string {
  const root = toMdastRoot(doc, meta);
  const style = meta.style;

  const options: Record<string, unknown> = {
    bullet: style.bullet,
    bulletOrdered: style.bulletOrdered,
    emphasis: style.emphasis,
    strong: style.strong,
    fence: style.fence,
    fences: style.fences,
    rule: style.rule,
    ruleRepetition: style.ruleRepetition,
    ruleSpaces: style.ruleSpaces,
    setext: style.setext,
    closeAtx: style.closeAtx,
    listItemIndent: style.listItemIndent,
    incrementListMarker: style.incrementListMarker,
    quote: style.quote,
    resourceLink: style.resourceLink,
    extensions: [gfmToMarkdown(), criticToMarkdown()],
  };

  if (style.hardBreak === "spaces") {
    // `mdast-util-to-markdown`'s core `break` handler always emits a trailing backslash; it
    // has no built-in option for the two-trailing-spaces style. Overriding the handler is
    // the documented extension point for exactly this (`Options.handlers`). This is a
    // simplified port of the core handler — it always assumes a break is legal here, unlike
    // the core version which falls back to a bare space inside constructs (table cells,
    // setext heading text) that cannot contain a real line break. That fallback is rare in
    // practice and, when missed, degrades to a literal two-space-and-newline that most
    // renderers still treat as a break — a known, minor gap.
    (options.extensions as unknown[]).push({ handlers: { break: () => "  \n" } });
  }

  let out = toMarkdown(root as any, options as any);
  if (style.finalNewline === false && out.endsWith("\n")) out = out.slice(0, -1);

  return (meta.frontmatter?.block ?? "") + out;
}
