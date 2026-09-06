import { XmlIndex, wAll, attrNS, deepText, descendantsNamed, W_NS } from "./xmlindex";

/**
 * Word's comment threading, read and written.
 *
 * A Word comment is spread across four parts, and the thread structure lives in none of the
 * obvious ones:
 *
 *   word/comments.xml           the bodies. `w:id`, author, date, and one or more `w:p`.
 *   word/commentsExtended.xml   the THREAD: `w15:paraId` -> `w15:paraIdParent` and `w15:done`.
 *   word/commentsIds.xml        `w15:paraId` -> a durable id that survives round-trips.
 *   word/document.xml           `w:commentRangeStart`/`End` and `w:commentReference`.
 *
 * The join key between them is NOT `w:id`. It is the `w14:paraId` of the LAST paragraph in
 * the comment body — an attribute on a paragraph inside the comment, not on the comment. Get
 * that wrong and replies attach to nothing and resolutions land on the wrong thread.
 *
 * The importer previously hard-coded `resolved: false, parentAnchorId: null` and never opened
 * commentsExtended.xml at all, so every reply in every document read as a separate top-level
 * thread and no resolved comment was ever known to be resolved. (The corpus happens to
 * contain neither — 675 threads across 11 documents, none replied to, none resolved — so the
 * gap was invisible in aggregate scores while being total.)
 *
 * WRITING follows the same rule as everything else in this package: touch the fewest bytes
 * that can express the change. Resolving a thread flips one attribute. Adding a reply appends
 * one element to each of three parts and leaves every existing byte alone.
 */

export const W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml";
export const W15_NS = "http://schemas.microsoft.com/office/word/2012/wordml";
export const W16CID_NS = "http://schemas.microsoft.com/office/word/2016/wordml/cid";

export interface CommentPartInfo {
  /** `w:id` from comments.xml. */
  id: string;
  /** `w14:paraId` of the last paragraph of the body. The thread key. */
  paraId: string | null;
  /** `w16cid:durableId`, when commentsIds.xml is present. */
  durableId: string | null;
  /** `w15:paraIdParent`: the paraId of the comment this one replies to. */
  paraIdParent: string | null;
  /** `w15:done`. */
  resolved: boolean;
}

/**
 * Read the thread structure. Returns one entry per `w:comment`, keyed by `w:id`.
 *
 * Every part is optional: a document written by a tool that does not emit commentsExtended
 * has comments with no thread structure, which is a flat list of top-level comments, not an
 * error.
 */
export function readCommentThreading(entries: Record<string, Uint8Array>): Map<string, CommentPartInfo> {
  const out = new Map<string, CommentPartInfo>();
  const comments = entries["word/comments.xml"];
  if (!comments) return out;

  // paraId -> w:id, built while walking the bodies.
  const byParaId = new Map<string, string>();
  try {
    const ix = XmlIndex.parse(comments);
    const root = ix.root.children.find((c) => c.local === "comments");
    for (const c of wAll(root, "comment")) {
      const id = attrNS(c, W_NS, "id");
      if (!id) continue;
      // The LAST paragraph's paraId is the thread key. A multi-paragraph comment has several
      // and only the last one appears in commentsExtended.
      const paras = descendantsNamed(c, W_NS, "p");
      const paraId = paras.length > 0 ? attrNS(paras[paras.length - 1]!, W14_NS, "paraId") ?? null : null;
      out.set(id, { id, paraId, durableId: null, paraIdParent: null, resolved: false });
      if (paraId) byParaId.set(paraId, id);
    }
  } catch { /* comments are annotations; never fatal */ }

  readInto(entries["word/commentsExtended.xml"], "commentsEx", "commentEx", (get) => {
    const paraId = get(W15_NS, "paraId");
    const rec = paraId ? out.get(byParaId.get(paraId) ?? "") : undefined;
    if (!rec) return;
    rec.paraIdParent = get(W15_NS, "paraIdParent") ?? null;
    const done = get(W15_NS, "done");
    rec.resolved = done === "1" || done === "true";
  });

  readInto(entries["word/commentsIds.xml"], "commentsIds", "commentId", (get) => {
    const paraId = get(W16CID_NS, "paraId");
    const rec = paraId ? out.get(byParaId.get(paraId) ?? "") : undefined;
    if (rec) rec.durableId = get(W16CID_NS, "durableId") ?? null;
  });

  return out;
}

function readInto(
  bytes: Uint8Array | undefined,
  rootLocal: string,
  childLocal: string,
  visit: (get: (uri: string, local: string) => string | undefined) => void,
): void {
  if (!bytes) return;
  try {
    const ix = XmlIndex.parse(bytes);
    const root = ix.root.children.find((c) => c.local === rootLocal);
    if (!root) return;
    for (const child of root.children) {
      if (child.local !== childLocal) continue;
      visit((uri, local) => attrNS(child, uri, local));
    }
  } catch { /* an unreadable annotation part is not a reason to fail the import */ }
}

