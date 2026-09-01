/**
 * .docx export — the splice engine (DOCX-FIDELITY.md §4).
 *
 * The one sentence this file exists to make true: **on export we do not build a docx, we edit
 * one.** Every byte of the origin package that we cannot prove needs to change is carried
 * through untouched, and "prove" means "the block's own text or inline formatting differs from
 * what we imported", not "we have a serializer for it".
 *
 * The consequence is an inversion of the usual fidelity question. We never ask "can we model
 * this?" — numbering, styles, headers, footers, footnotes, themes, fonts, settings and embedded
 * media are never parsed here, so nothing in this file can break them. We only ask "which byte
 * ranges must move?", and the answer is a set of `<w:p>` ranges, usually one.
 *
 * Four levels of intervention, in strict order of preference. Each level is a strictly larger
 * blast radius than the one above it, and every drop to a lower level is a ledger entry:
 *
 *   0. UNCHANGED       copy `originBytes[block.range]` verbatim. Same run splits, same rPr,
 *                      same rsids, same proofing state, same everything.
 *   1. RUN SPLICE      text changed, structure did not. Rewrite the character data of the
 *                      `w:t` leaves the edit actually touched. Every other byte of the
 *                      paragraph — pPr, rPr, bookmarks, comment ranges, the runs either side
 *                      of the edit — is still original.
 *   2. REBUILD         inline structure changed (marks, breaks, a paste). Regenerate the run
 *                      sequence from the doc model, reusing stored `rPr` blobs by reference and
 *                      preserving verbatim every run that carries a drawing, field or note
 *                      reference.
 *   3. SYNTHESIZE      a block with no origin at all. Inherit `pPr` from the block it was split
 *                      from (the aid lineage) or from the paragraph style it maps to.
 *
 * And one more, orthogonal: a block present at import and absent now is OMITTED, or wrapped as
 * a `w:del` revision when tracked-changes mode is on.
 *
 * Pure logic. No node:fs, no fetch. The caller supplies the origin bytes.
 */

import type { Node as PMNode, Mark } from "prosemirror-model";
import {
  XmlIndex, W_NS, R_NS, XML_NS,
  w, attrNS, wVal, wChildVal, wToggle,
  type XmlNode,
} from "./xmlindex.ts";
import { Ledger, type LedgerEntry } from "./ledger.ts";
import { spliceZip, ZipError } from "./zip.ts";
import type {
  BlockRecord, ByteRange, FidelitySidecar, PropBlob,
} from "./sidecar.ts";
import type { DocxOrigin } from "./import.ts";

/* ------------------------------------------------------------------ public surface */

export interface TrackedChangesOptions {
  author: string;
  /** ISO-8601. Word tolerates its absence but every real revision carries one. */
  date?: string | null;
  /** First `w:id` to mint. Ids only have to be unique within the document. */
  firstId?: number;
}

export interface ExportOptions {
  /**
   * When set, deletions become real Word revisions (`w:del` + `w:delText`) instead of being
   * omitted, and synthesized content becomes `w:ins`. Off by default: a plain export of an
   * edited document should contain the edited text, not a document full of pending revisions.
   */
  trackedChanges?: TrackedChangesOptions | null;
  /** Deflate level for the parts that had to be rewritten. Correctness-neutral. */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

export interface ExportStats {
  /** Blocks the sidecar knew about, excluding tables (whose paragraphs are counted instead). */
  blocks: number;
  copied: number;
  runSpliced: number;
  rebuilt: number;
  synthesized: number;
  deleted: number;
  /** Bytes of `word/document.xml` that came straight from the origin. */
  bytesCopied: number;
  bytesGenerated: number;
  documentXmlIdentical: boolean;
  packageIdentical: boolean;
  partsRewritten: string[];
  exportMs: number;
}

export interface ExportResult {
  /** The complete .docx package. */
  bytes: Uint8Array;
  /** The spliced main document part, for callers that want to diff it directly. */
  documentXml: Uint8Array;
  ledger: LedgerEntry[];
  stats: ExportStats;
}

export class DocxExportError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "DocxExportError";
  }
}

/* ------------------------------------------------------------------ text of a doc-model block */

/**
 * The plain text of a block, computed exactly the way the importer computed `BlockRecord.text`.
 *
 * This equality is the hinge of the whole engine: if these two strings agree the block is
 * copied verbatim, so a divergence between this function and the importer's accumulator would
 * either regenerate everything (slow, lossy) or regenerate nothing (silently dropping edits).
 * Import pushes `\t` for `w:tab` and `\n` for `w:br`/`w:cr` into the same buffer it pushes
 * `w:t` into, so both live here as ordinary characters.
 */
export function blockText(node: PMNode): string {
  let s = "";
  node.forEach((child) => {
    if (child.isText) s += child.text ?? "";
    else if (child.type.name === "hard_break") s += "\n";
    else if (child.isTextblock) s += blockText(child);
  });
  return s;
}

/* ------------------------------------------------------------------ inline signature */

/**
 * A block's inline formatting, reduced to a sequence of `(markKey, length)` segments.
 *
 * Comparing text alone would let "the user made this sentence bold" pass as unchanged, and the
 * block would be copied verbatim — a silently dropped edit, which is the exact failure mode
 * DOCX-FIDELITY.md §3 calls worse than visible loss. So the classifier compares text AND this.
 *
 * The two sides are computed from different materials on purpose: the current side from
 * ProseMirror marks, the origin side from the original XML. They agree when nothing changed
 * because the importer derived those marks from that XML by the same rules, which are restated
 * in `rPrMarkKey` below.
 */
interface Seg { key: string; len: number }

function pushSeg(out: Seg[], key: string, len: number): void {
  if (len <= 0) return;
  const last = out[out.length - 1];
  if (last && last.key === key) last.len += len;
  else out.push({ key, len });
}

const MODELED_MARKS = new Set([
  "strong", "em", "strike", "underline", "superscript", "subscript", "code",
]);

function markKeyOfMarks(marks: readonly Mark[]): string {
  const parts: string[] = [];
  for (const m of marks) {
    const t = m.type.name;
    if (MODELED_MARKS.has(t)) parts.push(t);
    else if (t === "rPrRef") parts.push(`rPr=${m.attrs.ref}`);
    else if (t === "link") parts.push(`link=${m.attrs.href}`);
    else if (t === "insertion") parts.push(`ins=${m.attrs.revId}`);
    else if (t === "deletion") parts.push(`del=${m.attrs.revId}`);
    else if (t === "comment") parts.push(`cmt=${m.attrs.anchorId}`);
  }
  return parts.sort().join("|");
}

