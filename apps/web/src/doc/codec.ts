import type { Node as PMNode } from "prosemirror-model";
import { markdownCodec } from "./markdown";
import { plainTextCodec } from "./plain";

/**
 * The text ⇄ document seam.
 *
 * Markdown is the on-disk truth and `@scriv/md` owns the translation: mdast in, `@scriv/doc-model`
 * nodes out, with the file's own style profile (bullet character, fence style, emphasis marker,
 * setext or ATX headings) carried in `meta` so that serializing an untouched document gives back
 * the bytes it arrived as. `apps/web` deliberately contains no Markdown syntax knowledge of its
 * own; this module only decides *which* codec a given path gets.
 *
 * Anything that is not Markdown opens through the plain-text codec, which has no syntax knowledge
 * at all and round-trips byte for byte. That is what makes it safe to open a `.txt`, a `.json` or
 * an unrecognised file in the same editor without silently rewriting it.
 */

export interface CodecResult {
  doc: PMNode;
  /** Opaque to the app: the codec's own round-trip state (frontmatter, style profile, …). */
  meta: unknown;
}

export interface DocumentCodec {
  /** Stable id, shown in the status bar so the active codec is never a guess. */
  id: string;
  label: string;
  /**
   * True when the codec maps document *structure* (headings, lists, tables) to schema nodes.
   * False means it only carries text, and `serialize` refuses a structured document rather than
   * silently flattening one.
   */
  structural: boolean;
  parse(text: string): CodecResult;
  serialize(doc: PMNode, meta: unknown): string;
}

/** Thrown when the active codec cannot represent something the document contains. */
export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodecError";
  }
}

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd", "mdx", "qmd", "rmd"]);

export function codecFor(path: string | null): DocumentCodec {
  if (!path) return markdownCodec;
  const dot = path.lastIndexOf(".");
  if (dot < 0) return plainTextCodec;
  const extension = path.slice(dot + 1).toLowerCase();
  return MARKDOWN_EXTENSIONS.has(extension) ? markdownCodec : plainTextCodec;
}

export { markdownCodec, plainTextCodec };
