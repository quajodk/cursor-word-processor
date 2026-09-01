/**
 * Corpus acquisition + inventory.
 *
 * Downloads real-world .docx files from public URLs, validates that each is a
 * genuine OOXML WordprocessingML package (not an HTML error page with a .docx
 * name, not a legacy .doc, not a .dotx template we can't score), and records
 * provenance + a feature inventory derived by ACTUALLY INSPECTING the OOXML
 * parts.
 *
 * Provenance lives in corpus/docx/MANIFEST.json, keyed by sha256 so that two
 * agents downloading concurrently merge rather than clobber, and so the same
 * file served from two URLs collapses to one entry with two source URLs.
 *
 * Bench tooling: allowed to touch the filesystem and the network (see
 * ARCHITECTURE.md §1 — the no-I/O rule binds library code, not the rig).
 */

import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { CORPUS_DIR, MANIFEST_PATH, ensureDir, listCorpusFiles } from "./paths.ts";

export interface FeatureInventory {
  paragraphs: number;
  runs: number;
  /** Distinct w:pStyle / w:rStyle ids referenced by the body. */
  styleRefs: number;
  /** Style definitions present in styles.xml. */
  styleDefs: number;
  tables: number;
  /** Deepest w:tbl nesting observed (1 = flat tables). */
  maxTableDepth: number;
  numbering: boolean;
  /** Distinct w:abstractNum levels defined — a proxy for multi-level lists. */
  numberingLevels: number;
  headers: number;
  footers: number;
  footnotes: number;
  endnotes: number;
  comments: number;
  /** w:ins / w:del / w:moveFrom / w:moveTo / w:pPrChange / w:rPrChange counts. */
  revisions: number;
  images: number;
  /** Embedded objects, charts, SmartArt, OLE. */
  embeddedObjects: number;
  /** w:sectPr count. >1 means section breaks. */
  sections: number;
  /** w:fldSimple + w:instrText — TOCs, page numbers, cross-references. */
  fields: number;
  hyperlinks: number;
  bookmarks: number;
  /** w:drawing textboxes / w:pict — floating content. */
  textboxes: number;
  contentControls: number;
  /** Distinct xml:lang values seen; >1 or non-en means multilingual. */
  languages: string[];
  /** True when body text contains codepoints outside Latin-1. */
  nonLatinText: boolean;
  /** rsid attributes — Word's revision-save churn. Relevant to the normalizer. */
  rsidAttrs: number;
  /** Rough page count from app.xml (Word's own estimate). May be absent. */
  reportedPages: number | null;
  reportedWords: number | null;
  /** Every zip entry name — the ground truth for "what parts exist". */
  parts: string[];
  /** Bytes of word/document.xml uncompressed — our real size metric. */
  documentXmlBytes: number;
  /** Producer application from app.xml, e.g. "Microsoft Office Word". */
  generator: string | null;
}

export interface ManifestEntry {
  sha256: string;
  /** Filename on disk, relative to corpus/docx/. */
  file: string;
  /** Every URL this exact byte sequence was retrieved from. */
  urls: string[];
  /** Human note about where this came from / why it's interesting. */
  source: string;
  bytes: number;
  retrieved: string;
  features: FeatureInventory;
}

export interface Manifest {
  version: 1;
  updated: string;
  /** Keyed by sha256. */
  files: Record<string, ManifestEntry>;
}

const WORD_NS_DOC = "word/document.xml";

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface Validated {
  bytes: Uint8Array;
  sha256: string;
  entries: Record<string, Uint8Array>;
}

/**
 * A file is corpus-eligible only if it is a real zip containing
 * word/document.xml with a <w:body>. This rejects: HTML error pages served
 * with a .docx name (extremely common on government sites), legacy .doc
 * (OLE compound files, magic D0CF11E0), .docm macro files are ALLOWED (they
 * are still WordprocessingML), and PDFs mislabelled as docx.
 */
