/**
 * Offset-recording XML index.
 *
 * DOCX-FIDELITY.md §4 step 2: parse `word/document.xml` with `saxes`, recording byte offsets
 * for every element open/close, yielding an offset-indexed tree **without ever re-serializing**.
 *
 * The parser is used as an INDEX, never as a transform. Nothing in this module can produce XML.
 * There is deliberately no `serialize()`, no node mutation and no attribute map that would let a
 * caller reconstruct a tag: the only way to get XML out of here is to slice the original bytes.
 * That is what guarantees byte-fidelity — a DOM round-trip would normalise attribute order,
 * self-closing form, namespace prefixes and insignificant whitespace, all of which Word notices.
 *
 * Offsets are BYTE offsets into the original buffer, not JS string indices. Those differ for
 * every non-ASCII document (the corpus has Hindi, Polish, Czech, Chinese and Arabic files), and
 * an offset that is right on ASCII and wrong on Devanagari is worse than no offset at all: it
 * would splice a document in the middle of a UTF-8 sequence and silently corrupt it.
 */

import { SaxesParser } from "saxes";

export interface XmlAttr {
  /** Raw qualified name exactly as written, e.g. `w:val`, `xmlns:w`, `xml:space`. */
  name: string;
  local: string;
  /** Resolved namespace URI, or "" when unprefixed / unresolved. */
  uri: string;
  prefix: string;
  /** Entity-decoded value. To get the raw bytes, slice the element. */
  value: string;
}

export interface XmlTextSpan {
  /** Byte offsets into the source buffer. */
  start: number;
  end: number;
  /** Code-unit offsets into the decoded source string. */
  charStart: number;
  charEnd: number;
  /** Entity-decoded value (`&amp;` -> `&`). Raw form is `src.slice(charStart, charEnd)`. */
  value: string;
}

export interface XmlNode {
  /** Raw qualified name as written, e.g. `w:p`. Never reconstructed, always as-parsed. */
  name: string;
  local: string;
  uri: string;
  prefix: string;
  attrs: XmlAttr[];

  /** Byte offset of the `<` that opens this element. */
  start: number;
  /** Byte offset one past the `>` that closes it. */
  end: number;
  /** Byte offset one past the `>` of the open tag. */
  contentStart: number;
  /** Byte offset of the `<` of the close tag. Equals contentStart when self-closing. */
  contentEnd: number;

  charStart: number;
  charEnd: number;
  charContentStart: number;
  charContentEnd: number;

  selfClosing: boolean;
  depth: number;
  /** Index among the parent's element children. */
  ordinal: number;

  parent: XmlNode | null;
  /** Element children only. WordprocessingML has no meaningful mixed content. */
  children: XmlNode[];
  /** Character data directly inside this element, decoded and concatenated. */
  text: string;
  /** Offsets of that character data, one span per contiguous run. */
  textSpans: XmlTextSpan[];
}

export interface XmlIndexOptions {
  /** Fail on XML that is not well-formed. Default true; the corpus is all valid. */
  strict?: boolean;
}

export interface XmlIndexStats {
  elements: number;
  /** Comments and processing instructions found inside the root element. */
  foreignNodes: number;
  /** True when the whole buffer is ASCII, i.e. byte offsets == char offsets (+ BOM). */
  ascii: boolean;
  encoding: "utf-8" | "utf-16le" | "utf-16be";
  bomBytes: number;
}

/**
 * Code-unit index -> byte offset.
 *
 * Queries from the parser arrive in monotonically increasing order, so the common path is an
 * incremental scan that costs O(n) over the whole parse. Checkpoints every 8k code units keep
 * out-of-order queries (which callers may make later, e.g. re-deriving a span) cheap too.
 */
class ByteOffsets {
  private cur = 0;
  private bytes: number;
  private cpChar: Int32Array = new Int32Array(0);
  private cpByte: Float64Array = new Float64Array(0);
  private readonly step = 8192;

  constructor(
    private readonly src: string,
    private readonly bomBytes: number,
    private readonly mode: "ascii" | "utf-8" | "utf-16",
  ) {
    this.bytes = bomBytes;
    if (mode === "utf-8") this.buildCheckpoints();
  }

  /**
   * Checkpoints store (charIndex, byteOffset) pairs at code-unit boundaries at or just past
   * each multiple of `step`. Storing the char index too — rather than assuming it is exactly
   * `k * step` — is what keeps this correct when a surrogate pair straddles a checkpoint.
   */
  private buildCheckpoints(): void {
    const len = this.src.length;
    const n = Math.floor(len / this.step) + 1;
    this.cpChar = new Int32Array(n);
    this.cpByte = new Float64Array(n);
    let b = this.bomBytes;
    let i = 0;
    let k = 1;
    this.cpChar[0] = 0;
    this.cpByte[0] = b;
    while (i < len) {
      b += utf8Len(this.src, i);
      i += surrogatePair(this.src, i) ? 2 : 1;
      while (k < n && i >= k * this.step) { this.cpChar[k] = i; this.cpByte[k] = b; k++; }
    }
    for (; k < n; k++) { this.cpChar[k] = i; this.cpByte[k] = b; }
  }

