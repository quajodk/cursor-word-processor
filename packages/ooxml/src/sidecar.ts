/**
 * `.scriv/<name>.md.fidelity.json` - the map between the Markdown source of truth and the
 * original .docx (ARCHITECTURE.md 4, DOCX-FIDELITY.md 2-3).
 *
 * This file is a CONTRACT. The importer writes it; the anchor engine updates it; the splice
 * engine reads it and must be able to rebuild `word/document.xml` from it plus the origin zip
 * without ever consulting the importer's internals.
 *
 * Three rules the shape obeys:
 *
 * 1. **Lossless through JSON.** Every value is a string, number, boolean, array or plain
 *    object. No Maps, no Uint8Arrays, no undefined-as-meaningful, no NaN. `parseSidecar` of
 *    `serializeSidecar` is the identity, and there is a test that proves it on the real corpus.
 *
 * 2. **Byte ranges, never reconstructed markup.** Anything we did not model is stored as the
 *    exact original text of a byte range, plus that range. The splice engine may copy either.
 *    Nothing in here was produced by a serializer, so nothing in here can have been normalised.
 *
 * 3. **Content-addressed property blobs.** A 200-page report has ~4 distinct `w:pPr` values
 *    across 3000 paragraphs. Storing them by hash keeps the sidecar proportional to the
 *    document's variety rather than its length, and makes git diffs of the sidecar readable.
 */

import type { LedgerEntry } from "./ledger.ts";
import type { Anchor } from "./anchor.ts";

/** Bump on any incompatible change. `parseSidecar` refuses versions it does not understand. */
export const SIDECAR_VERSION = 1;
export const SIDECAR_KIND = "scriv.docx.fidelity" as const;

/** `[startByte, endByte)` into the part named by the containing record. */
export type ByteRange = [number, number];

/** ProseMirror node type a block was imported as. */
export type BlockKind =
  | "paragraph" | "heading" | "blockquote" | "code_block"
  | "bullet_list" | "ordered_list" | "list_item"
  | "table" | "table_row" | "table_cell"
  | "figure" | "horizontal_rule";

/* ------------------------------------------------------------------ property store */

/**
 * Verbatim OOXML property blobs, keyed by a content-addressed ref. The ref is what lands in
 * the ProseMirror node attrs (`pPrRef`, `rPrRef`, `tcPrRef`) - the editor never looks inside.
 *
 * The `xml` is the raw source text of the element, exactly as it appeared, entity references
 * and attribute order included. `range` is where it came from, for the splice fast path.
 */
export interface PropBlob {
  ref: string;
  /** Element name as written, e.g. `w:pPr`. */
  element: string;
  /** Raw markup, byte-exact. Re-encoding this as UTF-8 reproduces the original bytes. */
  xml: string;
  /** Where it lived in the origin part. Multiple blocks may share one blob; this is the first. */
  range: ByteRange;
  /** How many blocks reference it. Diagnostics only. */
  uses: number;
}

export interface PropStore {
  /** `w:pPr` blobs, ref -> blob. Refs are prefixed `p:`. */
  pPr: Record<string, PropBlob>;
  /** `w:rPr` blobs. Refs prefixed `r:`. */
  rPr: Record<string, PropBlob>;
  /** `w:tcPr` blobs. Refs prefixed `c:`. */
  tcPr: Record<string, PropBlob>;
  /** `w:trPr` blobs. Refs prefixed `w:`. */
  trPr: Record<string, PropBlob>;
  /** `w:tblPr` + `w:tblGrid` blobs. Refs prefixed `t:`. */
  tblPr: Record<string, PropBlob>;
  /** `w:sectPr` blobs. Refs prefixed `s:`. */
  sectPr: Record<string, PropBlob>;
}

/* ------------------------------------------------------------------ document frame */