function currentSegments(node: PMNode): Seg[] {
  const out: Seg[] = [];
  node.forEach((child) => {
    if (child.isText) pushSeg(out, markKeyOfMarks(child.marks), (child.text ?? "").length);
    else if (child.type.name === "hard_break") pushSeg(out, markKeyOfMarks(child.marks), 1);
  });
  return out;
}

/**
 * The mark key the importer would have produced for a run with this `w:rPr`.
 *
 * Deliberately a restatement rather than a shared helper: `import.ts` is a built, tested module
 * and this file is not allowed to reshape it. The duplication is real and is the most likely
 * place for the two to drift; the T0 tier catches drift immediately, because any disagreement
 * shows up as a paragraph regenerated on a document nobody edited.
 */
function rPrMarkKey(rPr: XmlNode | null, rPrRef: string | null): string[] {
  const parts: string[] = [];
  if (rPr) {
    if (wToggle(rPr, "b") || wToggle(rPr, "bCs")) parts.push("strong");
    if (wToggle(rPr, "i") || wToggle(rPr, "iCs")) parts.push("em");
    if (wToggle(rPr, "strike") || wToggle(rPr, "dstrike")) parts.push("strike");
    const u = w(rPr, "u");
    if (u && (wVal(u) ?? "single") !== "none") parts.push("underline");
    const va = wChildVal(rPr, "vertAlign");
    if (va === "superscript") parts.push("superscript");
    else if (va === "subscript") parts.push("subscript");
  }
  if (rPrRef) parts.push(`rPr=${rPrRef}`);
  return parts;
}

/* ------------------------------------------------------------------ origin paragraph model */

/**
 * A character-data leaf inside a paragraph, located in both text space and byte space.
 *
 * `rewritable` is false for tabs, breaks and anything else whose text position is occupied by
 * an element that is not a `w:t` — the run splice refuses to touch a region that contains one,
 * because "replace the characters" is only meaningful where the characters are characters.
 */
interface Leaf {
  node: XmlNode;
  /** Offsets into the paragraph's plain text. */
  from: number;
  to: number;
  rewritable: boolean;
  run: XmlNode;
}

interface OriginPara {
  p: XmlNode;
  text: string;
  leaves: Leaf[];
  segs: Seg[];
  /** Runs whose content is exclusively text/tab/break — the ones a rebuild may discard. */
  textOnlyRuns: Set<XmlNode>;
  /** True when any run carries a drawing, object, field or note reference. */
  hasOpaqueContent: boolean;
  commentIds: string[];
}

/**
 * Wrapper keys behave like ProseMirror marks, not like a stack: a document may nest one
 * `w:hyperlink` inside another (Word emits this around field results), and the importer keeps a
 * single `link` mark whose value is the innermost href. Appending instead of replacing would
 * produce `link=X|link=X` and report a formatting change on a document nobody touched.
 */
function withKey(keys: readonly string[], prefix: string, value: string): string[] {
  return [...keys.filter((k) => !k.startsWith(prefix)), `${prefix}${value}`];
}

const RUN_CONTAINERS = new Set(["hyperlink", "ins", "del", "moveTo", "moveFrom", "smartTag", "sdt", "sdtContent", "customXml", "fldSimple"]);

/**
 * Walk a `w:p` exactly as the importer walked it, but recording XML nodes instead of building
 * a ProseMirror fragment. Same traversal, same text accumulation, same mark derivation.
 */
function readOriginPara(ix: XmlIndex, p: XmlNode, rels: FidelitySidecar["rels"], propOf: (el: XmlNode | null) => string | null): OriginPara {
  const out: OriginPara = {
    p, text: "", leaves: [], segs: [], textOnlyRuns: new Set(), hasOpaqueContent: false, commentIds: [],
  };
  const openComments: string[] = [];

  const walk = (container: XmlNode, wrapKeys: string[]): void => {
    for (const c of container.children) {
      if (c.uri !== W_NS) {
        if (c.local === "AlternateContent" || c.uri.includes("markup-compatibility")) {
          const fb = c.children.find((x) => x.local === "Fallback") ?? c.children.find((x) => x.local === "Choice");
          if (fb) walk(fb, wrapKeys);
        }
        continue;
      }
      switch (c.local) {
        case "r": emit(c, wrapKeys); break;
        case "hyperlink": {
          const relId = attrNS(c, R_NS, "id");
          const anchor = attrNS(c, W_NS, "anchor");
          const rel = relId ? rels[relId] : undefined;
          const href = rel ? (rel.targetMode === "External" ? rel.target : `#${rel.target}`) : anchor ? `#${anchor}` : "";
          walk(c, href ? withKey(wrapKeys, "link=", href) : wrapKeys);
          break;
        }
        case "ins": case "moveTo": {
          const id = attrNS(c, W_NS, "id") ?? "";
          walk(c, withKey(wrapKeys, "ins=", `rev:${c.local}:${id}`));
          break;
        }
        case "del": case "moveFrom": {
          const id = attrNS(c, W_NS, "id") ?? "";
          walk(c, withKey(wrapKeys, "del=", `rev:${c.local}:${id}`));
          break;
        }
        case "commentRangeStart": {
          const id = attrNS(c, W_NS, "id");
          if (id) { openComments.push(`c:${id}`); if (!out.commentIds.includes(id)) out.commentIds.push(id); }
          break;
        }
        case "commentRangeEnd": {
          const id = attrNS(c, W_NS, "id");
          if (id) { const k = openComments.lastIndexOf(`c:${id}`); if (k >= 0) openComments.splice(k, 1); }
          break;
        }
        case "smartTag": case "sdt": case "sdtContent": case "customXml": case "fldSimple":
          walk(c, wrapKeys);
          break;
        case "pPr": case "bookmarkStart": case "bookmarkEnd": case "proofErr":
        case "permStart": case "permEnd": case "lastRenderedPageBreak": case "tbl":
          break;
        default:
          break;
      }
    }
  };

  const emit = (r: XmlNode, wrapKeys: string[]): void => {
    const rPr = w(r, "rPr");
    const keyParts = [...rPrMarkKey(rPr, propOf(rPr)), ...wrapKeys, ...openComments.map((c) => `cmt=${c}`)];
    const key = keyParts.sort().join("|");
    let textOnly = true;
    for (const c of r.children) {
      if (c.uri !== W_NS) {
        if (c.local === "AlternateContent") { textOnly = false; out.hasOpaqueContent = true; }
        continue;
      }
      if (c.local === "rPr") continue;
      switch (c.local) {
        case "t": case "delText": {
          const from = out.text.length;
          out.text += c.text;
          out.leaves.push({ node: c, from, to: out.text.length, rewritable: true, run: r });
          pushSeg(out.segs, key, c.text.length);
          break;
        }
        case "tab": {
          const from = out.text.length;
          out.text += "\t";
          out.leaves.push({ node: c, from, to: out.text.length, rewritable: false, run: r });
          pushSeg(out.segs, key, 1);
          break;
        }
        case "br": {
          const type = attrNS(c, W_NS, "type");
          const from = out.text.length;
          out.text += type === "page" || type === "column" ? " " : "\n";
          out.leaves.push({ node: c, from, to: out.text.length, rewritable: false, run: r });
          pushSeg(out.segs, key, 1);
          break;
        }
        case "cr": {
          const from = out.text.length;
          out.text += "\n";
          out.leaves.push({ node: c, from, to: out.text.length, rewritable: false, run: r });
          pushSeg(out.segs, key, 1);
          break;
        }
        case "noBreakHyphen": {
          const from = out.text.length;
          out.text += "\u2011";
          out.leaves.push({ node: c, from, to: out.text.length, rewritable: false, run: r });
          pushSeg(out.segs, key, 1);
          break;
        }
        case "softHyphen": break;
        default:
          textOnly = false;
          out.hasOpaqueContent = true;
          break;
      }
    }
    if (textOnly) out.textOnlyRuns.add(r);
  };

  walk(p, []);
  return out;
}

