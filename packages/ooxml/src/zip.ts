/**
 * Zip SPLICING, not zip writing.
 *
 * DOCX-FIDELITY.md §4 step 5: "copy all other zip entries **verbatim, uncompressed bytes and
 * all**". Taken literally that is a statement about the *package*, not just about the parts:
 * if we re-zip a document whose parts are all unchanged we get a different file — different
 * deflate stream, different extra fields, different ordering, a different central directory —
 * and the byte-identity claim of §2 is dead on arrival even though every part is identical.
 *
 * So this module does not build a zip. It edits one:
 *
 *   - the bytes before the first local header (self-extracting stubs, alignment padding) are
 *     copied verbatim;
 *   - every UNCHANGED entry is copied as the raw byte span running from its local file header
 *     to the start of the next thing in the file. That span carries the local header, the extra
 *     field, the compressed stream, any data descriptor and any inter-entry padding, none of
 *     which we ever have to understand;
 *   - a CHANGED entry is the only place a new local header is synthesised;
 *   - each central directory record is copied verbatim with exactly four fields patched (crc,
 *     sizes, local header offset), so extra fields, comments, external attributes and the
 *     "version made by" survive untouched;
 *   - the end-of-central-directory record keeps its comment and its counts.
 *
 * The consequence worth stating plainly: `spliceZip(bytes, {})` returns `bytes`, and it does so
 * by actually rebuilding the file rather than by short-circuiting. That is a real test of this
 * module, and the scorer's T0 tier depends on it being true rather than asserted.
 *
 * Pure logic: no node:fs, no node:zlib. Deflate comes from fflate, CRC-32 is 20 lines below.
 */

import { deflateSync } from "fflate";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

export class ZipError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  name: string;
  /** Offset of the entry's local file header, from the central directory record. */
  localOffset: number;
  /**
   * One past the last byte belonging to this entry's local block: the start of the next local
   * header, or of the central directory. Includes any data descriptor and any padding, which is
   * exactly why we never need to parse either.
   */
  localEnd: number;
  /** Byte range of this entry's record in the central directory. */
  centralStart: number;
  centralEnd: number;
  /** Fields read from the central record — the authoritative copy per APPNOTE 4.4. */
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Raw name bytes, reused verbatim when a header has to be rewritten. */
  nameBytes: Uint8Array;
}

export interface ZipLayout {
  entries: ZipEntry[];
  /** Bytes before the first local header. Copied verbatim. */
  preamble: number;
  centralStart: number;
  centralEnd: number;
  /** [centralEnd, eocdStart) — zip64 EOCD record + locator live here when present. */
  eocdStart: number;
  eocdCommentLength: number;
  zip64: boolean;
}

/* ------------------------------------------------------------------ little-endian reads */

const u16 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const u32 = (b: Uint8Array, i: number): number =>
  (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)) + b[i + 3]! * 0x1000000;

function putU16(b: Uint8Array, i: number, v: number): void {
  b[i] = v & 0xff;
  b[i + 1] = (v >>> 8) & 0xff;
}

function putU32(b: Uint8Array, i: number, v: number): void {
  b[i] = v & 0xff;
  b[i + 1] = (v >>> 8) & 0xff;
  b[i + 2] = (v >>> 16) & 0xff;
  b[i + 3] = (v >>> 24) & 0xff;
}

/* ------------------------------------------------------------------ crc32 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ------------------------------------------------------------------ reading the layout */

/**
 * Read the package's physical layout. Deliberately shallow: it learns where things are, not
 * what they contain. The only fields decoded are the ones a rewrite has to patch.
 */
