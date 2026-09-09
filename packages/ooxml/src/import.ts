/**
 * .docx import.
 *
 * `importDocx(bytes)` returns three things, and the split between them is the whole design
 * (DOCX-FIDELITY.md 2):
 *
 *   doc      - the ProseMirror document. TEXT AND STRUCTURE. Complete on its own; this is what
 *              becomes the Markdown, and deleting everything else must never lose it.
 *   sidecar  - THE MAP. Anchors, verbatim OOXML property blobs by reference, byte ranges,
 *              comments, revisions, and the ledger of everything we could not model.
 *   origin   - THE SUBSTRATE. The untouched original zip, kept whole, so export can splice
 *              rather than regenerate.
 *
 * The importer's job is therefore NOT to understand OOXML. It is to understand as little as it
 * can get away with, and to record precisely where everything it did not understand lives, so
 * that export can put it back without ever having parsed it. Every branch in this file that
 * says "we do not model this" is followed by a ledger entry, because a loss nobody records is
 * the only kind of loss that actually hurts.
 */

import { unzipSync } from "fflate";
import type { Node as PMNode, Mark } from "prosemirror-model";
import { schema, newAid } from "@scriv/doc-model";
import {
  XmlIndex, W_NS, R_NS, XML_NS, PKG_REL_NS,
  w, wAll, attrNS, wVal, wChildVal, wToggle, deepText,
  type XmlNode,
} from "./xmlindex";
import { sha256Hex, shortHash } from "./hash";
import { Ledger, type LedgerEntry } from "./ledger";
import { readCommentThreading } from "./comments";
import { computeLabels, type LevelDef, type NumberingTable } from "./numbering";
import { anchorOf, prepareBlocks, type Anchor, type BlockSignalInput } from "./anchor";
import {
  SIDECAR_KIND, SIDECAR_VERSION, emptyPropStore, PROP_KINDS,
  type BlockKind, type BlockRecord, type BodyItem, type ByteRange, type CommentThread,
  type DocumentFrame, type DrawingRecord, type FidelitySidecar, type NumberingRecord,
  type PartRef, type PropBlob, type PropStore, type RevisionRecord, type RunContentKind,
  type RunRecord, type RunWrapper, type TableCellRecord, type TableRecord, type TableRowRecord,
} from "./sidecar";

export interface OriginEntry {
  name: string;
  bytes: Uint8Array;
}

/** The untouched original package. Written to `.scriv/origin/<sha>.docx`; never modified. */
export interface DocxOrigin {
  /** The original file, byte for byte. */
  bytes: Uint8Array;
  sha256: string;
  entries: OriginEntry[];
  documentPart: string;
  /** Raw bytes of the main document part. Offsets in the sidecar index into THIS. */
  documentXml: Uint8Array;
}

export interface ImportOptions {
  /**
   * Hash every zip part individually. Default FALSE.
   *
   * Nothing in the library reads these: origin integrity is already covered by
   * `origin.docxSha256` over the whole package, and the splice engine addresses parts by
   * name, not by digest. They were pure write-only cost — on a media-heavy document, a fifth
   * of the entire import — so they are now opt-in for whoever actually wants them.
   */
  hashParts?: boolean;
  /** Supply block ids deterministically (tests). Default: `newAid()` from doc-model. */
  mintAid?: (ordinal: number) => string;
  /** Timestamp written into the sidecar. Pass a fixed value for reproducible output. */
  now?: string;
}

export interface ImportResult {
  doc: PMNode;
  sidecar: FidelitySidecar;
  origin: DocxOrigin;
  /** Same array as `sidecar.ledger`; here so callers do not have to reach through. */
  ledger: LedgerEntry[];
}

export class DocxImportError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "DocxImportError";
  }
}

/* ------------------------------------------------------------------ package plumbing */

function findDocumentPart(entries: Record<string, Uint8Array>, ledger: Ledger): string {
  // The correct route: package relationships -> the officeDocument relationship.
  const rels = entries["_rels/.rels"];
  if (rels) {
    try {
      const ix = XmlIndex.parse(rels);
      const root = ix.root.children.find((c) => c.local === "Relationships");
      for (const r of root?.children ?? []) {
        const type = attrNS(r, "", "Type") ?? "";
        if (type.endsWith("/officeDocument")) {
          const target = attrNS(r, "", "Target") ?? "";
          const norm = target.replace(/^\/+/, "");
          if (entries[norm]) return norm;
          if (entries[`word/${norm}`]) return `word/${norm}`;
        }
      }
    } catch {
      ledger.add({ code: "missing-part", severity: "info", stage: "import", part: "_rels/.rels", detail: "package relationships unreadable; falling back to the conventional path" });
    }
  }
  if (entries["word/document.xml"]) return "word/document.xml";
  const guess = Object.keys(entries).find((n) => /^word\/document[0-9]*\.xml$/.test(n));
  if (guess) return guess;
  throw new DocxImportError("no WordprocessingML main document part found", "no-document-part");
}

interface RelRecord { type: string; target: string; targetMode: string | null }

function parseRels(bytes: Uint8Array | undefined): Record<string, RelRecord> {
  const out: Record<string, RelRecord> = {};
  if (!bytes) return out;
  try {
    const ix = XmlIndex.parse(bytes);
    const root = ix.root.children.find((c) => c.local === "Relationships" || c.uri === PKG_REL_NS);
    for (const r of root?.children ?? []) {
      const id = attrNS(r, "", "Id");
      if (!id) continue;
      out[id] = {
        type: attrNS(r, "", "Type") ?? "",
        target: attrNS(r, "", "Target") ?? "",
        targetMode: attrNS(r, "", "TargetMode") ?? null,
      };
    }
  } catch { /* a broken rels part is not a reason to lose the document */ }
  return out;
}

/**
 * How big an image may be before it stays a reference rather than becoming a data URI.
 * Two megabytes covers essentially every image in the corpus while keeping a document with
 * dozens of photographs from turning into a hundred-megabyte string.
 */
const MAX_INLINE_MEDIA = 2 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", svg: "image/svg+xml",
  webp: "image/webp", emf: "image/emf", wmf: "image/wmf",
};

/**
 * A renderable `src` for an image inside the package.
 *
 * The part name (`word/media/image1.png`) is meaningless to a browser — every imported image
 * rendered broken, which against Google Docs on "does this look like a document" is the whole
 * comparison. The bytes are right there in the zip, so they become a data URI. EMF and WMF are
 * Windows metafile formats no browser renders; they keep the reference and are ledgered rather
 * than being silently emitted as a src that cannot load.
 */