/**
 * The body of `word/document.xml`, described as an ordered, gapless partition of its content
 * span. The splice engine walks this list: `block` items are candidates for regeneration,
 * `opaque` items are copied byte-for-byte and never understood.
 *
 * "Gapless" is load-bearing and tested: `items[0].range[0] === bodyContent[0]`,
 * `items[i].range[1] === items[i+1].range[0]`, and the last item ends at `bodyContent[1]`.
 * Whitespace and unmodeled elements between blocks live in `opaque` items, so reassembling the
 * body is a concatenation and cannot drop anything by accident.
 */
export interface BodyItem {
  kind: "block" | "opaque";
  /** Element name as written; `#text` for inter-element whitespace. */
  element: string;
  range: ByteRange;
  /** Present when `kind === "block"`. */
  aid?: string;
}

export interface DocumentFrame {
  /** Part name, essentially always `word/document.xml`. */
  part: string;
  /** Byte length of the part. */
  bytes: number;
  /** Content span of `w:body`: everything the splice engine may rewrite. */
  bodyContent: ByteRange;
  /** `[0, bodyContent[0])` - XML declaration, `w:document` open tag, `w:body` open tag. */
  prologue: ByteRange;
  /** `[bodyContent[1], bytes)` - `</w:body></w:document>`. */
  epilogue: ByteRange;
  items: BodyItem[];
}

/* ------------------------------------------------------------------ blocks and runs */

export type RunContentKind =
  | "text" | "break" | "tab" | "drawing" | "picture" | "object"
  | "symbol" | "fieldChar" | "instrText" | "footnoteRef" | "endnoteRef"
  | "commentRef" | "softHyphen" | "noBreakHyphen" | "other";

/**
 * Where a run sits in the wrapper stack that encloses it inside the paragraph. Order is
 * outermost-first. The splice engine needs this to rebuild `w:hyperlink` / `w:ins` / `w:del`
 * nesting when regenerating a paragraph's content.
 */
export interface RunWrapper {
  element: string;              // "w:hyperlink" | "w:ins" | "w:del" | "w:sdtContent" | ...
  /** Byte range of the wrapper element in the origin part. */
  range: ByteRange;
  /** `r:id` for hyperlinks. */
  relId?: string;
  /** `w:anchor` for internal hyperlinks. */
  anchor?: string;
  /** `w:id` for revisions. */
  revId?: string;
  author?: string;
  date?: string;
}

export interface RunRecord {
  /** Byte range of the `w:r` in the origin part. */
  range: ByteRange;
  element: string;
  rPrRef: string | null;
  /** Byte range of the `w:rPr` inside `range`, if present. */
  rPrRange: ByteRange | null;
  /**
   * Byte range of the run's *content after* `w:rPr` - what the splice engine replaces when
   * only text changed. Null when the run has no content children.
   */
  contentRange: ByteRange | null;
  /** Offset of this run's text within the block's plain text, in UTF-16 code units. */
  textStart: number;
  textLen: number;
  /** What the run actually carried, in order. `["text"]` for the overwhelming majority. */
  content: RunContentKind[];
  /** `xml:space="preserve"` was set on `w:t`. Must be re-emitted or leading spaces vanish. */
  preserveSpace: boolean;
  wrappers: RunWrapper[];
  /** Refs into `sidecar.drawings` for any drawing this run carried. */
  drawingRefs?: string[];
}

export interface TableCellRecord {
  aid: string;
  range: ByteRange;
  tcPrRef: string | null;
  /** Aids of the blocks inside the cell, in order. */
  children: string[];
  gridSpan: number;
  /** "restart" | "continue" | null - `w:vMerge`. */
  vMerge: string | null;
}

export interface TableRowRecord {
  aid: string;
  range: ByteRange;
  trPrRef: string | null;
  cells: TableCellRecord[];
}

export interface TableRecord {
  tblPrRef: string | null;
  /** `w:tblGrid` column widths, in twentieths of a point. */
  grid: number[];
  rows: TableRowRecord[];
  /** Depth of table nesting; 0 for a top-level table. */
  depth: number;
}