export function validateDocx(bytes: Uint8Array): Validated | { error: string } {
  if (bytes.length < 100) return { error: `too small (${bytes.length} bytes)` };
  const magic = [bytes[0], bytes[1], bytes[2], bytes[3]];
  if (magic[0] === 0xd0 && magic[1] === 0xcf) return { error: "legacy .doc (OLE compound file)" };
  if (magic[0] === 0x25 && magic[1] === 0x50) return { error: "PDF, not docx" };
  if (!(magic[0] === 0x50 && magic[1] === 0x4b)) {
    const head = strFromU8(bytes.slice(0, 200)).replace(/\s+/g, " ").slice(0, 120);
    return { error: `not a zip (starts with: ${head})` };
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (e) {
    return { error: `zip parse failed: ${(e as Error).message}` };
  }
  const doc = entries[WORD_NS_DOC];
  if (!doc) {
    const names = Object.keys(entries).slice(0, 8).join(", ");
    return { error: `no ${WORD_NS_DOC} (entries: ${names})` };
  }
  const xml = strFromU8(doc);
  if (!/<w:body[\s>]/.test(xml)) return { error: "document.xml has no <w:body>" };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, entries };
}

/* ------------------------------------------------------------------ */
/* Feature inventory — by inspection, never by guessing                */
/* ------------------------------------------------------------------ */

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

