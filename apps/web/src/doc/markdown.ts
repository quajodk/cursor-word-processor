import { DEFAULT_STYLE, parseMarkdown, serializeMarkdown, type DocMeta } from "@scriv/md";
import type { Node as PMNode } from "prosemirror-model";
import type { CodecResult, DocumentCodec } from "./codec";

/**
 * Markdown, delegated in full to `@scriv/md`.
 *
 * The only thing this file adds is custody of `meta`. `parseMarkdown` returns the frontmatter it
 * stripped and the style profile it detected — which bullet the file uses, whether its headings
 * are ATX or setext, whether it ends with a newline — and `serializeMarkdown` needs that same
 * object back or it will rewrite every marker in the document to the defaults. So the controller
 * holds the meta of the open file and hands it back on save, and a document that was opened and
 * not edited saves as the bytes it arrived as.
 */

function parse(text: string): CodecResult {
  const result = parseMarkdown(text);
  return { doc: result.doc, meta: result.meta };
}

function isDocMeta(value: unknown): value is DocMeta {
  return typeof value === "object" && value !== null && "style" in value;
}

function serialize(doc: PMNode, meta: unknown): string {
  // A document that never came from a file (the specimen, a new buffer) has no detected style;
  // the package's documented defaults are the right answer there.
  const resolved: DocMeta = isDocMeta(meta)
    ? meta
    : { frontmatter: null, style: DEFAULT_STYLE, comments: [], revisions: [] };
  return serializeMarkdown(doc, resolved);
}

export const markdownCodec: DocumentCodec = {
  id: "markdown",
  label: "Markdown (CommonMark + GFM)",
  structural: true,
  parse,
  serialize,
};