/**
 * One editable block, keyed by `aid`.
 *
 * `range` is what makes the "unchanged blocks are byte-identical" guarantee mechanical: if the
 * block's text is unchanged, the splice engine copies `originBytes[range[0]..range[1])` and is
 * done - no property is consulted, so no property can be got wrong.
 */
export interface BlockRecord {
  aid: string;
  kind: BlockKind;
  /** Element name in the origin, e.g. `w:p` or `w:tbl`. */
  element: string;
  /** Position of the block in the imported document, for anchor bootstrapping. */
  ordinal: number;
  /** Byte range of the whole element. Null for blocks created after import. */
  range: ByteRange | null;
  /** Content span of the element - inside the tags. */
  contentRange: ByteRange | null;
  /** Byte range of the `w:pPr`, which sits at the head of `contentRange`. */
  pPrRange: ByteRange | null;

  styleId: string | null;
  pPrRef: string | null;
  numRef: string | null;
  /** Heading level, when `kind === "heading"`. */
  level: number | null;
  /** Outline/list depth from `w:ilvl`. */
  listLevel: number | null;

  runs: RunRecord[];
  /** Plain text of the block, as the editor sees it. The anchor signals are computed on this. */
  text: string;
  /** Child block aids for containers. */
  children?: string[];
  table?: TableRecord;
  /** Comment anchor ids that start or end inside this block. */
  commentAnchors?: string[];
  /** Revision ids that touch this block. */
  revisionIds?: string[];
}

/* ------------------------------------------------------------------ satellites */

export interface NumberingRecord {
  ref: string;
  numId: string;
  ilvl: number;
  /** `bullet` | `decimal` | `lowerLetter` | ... as read from numbering.xml, or null. */
  numFmt: string | null;
  /** The abstract numbering id this resolves to, when resolvable. */
  abstractNumId: string | null;
}

export interface DrawingRecord {
  ref: string;
  /** Verbatim `w:drawing` / `w:pict` markup. */
  xml: string;
  range: ByteRange;
  /** `true` for `wp:inline`, `false` for `wp:anchor` (floating). */
  inline: boolean;
  /** Relationship ids referenced (`r:embed`, `r:link`). */
  relIds: string[];
  /** Resolved part names for those relationships, e.g. `word/media/image1.png`. */
  targets: string[];
  /** `wp:docPr/@descr` or `@name`. */
  alt: string | null;
  /** EMU extents, when present. */
  cx: number | null;
  cy: number | null;
}

export interface CommentThread {
  /** The id carried by the `comment` mark in the doc model. */
  anchorId: string;
  /** `w:id` values from `w:commentRangeStart`. A thread may cover several. */
  commentIds: string[];
  author: string;
  initials: string | null;
  date: string | null;
  /** Plain text of the comment body. */
  text: string;
  /** Verbatim `w:comment` markup from `word/comments.xml`, so export can splice it back. */
  xml: string;
  /** From `commentsExtended.xml`, when present. */
  resolved: boolean;
  parentAnchorId: string | null;
  /** Aid the comment currently attaches to; updated by re-anchoring. */
  aid: string | null;
  /** Character offsets of the marked range within that block's text. */
  span: [number, number] | null;
}

export interface RevisionRecord {
  revId: string;
  kind: "ins" | "del" | "moveFrom" | "moveTo" | "pPrChange" | "rPrChange" | "sectPrChange" | "tblPrChange";
  /** `w:id`. */
  id: string;
  author: string;
  date: string | null;
  /** Aid of the block it applies to. */
  aid: string | null;
}

/** A part of the origin zip. Export copies every one of these verbatim except the ones it edits. */
export interface PartRef {
  name: string;
  bytes: number;
  sha256: string;
}

