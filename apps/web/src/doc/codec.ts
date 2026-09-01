import type { Node as PMNode } from "prosemirror-model";
import { plainTextCodec } from "./plain";

/**
 * The text ⇄ document seam.
 *
 * Markdown is the on-disk truth, and turning Markdown into a `@scriv/doc-model` document is
 * `@scriv/md`'s job — mdast in, schema nodes out, style profile preserved for the round trip.
 * That package is being built in parallel and does not export `parseMarkdown` /
 * `serializeMarkdown` yet, so this module exists to make the dependency explicit and one-line
 * swappable rather than to pre-empt it.
 *
 * Deliberately *not* here: any knowledge of Markdown syntax. The fallback codec below reads and
 * writes plain text and knows nothing about `#`, `-` or `|`. Re-implementing a Markdown parser
 * in `apps/web` would duplicate `@scriv/md` and guarantee two divergent answers to the same
 * question; a shell that can open, edit and save a file losslessly without one is the honest
 * intermediate state.
 *
 * Wiring `@scriv/md` when it lands is exactly:
 *
 *     import { parseMarkdown, serializeMarkdown } from "@scriv/md";
 *     setDocumentCodec({
 *       id: "scriv-md", label: "Markdown", structural: true,
 *       parse: (text) => parseMarkdown(text),
 *       serialize: (doc, meta) => serializeMarkdown(doc, meta as DocMeta),
 *     });
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
   * False means it only carries text, and `serialize` will refuse a structured document rather
   * than silently flatten one.
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

let active: DocumentCodec = plainTextCodec;
const listeners = new Set<() => void>();

export function documentCodec(): DocumentCodec {
  return active;
}

export function setDocumentCodec(codec: DocumentCodec): void {
  active = codec;
  for (const l of listeners) l();
}

export function onCodecChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