export function readZipLayout(buf: Uint8Array): ZipLayout {
  // The EOCD is at the end, but a zip comment may follow it, so scan backwards.
  const maxBack = Math.min(buf.length, 0xffff + 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= buf.length - maxBack && i >= 0; i--) {
    if (u32(buf, i) === SIG_EOCD) {
      // Guard against the signature appearing inside a comment: the declared comment length
      // must reach exactly the end of the file.
      if (i + 22 + u16(buf, i + 20) === buf.length) { eocd = i; break; }
    }
  }
  if (eocd < 0) throw new ZipError("no end-of-central-directory record", "no-eocd");

  const total = u16(buf, eocd + 10);
  let centralSize = u32(buf, eocd + 12);
  let centralStart = u32(buf, eocd + 16);
  let count = total;
  let zip64 = false;

  if (centralStart === 0xffffffff || centralSize === 0xffffffff || total === 0xffff) {
    zip64 = true;
    // The zip64 locator sits immediately before the EOCD.
    if (eocd >= 20 && u32(buf, eocd - 20) === SIG_ZIP64_LOCATOR) {
      const z64 = u32(buf, eocd - 20 + 8); // low 32 bits of the zip64 EOCD offset
      if (u32(buf, z64) === SIG_ZIP64_EOCD) {
        count = u32(buf, z64 + 32);
        centralSize = u32(buf, z64 + 40);
        centralStart = u32(buf, z64 + 48);
      }
    }
  }

  const entries: ZipEntry[] = [];
  let p = centralStart;
  for (let i = 0; i < count; i++) {
    if (u32(buf, p) !== SIG_CENTRAL) throw new ZipError(`central directory record ${i} has a bad signature`, "bad-central");
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const entry: ZipEntry = {
      name: new TextDecoder("utf-8").decode(nameBytes),
      localOffset: u32(buf, p + 42),
      localEnd: -1,
      centralStart: p,
      centralEnd: p + 46 + nameLen + extraLen + commentLen,
      flags: u16(buf, p + 8),
      method: u16(buf, p + 10),
      crc32: u32(buf, p + 16),
      compressedSize: u32(buf, p + 20),
      uncompressedSize: u32(buf, p + 24),
      nameBytes,
    };
    entries.push(entry);
    p = entry.centralEnd;
  }
  const centralEnd = p;

  // Local blocks are delimited by the next local header in FILE order, which is not always
  // central directory order. Sorting by offset and chaining is what makes an unchanged entry a
  // verbatim span rather than a reconstruction.
  const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 0; i < byOffset.length; i++) {
    byOffset[i]!.localEnd = i + 1 < byOffset.length ? byOffset[i + 1]!.localOffset : centralStart;
    if (u32(buf, byOffset[i]!.localOffset) !== SIG_LOCAL) {
      throw new ZipError(`entry ${byOffset[i]!.name} has no local file header at its declared offset`, "bad-local");
    }
  }

  return {
    entries,
    preamble: byOffset.length > 0 ? byOffset[0]!.localOffset : 0,
    centralStart,
    centralEnd,
    eocdStart: eocd,
    eocdCommentLength: u16(buf, eocd + 20),
    zip64,
  };
}

/* ------------------------------------------------------------------ splicing */