  at(charIndex: number): number {
    if (this.mode === "ascii") return this.bomBytes + charIndex;
    if (this.mode === "utf-16") return this.bomBytes + charIndex * 2;
    if (charIndex < this.cur) {
      let k = Math.min(Math.floor(charIndex / this.step), this.cpChar.length - 1);
      while (k > 0 && this.cpChar[k]! > charIndex) k--;
      this.cur = this.cpChar[k]!;
      this.bytes = this.cpByte[k]!;
    }
    let cur = this.cur;
    let bytes = this.bytes;
    const src = this.src;
    while (cur < charIndex) {
      bytes += utf8Len(src, cur);
      cur += surrogatePair(src, cur) ? 2 : 1;
    }
    this.cur = cur;
    this.bytes = bytes;
    return bytes;
  }
}

function surrogatePair(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  if (c < 0xd800 || c > 0xdbff || i + 1 >= s.length) return false;
  const d = s.charCodeAt(i + 1);
  return d >= 0xdc00 && d <= 0xdfff;
}

function utf8Len(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  if (surrogatePair(s, i)) return 4;
  return 3;
}

interface Decoded {
  src: string;
  bomBytes: number;
  encoding: "utf-8" | "utf-16le" | "utf-16be";
  ascii: boolean;
}

/**
 * Decode without letting the decoder eat the BOM: TextDecoder strips a UTF-8 BOM by default,
 * which would shift every subsequent byte offset by three and corrupt every splice.
 */
function decode(buf: Uint8Array): Decoded {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { src: new TextDecoder("utf-16le").decode(buf.subarray(2)), bomBytes: 2, encoding: "utf-16le", ascii: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { src: new TextDecoder("utf-16be").decode(buf.subarray(2)), bomBytes: 2, encoding: "utf-16be", ascii: false };
  }
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  const body = bom ? buf.subarray(bom) : buf;
  let ascii = true;
  for (let i = 0; i < body.length; i++) {
    if (body[i]! >= 0x80) { ascii = false; break; }
  }
  return { src: new TextDecoder("utf-8").decode(body), bomBytes: bom, encoding: "utf-8", ascii };
}

export class XmlIndex {
  readonly bytes: Uint8Array;
  /** The decoded source. Slicing this by `charStart`/`charEnd` gives the RAW markup. */
  readonly src: string;
  readonly root: XmlNode;
  readonly stats: XmlIndexStats;

  private constructor(bytes: Uint8Array, src: string, root: XmlNode, stats: XmlIndexStats) {
    this.bytes = bytes;
    this.src = src;
    this.root = root;
    this.stats = stats;
  }

  /** Raw markup for a node, exactly as it appears in the original buffer. */
  raw(n: XmlNode): string {
    return this.src.slice(n.charStart, n.charEnd);
  }

  /** Raw markup for a node's content, excluding its own tags. */
  rawInner(n: XmlNode): string {
    return this.src.slice(n.charContentStart, n.charContentEnd);
  }

  /** Original bytes for a node. This is what the splice engine copies. */
  rawBytes(n: XmlNode): Uint8Array {
    return this.bytes.subarray(n.start, n.end);
  }