export function inventory(entries: Record<string, Uint8Array>): FeatureInventory {
  const parts = Object.keys(entries).sort();
  const text = (name: string): string => {
    const b = entries[name];
    return b ? strFromU8(b) : "";
  };

  const doc = text(WORD_NS_DOC);
  const styles = text("word/styles.xml");
  const numbering = text("word/numbering.xml");
  const commentsXml = text("word/comments.xml");
  const footnotesXml = text("word/footnotes.xml");
  const endnotesXml = text("word/endnotes.xml");
  const app = text("docProps/app.xml");

  const headerParts = parts.filter((p) => /^word\/header\d*\.xml$/.test(p));
  const footerParts = parts.filter((p) => /^word\/footer\d*\.xml$/.test(p));
  const mediaParts = parts.filter((p) => /^word\/media\//.test(p));
  const embedParts = parts.filter((p) =>
    /^word\/(embeddings|charts|diagrams)\//.test(p),
  );

  /* Every part that can hold body content — headers and footers carry tables,
     fields and images too, and ignoring them undercounts real documents. */
  const bodyParts = [doc, ...headerParts.map(text), ...footerParts.map(text), footnotesXml, endnotesXml];
  const allBody = bodyParts.join("");

  const styleRefs = new Set<string>();
  for (const m of allBody.matchAll(/<w:(?:pStyle|rStyle|tblStyle)\s+w:val="([^"]*)"/g)) {
    styleRefs.add(m[1]!);
  }

  /* Real footnotes/endnotes: the parts always contain two synthetic entries
     (separator, continuationSeparator) even in documents with none. */
  const realNotes = (xml: string, tag: string): number =>
    count(xml, new RegExp(`<w:${tag}\\s+[^>]*w:id="(?!-?[01]")`, "g"));

  /* Table nesting depth via a scan of open/close tags, not a regex guess. */
  let maxTableDepth = 0;
  {
    let depth = 0;
    for (const m of allBody.matchAll(/<(\/?)w:tbl(\s|>|\/>)/g)) {
      if (m[1] === "/") depth = Math.max(0, depth - 1);
      else if (!m[0].endsWith("/>")) {
        depth++;
        maxTableDepth = Math.max(maxTableDepth, depth);
      }
    }
  }

  const langs = new Set<string>();
  for (const m of allBody.matchAll(/w:val="([a-z]{2}(?:-[A-Z]{2})?)"[^>]*\/>\s*<\/w:lang>|<w:lang\s+[^>]*w:val="([a-z]{2}(?:-[A-Za-z]{2,4})?)"/g)) {
    const v = m[1] ?? m[2];
    if (v) langs.add(v);
  }

  /* Non-Latin detection reads only <w:t> text content, so that base64 image
     data and namespace URIs cannot make a document look multilingual. */
  let nonLatinText = false;
  for (const m of allBody.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)) {
    const s = m[1]!;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c > 0x024f && !(c >= 0x2000 && c <= 0x206f)) {
        nonLatinText = true;
        break;
      }
    }
    if (nonLatinText) break;
  }

  const num = (re: RegExp, src: string): number | null => {
    const m = src.match(re);
    return m ? Number(m[1]) : null;
  };

  return {
    paragraphs: count(doc, /<w:p(?:\s[^>]*)?>/g),
    runs: count(doc, /<w:r(?:\s[^>]*)?>/g),
    styleRefs: styleRefs.size,
    styleDefs: count(styles, /<w:style\s/g),
    tables: count(allBody, /<w:tbl(?:\s[^>]*)?>/g),
    maxTableDepth,
    numbering: numbering.length > 0 && /<w:num\s/.test(numbering),
    numberingLevels: count(numbering, /<w:lvl\s/g),
    headers: headerParts.length,
    footers: footerParts.length,
    footnotes: realNotes(footnotesXml, "footnote"),
    endnotes: realNotes(endnotesXml, "endnote"),
    comments: count(commentsXml, /<w:comment\s/g),
    revisions:
      count(allBody, /<w:ins\s/g) +
      count(allBody, /<w:del\s/g) +
      count(allBody, /<w:moveFrom\s/g) +
      count(allBody, /<w:moveTo\s/g) +
      count(allBody, /<w:pPrChange\s/g) +
      count(allBody, /<w:rPrChange\s/g) +
      count(allBody, /<w:tblPrChange\s/g),
    images: mediaParts.length,
    embeddedObjects: embedParts.length + count(allBody, /<w:object[\s>]/g),
    sections: count(allBody, /<w:sectPr[\s>]/g),
    fields: count(allBody, /<w:fldSimple[\s>]/g) + count(allBody, /<w:instrText[\s>]/g),
    hyperlinks: count(allBody, /<w:hyperlink[\s>]/g),
    bookmarks: count(allBody, /<w:bookmarkStart[\s>]/g),
    textboxes: count(allBody, /<w:txbxContent[\s>]/g) + count(allBody, /<w:pict[\s>]/g),
    contentControls: count(allBody, /<w:sdt[\s>]/g),
    languages: [...langs].sort(),
    nonLatinText,
    rsidAttrs: count(doc, /\sw:rsid[A-Za-z]*="/g),
    reportedPages: num(/<Pages>(\d+)<\/Pages>/, app),
    reportedWords: num(/<Words>(\d+)<\/Words>/, app),
    parts,
    documentXmlBytes: entries[WORD_NS_DOC]?.length ?? 0,
    generator: app.match(/<Application>([^<]*)<\/Application>/)?.[1] ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Manifest I/O — merge, never overwrite                               */
/* ------------------------------------------------------------------ */

export async function readManifest(): Promise<Manifest> {
  const f = Bun.file(MANIFEST_PATH);
  if (!(await f.exists())) return { version: 1, updated: new Date().toISOString(), files: {} };
  try {
    const m = (await f.json()) as Manifest;
    if (!m.files) return { version: 1, updated: new Date().toISOString(), files: {} };
    return m;
  } catch {
    return { version: 1, updated: new Date().toISOString(), files: {} };
  }
}

/**
 * Re-reads the manifest immediately before writing and merges into it, so that
 * a concurrent agent's entries survive. Union on `urls`; incoming feature
 * inventory wins (it is derived from bytes, so it is identical anyway).
 */
export async function mergeManifest(incoming: Record<string, ManifestEntry>): Promise<Manifest> {
  const current = await readManifest();
  for (const [sha, entry] of Object.entries(incoming)) {
    const prev = current.files[sha];
    if (prev) {
      current.files[sha] = {
        ...prev,
        ...entry,
        urls: [...new Set([...prev.urls, ...entry.urls])].sort(),
        source: prev.source || entry.source,
        retrieved: prev.retrieved < entry.retrieved ? prev.retrieved : entry.retrieved,
      };
    } else {
      current.files[sha] = entry;
    }
  }
  current.updated = new Date().toISOString();
  await ensureDir(CORPUS_DIR);
  await Bun.write(MANIFEST_PATH, JSON.stringify(current, null, 2) + "\n");
  return current;
}

/* ------------------------------------------------------------------ */
/* Fetch                                                               */
/* ------------------------------------------------------------------ */

export interface Candidate {
  url: string;
  /** Short provenance note: who published it, what kind of document. */
  source: string;
  /** Preferred basename (without extension); falls back to the URL basename. */
  name?: string;
}

export interface FetchOutcome {
  url: string;
  ok: boolean;
  reason?: string;
  sha256?: string;
  file?: string;
  bytes?: number;
  duplicateOf?: string;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function safeName(c: Candidate): string {
  const fromUrl = decodeURIComponent(c.url.split("?")[0]!.split("/").pop() ?? "doc");
  const base = (c.name ?? fromUrl).replace(/\.(docx|docm|dotx)$/i, "");
  return (
    base
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72) || "doc"
  );
}

export async function fetchCandidate(c: Candidate, existing: Manifest): Promise<FetchOutcome> {
  let res: Response;
  try {
    res = await fetch(c.url, {
      headers: { "User-Agent": UA, Accept: "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    return { url: c.url, ok: false, reason: `network: ${(e as Error).message}` };
  }
  if (!res.ok) return { url: c.url, ok: false, reason: `HTTP ${res.status}` };

  const bytes = new Uint8Array(await res.arrayBuffer());
  const v = validateDocx(bytes);
  if ("error" in v) return { url: c.url, ok: false, reason: v.error };

  const prior = existing.files[v.sha256];
  if (prior) {
    return {
      url: c.url,
      ok: true,
      sha256: v.sha256,
      file: prior.file,
      bytes: bytes.length,
      duplicateOf: prior.file,
    };
  }

  const file = `${safeName(c)}-${v.sha256.slice(0, 8)}.docx`;
  await ensureDir(CORPUS_DIR);
  await Bun.write(`${CORPUS_DIR}/${file}`, bytes);
  return { url: c.url, ok: true, sha256: v.sha256, file, bytes: bytes.length };
}

/**
 * Rebuilds the inventory for every .docx currently on disk. Used after a fetch
 * run, and standalone to pick up files another agent downloaded without
 * writing a manifest entry.
 */
export async function reinventory(
  sourceHints: Map<string, { source: string; urls: string[] }> = new Map(),
): Promise<Manifest> {
  const files = await listCorpusFiles();
  const incoming: Record<string, ManifestEntry> = {};
  const existing = await readManifest();
  const byFile = new Map<string, ManifestEntry>();
  for (const e of Object.values(existing.files)) byFile.set(e.file, e);

  for (const file of files) {
    const bytes = new Uint8Array(await Bun.file(`${CORPUS_DIR}/${file}`).arrayBuffer());
    const v = validateDocx(bytes);
    if ("error" in v) {
      console.warn(`  ! skipping ${file}: ${v.error}`);
      continue;
    }
    const hint = sourceHints.get(file);
    const prev = byFile.get(file) ?? existing.files[v.sha256];
    incoming[v.sha256] = {
      sha256: v.sha256,
      file,
      urls: [...new Set([...(prev?.urls ?? []), ...(hint?.urls ?? [])])].sort(),
      source: hint?.source ?? prev?.source ?? "unknown (present on disk before this run)",
      bytes: bytes.length,
      retrieved: prev?.retrieved ?? new Date().toISOString(),
      features: inventory(v.entries),
    };
  }
  return mergeManifest(incoming);
}