export interface SpliceOptions {
  /**
   * Deflate level for entries that had to be rewritten. Irrelevant to correctness; 6 matches
   * what most producers emit and keeps output sizes in the same ballpark as the origin.
   */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

export interface SpliceReport {
  /** Entries whose bytes were re-encoded. */
  rewritten: string[];
  /** Entries copied as verbatim byte spans. */
  copied: number;
  /** True when the output is byte-identical to the input. */
  identical: boolean;
}

/**
 * Rebuild the package with `replacements` (part name -> new uncompressed bytes) applied.
 *
 * A replacement whose bytes are already what the entry holds is NOT treated as a change: the
 * caller is expected to hand us the result of a splice that may well have reproduced the
 * original exactly, and re-deflating it would throw away byte-identity for no reason. That
 * check compares the *uncompressed* content, so it costs one inflate of one part.
 */
export function spliceZip(
  buf: Uint8Array,
  replacements: Record<string, Uint8Array>,
  opts: SpliceOptions = {},
): { bytes: Uint8Array; report: SpliceReport } {
  const layout = readZipLayout(buf);
  if (layout.zip64) throw new ZipError("zip64 packages are not spliced", "zip64");

  const rewritten = new Map<string, { data: Uint8Array; crc: number; deflated: Uint8Array | null }>();
  for (const [name, data] of Object.entries(replacements)) {
    const e = layout.entries.find((x) => x.name === name);
    if (!e) throw new ZipError(`cannot replace ${name}: no such entry`, "no-entry");
    const crc = crc32(data);
    // Identical content: leave the entry alone, keeping its original compressed stream.
    if (crc === e.crc32 && data.length === e.uncompressedSize) continue;
    const deflated = e.method === 0 ? null : deflateSync(data, { level: opts.level ?? 6 });
    rewritten.set(name, { data, crc, deflated });
  }

  if (rewritten.size === 0) {
    // Nothing changed. Still reassemble rather than returning the input: an assembler that is
    // only exercised on the changed path is an assembler nobody has tested.
    const out = reassemble(buf, layout, rewritten, opts);
    return { bytes: out, report: { rewritten: [], copied: layout.entries.length, identical: eq(out, buf) } };
  }

  const out = reassemble(buf, layout, rewritten, opts);
  return {
    bytes: out,
    report: {
      rewritten: [...rewritten.keys()],
      copied: layout.entries.length - rewritten.size,
      identical: eq(out, buf),
    },
  };
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function reassemble(
  buf: Uint8Array,
  layout: ZipLayout,
  rewritten: Map<string, { data: Uint8Array; crc: number; deflated: Uint8Array | null }>,
  _opts: SpliceOptions,
): Uint8Array {
  const byOffset = [...layout.entries].sort((a, b) => a.localOffset - b.localOffset);
  const pieces: Uint8Array[] = [];
  /** New local header offset for each entry, keyed by central record start (unique per entry). */
  const newOffset = new Map<number, number>();
  interface Patch { crc: number; csize: number; usize: number; flags: number; method: number }
  const patched = new Map<number, Patch>();

  let at = 0;
  const push = (b: Uint8Array): void => { pieces.push(b); at += b.length; };

  push(buf.subarray(0, layout.preamble));

  for (const e of byOffset) {
    newOffset.set(e.centralStart, at);
    const rep = rewritten.get(e.name);
    if (!rep) {
      // The whole span: local header, extra field, stream, data descriptor, padding.
      push(buf.subarray(e.localOffset, e.localEnd));
      continue;
    }
    const stored = rep.deflated ?? rep.data;
    const useStored = rep.deflated !== null && rep.deflated.length >= rep.data.length;
    const payload = useStored ? rep.data : stored;
    const method = useStored ? 0 : e.method === 0 ? 0 : 8;
    // Bit 3 (data descriptor) must go: we know the sizes up front and write them in the header.
    const flags = e.flags & ~0x0008;

    const header = new Uint8Array(30 + e.nameBytes.length);
    putU32(header, 0, SIG_LOCAL);
    putU16(header, 4, u16(buf, e.localOffset + 4));   // version needed, as the producer set it
    putU16(header, 6, flags);
    putU16(header, 8, method);
    putU16(header, 10, u16(buf, e.localOffset + 10)); // last mod time
    putU16(header, 12, u16(buf, e.localOffset + 12)); // last mod date
    putU32(header, 14, rep.crc);
    putU32(header, 18, payload.length);
    putU32(header, 22, rep.data.length);
    putU16(header, 26, e.nameBytes.length);
    putU16(header, 28, 0);                            // no extra field: a stale one could lie
    header.set(e.nameBytes, 30);
    push(header);
    push(payload);
    // The method may have flipped to stored; the central record has to agree.
    patched.set(e.centralStart, { crc: rep.crc, csize: payload.length, usize: rep.data.length, flags, method });
  }

  const centralStart = at;
  for (const e of layout.entries) {
    const rec = buf.slice(e.centralStart, e.centralEnd);
    putU32(rec, 42, newOffset.get(e.centralStart)!);
    const s = patched.get(e.centralStart);
    if (s) {
      putU16(rec, 8, s.flags);
      putU16(rec, 10, s.method);
      putU32(rec, 16, s.crc);
      putU32(rec, 20, s.csize);
      putU32(rec, 24, s.usize);
    }
    push(rec);
  }
  const centralSize = at - centralStart;

  // Anything between the central directory and the EOCD (there is nothing in a non-zip64
  // package, and we refuse zip64 above) is carried through unchanged.
  push(buf.subarray(layout.centralEnd, layout.eocdStart));

  const eocd = buf.slice(layout.eocdStart, layout.eocdStart + 22 + layout.eocdCommentLength);
  putU32(eocd, 12, centralSize);
  putU32(eocd, 16, centralStart);
  push(eocd);

  const out = new Uint8Array(at);
  let o = 0;
  for (const p of pieces) { out.set(p, o); o += p.length; }
  return out;
}