/** Plain text of one comment body, for the UI and for the sidecar. */
export function commentBodyText(node: Parameters<typeof deepText>[0]): string {
  return deepText(node).replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ writing */

export interface NewReply {
  /** `w:id` of the comment being replied to. */
  parentId: string;
  text: string;
  author: string;
  initials: string;
  /** ISO-8601. Word writes seconds-resolution UTC with a trailing Z. */
  date: string;
}

export interface CommentWriteResult {
  /** Part name -> new bytes. Only parts that actually changed appear. */
  parts: Record<string, Uint8Array>;
  /** `w:id` assigned to each new reply, in the order given. document.xml needs these. */
  replyIds: string[];
  /** Anything that could not be done, and why. */
  problems: string[];
}

export interface CommentEdits {
  replies: NewReply[];
  /** `w:id` -> resolved. Applies to the thread root, which is how Word shows it. */
  resolved: Map<string, boolean>;
}

/**
 * Apply comment edits to the annotation parts.
 *
 * Byte-surgical, like everything else here: the existing parts are spliced, never rebuilt.
 * A rebuilt comments.xml would renormalize namespace prefixes and attribute order across
 * every comment in the document, which is exactly the kind of gratuitous diff this package
 * exists to avoid.
 */
export function applyCommentEdits(
  entries: Record<string, Uint8Array>,
  edits: CommentEdits,
): CommentWriteResult {
  const problems: string[] = [];
  const parts: Record<string, Uint8Array> = {};
  const replyIds: string[] = [];

  const threading = readCommentThreading(entries);
  const commentsBytes = entries["word/comments.xml"];

  if (edits.replies.length > 0 && !commentsBytes) {
    problems.push("cannot add a reply: word/comments.xml is absent and creating it would mean writing a new part, its relationship and its content-type override");
  }

  /* ---- replies ---- */
  let commentsXml = commentsBytes ? decode(commentsBytes) : "";
  const newEx: string[] = [];
  const newIds: string[] = [];

  if (edits.replies.length > 0 && commentsBytes) {
    let nextId = 1 + Math.max(-1, ...[...threading.keys()].map((k) => Number(k)).filter(Number.isFinite));
    const prefix = prefixFor(commentsXml, W_NS) ?? "w:";

    for (const reply of edits.replies) {
      const parent = threading.get(reply.parentId);
      if (!parent) { problems.push(`reply target ${reply.parentId} is not a comment in this document`); continue; }
      // A reply threads to the root of its thread, not to another reply: Word stores a flat
      // parent pointer and shows one level.
      const rootParaId = rootParaIdOf(parent, threading);
      if (!rootParaId) { problems.push(`comment ${reply.parentId} has no w14:paraId, so a reply cannot be threaded to it`); continue; }

      const id = String(nextId++);
      const paraId = randomHex8();
      commentsXml = insertBefore(commentsXml, `</${prefix}comments>`, commentElement(prefix, id, paraId, reply));
      newEx.push(`<w15:commentEx w15:paraId="${paraId}" w15:paraIdParent="${rootParaId}" w15:done="0"/>`);
      newIds.push(`<w16cid:commentId w16cid:paraId="${paraId}" w16cid:durableId="${randomHex8()}"/>`);
      replyIds.push(id);
    }
    if (replyIds.length > 0) parts["word/comments.xml"] = encode(commentsXml);
  }

  /* ---- resolved ---- */
  const extBytes = entries["word/commentsExtended.xml"];
  if ((edits.resolved.size > 0 || newEx.length > 0)) {
    if (!extBytes) {
      if (edits.resolved.size > 0) {
        problems.push("cannot record resolved state: word/commentsExtended.xml is absent in this document");
      }
    } else {
      let ext = decode(extBytes);
      for (const [id, done] of edits.resolved) {
        const rec = threading.get(id);
        if (!rec?.paraId) { problems.push(`comment ${id} has no w14:paraId, so its resolved state has nowhere to live`); continue; }
        const next = setDone(ext, rec.paraId, done);
        if (next === null) problems.push(`no <w15:commentEx> for paraId ${rec.paraId}; resolved state not written`);
        else ext = next;
      }
      if (newEx.length > 0) ext = insertBefore(ext, "</w15:commentsEx>", newEx.join(""));
      parts["word/commentsExtended.xml"] = encode(ext);
    }
  }

  if (newIds.length > 0) {
    const idsBytes = entries["word/commentsIds.xml"];
    // Optional part: a document without it simply has no durable ids, and Word regenerates
    // them. Writing one from scratch would need a relationship and a content-type override.
    if (idsBytes) parts["word/commentsIds.xml"] = encode(insertBefore(decode(idsBytes), "</w16cid:commentsIds>", newIds.join("")));
  }

  return { parts, replyIds, problems };
}

/** The thread root's paraId: follow the parent pointer, defensively bounded. */
function rootParaIdOf(rec: CommentPartInfo, all: Map<string, CommentPartInfo>): string | null {
  let cur = rec;
  for (let hops = 0; hops < 16; hops++) {
    if (!cur.paraIdParent) return cur.paraId;
    const parent = [...all.values()].find((c) => c.paraId === cur.paraIdParent);
    if (!parent) return cur.paraIdParent;
    cur = parent;
  }
  return cur.paraId;
}

/**
 * One `w:comment`, shaped the way Word writes them.
 *
 * The `w:annotationRef` run is not decoration: Word renders the comment reference mark from
 * it, and a comment without one shows in the pane with no bullet linking it to the text.
 */
function commentElement(p: string, id: string, paraId: string, reply: NewReply): string {
  return (
    `<${p}comment ${p}id="${escAttr(id)}" ${p}author="${escAttr(reply.author)}"` +
    ` ${p}date="${escAttr(reply.date)}" ${p}initials="${escAttr(reply.initials)}">` +
    `<${p}p w14:paraId="${paraId}" w14:textId="77777777">` +
    `<${p}pPr><${p}pStyle ${p}val="CommentText"/></${p}pPr>` +
    `<${p}r><${p}rPr><${p}rStyle ${p}val="CommentReference"/></${p}rPr><${p}annotationRef/></${p}r>` +
    `<${p}r><${p}t xml:space="preserve">${escText(reply.text)}</${p}t></${p}r>` +
    `</${p}p></${p}comment>`
  );
}

/** The document.xml markup that anchors a reply to the same range as its parent. */
export function replyRangeMarkup(prefix: string, id: string): { start: string; end: string } {
  return {
    start: `<${prefix}commentRangeStart ${prefix}id="${escAttr(id)}"/>`,
    end:
      `<${prefix}commentRangeEnd ${prefix}id="${escAttr(id)}"/>` +
      `<${prefix}r><${prefix}commentReference ${prefix}id="${escAttr(id)}"/></${prefix}r>`,
  };
}

export interface AnchorReplyResult {
  documentXml: Uint8Array<ArrayBuffer>;
  /** Replies that could not be anchored, with the reason. They must not be written at all. */
  problems: string[];
  anchored: number;
}

/**
 * Give each reply the same text range as the comment it answers.
 *
 * Word threads replies by range, not by pointer: a reply carries its own
 * `w:commentRangeStart`/`End` around exactly the text its parent covers, and the parent link
 * lives in commentsExtended.xml. A reply with a body but no range is a comment attached to
 * nothing, which Word reports as a repair.
 *
 * The insertion is located by ELEMENT rather than by exact text, because attribute order and
 * self-closing whitespace vary between producers and a literal match would silently anchor
 * nothing on a document written by anything other than Word.
 */
export function anchorReplies(
  documentXml: Uint8Array<ArrayBuffer>,
  encoding: "utf-8" | "utf-16le" | "utf-16be",
  prefix: string,
  pairs: { parentId: string; replyId: string }[],
): AnchorReplyResult {
  if (pairs.length === 0) return { documentXml, problems: [], anchored: 0 };

  const { bom, text } = decodeWithBom(documentXml, encoding);
  let out = text;
  const problems: string[] = [];
  let anchored = 0;

  for (const { parentId, replyId } of pairs) {
    const startMatch = elementRe("commentRangeStart", parentId).exec(out);
    // The reference RUN, not the range end: Word puts the reply's end after the parent's
    // whole reference so the two references sit side by side in reading order. The run is
    // found by scanning out from the reference rather than by matching a run pattern —
    // Word's reference run carries an `<w:rPr>` with the CommentReference style in front of
    // the reference itself, and a pattern that assumed the reference was the run's only
    // child matched nothing on real documents.
    const refMatch = elementRe("commentReference", parentId).exec(out);
    const runEnd = refMatch ? endOfEnclosingRun(out, refMatch.index) : -1;

    if (!startMatch || !refMatch || runEnd < 0) {
      problems.push(
        `comment ${parentId} has no complete range in the document body ` +
        `(start ${startMatch ? "found" : "missing"}, reference ${refMatch ? "found" : "missing"}` +
        `${refMatch && runEnd < 0 ? ", but it is not inside a run" : ""}); the reply was not written`,
      );
      continue;
    }

    const markup = replyRangeMarkup(prefix, replyId);
    // Splice the later offset first so the earlier one stays valid.
    const startEnd = startMatch.index + startMatch[0].length;
    const refEnd = runEnd;
    if (refEnd < startEnd) {
      problems.push(`comment ${parentId} has its reference before its range start; the reply was not written`);
      continue;
    }
    out = out.slice(0, refEnd) + markup.end + out.slice(refEnd);
    out = out.slice(0, startEnd) + markup.start + out.slice(startEnd);
    anchored++;
  }

  return { documentXml: anchored > 0 ? encodeWithBom(bom, out, encoding) : documentXml, problems, anchored };
}

/**
 * End offset of the `<w:r>` containing the reference at `at`.
 *
 * Scans back to the nearest run open tag and forward to its close. Returns -1 when the
 * reference is not inside a run, which is malformed and must not be guessed at.
 */
function endOfEnclosingRun(xml: string, at: number): number {
  const open = /<([\w.-]+:)?r\b[^>]*>/g;
  let runStart = -1;
  for (let m = open.exec(xml); m && m.index < at; m = open.exec(xml)) runStart = m.index;
  if (runStart < 0) return -1;
  const close = /<\/([\w.-]+:)?r>/g;
  close.lastIndex = at;
  const c = close.exec(xml);
  return c ? c.index + c[0].length : -1;
}

/** An element with a given `id` attribute, whatever its prefix and attribute order. */
function elementRe(local: string, id: string): RegExp {
  return new RegExp(`<([\\w.-]+:)?${local}\\b[^>]*?\\bid="${escapeRe(id)}"[^>]*?/?>`);
}

function decodeWithBom(bytes: Uint8Array, encoding: string): { bom: Uint8Array; text: string } {
  // TextDecoder swallows a BOM. Keeping it means a document that arrived with one leaves
  // with one, which matters because the ZIP entry is compared byte for byte downstream.
  const hasUtf8Bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const hasUtf16Bom = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
  const bomLen = encoding === "utf-8" ? (hasUtf8Bom ? 3 : 0) : (hasUtf16Bom ? 2 : 0);
  return {
    bom: bytes.subarray(0, bomLen),
    text: new TextDecoder(encoding).decode(bytes.subarray(bomLen)),
  };
}

function encodeWithBom(bom: Uint8Array, text: string, encoding: "utf-8" | "utf-16le" | "utf-16be"): Uint8Array<ArrayBuffer> {
  let body: Uint8Array<ArrayBuffer>;
  if (encoding === "utf-8") body = new TextEncoder().encode(text);
  else {
    body = new Uint8Array(text.length * 2);
    const dv = new DataView(body.buffer);
    for (let i = 0; i < text.length; i++) dv.setUint16(i * 2, text.charCodeAt(i), encoding === "utf-16le");
  }
  if (bom.length === 0) return body;
  const out = new Uint8Array(bom.length + body.length);
  out.set(bom, 0);
  out.set(body, bom.length);
  return out;
}

/** Flip `w15:done` on one `w15:commentEx`, without touching any other byte. */
function setDone(xml: string, paraId: string, done: boolean): string | null {
  // Attribute order and prefix vary between producers, so the element is located by its
  // paraId and only its own `done` attribute is rewritten.
  const re = new RegExp(`<([\\w.-]+:)?commentEx\\b[^>]*?paraId="${escapeRe(paraId)}"[^>]*?/?>`, "i");
  const m = re.exec(xml);
  if (!m) return null;
  const element = m[0];
  const value = done ? "1" : "0";
  let withDone: string;
  if (/\bdone="[^"]*"/i.test(element)) {
    withDone = element.replace(/\bdone="[^"]*"/i, `done="${value}"`);
  } else if (element.endsWith("/>")) {
    withDone = `${element.slice(0, -2).trimEnd()} w15:done="${value}"/>`;
  } else {
    // A commentEx with children is not something Word writes and not something to guess at.
    return null;
  }
  return xml.slice(0, m.index) + withDone + xml.slice(m.index + element.length);
}

function insertBefore(xml: string, closing: string, addition: string): string {
  const at = xml.lastIndexOf(closing);
  if (at < 0) return xml + addition;
  return xml.slice(0, at) + addition + xml.slice(at);
}

/** The prefix a part uses for a namespace, e.g. "w:" — or null when it is the default. */
export function prefixFor(xml: string, uri: string): string | null {
  const m = new RegExp(`xmlns:([\\w.-]+)="${escapeRe(uri)}"`).exec(xml);
  return m ? `${m[1]}:` : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const encode = (s: string) => new TextEncoder().encode(s);

/** Word's paraId/durableId are 8 hex digits and must not be zero. */
function randomHex8(): string {
  let v = 0;
  while (v === 0) v = Math.floor(Math.random() * 0xffffffff) >>> 0;
  return v.toString(16).toUpperCase().padStart(8, "0");
}