export interface OriginRef {
  /** sha256 of the whole original .docx. Identifies `.scriv/origin/<sha>.docx`. */
  docxSha256: string;
  docxBytes: number;
  documentPart: string;
  documentXmlBytes: number;
  documentXmlSha256: string;
  encoding: "utf-8" | "utf-16le" | "utf-16be";
  /** Byte-order-mark length. Every offset in this sidecar already includes it. */
  bomBytes: number;
  zipEntryCount: number;
}

export interface ImportStats {
  blocks: number;
  paragraphs: number;
  headings: number;
  listItems: number;
  tables: number;
  runs: number;
  drawings: number;
  comments: number;
  revisions: number;
  /** Distinct property blobs stored, by kind. */
  distinctProps: Record<string, number>;
  /** Wall-clock ms the import took. Diagnostics; not part of the contract. */
  importMs: number;
}

/* ------------------------------------------------------------------ the sidecar */

export interface FidelitySidecar {
  version: number;
  kind: typeof SIDECAR_KIND;
  /** Package + version that produced this file. */
  generator: string;
  createdAt: string;

  origin: OriginRef;
  parts: PartRef[];
  /** Relationship id -> target, from `word/_rels/document.xml.rels`. */
  rels: Record<string, { type: string; target: string; targetMode: string | null }>;

  document: DocumentFrame;
  props: PropStore;

  /** aid -> block. Insertion order is document order at import time. */
  blocks: Record<string, BlockRecord>;
  /** aid -> anchor. Same key space as `blocks`; see anchor.ts. */
  anchors: Record<string, Anchor>;

  numbering: Record<string, NumberingRecord>;
  drawings: Record<string, DrawingRecord>;
  comments: Record<string, CommentThread>;
  revisions: Record<string, RevisionRecord>;

  ledger: LedgerEntry[];
  stats: ImportStats;
}

/* ------------------------------------------------------------------ (de)serialisation */

export function emptyPropStore(): PropStore {
  return { pPr: {}, rPr: {}, tcPr: {}, trPr: {}, tblPr: {}, sectPr: {} };
}

export function serializeSidecar(s: FidelitySidecar, pretty = false): string {
  return JSON.stringify(s, null, pretty ? 2 : 0);
}

export class SidecarVersionError extends Error {
  constructor(readonly found: unknown) {
    super(`unsupported fidelity sidecar version ${String(found)}; this build understands ${SIDECAR_VERSION}`);
    this.name = "SidecarVersionError";
  }
}

export function parseSidecar(json: string): FidelitySidecar {
  const raw = JSON.parse(json) as Partial<FidelitySidecar>;
  if (raw.kind !== SIDECAR_KIND) throw new Error(`not a scriv fidelity sidecar (kind=${String(raw.kind)})`);
  if (raw.version !== SIDECAR_VERSION) throw new SidecarVersionError(raw.version);
  return raw as FidelitySidecar;
}

/** Canonical on-disk name next to the Markdown file. */
export function sidecarName(markdownFileName: string): string {
  return `${markdownFileName}.fidelity.json`;
}

/* ------------------------------------------------------------------ prop interning */

/**
 * Interns property blobs by content so the sidecar stores each distinct `w:pPr` once.
 *
 * The ref is `<prefix>:<12 hex of sha256 of the raw markup>`. Content addressing means two
 * paragraphs with identical properties share a ref automatically, and it means a ref is stable
 * across imports of the same file - which is what lets a sidecar be diffed in git.
 */
export interface PropKindSpec {
  bucket: keyof PropStore;
  prefix: string;
}

export const PROP_KINDS: Record<string, PropKindSpec> = {
  pPr: { bucket: "pPr", prefix: "p" },
  rPr: { bucket: "rPr", prefix: "r" },
  tcPr: { bucket: "tcPr", prefix: "c" },
  trPr: { bucket: "trPr", prefix: "w" },
  tblPr: { bucket: "tblPr", prefix: "t" },
  sectPr: { bucket: "sectPr", prefix: "s" },
};