  static parse(bytes: Uint8Array, opts: XmlIndexOptions = {}): XmlIndex {
    const { src, bomBytes, encoding, ascii } = decode(bytes);
    const mode = ascii ? "ascii" : encoding === "utf-8" ? "utf-8" : "utf-16";
    const off = new ByteOffsets(src, bomBytes, mode);

    const root: XmlNode = {
      name: "#document", local: "#document", uri: "", prefix: "", attrs: [],
      start: bomBytes, end: bytes.length, contentStart: bomBytes, contentEnd: bytes.length,
      charStart: 0, charEnd: src.length, charContentStart: 0, charContentEnd: src.length,
      selfClosing: false, depth: -1, ordinal: 0,
      parent: null, children: [], text: "", textSpans: [],
    };

    let cur = root;
    let elements = 0;
    let foreign = 0;
    let pendingCharStart = -1;
    /** End of the last thing consumed inside `cur`, in code units — the start of any text run. */
    let gapFrom = 0;
    let textBuf = "";
    let textFrom = -1;

    const parser = new SaxesParser({ xmlns: true, position: true, fileName: "document.xml" });

    const flushText = (charEnd: number): void => {
      if (textFrom < 0) { textBuf = ""; return; }
      if (textBuf.length > 0 || charEnd > textFrom) {
        cur.text += textBuf;
        cur.textSpans.push({
          start: off.at(textFrom), end: off.at(charEnd),
          charStart: textFrom, charEnd, value: textBuf,
        });
      }
      textBuf = "";
      textFrom = -1;
    };

    parser.on("opentagstart", (tag) => {
      // `position` sits one past the delimiter that terminated the name.
      let s = parser.position - tag.name.length - 2;
      if (src.charCodeAt(s) !== 0x3c /* < */) s = backTo(src, parser.position, 0x3c);
      pendingCharStart = s;
      flushText(s);
      gapFrom = s;
    });

    parser.on("opentag", (tag) => {
      const charStart = pendingCharStart;
      const charContentStart = parser.position;
      const node: XmlNode = {
        name: tag.name,
        local: tag.local ?? tag.name,
        uri: tag.uri ?? "",
        prefix: tag.prefix ?? "",
        attrs: [],
        start: off.at(charStart), end: -1,
        contentStart: off.at(charContentStart), contentEnd: -1,
        charStart, charEnd: -1,
        charContentStart, charContentEnd: -1,
        selfClosing: tag.isSelfClosing,
        depth: cur.depth + 1,
        ordinal: cur.children.length,
        parent: cur,
        children: [],
        text: "",
        textSpans: [],
      };
      for (const key of Object.keys(tag.attributes)) {
        const a = tag.attributes[key] as { name?: string; local: string; uri: string; prefix: string; value: string };
        node.attrs.push({ name: key, local: a.local, uri: a.uri, prefix: a.prefix, value: a.value });
      }
      cur.children.push(node);
      cur = node;
      elements++;
      gapFrom = charContentStart;
      textFrom = -1;
      textBuf = "";
    });

    parser.on("text", (t) => {
      if (textFrom < 0) textFrom = gapFrom;
      textBuf += t;
    });
    parser.on("cdata", (t) => {
      if (textFrom < 0) textFrom = gapFrom;
      textBuf += t;
    });

    parser.on("comment", () => { foreign++; flushText(gapFrom); gapFrom = parser.position; textFrom = -1; textBuf = ""; });
    parser.on("processinginstruction", () => { foreign++; flushText(gapFrom); gapFrom = parser.position; textFrom = -1; textBuf = ""; });

    parser.on("closetag", () => {
      const charEnd = parser.position;
      const charContentEnd = cur.selfClosing ? cur.charContentStart : backTo(src, charEnd, 0x3c);
      flushText(charContentEnd);
      cur.charContentEnd = charContentEnd;
      cur.charEnd = charEnd;
      cur.contentEnd = off.at(charContentEnd);
      cur.end = off.at(charEnd);
      const parent = cur.parent ?? root;
      gapFrom = charEnd;
      textFrom = -1;
      textBuf = "";
      cur = parent;
    });

    if (opts.strict === false) parser.on("error", () => {});
    else parser.on("error", (e) => { throw e; });

    parser.write(src).close();

    if (cur !== root) throw new Error(`xmlindex: unbalanced XML, still inside <${cur.name}>`);

    return new XmlIndex(bytes, src, root, {
      elements, foreignNodes: foreign, ascii, encoding, bomBytes,
    });
  }
}

/** Scan backwards from `from` (exclusive) for `code`. Bounded by tag length in practice. */
function backTo(src: string, from: number, code: number): number {
  for (let i = from - 1; i >= 0; i--) if (src.charCodeAt(i) === code) return i;
  return 0;
}

/* ------------------------------------------------------------------ traversal helpers */

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
export const XML_NS = "http://www.w3.org/XML/1998/namespace";
export const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";

/** First element child with the given local name in the wordprocessingml namespace. */
export function w(n: XmlNode | null | undefined, local: string): XmlNode | null {
  if (!n) return null;
  for (const c of n.children) if (c.local === local && c.uri === W_NS) return c;
  return null;
}

export function wAll(n: XmlNode | null | undefined, local: string): XmlNode[] {
  if (!n) return [];
  return n.children.filter((c) => c.local === local && c.uri === W_NS);
}

/** Attribute lookup by local name + namespace. Pass "" for unprefixed attributes. */
export function attrNS(n: XmlNode | null | undefined, uri: string, local: string): string | undefined {
  if (!n) return undefined;
  for (const a of n.attrs) if (a.local === local && a.uri === uri) return a.value;
  return undefined;
}

/** `w:val` of `n` itself — the OOXML idiom for a scalar attribute. */
export function wVal(n: XmlNode | null | undefined): string | undefined {
  return attrNS(n, W_NS, "val");
}

/** `w:val` of a named child, e.g. `wChildVal(pPr, "pStyle")`. */
export function wChildVal(n: XmlNode | null | undefined, local: string): string | undefined {
  return wVal(w(n, local));
}

/**
 * An OOXML toggle property: present means on unless `w:val` says otherwise.
 * `<w:b/>`, `<w:b w:val="1"/>`, `<w:b w:val="true"/>` are on; `w:val="0"|"false"|"off"` is off.
 */
export function wToggle(n: XmlNode | null | undefined, local: string): boolean {
  const el = w(n, local);
  if (!el) return false;
  const v = wVal(el);
  if (v === undefined) return true;
  return v !== "0" && v !== "false" && v !== "off";
}

export function descendantsNamed(n: XmlNode, uri: string, local: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (x: XmlNode): void => {
    for (const c of x.children) {
      if (c.local === local && c.uri === uri) out.push(c);
      walk(c);
    }
  };
  walk(n);
  return out;
}

/** All character data beneath a node, in document order. */
export function deepText(n: XmlNode): string {
  let s = n.text;
  for (const c of n.children) s += deepText(c);
  return s;
}