function mediaSrc(part: string, entries: Record<string, Uint8Array>, ledger: Ledger, aid: string): string {
  if (part === "" || /^https?:/i.test(part)) return part;
  const bytes = entries[part];
  const ext = part.slice(part.lastIndexOf(".") + 1).toLowerCase();
  const mime = MEDIA_TYPES[ext];
  if (!bytes || !mime || ext === "emf" || ext === "wmf" || bytes.length > MAX_INLINE_MEDIA) {
    ledger.add({
      code: "media-not-inlined", severity: "info", stage: "import", aid,
      detail: !bytes ? `image part missing from the package: ${part}`
        : !mime || ext === "emf" || ext === "wmf" ? `no browser renders ${ext.toUpperCase()}; kept as a reference`
        : `image is ${(bytes.length / 1024 / 1024).toFixed(1)} MB, above the inline limit`,
    });
    return part;
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Resolve a relationship target to a zip part name, e.g. `media/image1.png` -> `word/media/...`. */
function resolveTarget(documentPart: string, target: string): string {
  if (/^[a-z]+:/i.test(target)) return target;      // external URL
  if (target.startsWith("/")) return target.slice(1);
  const dir = documentPart.slice(0, documentPart.lastIndexOf("/") + 1);
  const joined = dir + target;
  const parts: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/* ------------------------------------------------------------------ property interning */

class Props {
  readonly store: PropStore = emptyPropStore();

  /** Intern a property element by its exact source text. Returns null for absent elements. */
  intern(kind: keyof typeof PROP_KINDS, el: XmlNode | null, ix: XmlIndex): string | null {
    if (!el) return null;
    const spec = PROP_KINDS[kind]!;
    const xml = ix.raw(el);
    const ref = `${spec.prefix}:${shortHash(xml)}`;
    const bucket = this.store[spec.bucket] as Record<string, PropBlob>;
    const found = bucket[ref];
    if (found) { found.uses++; return ref; }
    bucket[ref] = { ref, element: el.name, xml, range: [el.start, el.end], uses: 1 };
    return ref;
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const k of Object.keys(this.store) as Array<keyof PropStore>) out[k] = Object.keys(this.store[k]).length;
    return out;
  }
}

/* ------------------------------------------------------------------ numbering */

function parseNumbering(bytes: Uint8Array | undefined): {
  fmt: Map<string, { numFmt: string | null; abstractNumId: string | null }>;
  table: NumberingTable;
} {
  const fmt = new Map<string, { numFmt: string | null; abstractNumId: string | null }>();
  const table: NumberingTable = { byNumId: new Map(), unmodeled: [] };
  if (!bytes) return { fmt, table };
  try {
    const ix = XmlIndex.parse(bytes);
    const root = ix.root.children.find((c) => c.local === "numbering");
    if (!root) return { fmt, table };

    /** abstractNumId -> ilvl -> the full level definition. */
    const abstract = new Map<string, Map<number, LevelDef>>();
    for (const an of wAll(root, "abstractNum")) {
      const id = attrNS(an, W_NS, "abstractNumId");
      if (!id) continue;
      const levels = new Map<number, LevelDef>();
      for (const lvl of wAll(an, "lvl")) {
        const ilvl = Number(attrNS(lvl, W_NS, "ilvl") ?? "0");
        const numFmt = wChildVal(lvl, "numFmt") ?? null;
        const startRaw = Number(wChildVal(lvl, "start") ?? "1");
        const restartRaw = wChildVal(lvl, "lvlRestart");
        levels.set(ilvl, {
          ilvl,
          numFmt,
          lvlText: wChildVal(lvl, "lvlText") ?? null,
          start: Number.isFinite(startRaw) ? startRaw : 1,
          lvlRestart: restartRaw === undefined ? null : (Number.isFinite(Number(restartRaw)) ? Number(restartRaw) : null),
          isLgl: w(lvl, "isLgl") !== null,
          suff: wChildVal(lvl, "suff") ?? null,
        });
        // A format outside the set `numbering.ts` renders is shown as a decimal. That is a
        // visible approximation, so it is named rather than passing silently.
        if (numFmt && !KNOWN_NUM_FMTS.has(numFmt)) table.unmodeled.push(numFmt);
      }
      abstract.set(id, levels);
    }

    for (const num of wAll(root, "num")) {
      const numId = attrNS(num, W_NS, "numId");
      if (!numId) continue;
      const absId = wChildVal(num, "abstractNumId") ?? null;
      const levels = new Map<number, LevelDef>(absId !== null ? abstract.get(absId) ?? [] : []);
      const startOverride = new Map<number, number>();

      for (const ov of wAll(num, "lvlOverride")) {
        const ilvl = Number(attrNS(ov, W_NS, "ilvl") ?? "0");
        const so = wChildVal(ov, "startOverride");
        if (so !== undefined && Number.isFinite(Number(so))) startOverride.set(ilvl, Number(so));
        const lvl = w(ov, "lvl");
        if (!lvl) continue;
        const base = levels.get(ilvl) ?? { ilvl, numFmt: null, lvlText: null, start: 1, lvlRestart: null, isLgl: false, suff: null };
        levels.set(ilvl, {
          ...base,
          numFmt: wChildVal(lvl, "numFmt") ?? base.numFmt,
          lvlText: wChildVal(lvl, "lvlText") ?? base.lvlText,
        });
      }

      table.byNumId.set(numId, { numId, abstractNumId: absId, levels, startOverride });
      for (let i = 0; i < 9; i++) {
        fmt.set(`${numId}:${i}`, { numFmt: levels.get(i)?.numFmt ?? null, abstractNumId: absId });
      }
    }
  } catch { /* numbering.xml is never required for text */ }
  return { fmt, table };
}

/**
 * Numbering that lives on the paragraph STYLE rather than on the paragraph.
 *
 * This is how Word numbers headings, and it is the normal case rather than an exotic one:
 * `Heading1`..`Heading9` each carry a `w:numPr` in styles.xml pointing at one shared numId
 * with the matching `w:ilvl`, and the paragraphs in the body carry nothing but
 * `w:pStyle w:val="Heading2"`.
 *
 * Reading only the paragraph's own `w:pPr` therefore misses almost every numbered heading in
 * the world. Measured against the numbers Word itself cached in 14 corpus documents' tables
 * of contents, paragraph-only resolution agreed with Word on 5.3% of 563 headings, and
 * essentially all of the misses were headings we gave no number at all.
 *
 * `w:basedOn` is followed, because a house style is usually `basedOn="Heading2"` and inherits
 * its numbering. The walk is depth-bounded: styles.xml is user data and a cycle in it must
 * not hang the import.
 */
function parseStyleNumbering(bytes: Uint8Array | undefined): Map<string, { numId: string; ilvl: number }> {
  const direct = new Map<string, { numId: string | null; ilvl: number | null; basedOn: string | null }>();
  const out = new Map<string, { numId: string; ilvl: number }>();
  if (!bytes) return out;

  try {
    const ix = XmlIndex.parse(bytes);
    const root = ix.root.children.find((c) => c.local === "styles");
    if (!root) return out;
    for (const st of wAll(root, "style")) {
      const id = attrNS(st, W_NS, "styleId");
      if (!id) continue;
      const pPr = w(st, "pPr");
      const numPr = w(pPr, "numPr");
      const numId = wChildVal(numPr, "numId") ?? null;
      const ilvlRaw = wChildVal(numPr, "ilvl");
      direct.set(id, {
        numId,
        // A style with a numId and no ilvl means level 0 — Heading1 is written that way.
        ilvl: ilvlRaw === undefined ? (numId ? 0 : null) : (Number(ilvlRaw) || 0),
        basedOn: wChildVal(st, "basedOn") ?? null,
      });
    }
  } catch { /* styles.xml is never required for text */ }

  for (const id of direct.keys()) {
    let cur: string | null = id;
    const seen = new Set<string>();
    for (let hops = 0; cur !== null && hops < 16; hops++) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const def: { numId: string | null; ilvl: number | null; basedOn: string | null } | undefined = direct.get(cur);
      if (!def) break;
      if (def.numId !== null && def.numId !== "0") {
        out.set(id, { numId: def.numId, ilvl: def.ilvl ?? 0 });
        break;
      }
      cur = def.basedOn;
    }
  }
  return out;
}

/** The formats `numbering.ts` renders exactly. Everything else falls back to decimal. */
const KNOWN_NUM_FMTS = new Set([
  "decimal", "decimalZero", "upperRoman", "lowerRoman", "upperLetter", "lowerLetter",
  "ordinal", "bullet", "none", "chicago",
]);

/* ------------------------------------------------------------------ comments */

function parseComments(bytes: Uint8Array | undefined): Map<string, { author: string; initials: string | null; date: string | null; text: string; xml: string }> {
  const out = new Map<string, { author: string; initials: string | null; date: string | null; text: string; xml: string }>();
  if (!bytes) return out;
  try {
    const ix = XmlIndex.parse(bytes);
    const root = ix.root.children.find((c) => c.local === "comments");
    for (const c of wAll(root, "comment")) {
      const id = attrNS(c, W_NS, "id");
      if (!id) continue;
      out.set(id, {
        author: attrNS(c, W_NS, "author") ?? "",
        initials: attrNS(c, W_NS, "initials") ?? null,
        date: attrNS(c, W_NS, "date") ?? null,
        text: deepText(c).replace(/\s+/g, " ").trim(),
        xml: ix.raw(c),
      });
    }
  } catch { /* comments are annotations; never fatal */ }
  return out;
}

/* ------------------------------------------------------------------ the importer */

interface RunCtx {
  wrappers: RunWrapper[];
  link: { href: string; title: string | null } | null;
  ins: { revId: string; author: string; date: string | null } | null;
  del: { revId: string; author: string; date: string | null } | null;
  comments: string[];
}

interface ParaBuild {
  inline: PMNode[];
  text: string;
  runs: RunRecord[];
  drawings: string[];
  commentAnchors: Set<string>;
  revisionIds: Set<string>;
  /** True when the paragraph carried a drawing and nothing else. */
  drawingOnly: boolean;
  images: Array<{ src: string; alt: string | null; drawingRef: string }>;
}

export function importDocx(bytes: Uint8Array, options: ImportOptions = {}): ImportResult {
  const t0 = Date.now();
  const ledger = new Ledger();
  const mintAid = options.mintAid ?? (() => newAid());

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (e) {
    throw new DocxImportError(`not a readable zip package: ${(e as Error).message}`, "bad-zip");
  }
  if (!entries["[Content_Types].xml"]) {
    ledger.add({ code: "unsupported-package", severity: "degraded", stage: "import", detail: "no [Content_Types].xml; this may not be an OPC package" });
  }

  const documentPart = findDocumentPart(entries, ledger);
  const documentXml = entries[documentPart]!;
  const relsPart = `${documentPart.slice(0, documentPart.lastIndexOf("/") + 1)}_rels/${documentPart.slice(documentPart.lastIndexOf("/") + 1)}.rels`;
  const rels = parseRels(entries[relsPart]);
  const numbering = parseNumbering(entries["word/numbering.xml"]);
  const styleNumbering = parseStyleNumbering(entries["word/styles.xml"]);
  const commentBodies = parseComments(entries["word/comments.xml"]);
  // Thread structure lives in commentsExtended.xml, not in comments.xml. Reading it is what
  // makes a reply a reply rather than a second unrelated thread on the same sentence.
  const commentThreading = readCommentThreading(entries);

  const ix = XmlIndex.parse(documentXml);
  if (ix.stats.encoding !== "utf-8") {
    ledger.add({ code: "encoding-nonstandard", severity: "info", stage: "import", part: documentPart, detail: `document.xml is ${ix.stats.encoding}; byte offsets account for it` });
  }
  if (ix.stats.foreignNodes > 0) {
    ledger.add({ code: "xml-foreign-nodes", severity: "info", stage: "import", part: documentPart, count: ix.stats.foreignNodes, detail: "XML comments or processing instructions inside document.xml; copied verbatim" });
  }

  const docEl = ix.root.children.find((c) => c.local === "document" && c.uri === W_NS)
    ?? ix.root.children.find((c) => c.local === "document");
  if (!docEl) throw new DocxImportError("document part has no <w:document> root", "no-document-root");
  const body = w(docEl, "body");
  if (!body) throw new DocxImportError("<w:document> has no <w:body>", "no-body");

  const props = new Props();
  const blocks: Record<string, BlockRecord> = {};
  const drawings: Record<string, DrawingRecord> = {};
  const comments: Record<string, CommentThread> = {};
  const revisions: Record<string, RevisionRecord> = {};
  const numberingRecords: Record<string, NumberingRecord> = {};
  const items: BodyItem[] = [];
  const signalInputs: BlockSignalInput[] = [];
  const orderedAids: string[] = [];

  let ordinal = 0;
  const stats = { paragraphs: 0, headings: 0, listItems: 0, tables: 0, runs: 0, drawings: 0 };

  /* -------------------------------------------------- numbering refs */

  const numRefFor = (numId: string, ilvl: number): string => {
    const ref = `n:${numId}:${ilvl}`;
    if (!numberingRecords[ref]) {
      const f = numbering.fmt.get(`${numId}:${ilvl}`);
      numberingRecords[ref] = { ref, numId, ilvl, numFmt: f?.numFmt ?? null, abstractNumId: f?.abstractNumId ?? null };
    }
    return ref;
  };

  /* -------------------------------------------------- drawings */

  const internDrawing = (el: XmlNode): string => {
    const xml = ix.raw(el);
    const ref = `d:${shortHash(xml)}`;
    if (!drawings[ref]) {
      const relIds: string[] = [];
      const targets: string[] = [];
      let cx: number | null = null, cy: number | null = null, alt: string | null = null;
      const walk = (nd: XmlNode): void => {
        for (const a of nd.attrs) {
          if (a.uri === R_NS && (a.local === "embed" || a.local === "link" || a.local === "id")) {
            if (!relIds.includes(a.value)) {
              relIds.push(a.value);
              const rel = rels[a.value];
              if (rel) targets.push(rel.targetMode === "External" ? rel.target : resolveTarget(documentPart, rel.target));
            }
          }
        }
        if (nd.local === "extent" && cx === null) {
          cx = Number(attrNS(nd, "", "cx") ?? "") || null;
          cy = Number(attrNS(nd, "", "cy") ?? "") || null;
        }
        if (nd.local === "docPr" && alt === null) alt = attrNS(nd, "", "descr") ?? attrNS(nd, "", "name") ?? null;
        for (const c of nd.children) walk(c);
      };
      walk(el);
      drawings[ref] = {
        ref, xml, range: [el.start, el.end],
        inline: el.children.some((c) => c.local === "inline"),
        relIds, targets, alt, cx, cy,
      };
      stats.drawings++;
    }
    return ref;
  };

  /* -------------------------------------------------- run-level walk */

  const rPrMarks = (rPr: XmlNode | null): Mark[] => {
    const marks: Mark[] = [];
    if (!rPr) return marks;
    if (wToggle(rPr, "b") || wToggle(rPr, "bCs")) marks.push(schema.marks.strong!.create());
    if (wToggle(rPr, "i") || wToggle(rPr, "iCs")) marks.push(schema.marks.em!.create());
    if (wToggle(rPr, "strike") || wToggle(rPr, "dstrike")) marks.push(schema.marks.strike!.create());
    const u = w(rPr, "u");
    if (u && (wVal(u) ?? "single") !== "none") marks.push(schema.marks.underline!.create());
    const va = wChildVal(rPr, "vertAlign");
    if (va === "superscript") marks.push(schema.marks.superscript!.create());
    else if (va === "subscript") marks.push(schema.marks.subscript!.create());
    return marks;
  };

  const walkInline = (container: XmlNode, ctx: RunCtx, build: ParaBuild): void => {
    for (const c of container.children) {
      if (c.uri !== W_NS) {
        if (c.local === "AlternateContent" || c.uri.includes("markup-compatibility")) {
          // mc:AlternateContent: take the Fallback's text if any, and say so.
          ledger.add({ code: "unmodeled-run-child", severity: "degraded", stage: "import", element: c.name, detail: "markup-compatibility alternate content; kept verbatim in the origin, not modeled inline" });
          const fallback = c.children.find((x) => x.local === "Fallback") ?? c.children.find((x) => x.local === "Choice");
          if (fallback) walkInline(fallback, ctx, build);
        }
        continue;
      }
      switch (c.local) {
        case "r": emitRun(c, ctx, build); break;
        case "hyperlink": {
          const relId = attrNS(c, R_NS, "id");
          const anchor = attrNS(c, W_NS, "anchor");
          const rel = relId ? rels[relId] : undefined;
          const href = rel
            ? (rel.targetMode === "External" ? rel.target : `#${rel.target}`)
            : anchor ? `#${anchor}` : "";
          const wrapper: RunWrapper = { element: c.name, range: [c.start, c.end] };
          if (relId) wrapper.relId = relId;
          if (anchor) wrapper.anchor = anchor;
          walkInline(c, { ...ctx, wrappers: [...ctx.wrappers, wrapper], link: href ? { href, title: attrNS(c, W_NS, "tooltip") ?? null } : ctx.link }, build);
          break;
        }
        case "ins": case "del": case "moveTo": case "moveFrom": {
          const id = attrNS(c, W_NS, "id") ?? "";
          const author = attrNS(c, W_NS, "author") ?? "";
          const date = attrNS(c, W_NS, "date") ?? null;
          const revId = `rev:${c.local}:${id}`;
          revisions[revId] = { revId, kind: c.local as RevisionRecord["kind"], id, author, date, aid: null };
          build.revisionIds.add(revId);
          const wrapper: RunWrapper = { element: c.name, range: [c.start, c.end], revId, author };
          if (date) wrapper.date = date;
          const next: RunCtx = { ...ctx, wrappers: [...ctx.wrappers, wrapper] };
          if (c.local === "ins" || c.local === "moveTo") next.ins = { revId, author, date };
          else next.del = { revId, author, date };
          if (c.local === "moveTo" || c.local === "moveFrom") {
            ledger.add({ code: "revision-unmodeled", severity: "degraded", stage: "import", element: c.name, detail: "move revisions are represented as plain insertions/deletions in the editor" });
          }
          walkInline(c, next, build);
          break;
        }
        case "commentRangeStart": {
          const id = attrNS(c, W_NS, "id");
          if (id) { ctx.comments.push(`c:${id}`); build.commentAnchors.add(`c:${id}`); }
          break;
        }
        case "commentRangeEnd": {
          const id = attrNS(c, W_NS, "id");
          if (id) {
            const k = ctx.comments.lastIndexOf(`c:${id}`);
            if (k >= 0) ctx.comments.splice(k, 1);
          }
          break;
        }
        case "smartTag": case "sdt": case "sdtContent": case "customXml": {
          if (c.local === "sdt") ledger.add({ code: "content-control-unwrapped", severity: "info", stage: "import", element: c.name, detail: "inline content control unwrapped; its content is editable, the control is preserved in the origin" });
          walkInline(c, ctx, build);
          break;
        }
        case "fldSimple": {
          ledger.add({ code: "field-flattened", severity: "degraded", stage: "import", element: c.name, detail: "field kept as its cached result text; the field code lives in the origin" });
          walkInline(c, ctx, build);
          break;
        }
        case "bookmarkStart": case "bookmarkEnd": case "proofErr": case "permStart": case "permEnd":
        case "lastRenderedPageBreak": case "pPr":
          break;
        case "tbl":
          // A table nested inside a paragraph-level container is handled by the block walker.
          break;
        default:
          if (c.children.length > 0 || c.text.length > 0) {
            ledger.add({ code: "unmodeled-run-child", severity: "info", stage: "import", element: c.name, detail: "paragraph child not modeled inline; preserved in the origin" });
          }
          break;
      }
    }
  };

  const emitRun = (r: XmlNode, ctx: RunCtx, build: ParaBuild): void => {
    const rPr = w(r, "rPr");
    const rPrRef = props.intern("rPr", rPr, ix);
    const marks = rPrMarks(rPr);
    if (rPrRef) marks.push(schema.marks.rPrRef!.create({ ref: rPrRef }));
    if (ctx.link) marks.push(schema.marks.link!.create({ href: ctx.link.href, title: ctx.link.title }));
    if (ctx.ins) marks.push(schema.marks.insertion!.create({ revId: ctx.ins.revId, author: ctx.ins.author, date: ctx.ins.date, origin: "user" }));
    if (ctx.del) marks.push(schema.marks.deletion!.create({ revId: ctx.del.revId, author: ctx.del.author, date: ctx.del.date, origin: "user" }));
    for (const cid of ctx.comments) marks.push(schema.marks.comment!.create({ anchorId: cid }));

    const textStart = build.text.length;
    const content: RunContentKind[] = [];
    let preserve = false;
    const runDrawings: string[] = [];
    let contentStart = -1, contentEnd = -1;

    const push = (s: string): void => {
      if (s.length === 0) return;
      build.text += s;
      build.inline.push(schema.text(s, marks));
    };

    for (const c of r.children) {
      if (c.uri !== W_NS) {
        if (c.local === "AlternateContent") {
          const fb = c.children.find((x) => x.local === "Fallback") ?? c.children.find((x) => x.local === "Choice");
          if (fb) for (const g of fb.children) if (g.local === "drawing" || g.local === "pict") { runDrawings.push(internDrawing(g)); content.push("drawing"); }
        }
        continue;
      }
      if (c.local === "rPr") continue;
      if (contentStart < 0) contentStart = c.start;
      contentEnd = c.end;
      switch (c.local) {
        case "t": case "delText":
          if (attrNS(c, XML_NS, "space") === "preserve") preserve = true;
          push(c.text);
          content.push("text");
          break;
        case "tab": push("\t"); content.push("tab"); break;
        case "br": {
          const type = attrNS(c, W_NS, "type");
          if (type === "page" || type === "column") { push(" "); }
          else { build.inline.push(schema.nodes.hard_break!.create(null, null, marks)); build.text += "\n"; }
          content.push("break");
          break;
        }
        case "cr": build.inline.push(schema.nodes.hard_break!.create(null, null, marks)); build.text += "\n"; content.push("break"); break;
        case "noBreakHyphen": push("‑"); content.push("text"); break;
        case "softHyphen": content.push("softHyphen"); break;
        case "drawing": case "pict": {
          runDrawings.push(internDrawing(c));
          content.push(c.local === "drawing" ? "drawing" : "picture");
          break;
        }
        case "object":
          content.push("object");
          ledger.add({ code: "unmodeled-run-child", severity: "degraded", stage: "import", element: c.name, detail: "embedded OLE object: preserved in the origin, invisible in the editor" });
          break;
        case "sym":
          content.push("symbol");
          ledger.add({ code: "unmodeled-run-child", severity: "degraded", stage: "import", element: c.name, detail: "symbol-font character: preserved in the origin, not shown inline" });
          break;
        case "instrText": content.push("instrText"); break;
        case "fldChar": content.push("fieldChar"); break;
        case "footnoteReference": case "endnoteReference":
          content.push(c.local === "footnoteReference" ? "footnoteRef" : "endnoteRef");
          ledger.add({ code: "footnote-reference", severity: "degraded", stage: "import", element: c.name, detail: "note reference kept as an anchor; the note body lives in another part and is not editable" });
          break;
        case "commentReference": content.push("commentRef"); break;
        default: content.push("other"); break;
      }
    }

    if (runDrawings.length > 0) build.drawings.push(...runDrawings);

    const rec: RunRecord = {
      range: [r.start, r.end],
      element: r.name,
      rPrRef,
      rPrRange: rPr ? [rPr.start, rPr.end] : null,
      contentRange: contentStart >= 0 ? [contentStart, contentEnd] : null,
      textStart,
      textLen: build.text.length - textStart,
      content,
      preserveSpace: preserve,
      wrappers: ctx.wrappers,
    };
    if (runDrawings.length > 0) rec.drawingRefs = runDrawings;
    build.runs.push(rec);
    stats.runs++;
  };

  /* -------------------------------------------------- paragraph -> block */

  interface ParaInfo {
    aid: string;
    kind: BlockKind;
    level: number | null;
    numId: string | null;
    ilvl: number;
    numRef: string | null;
    styleId: string | null;
    node: PMNode;
    record: BlockRecord;
  }

  const importParagraph = (p: XmlNode): ParaInfo => {
    const aid = mintAid(ordinal);
    const pPr = w(p, "pPr");
    const pPrRef = props.intern("pPr", pPr, ix);
    const styleId = wChildVal(pPr, "pStyle") ?? null;
    const numPr = w(pPr, "numPr");
    let numId = wChildVal(numPr, "numId") ?? null;
    let ilvl = Number(wChildVal(numPr, "ilvl") ?? "0") || 0;
    // Direct numbering wins; otherwise the paragraph's style supplies it. Heading numbering
    // almost always arrives this second way — see `parseStyleNumbering`.
    if (numId === null && styleId) {
      const fromStyle = styleNumbering.get(styleId);
      if (fromStyle) { numId = fromStyle.numId; ilvl = fromStyle.ilvl; }
    }
    // A numId of 0 means "no numbering" in OOXML, not "list zero".
    const listed = numId !== null && numId !== "0";
    const numRef = listed && numId !== null ? numRefFor(numId, ilvl) : null;

    const sectPr = w(pPr, "sectPr");
    if (sectPr) props.intern("sectPr", sectPr, ix);

    let level: number | null = null;
    const headingMatch = styleId ? /^heading\s*([1-9])$/i.exec(styleId) : null;
    if (headingMatch) level = Number(headingMatch[1]);
    else {
      const outline = wChildVal(pPr, "outlineLvl");
      if (outline !== undefined && !listed) {
        const n = Number(outline);
        if (Number.isFinite(n) && n >= 0 && n <= 8) level = n + 1;
      }
    }

    const build: ParaBuild = {
      inline: [], text: "", runs: [], drawings: [],
      commentAnchors: new Set(), revisionIds: new Set(),
      drawingOnly: false, images: [],
    };
    walkInline(p, { wrappers: [], link: null, ins: null, del: null, comments: [] }, build);

    const hasText = build.text.trim().length > 0;
    build.drawingOnly = build.drawings.length > 0 && !hasText;

    let kind: BlockKind;
    let node: PMNode;
    if (build.drawingOnly) {
      // The sidecar kind describes the ORIGIN block — a Word paragraph whose only content is
      // a drawing — while the node below is a plain paragraph holding an inline image. They
      // are deliberately different: the exporter keys its verbatim-copy path on the origin
      // shape, and collapsing the two made it rebuild every drawing block instead of copying
      // it, which took T0 from 60/60 byte-identical to 54/60.
      kind = "figure";
      const ref = build.drawings[0]!;
      const d = drawings[ref]!;
      const part = d.targets[0] ?? "";
      const src = part === "" ? "" : mediaSrc(part, entries, ledger, aid);
      // A drawing with no picture relationship is a chart, a shape or a text box — there is
      // no image to show. Emitting an image node with an empty src put a broken-image icon in
      // the document for every one of them. The paragraph stays (so the anchor, its
      // properties and its place in the flow survive for export) and the loss is recorded.
      const children = src === ""
        ? []
        : [schema.nodes.image!.create({ src, alt: d.alt, title: null, drawingRef: ref })];
      if (children.length === 0) {
        ledger.add({
          code: "media-not-inlined", severity: "degraded", stage: "import", aid,
          detail: "drawing has no picture relationship (chart, shape or text box): nothing to display",
        });
      }
      // A paragraph holding one inline image, NOT a figure wrapping a block image. `figure`
      // takes block content, and images are inline: the previous shape produced a document
      // that violated its own schema, which `create` does not validate and so nothing caught.
      node = schema.nodes.paragraph!.create({ aid, styleId, pPrRef }, children);
    } else {
      if (build.drawings.length > 0) {
        ledger.add({
          code: "inline-drawing-detached", severity: "degraded", stage: "import", aid,
          count: build.drawings.length,
          detail: "drawing inside a paragraph that also has text: kept in the sidecar and the origin, not shown inline",
        });
      }
      if (level !== null) {
        kind = "heading";
        node = schema.nodes.heading!.create({ aid, level, styleId, pPrRef }, build.inline);
        stats.headings++;
      } else if (listed) {
        kind = "list_item";
        node = schema.nodes.paragraph!.create({ aid, styleId, pPrRef }, build.inline);
        stats.listItems++;
      } else {
        kind = "paragraph";
        node = schema.nodes.paragraph!.create({ aid, styleId, pPrRef }, build.inline);
        stats.paragraphs++;
      }
    }

    for (const rev of build.revisionIds) if (revisions[rev]) revisions[rev]!.aid = aid;

    const record: BlockRecord = {
      aid, kind, element: p.name, ordinal,
      range: [p.start, p.end],
      contentRange: [p.contentStart, p.contentEnd],
      pPrRange: pPr ? [pPr.start, pPr.end] : null,
      styleId, pPrRef, numRef, level,
      listLevel: listed ? ilvl : null,
      runs: build.runs,
      text: build.text,
    };
    if (build.commentAnchors.size > 0) record.commentAnchors = [...build.commentAnchors];
    if (build.revisionIds.size > 0) record.revisionIds = [...build.revisionIds];
    blocks[aid] = record;
    signalInputs.push({ kind, text: build.text, level, listRef: numRef, listLevel: record.listLevel, styleId, aid });
    orderedAids.push(aid);
    ordinal++;

    return { aid, kind, level, numId: listed ? numId : null, ilvl, numRef, styleId, node, record };
  };

  /* -------------------------------------------------- table -> block */

  const importTable = (tbl: XmlNode, depth: number): { node: PMNode | null; record: BlockRecord; flattened: PMNode[] } => {
    const aid = mintAid(ordinal);
    const tblPr = w(tbl, "tblPr");
    const tblPrRef = props.intern("tblPr", tblPr, ix);
    const gridEl = w(tbl, "tblGrid");
    const grid = wAll(gridEl, "gridCol").map((g) => Number(attrNS(g, W_NS, "w") ?? "0") || 0);
    if (depth > 0) {
      ledger.add({ code: "nested-table", severity: "degraded", stage: "import", aid, detail: `table nested ${depth} deep; geometry is approximated in the editor` });
    }

    const rowsXml = wAll(tbl, "tr");
    const rowRecords: TableRowRecord[] = [];
    const childAids: string[] = [];
    const pmRows: PMNode[] = [];
    const flattened: PMNode[] = [];
    let tableOk = rowsXml.length > 0;

    // Column occupancy for vertical merges: a `continue` cell is covered by the `restart`
    // above it and must be omitted from the ProseMirror table entirely.
    const pending: Array<{ col: number; span: number; cellNodeIndex: number; rowIndex: number }> = [];
    const rowspanOf = new Map<string, number>();

    for (let ri = 0; ri < rowsXml.length; ri++) {
      const tr = rowsXml[ri]!;
      const trPr = w(tr, "trPr");
      const trPrRef = props.intern("trPr", trPr, ix);
      const cellsXml = wAll(tr, "tc");
      const cellRecords: TableCellRecord[] = [];
      const pmCells: PMNode[] = [];
      let col = 0;

      for (const tc of cellsXml) {
        const cellAid = mintAid(ordinal);
        const tcPr = w(tc, "tcPr");
        const tcPrRef = props.intern("tcPr", tcPr, ix);
        const gridSpan = Number(wChildVal(tcPr, "gridSpan") ?? "1") || 1;
        const vMergeEl = w(tcPr, "vMerge");
        const vMerge = vMergeEl ? (wVal(vMergeEl) ?? "continue") : null;

        const inner: PMNode[] = [];
        const innerAids: string[] = [];
        for (const child of tc.children) {
          if (child.uri !== W_NS) continue;
          if (child.local === "p") {
            const pi = importParagraph(child);
            inner.push(pi.node);
            innerAids.push(pi.aid);
          } else if (child.local === "tbl") {
            const t = importTable(child, depth + 1);
            if (t.node) { inner.push(t.node); innerAids.push(t.record.aid); }
            else inner.push(...t.flattened);
          }
        }
        if (inner.length === 0) inner.push(schema.nodes.paragraph!.create({ aid: mintAid(ordinal) }));

        cellRecords.push({ aid: cellAid, range: [tc.start, tc.end], tcPrRef, children: innerAids, gridSpan, vMerge });

        if (vMerge === "continue") {
          // Covered by a restart above: extend that cell's rowspan and emit nothing here.
          const owner = pending.find((p) => p.col === col);
          if (owner) {
            const key = `${owner.rowIndex}:${owner.cellNodeIndex}`;
            rowspanOf.set(key, (rowspanOf.get(key) ?? 1) + 1);
          } else {
            tableOk = false;
          }
          col += gridSpan;
          continue;
        }
        if (vMerge === "restart") {
          pending.push({ col, span: gridSpan, cellNodeIndex: pmCells.length, rowIndex: pmRows.length });
        }
        try {
          pmCells.push(schema.nodes.table_cell!.create({ colspan: gridSpan, rowspan: 1, colwidth: null, tcPrRef }, inner));
        } catch {
          tableOk = false;
          flattened.push(...inner);
        }
        col += gridSpan;
      }

      rowRecords.push({ aid: mintAid(ordinal), range: [tr.start, tr.end], trPrRef, cells: cellRecords });
      if (pmCells.length > 0) {
        try { pmRows.push(schema.nodes.table_row!.create(null, pmCells)); }
        catch { tableOk = false; }
      }
      for (const cr of cellRecords) childAids.push(cr.aid);
    }

    // Apply the rowspans computed from vMerge continuations.
    if (rowspanOf.size > 0) {
      for (let ri = 0; ri < pmRows.length; ri++) {
        const row = pmRows[ri]!;
        const cells: PMNode[] = [];
        let changed = false;
        row.forEach((cell, _o, ci) => {
          const rs = rowspanOf.get(`${ri}:${ci}`);
          if (rs && rs > 1) { cells.push(cell.type.create({ ...cell.attrs, rowspan: rs }, cell.content, cell.marks)); changed = true; }
          else cells.push(cell);
        });
        if (changed) { try { pmRows[ri] = row.type.create(row.attrs, cells, row.marks); } catch { tableOk = false; } }
      }
      ledger.add({ code: "vmerge-approximated", severity: "degraded", stage: "import", aid, detail: "vertical cell merges mapped to rowspans; Word's own layout may differ" });
    }

    const record: BlockRecord = {
      aid, kind: "table", element: tbl.name, ordinal,
      range: [tbl.start, tbl.end],
      contentRange: [tbl.contentStart, tbl.contentEnd],
      pPrRange: null,
      styleId: wChildVal(tblPr, "tblStyle") ?? null,
      pPrRef: null, numRef: null, level: null, listLevel: null,
      runs: [],
      text: deepText(tbl).replace(/\s+/g, " ").trim().slice(0, 4096),
      children: childAids,
      table: { tblPrRef, grid, rows: rowRecords, depth },
    };
    blocks[aid] = record;
    signalInputs.push({ kind: "table", text: record.text, level: null, listRef: null, listLevel: null, styleId: record.styleId, aid });
    orderedAids.push(aid);
    ordinal++;
    stats.tables++;

    let node: PMNode | null = null;
    if (tableOk && pmRows.length > 0) {
      try { node = schema.nodes.table!.create(null, pmRows); } catch { node = null; }
    }
    if (!node) {
      ledger.add({ code: "nested-table", severity: "degraded", stage: "import", aid, detail: "table geometry could not be represented; its cell paragraphs are kept as flat blocks" });
      const flat: PMNode[] = flattened.slice();
      for (const row of pmRows) row.forEach((cell) => cell.forEach((b) => flat.push(b)));
      return { node: null, record, flattened: flat };
    }
    return { node, record, flattened: [] };
  };

  /* -------------------------------------------------- body walk */

  let tableAlerted = false;
  const topLevel: PMNode[] = [];
  /** Consecutive numbered paragraphs, buffered so they can be nested into real lists. */
  let listBuf: ParaInfo[] = [];

  const flushList = (): void => {
    if (listBuf.length === 0) return;
    topLevel.push(...buildLists(listBuf, numberingRecords));
    listBuf = [];
  };

  const cursor = { at: body.contentStart };
  const pushOpaque = (to: number, element: string): void => {
    if (to > cursor.at) items.push({ kind: "opaque", element, range: [cursor.at, to] });
    cursor.at = to;
  };

  const walkBody = (container: XmlNode): void => {
    for (const c of container.children) {
      if (c.uri !== W_NS) { continue; }
      if (c.local === "p") {
        pushOpaque(c.start, "#text");
        const pi = importParagraph(c);
        items.push({ kind: "block", element: c.name, range: [c.start, c.end], aid: pi.aid });
        cursor.at = c.end;
        // A numbered HEADING is a heading, not a list item: list_item requires a
        // paragraph as its first child, and a numbered Heading1 is still a heading.
        if (pi.kind === "list_item") listBuf.push(pi);
        else { flushList(); topLevel.push(pi.node); }
      } else if (c.local === "tbl") {
        pushOpaque(c.start, "#text");
        flushList();
        const t = importTable(c, 0);
        items.push({ kind: "block", element: c.name, range: [c.start, c.end], aid: t.record.aid });
        cursor.at = c.end;
        if (t.node) topLevel.push(t.node);
        else topLevel.push(...t.flattened);
        if (!tableAlerted) {
          tableAlerted = true;
          ledger.add({
            code: "table-identity-unbacked", severity: "degraded", stage: "import",
            detail: "prosemirror-tables nodes carry no `aid` attribute, so table identity lives only in the sidecar and is recovered by alignment on reload",
          });
        }
      } else if (c.local === "sdt") {
        // Unwrap: the content is editable, the control itself is preserved by the origin bytes.
        ledger.add({ code: "content-control-unwrapped", severity: "info", stage: "import", element: c.name, detail: "block-level content control unwrapped" });
        const content = w(c, "sdtContent");
        if (content) walkBody(content);
      } else if (c.local === "altChunk") {
        pushOpaque(c.end, c.name);
        ledger.add({ code: "alt-chunk", severity: "dropped", stage: "import", element: c.name, detail: "w:altChunk foreign content is preserved in the origin but is not imported and cannot be edited" });
      } else {
        // sectPr, bookmarkStart/End, commentRangeStart/End, proofErr, customXml wrappers...
        if (c.local === "sectPr") props.intern("sectPr", c, ix);
        else if (c.local !== "bookmarkStart" && c.local !== "bookmarkEnd" && c.local !== "proofErr"
          && c.local !== "commentRangeStart" && c.local !== "commentRangeEnd") {
          ledger.add({ code: "unmodeled-body-element", severity: "info", stage: "import", element: c.name, detail: "body-level element carried verbatim in the origin, not modeled" });
        }
        pushOpaque(c.end, c.name);
      }
    }
  };

  walkBody(body);
  flushList();
  pushOpaque(body.contentEnd, "#text");

  if (topLevel.length === 0) topLevel.push(schema.nodes.paragraph!.create({ aid: mintAid(0) }));

  let doc: PMNode;
  try {
    doc = schema.nodes.doc!.create(null, topLevel);
  } catch (e) {
    throw new DocxImportError(`document model rejected the imported content: ${(e as Error).message}`, "invalid-doc");
  }

  /* -------------------------------------------------- comments */

  // A comment range may cover several paragraphs; the thread binds to the FIRST of them, so
  // this loop must run in DOCUMENT ORDER. `Object.entries(blocks)` is not document order.
  //
  // Aids are minted fresh on every import, and about one in 1,500 comes out as an all-digit
  // string like "66030358" (measured: 4 integer-like aids across 6,015 corpus blocks).
  // JavaScript hoists integer-like keys to the FRONT of an object's key order, ascending
  // numerically, so those blocks teleport to the top of the iteration — a different few on
  // every run, because the aids are random. A multi-paragraph comment could therefore bind to
  // a later paragraph than the one it starts on, silently and nondeterministically.
  //
  // `orderedAids` is the importer's own record of document order and is what the numbering
  // pass below and the anchor pass already use. Table children are pushed before their table,
  // which does not matter here: only paragraphs carry `commentAnchors`, and paragraphs are in
  // true document order relative to one another.
  const commentToBlock = new Map<string, string>();
  for (const aid of orderedAids) {
    const rec = blocks[aid];
    if (!rec) continue;
    for (const anchorId of rec.commentAnchors ?? []) if (!commentToBlock.has(anchorId)) commentToBlock.set(anchorId, aid);
  }
  for (const [id, body_] of commentBodies) {
    const anchorId = `c:${id}`;
    const aid = commentToBlock.get(anchorId) ?? null;
    if (!aid) {
      ledger.add({ code: "comment-orphan", severity: "degraded", stage: "import", detail: `comment ${id} has no range in the document body; it will not be shown` });
    }
    const threading = commentThreading.get(id);
    comments[anchorId] = {
      anchorId, commentIds: [id],
      author: body_.author, initials: body_.initials, date: body_.date,
      text: body_.text, xml: body_.xml,
      resolved: threading?.resolved ?? false,
      // The parent pointer is a paraId; the sidecar speaks anchorIds. Resolved in a second
      // pass below, once every comment's paraId is known.
      parentAnchorId: null,
      paraId: threading?.paraId ?? null,
      durableId: threading?.durableId ?? null,
      aid, span: null,
    };
  }

  // paraId -> anchorId, so `w15:paraIdParent` can become something the rest of the app can use.
  {
    const byParaId = new Map<string, string>();
    for (const t of Object.values(comments)) if (t.paraId) byParaId.set(t.paraId, t.anchorId);
    for (const t of Object.values(comments)) {
      const parentParaId = commentThreading.get(t.commentIds[0]!)?.paraIdParent;
      if (!parentParaId) continue;
      const parent = byParaId.get(parentParaId);
      if (parent) t.parentAnchorId = parent;
      else ledger.add({ code: "comment-orphan", severity: "info", stage: "import", detail: `${t.anchorId} replies to paraId ${parentParaId}, which is not a comment in this document; shown as a top-level thread` });
    }
  }
  for (const anchorId of commentToBlock.keys()) {
    if (!comments[anchorId]) {
      ledger.add({ code: "comment-orphan", severity: "degraded", stage: "import", detail: `${anchorId} is anchored in the body but has no thread in word/comments.xml` });
    }
  }

  /* -------------------------------------------------- numbering labels */
  //
  // The number a reader sees in front of a heading or list item — "1.", "2.1", "iv".
  //
  // Computed here rather than at each paragraph because a label depends on every numbered
  // paragraph BEFORE it: counters advance and restart in document order, so a per-paragraph
  // decision cannot know what "2.1" should be. `orderedAids` is that document order.
  //
  // Nothing here changes the document. The label goes in the sidecar, is drawn as a
  // decoration, and never becomes text — see the note on `BlockRecord.numLabel`.
  {
    const numbered: { aid: string; numId: string; ilvl: number }[] = [];
    for (const aid of orderedAids) {
      const rec = blocks[aid];
      if (!rec?.numRef) continue;
      // `numRef` is minted as `n:<numId>:<ilvl>` by `numRefFor`.
      const parts = rec.numRef.split(":");
      if (parts.length !== 3) continue;
      numbered.push({ aid, numId: parts[1]!, ilvl: Number(parts[2]) || 0 });
    }

    const labels = computeLabels(numbering.table, numbered);
    let labelled = 0;
    for (let i = 0; i < numbered.length; i++) {
      const label = labels[i] ?? null;
      blocks[numbered[i]!.aid]!.numLabel = label;
      if (label !== null) labelled++;
    }

    const unnumbered = numbered.length - labelled;
    if (unnumbered > 0) {
      ledger.add({
        code: "numbering-unlabelled", severity: "degraded", stage: "import", count: unnumbered,
        detail: "blocks carry w:numPr but numbering.xml does not define a label for them; they are shown without a number",
      });
    }
    if (numbering.table.unmodeled.length > 0) {
      const kinds = [...new Set(numbering.table.unmodeled)];
      ledger.add({
        code: "numbering-format-approximated", severity: "degraded", stage: "import",
        count: numbering.table.unmodeled.length,
        detail: `number formats shown as decimals because they are not modelled: ${kinds.join(", ")}`,
      });
    }
  }

  /* -------------------------------------------------- anchors */

  const prepared = prepareBlocks(signalInputs);
  const anchors: Record<string, Anchor> = {};
  for (let i = 0; i < prepared.length; i++) anchors[orderedAids[i]!] = anchorOf(prepared[i]!, orderedAids[i]!);

  /* -------------------------------------------------- assemble */

  const partNames = Object.keys(entries);
  const parts: PartRef[] = partNames.map((name) => ({
    name,
    bytes: entries[name]!.length,
    sha256: options.hashParts === true ? sha256Hex(entries[name]!) : "",
  }));

  const frame: DocumentFrame = {
    part: documentPart,
    bytes: documentXml.length,
    bodyContent: [body.contentStart, body.contentEnd],
    prologue: [0, body.contentStart],
    epilogue: [body.contentEnd, documentXml.length],
    items,
  };

  const sidecar: FidelitySidecar = {
    version: SIDECAR_VERSION,
    kind: SIDECAR_KIND,
    generator: "@scriv/ooxml",
    createdAt: options.now ?? new Date().toISOString(),
    origin: {
      docxSha256: sha256Hex(bytes),
      docxBytes: bytes.length,
      documentPart,
      documentXmlBytes: documentXml.length,
      documentXmlSha256: sha256Hex(documentXml),
      encoding: ix.stats.encoding,
      bomBytes: ix.stats.bomBytes,
      zipEntryCount: partNames.length,
    },
    parts,
    rels: Object.fromEntries(Object.entries(rels).map(([k, v]) => [k, { type: v.type, target: v.target, targetMode: v.targetMode }])),
    document: frame,
    props: props.store,
    blocks,
    anchors,
    numbering: numberingRecords,
    drawings,
    comments,
    revisions,
    ledger: [],
    stats: {
      blocks: Object.keys(blocks).length,
      paragraphs: stats.paragraphs,
      headings: stats.headings,
      listItems: stats.listItems,
      tables: stats.tables,
      runs: stats.runs,
      drawings: stats.drawings,
      comments: Object.keys(comments).length,
      revisions: Object.keys(revisions).length,
      distinctProps: props.counts(),
      importMs: Date.now() - t0,
    },
  };
  sidecar.ledger = ledger.entries();

  const origin: DocxOrigin = {
    bytes,
    sha256: sidecar.origin.docxSha256,
    entries: partNames.map((name) => ({ name, bytes: entries[name]! })),
    documentPart,
    documentXml,
  };

  return { doc, sidecar, origin, ledger: sidecar.ledger };
}

/* ------------------------------------------------------------------ list nesting */

interface ListParaLike { ilvl: number; numId: string | null; numRef: string | null; node: PMNode; aid: string }

/**
 * Turn a run of consecutive numbered paragraphs into nested `bullet_list` / `ordered_list`.
 *
 * Word has no list element - it has paragraphs that mention a numbering definition. Nesting is
 * implied by `w:ilvl`, which in real documents jumps by more than one and changes format
 * mid-list, so this tolerates both rather than assuming well-formed input.
 *
 * The `aid` stays on the inner paragraph, which is the unit the splice engine rewrites: one
 * `w:p` in, one `w:p` out. The list and list_item wrappers are pure editor structure and take
 * their identity from the editor's own aid plugin.
 */
function buildLists(items: readonly ListParaLike[], numbering: Record<string, NumberingRecord>): PMNode[] {
  const isBullet = (ref: string | null): boolean => {
    if (!ref) return true;
    const fmt = numbering[ref]?.numFmt;
    if (fmt === null || fmt === undefined) return false;
    return fmt === "bullet" || fmt === "none";
  };
  const lvl = (x: ListParaLike): number => Math.max(0, Math.min(8, x.ilvl));

  const level = (from: number, depth: number): { list: PMNode; next: number } => {
    const bullet = isBullet(items[from]!.numRef);
    const lis: PMNode[] = [];
    let i = from;
    while (i < items.length) {
      const d = lvl(items[i]!);
      if (d < depth) break;
      if (d === depth) {
        if (isBullet(items[i]!.numRef) !== bullet) break;
        lis.push(schema.nodes.list_item!.create(null, [items[i]!.node]));
        i++;
      } else {
        const sub = level(i, d);
        i = sub.next;
        const last = lis.pop();
        if (last) lis.push(last.type.create(last.attrs, last.content.addToEnd(sub.list), last.marks));
        else lis.push(schema.nodes.list_item!.create(null, [schema.nodes.paragraph!.create(null), sub.list]));
      }
    }
    const type = bullet ? schema.nodes.bullet_list! : schema.nodes.ordered_list!;
    return { list: type.create(bullet ? {} : { start: 1 }, lis), next: i };
  };

  const out: PMNode[] = [];
  let i = 0;
  while (i < items.length) {
    const r = level(i, lvl(items[i]!));
    if (r.next <= i) { out.push(items[i]!.node); i++; continue; }
    out.push(r.list);
    i = r.next;
  }
  return out;
}