/* ------------------------------------------------------------------ XML emission helpers */

const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

function escText(s: string): string {
  return s.replace(XML_INVALID, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(s: string): string {
  return escText(s).replace(/"/g, "&quot;");
}

/** UTF-8 by default; the corpus contains UTF-16 document parts and their offsets say so. */
function encodeFragment(s: string, encoding: "utf-8" | "utf-16le" | "utf-16be"): Uint8Array {
  if (encoding === "utf-8") return new TextEncoder().encode(s);
  const out = new Uint8Array(s.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), encoding === "utf-16le");
  return out;
}

/* ------------------------------------------------------------------ the engine */

interface CurrentBlock {
  aid: string;
  node: PMNode;
  text: string;
  segs: Seg[];
  /** Index in document order over identified blocks. */
  order: number;
}

/**
 * Node types that map one-to-one onto an origin `w:p`. Containers (list, list_item, blockquote,
 * table) are deliberately absent: they carry an `aid` in the editor, but the importer never
 * created a `BlockRecord` for them, so treating one as a block would synthesize a paragraph
 * holding the concatenated text of all its children.
 */
const IDENTIFIED = new Set(["paragraph", "heading", "figure", "code_block", "horizontal_rule"]);

function collectCurrent(doc: PMNode): CurrentBlock[] {
  const out: CurrentBlock[] = [];
  const seen = new Set<string>();
  doc.descendants((node) => {
    if (!IDENTIFIED.has(node.type.name)) return true;
    const aid: string | null = node.attrs.aid ?? null;
    if (aid && !seen.has(aid)) {
      seen.add(aid);
      out.push({ aid, node, text: blockText(node), segs: currentSegments(node), order: out.length });
    } else if (!aid) {
      out.push({ aid: `\u0000new:${out.length}`, node, text: blockText(node), segs: currentSegments(node), order: out.length });
    }
    // A paragraph inside a list_item or a table cell is still a block; keep descending.
    return true;
  });
  return out;
}

export function exportDocx(
  doc: PMNode,
  sidecar: FidelitySidecar,
  origin: DocxOrigin,
  options: ExportOptions = {},
): ExportResult {
  const t0 = Date.now();
  const ledger = new Ledger();
  const enc = sidecar.origin.encoding;
  const src = origin.documentXml;

  const ix = XmlIndex.parse(src);
  const docEl = ix.root.children.find((c) => c.local === "document" && c.uri === W_NS)
    ?? ix.root.children.find((c) => c.local === "document");
  if (!docEl) throw new DocxExportError("origin document part has no <w:document> root", "no-document-root");
  const body = w(docEl, "body");
  if (!body) throw new DocxExportError("origin <w:document> has no <w:body>", "no-body");

  /* Prefixes as the origin binds them. A document that binds wordprocessingml to `foo:` gets
     `foo:` in anything we synthesize; emitting `w:` would be well-formed and wrong. */
  const wp = body.prefix ? `${body.prefix}:` : "";
  const rPrefix = findPrefix(docEl, R_NS);

  /* Byte-offset index of every element we might need to look at. */
  const nodeAt = new Map<number, XmlNode>();
  {
    const walk = (n: XmlNode): void => {
      nodeAt.set(n.start, n);
      for (const c of n.children) walk(c);
    };
    walk(body);
  }

  /* Property blobs, addressable both ways. */
  const blobByRef = new Map<string, PropBlob>();
  const refByXml = new Map<string, string>();
  for (const bucket of Object.values(sidecar.props)) {
    for (const blob of Object.values(bucket as Record<string, PropBlob>)) {
      blobByRef.set(blob.ref, blob);
      refByXml.set(blob.xml, blob.ref);
    }
  }
  const propOf = (el: XmlNode | null): string | null => (el ? refByXml.get(ix.raw(el)) ?? null : null);

  /* -------------------------------------------------- the diff, keyed by aid */

  const current = collectCurrent(doc);
  const currentByAid = new Map<string, CurrentBlock>();
  for (const c of current) if (!c.aid.startsWith("\u0000")) currentByAid.set(c.aid, c);

  /** Paragraph-ish origin blocks, sorted by position. Tables are containers, not blocks. */
  const paras: BlockRecord[] = Object.values(sidecar.blocks)
    .filter((b) => b.kind !== "table" && b.range !== null)
    .sort((a, b) => a.range![0] - b.range![0]);

  /** Cell membership, so deleting every paragraph in a cell cannot produce invalid OOXML. */
  const cellOf = new Map<string, string>();
  const cellMembers = new Map<string, string[]>();
  for (const rec of Object.values(sidecar.blocks)) {
    if (!rec.table) continue;
    for (const row of rec.table.rows) {
      for (const cell of row.cells) {
        const members = cell.children.filter((a) => sidecar.blocks[a] && sidecar.blocks[a]!.kind !== "table");
        cellMembers.set(cell.aid, members);
        for (const m of members) cellOf.set(m, cell.aid);
      }
    }
  }
  const cellSurvivors = new Map<string, number>();
  for (const [cellAid, members] of cellMembers) {
    cellSurvivors.set(cellAid, members.filter((m) => currentByAid.has(m)).length);
  }

  /** New blocks, attached to the last known block that precedes them in the current document. */
  const insertAfter = new Map<string, CurrentBlock[]>();
  const insertAtStart: CurrentBlock[] = [];
  {
    let anchor: string | null = null;
    for (const c of current) {
      if (!c.aid.startsWith("\u0000") && sidecar.blocks[c.aid]) { anchor = c.aid; continue; }
      const list = anchor === null ? insertAtStart : (insertAfter.get(anchor) ?? []);
      list.push(c);
      if (anchor !== null) insertAfter.set(anchor, list);
    }
  }

  /* -------------------------------------------------- emit document.xml */

  const pieces: Uint8Array[] = [];
  let bytesCopied = 0;
  let bytesGenerated = 0;
  const copy = (from: number, to: number): void => {
    if (to <= from) return;
    pieces.push(src.subarray(from, to));
    bytesCopied += to - from;
  };
  const gen = (s: string): void => {
    if (s.length === 0) return;
    const b = encodeFragment(s, enc);
    pieces.push(b);
    bytesGenerated += b.length;
  };

  const stats = { copied: 0, runSpliced: 0, rebuilt: 0, synthesized: 0, deleted: 0 };
  const survivingComments = new Set<string>();
  const reportedCells = new Set<string>();
  /** Hyperlink relationships this export had to add. */
  const newRels: Array<{ id: string; target: string }> = [];
  let nextRelNum = 1;
  for (const id of Object.keys(sidecar.rels)) {
    const m = /^rId(\d+)$/.exec(id);
    if (m) nextRelNum = Math.max(nextRelNum, Number(m[1]) + 1);
  }
  const relIdFor = (href: string): string | null => {
    if (!rPrefix) return null;
    for (const [id, rel] of Object.entries(sidecar.rels)) {
      if (rel.type.endsWith("/hyperlink") && rel.target === href) return id;
    }
    for (const r of newRels) if (r.target === href) return r.id;
    const id = `rId${nextRelNum++}`;
    newRels.push({ id, target: href });
    return id;
  };

  let trackedId = options.trackedChanges?.firstId ?? 90000;
  const mintRevId = (): number => trackedId++;

  /* Generation of run sequences from doc-model inline content. Shared by rebuild and synthesis. */
  const generateRuns = (node: PMNode, opts: { asInsertion: boolean }): string => {
    let out = "";
    const groups: Array<{ key: string; marks: readonly Mark[]; text: string }> = [];
    node.forEach((child) => {
      if (child.isText) {
        const key = markKeyOfMarks(child.marks);
        const last = groups[groups.length - 1];
        if (last && last.key === key) last.text += child.text ?? "";
        else groups.push({ key, marks: child.marks, text: child.text ?? "" });
      } else if (child.type.name === "hard_break") {
        const key = markKeyOfMarks(child.marks);
        const last = groups[groups.length - 1];
        if (last && last.key === key) last.text += "\n";
        else groups.push({ key, marks: child.marks, text: "\n" });
      }
    });

    const closeComment = (id: string): string =>
      `<${wp}commentRangeEnd ${wp}id="${escAttr(id)}"/>`
      + `<${wp}r><${wp}commentReference ${wp}id="${escAttr(id)}"/></${wp}r>`;

    let openComment: string | null = null;
    for (const g of groups) {
      const cmt = g.marks.find((m) => m.type.name === "comment")?.attrs.anchorId as string | undefined;
      const cmtId = cmt ? cmt.replace(/^c:/, "") : null;
      if (openComment !== cmtId) {
        if (openComment !== null) out += closeComment(openComment);
        if (cmtId !== null) { out += `<${wp}commentRangeStart ${wp}id="${escAttr(cmtId)}"/>`; survivingComments.add(cmtId); }
        openComment = cmtId;
      }

      const del = g.marks.find((m) => m.type.name === "deletion");
      const rPrXml = rPrFor(g.marks);
      let run = `<${wp}r>${rPrXml}${runContent(g.text, !!del)}</${wp}r>`;

      const ins = g.marks.find((m) => m.type.name === "insertion");
      if (del) {
        run = `<${wp}del ${wp}id="${mintRevId()}" ${wp}author="${escAttr(String(del.attrs.author || "scriv"))}"${del.attrs.date ? ` ${wp}date="${escAttr(String(del.attrs.date))}"` : ""}>${run}</${wp}del>`;
      } else if (ins || opts.asInsertion) {
        const author = ins ? String(ins.attrs.author || "scriv") : options.trackedChanges?.author ?? "scriv";
        const date = ins ? (ins.attrs.date as string | null) : options.trackedChanges?.date ?? null;
        run = `<${wp}ins ${wp}id="${mintRevId()}" ${wp}author="${escAttr(author)}"${date ? ` ${wp}date="${escAttr(date)}"` : ""}>${run}</${wp}ins>`;
      }

      const link = g.marks.find((m) => m.type.name === "link");
      if (link) {
        const href = String(link.attrs.href ?? "");
        if (href.startsWith("#")) {
          run = `<${wp}hyperlink ${wp}anchor="${escAttr(href.slice(1))}">${run}</${wp}hyperlink>`;
        } else {
          const id = relIdFor(href);
          if (id) run = `<${wp}hyperlink ${rPrefix}id="${escAttr(id)}">${run}</${wp}hyperlink>`;
          else ledger.add({ code: "splice-props-dropped", severity: "degraded", stage: "export", detail: "a link could not be expressed: the document does not bind the relationships namespace" });
        }
      }
      out += run;
    }
    if (openComment !== null) out += closeComment(openComment);
    return out;
  };

  const runContent = (text: string, deleted = false): string => {
    const t = deleted ? `${wp}delText` : `${wp}t`;
    let out = "";
    let buf = "";
    const flush = (): void => {
      if (buf.length === 0) return;
      out += `<${t} xml:space="preserve">${escText(buf)}</${t}>`;
      buf = "";
    };
    for (const ch of text) {
      if (ch === "\n") { flush(); out += `<${wp}br/>`; }
      else if (ch === "\t") { flush(); out += `<${wp}tab/>`; }
      else buf += ch;
    }
    flush();
    return out;
  };

  /**
   * The `w:rPr` for a generated run: the stored blob when the modeled marks still agree with
   * it, a merge of blob + modeled marks when they do not, and a synthesized bag when there is
   * no blob at all. Never a re-serialization of a blob we did understand.
   */
  const rPrFor = (marks: readonly Mark[]): string => {
    const ref = marks.find((m) => m.type.name === "rPrRef")?.attrs.ref as string | undefined;
    const blob = ref ? blobByRef.get(ref) ?? null : null;
    const wanted = {
      b: marks.some((m) => m.type.name === "strong"),
      i: marks.some((m) => m.type.name === "em"),
      strike: marks.some((m) => m.type.name === "strike"),
      u: marks.some((m) => m.type.name === "underline"),
      vertAlign: marks.some((m) => m.type.name === "superscript") ? "superscript"
        : marks.some((m) => m.type.name === "subscript") ? "subscript" : null,
    };
    return mergeRPr(blob ? blob.xml : null, wanted, wp);
  };

  /* -------------------------------------------------- per-block emission */

  const emitSynthesized = (c: CurrentBlock, inheritFrom: BlockRecord | null): void => {
    const node = c.node;
    const styleId: string | null = node.attrs.styleId
      ?? (node.type.name === "heading" ? `Heading${node.attrs.level ?? 1}` : null);
    let pPr = "";
    const inheritedBlob = inheritFrom?.pPrRef ? blobByRef.get(inheritFrom.pPrRef) : undefined;
    if (inheritedBlob && (node.attrs.styleId ?? null) === (inheritFrom?.styleId ?? null)) {
      // Lineage: a block split off another inherits its paragraph properties whole.
      pPr = inheritedBlob.xml;
    } else if (styleId) {
      pPr = `<${wp}pPr><${wp}pStyle ${wp}val="${escAttr(styleId)}"/></${wp}pPr>`;
    }
    gen(`<${wp}p>${pPr}${generateRuns(node, { asInsertion: !!options.trackedChanges })}</${wp}p>`);
    stats.synthesized++;
    ledger.add({
      code: "splice-synthesized", severity: "info", stage: "export",
      detail: inheritedBlob ? "new paragraph synthesized, inheriting pPr from its lineage" : "new paragraph synthesized from its mapped paragraph style",
    });
  };

  const emitInsertionsAfter = (aid: string, rec: BlockRecord | null): void => {
    const list = insertAfter.get(aid);
    if (!list) return;
    for (const c of list) emitSynthesized(c, rec);
  };

  let cursor = sidecar.document.bodyContent[0];

  for (const c of insertAtStart) {
    copy(cursor, sidecar.document.bodyContent[0]);
    emitSynthesized(c, null);
  }

  for (const rec of paras) {
    const [start, end] = rec.range as ByteRange;
    if (start < cursor) {
      // Overlapping ranges would mean the sidecar disagrees with itself; skip rather than
      // corrupt, and say so.
      ledger.add({ code: "splice-props-dropped", severity: "dropped", stage: "export", aid: rec.aid, detail: "block range overlaps the previous block; left as origin bytes" });
      continue;
    }
    copy(cursor, start);
    cursor = end;

    const cur = currentByAid.get(rec.aid);
    const pNode = nodeAt.get(start) ?? null;

    if (!cur) {
      /**
       * A block absent from the doc model is a deletion — unless NOTHING in its table cell
       * survives, in which case the model never represented that cell in the first place and
       * "absent" means "invisible", not "deleted".
       *
       * The case that forces this distinction is `w:vMerge="continue"`: the importer folds a
       * continuation cell into the rowspan of the cell above and never emits a node for it, so
       * its paragraphs are in the sidecar and not in the document. Deleting them would silently
       * dissolve merged cells on every export — and would leave a `w:tc` with no `w:p`, which is
       * not valid OOXML. Preserving them costs a stale paragraph in the (rare, and in this
       * corpus non-existent) case where a user really did empty a whole cell; that failure is
       * visible on screen, which is the one DOCX-FIDELITY.md §3 tells us to prefer.
       *
       * Measured on the corpus: 2,635 blocks are absent from the doc model across 288 files and
       * every single one of them is in a zero-survivor cell. Not one top-level block is lost.
       */
      const cell = cellOf.get(rec.aid);
      const unrepresented = cell !== undefined && (cellSurvivors.get(cell) ?? 0) === 0;
      if (unrepresented) {
        copy(start, end);
        stats.copied++;
        if (!reportedCells.has(cell!)) {
          reportedCells.add(cell!);
          ledger.add({ code: "splice-props-dropped", severity: "info", stage: "export", aid: rec.aid, detail: "table cell not represented in the document model (a vertical-merge continuation); its paragraphs are preserved verbatim rather than treated as deleted" });
        }
      } else if (options.trackedChanges && pNode) {
        gen(markParagraphDeleted(ix, pNode, wp, options.trackedChanges, mintRevId));
        stats.deleted++;
        ledger.add({ code: "splice-regenerated", severity: "info", stage: "export", aid: rec.aid, detail: "deleted paragraph exported as a w:del revision" });
      } else {
        stats.deleted++;
      }
      emitInsertionsAfter(rec.aid, rec);
      continue;
    }

    if (!pNode) {
      // The sidecar points at a range the origin does not start an element at. Copy and move on.
      copy(start, end);
      stats.copied++;
      ledger.add({ code: "splice-props-dropped", severity: "degraded", stage: "export", aid: rec.aid, detail: "no element found at the recorded block offset; origin bytes copied unchanged" });
      emitInsertionsAfter(rec.aid, rec);
      continue;
    }

    /**
     * A `figure` is the one block whose doc-model form deliberately drops content: the importer
     * turns "a paragraph holding a drawing and nothing but whitespace" into a `figure` carrying
     * the image alone, so the tabs and line breaks around the image exist in the origin and not
     * in the model. Comparing text here would report a change on every export of every document
     * containing an image, and regenerating would destroy the drawing.
     *
     * So a figure is compared on the only thing the model actually carries — which drawing it
     * points at — and anything else about it is preserved by not being understood.
     */
    if (rec.kind === "figure") {
      const originRefs = rec.runs.flatMap((r) => r.drawingRefs ?? []);
      const modelRefs: string[] = [];
      cur.node.forEach((child) => { if (child.type.name === "image" && child.attrs.drawingRef) modelRefs.push(child.attrs.drawingRef); });
      copy(start, end);
      stats.copied++;
      if (cur.node.type.name !== "figure" || modelRefs.join() !== originRefs.slice(0, modelRefs.length).join()) {
        ledger.add({
          code: "splice-props-dropped", severity: "dropped", stage: "export", aid: rec.aid,
          detail: "a figure's drawing changed in the editor; drawings are not synthesizable and the original was kept",
        });
      }
      emitInsertionsAfter(rec.aid, rec);
      continue;
    }

    const op = readOriginPara(ix, pNode, sidecar.rels, propOf);
    for (const id of op.commentIds) survivingComments.add(id);

    if (op.text === cur.text && segsEqual(op.segs, cur.segs)) {
      copy(start, end);
      stats.copied++;
      emitInsertionsAfter(rec.aid, rec);
      continue;
    }

    const spliced = op.text !== cur.text && segsEqual(op.segs, cur.segs)
      ? runSplice(ix, op, cur.text, wp)
      : null;

    if (spliced) {
      for (const piece of spliced) {
        if (typeof piece === "string") gen(piece);
        else copy(piece[0], piece[1]);
      }
      stats.runSpliced++;
      ledger.add({ code: "splice-regenerated", severity: "info", stage: "export", aid: rec.aid, detail: "text changed; only the w:t leaves the edit touched were rewritten" });
    } else {
      gen(rebuildParagraph(ix, op, cur.node, generateRuns, ledger, rec.aid));
      stats.rebuilt++;
    }
    emitInsertionsAfter(rec.aid, rec);
  }

  copy(cursor, sidecar.document.bodyContent[1]);
  copy(sidecar.document.epilogue[0], sidecar.document.epilogue[1]);
  // The prologue is emitted first; assemble with it in front.
  const head = src.subarray(0, sidecar.document.prologue[1]);
  bytesCopied += head.length;

  let total = head.length;
  for (const p of pieces) total += p.length;
  const documentXml = new Uint8Array(total);
  documentXml.set(head, 0);
  {
    let o = head.length;
    for (const p of pieces) { documentXml.set(p, o); o += p.length; }
  }

  /* -------------------------------------------------- satellite parts */

  const replacements: Record<string, Uint8Array> = {};
  const documentXmlIdentical = bytesEqual(documentXml, src);
  if (!documentXmlIdentical) replacements[sidecar.origin.documentPart] = documentXml;

  if (newRels.length > 0) {
    const relsPart = relsPathFor(sidecar.origin.documentPart);
    const existing = origin.entries.find((e) => e.name === relsPart);
    if (existing) {
      const patched = appendRelationships(existing.bytes, newRels);
      if (patched) replacements[relsPart] = patched;
      else ledger.add({ code: "splice-props-dropped", severity: "degraded", stage: "export", part: relsPart, detail: "could not append hyperlink relationships; the links point nowhere" });
    }
  }

  const commentsPart = origin.entries.find((e) => e.name === "word/comments.xml");
  if (commentsPart && Object.keys(sidecar.comments).length > 0) {
    const dropped = Object.values(sidecar.comments)
      .flatMap((t) => t.commentIds)
      .filter((id) => !survivingComments.has(id));
    if (dropped.length > 0) {
      const pruned = pruneComments(commentsPart.bytes, new Set(dropped));
      if (pruned) {
        replacements["word/comments.xml"] = pruned;
        ledger.add({ code: "comment-orphan", severity: "info", stage: "export", count: dropped.length, detail: "comment threads whose anchored text was deleted were removed from word/comments.xml" });
      }
    }
  }

  /* -------------------------------------------------- the package */

  let bytes: Uint8Array;
  let packageIdentical = false;
  let partsRewritten: string[] = [];
  try {
    const r = spliceZip(origin.bytes, replacements, { level: options.level ?? 6 });
    bytes = r.bytes;
    packageIdentical = r.report.identical;
    partsRewritten = r.report.rewritten;
  } catch (e) {
    if (e instanceof ZipError) {
      throw new DocxExportError(`origin package cannot be spliced: ${e.message}`, e.code);
    }
    throw e;
  }

  return {
    bytes,
    documentXml,
    ledger: ledger.entries(),
    stats: {
      blocks: paras.length,
      copied: stats.copied,
      runSpliced: stats.runSpliced,
      rebuilt: stats.rebuilt,
      synthesized: stats.synthesized,
      deleted: stats.deleted,
      bytesCopied,
      bytesGenerated,
      documentXmlIdentical,
      packageIdentical,
      partsRewritten,
      exportMs: Date.now() - t0,
    },
  };
}

/* ------------------------------------------------------------------ run splice */

type Piece = string | ByteRange;

/**
 * Level 1. The text changed but the inline structure did not, so the edit is a substring
 * replacement somewhere in the paragraph's character data.
 *
 * Common prefix and suffix bound the change; every `w:t` leaf outside those bounds keeps its
 * original bytes, and the leaves inside are rewritten with their share of the new text. A
 * change that reaches a `w:tab`, `w:br` or any non-character leaf is refused here — "replace
 * these characters" is not a meaningful instruction for an element — and falls through to the
 * rebuild, which is a decision the ledger records.
 */
function runSplice(ix: XmlIndex, op: OriginPara, newText: string, _wp: string): Piece[] | null {
  const old = op.text;
  if (old === newText) return null;

  let pfx = 0;
  const maxPfx = Math.min(old.length, newText.length);
  while (pfx < maxPfx && old.charCodeAt(pfx) === newText.charCodeAt(pfx)) pfx++;
  let sfx = 0;
  while (sfx < maxPfx - pfx && old.charCodeAt(old.length - 1 - sfx) === newText.charCodeAt(newText.length - 1 - sfx)) sfx++;

  const oldEnd = old.length - sfx;
  const newMid = newText.slice(pfx, newText.length - sfx);

  const touched = op.leaves.filter((l) => l.to > pfx && l.from < oldEnd);
  // A zero-length change region still has to land somewhere: pick the leaf that contains the
  // insertion point, preferring the one that ends there so text joins the preceding run.
  if (touched.length === 0) {
    const at = op.leaves.filter((l) => l.from <= pfx && pfx <= l.to);
    const host = at.reverse().find((l) => l.rewritable);
    if (!host) return null;
    touched.push(host);
  }
  if (touched.some((l) => !l.rewritable)) return null;

  const pieces: Piece[] = [];
  let cursor = op.p.start;
  let placed = false;
  for (const leaf of touched) {
    const head = old.slice(leaf.from, Math.max(leaf.from, Math.min(leaf.to, pfx)));
    const tail = old.slice(Math.min(leaf.to, Math.max(leaf.from, oldEnd)), leaf.to);
    const text = head + (placed ? "" : newMid) + tail;
    placed = true;
    pieces.push([cursor, leaf.node.start]);
    pieces.push(rewriteTextLeaf(ix, leaf.node, text));
    cursor = leaf.node.end;
  }
  pieces.push([cursor, op.p.end]);
  return pieces;
}

/**
 * Rewrite one `w:t`'s character data, keeping its tag exactly as the producer wrote it.
 *
 * `xml:space="preserve"` is added when the new text has significant edge whitespace and the
 * original tag did not declare it. Without that, Word silently eats the space and the writer's
 * edit comes back subtly wrong.
 */
function rewriteTextLeaf(ix: XmlIndex, node: XmlNode, text: string): string {
  const open = ix.src.slice(node.charStart, node.charContentStart);
  const needPreserve = /^\s|\s$/.test(text) || text.length === 0;
  const hasPreserve = attrNS(node, XML_NS, "space") === "preserve";
  let openTag = open;
  if (node.selfClosing) openTag = open.replace(/\/>$/, ">");
  if (needPreserve && !hasPreserve) openTag = openTag.replace(/>$/, ' xml:space="preserve">');
  return `${openTag}${escText(text)}</${node.name}>`;
}

/* ------------------------------------------------------------------ rebuild */

/**
 * Level 2. The inline structure changed, so the run sequence is regenerated from the doc model.
 *
 * What survives verbatim, and why it is worth the extra code: every `w:p` child that is not a
 * run container (bookmarks, comment ranges, `w:pPr`) and every run that carries something other
 * than characters — a drawing, an embedded object, a field, a footnote reference. Regenerating
 * those from a model that never understood them is exactly the failure this project exists to
 * avoid, so they are copied and the generated text is placed where the first text-only run was.
 */
function rebuildParagraph(
  ix: XmlIndex,
  op: OriginPara,
  node: PMNode,
  generateRuns: (n: PMNode, o: { asInsertion: boolean }) => string,
  ledger: Ledger,
  aid: string,
): string {
  const p = op.p;
  const openTag = ix.src.slice(p.charStart, p.charContentStart);
  let out = p.selfClosing ? openTag.replace(/\/>$/, ">") : openTag;

  const generated = generateRuns(node, { asInsertion: false });
  let placed = false;

  const isRunish = (c: XmlNode): boolean =>
    c.uri === W_NS && (c.local === "r" || RUN_CONTAINERS.has(c.local));

  const emitPreservedRun = (r: XmlNode): string => {
    // Copy the run, minus its character data: the text has been regenerated elsewhere and
    // leaving it here would duplicate it.
    const drop = r.children.filter((c) => c.uri === W_NS && (c.local === "t" || c.local === "delText"));
    if (drop.length === 0) return ix.raw(r);
    let s = "";
    let cur = r.charStart;
    for (const d of drop) { s += ix.src.slice(cur, d.charStart); cur = d.charEnd; }
    s += ix.src.slice(cur, r.charEnd);
    return s;
  };

  const walk = (container: XmlNode): void => {
    for (const c of container.children) {
      if (!isRunish(c)) {
        if (c.uri === W_NS && (c.local === "commentRangeStart" || c.local === "commentRangeEnd")) continue;
        out += ix.raw(c);
        continue;
      }
      if (c.local === "r") {
        if (op.textOnlyRuns.has(c)) {
          if (!placed) { out += generated; placed = true; }
          continue;
        }
        if (!placed) { out += generated; placed = true; }
        out += emitPreservedRun(c);
        continue;
      }
      walk(c);
    }
  };
  walk(p);
  if (!placed) out += generated;

  if (op.hasOpaqueContent) {
    ledger.add({
      code: "splice-regenerated", severity: "degraded", stage: "export", aid,
      detail: "paragraph rebuilt: runs carrying drawings, fields or note references were preserved verbatim but may have moved relative to the regenerated text",
    });
  } else {
    ledger.add({ code: "splice-regenerated", severity: "info", stage: "export", aid, detail: "inline structure changed; paragraph content regenerated from the doc model" });
  }
  return `${out}</${p.name}>`;
}

/* ------------------------------------------------------------------ tracked deletion */

/**
 * Turn a paragraph into a Word deletion revision: every run wrapped in `w:del`, every `w:t`
 * turned into `w:delText`, and the paragraph mark itself marked deleted via `pPr/rPr/del` —
 * without which Word shows the text struck through but still breaks the paragraph there.
 */
function markParagraphDeleted(
  ix: XmlIndex,
  p: XmlNode,
  wp: string,
  tc: TrackedChangesOptions,
  mintId: () => number,
): string {
  const author = escAttr(tc.author);
  const date = tc.date ? ` ${wp}date="${escAttr(tc.date)}"` : "";
  const delAttrs = (): string => `${wp}id="${mintId()}" ${wp}author="${author}"${date}`;

  const openTag = ix.src.slice(p.charStart, p.charContentStart);
  let out = p.selfClosing ? openTag.replace(/\/>$/, ">") : openTag;

  const pPr = w(p, "pPr");
  if (pPr) out += injectParagraphMarkDeletion(ix, pPr, wp, delAttrs());
  else out += `<${wp}pPr><${wp}rPr><${wp}del ${delAttrs()}/></${wp}rPr></${wp}pPr>`;

  const convert = (n: XmlNode): string => {
    let s = "";
    let cur = n.charContentStart;
    for (const c of n.children) {
      s += ix.src.slice(cur, c.charStart);
      if (c.uri === W_NS && (c.local === "t")) {
        const open = ix.src.slice(c.charStart, c.charContentStart).replace(/^<[^\s/>]+/, `<${wp}delText`).replace(/\/>$/, ">");
        s += `${open}${ix.src.slice(c.charContentStart, c.charContentEnd)}</${wp}delText>`;
      } else {
        s += ix.raw(c);
      }
      cur = c.charEnd;
    }
    s += ix.src.slice(cur, n.charContentEnd);
    return s;
  };

  for (const c of p.children) {
    if (c === pPr) continue;
    if (c.uri === W_NS && c.local === "r") {
      const open = ix.src.slice(c.charStart, c.charContentStart);
      out += `<${wp}del ${delAttrs()}>${c.selfClosing ? open.replace(/\/>$/, ">") : open}${convert(c)}</${c.name}></${wp}del>`;
    } else {
      out += ix.raw(c);
    }
  }
  return `${out}</${p.name}>`;
}

/** Insert `<w:rPr><w:del/></w:rPr>` into a pPr at the position CT_PPr's sequence requires. */
function injectParagraphMarkDeletion(ix: XmlIndex, pPr: XmlNode, wp: string, attrs: string): string {
  const marker = `<${wp}rPr><${wp}del ${attrs}/></${wp}rPr>`;
  const existing = w(pPr, "rPr");
  if (existing) {
    const inner = ix.src.slice(existing.charContentStart, existing.charContentEnd);
    return ix.src.slice(pPr.charStart, existing.charStart)
      + `<${existing.name}><${wp}del ${attrs}/>${inner}</${existing.name}>`
      + ix.src.slice(existing.charEnd, pPr.charEnd);
  }
  // rPr sits after every other property except sectPr / pPrChange.
  const after = pPr.children.find((c) => c.uri === W_NS && (c.local === "sectPr" || c.local === "pPrChange"));
  const at = after ? after.charStart : pPr.charContentEnd;
  if (pPr.selfClosing) return `<${pPr.name}>${marker}</${pPr.name}>`;
  return ix.src.slice(pPr.charStart, at) + marker + ix.src.slice(at, pPr.charEnd);
}

/* ------------------------------------------------------------------ rPr merging */

/**
 * ECMA-376 §17.3.2 orders `w:rPr`'s children. Inserting `<w:b/>` at the end of an existing rPr
 * produces markup Word will load but a validator will reject, so a merged property is placed
 * before the first sibling that must follow it. Elements this table does not know keep their
 * relative position, which is the conservative choice for producer extensions.
 */
const RPR_ORDER = [
  "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike",
  "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden",
  "color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect",
  "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout",
  "specVanish", "oMath",
];

interface WantedMarks { b: boolean; i: boolean; strike: boolean; u: boolean; vertAlign: string | null }

export function mergeRPr(originalXml: string | null, wanted: WantedMarks, wp: string): string {
  const controlled = new Set(["b", "bCs", "i", "iCs", "strike", "dstrike", "u", "vertAlign"]);
  const additions: Array<{ local: string; xml: string }> = [];
  if (wanted.b) additions.push({ local: "b", xml: `<${wp}b/>` });
  if (wanted.i) additions.push({ local: "i", xml: `<${wp}i/>` });
  if (wanted.strike) additions.push({ local: "strike", xml: `<${wp}strike/>` });
  if (wanted.u) additions.push({ local: "u", xml: `<${wp}u ${wp}val="single"/>` });
  if (wanted.vertAlign) additions.push({ local: "vertAlign", xml: `<${wp}vertAlign ${wp}val="${wanted.vertAlign}"/>` });

  if (!originalXml) {
    if (additions.length === 0) return "";
    return `<${wp}rPr>${additions.map((a) => a.xml).join("")}</${wp}rPr>`;
  }

  // Parse the blob (it is a self-contained element) only to find its children's extents.
  let ix: XmlIndex;
  try {
    ix = XmlIndex.parse(new TextEncoder().encode(originalXml));
  } catch {
    return originalXml;
  }
  const root = ix.root.children[0];
  if (!root) return originalXml;

  const kept: Array<{ local: string; xml: string }> = [];
  for (const c of root.children) {
    if (c.uri === W_NS && controlled.has(c.local)) continue;
    kept.push({ local: c.local, xml: ix.raw(c) });
  }

  // Merge, preserving the original relative order of the kept children.
  const rank = (local: string): number => {
    const i = RPR_ORDER.indexOf(local);
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  const out: string[] = [];
  let ai = 0;
  for (const k of kept) {
    while (ai < additions.length && rank(additions[ai]!.local) < rank(k.local)) out.push(additions[ai++]!.xml);
    out.push(k.xml);
  }
  while (ai < additions.length) out.push(additions[ai++]!.xml);

  if (out.length === 0) return "";
  const openTag = ix.src.slice(root.charStart, root.charContentStart).replace(/\/>$/, ">");
  return `${openTag}${out.join("")}</${root.name}>`;
}

/* ------------------------------------------------------------------ satellite part edits */

function relsPathFor(part: string): string {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}

const HYPERLINK_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

/** Append hyperlink relationships by splicing before `</Relationships>`. Nothing else moves. */
function appendRelationships(bytes: Uint8Array, rels: Array<{ id: string; target: string }>): Uint8Array | null {
  const src = new TextDecoder("utf-8").decode(bytes);
  const at = src.lastIndexOf("</Relationships>");
  if (at < 0) return null;
  const add = rels
    .map((r) => `<Relationship Id="${escAttr(r.id)}" Type="${HYPERLINK_REL}" Target="${escAttr(r.target)}" TargetMode="External"/>`)
    .join("");
  return new TextEncoder().encode(src.slice(0, at) + add + src.slice(at));
}

/** Remove `w:comment` elements whose anchored range no longer exists. Byte-splice, no re-serialize. */
function pruneComments(bytes: Uint8Array, dropIds: Set<string>): Uint8Array | null {
  let ix: XmlIndex;
  try {
    ix = XmlIndex.parse(bytes);
  } catch {
    return null;
  }
  const root = ix.root.children.find((c) => c.local === "comments");
  if (!root) return null;
  const drop = root.children.filter((c) => c.local === "comment" && c.uri === W_NS && dropIds.has(attrNS(c, W_NS, "id") ?? ""));
  if (drop.length === 0) return null;
  const pieces: Uint8Array[] = [];
  let cur = 0;
  for (const d of drop) { pieces.push(bytes.subarray(cur, d.start)); cur = d.end; }
  pieces.push(bytes.subarray(cur));
  let n = 0;
  for (const p of pieces) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of pieces) { out.set(p, o); o += p.length; }
  return out;
}

/* ------------------------------------------------------------------ small helpers */

function segsEqual(a: readonly Seg[], b: readonly Seg[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]!.key !== b[i]!.key || a[i]!.len !== b[i]!.len) return false;
  return true;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The prefix the origin binds to a namespace, e.g. `r:`. Empty when it binds none. */
function findPrefix(el: XmlNode, uri: string): string {
  for (const a of el.attrs) {
    if (a.prefix === "xmlns" && a.value === uri) return `${a.local}:`;
  }
  return "";
}
