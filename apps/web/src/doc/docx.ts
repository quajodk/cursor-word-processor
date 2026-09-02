import { exportDocx, importDocx, type DocxOrigin, type FidelitySidecar, type LedgerEntry } from "@scriv/ooxml";
import type { Node as PMNode } from "prosemirror-model";
import { CodecError, type CodecResult, type DocumentCodec } from "./codec";

/**
 * Word documents, delegated in full to `@scriv/ooxml`.
 *
 * The whole point of the design (docs/DOCX-FIDELITY.md) is that export does not BUILD a .docx,
 * it EDITS the one that arrived. So `meta` has to carry two things forward from import: the
 * fidelity sidecar, and the original zip itself. Lose either and the next save regenerates the
 * file instead of splicing it, which is precisely the failure every other tool has.
 *
 * That makes this meta heavier than the Markdown codec's — the original document is held in
 * memory for as long as it is open. That is deliberate and it is the cost of the guarantee:
 * a paragraph the writer never touched is written back as the exact original bytes.
 */

export interface DocxMeta {
  sidecar: FidelitySidecar;
  origin: DocxOrigin;
  /** What import could not model. Surfaced in the UI; never silently discarded. */
  ledger: LedgerEntry[];
}

function isDocxMeta(value: unknown): value is DocxMeta {
  return typeof value === "object" && value !== null && "sidecar" in value && "origin" in value;
}

function parseBinary(bytes: Uint8Array): CodecResult {
  const result = importDocx(bytes);
  const meta: DocxMeta = { sidecar: result.sidecar, origin: result.origin, ledger: result.ledger };
  return { doc: result.doc, meta };
}

function serializeBinary(doc: PMNode, meta: unknown): Uint8Array {
  if (!isDocxMeta(meta)) {
    // Refuse rather than regenerate. A document that reached this codec without an origin
    // cannot be spliced, and writing a rebuilt-from-scratch .docx over someone's file would
    // destroy exactly the formatting this package exists to preserve.
    throw new CodecError(
      "This document has no original .docx to write back into. Use “File: Save As” to write " +
      "Markdown instead, or reopen the Word file.",
    );
  }
  return exportDocx(doc, meta.sidecar, meta.origin).bytes;
}

/** Text entry points are never called for a binary codec, and say so rather than guessing. */
function parse(): CodecResult {
  throw new CodecError("A Word document must be opened as bytes, not text.");
}
function serialize(): string {
  throw new CodecError("A Word document cannot be serialized to text. Use “File: Save As”.");
}

export const docxCodec: DocumentCodec = {
  id: "docx",
  label: "Word (.docx, spliced)",
  structural: true,
  binary: true,
  parse,
  serialize,
  parseBinary,
  serializeBinary,
};
