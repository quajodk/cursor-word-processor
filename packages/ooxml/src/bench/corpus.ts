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
import { CORPUS_DIR, MANIFEST_PATH, ensureDir, listCorpusFiles } from "./paths";

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

/**
 * MANIFEST.json is a SHARED record — another agent writes it concurrently with
 * a flatter schema (`{note, generatedBy, files: [{file,url,sha256,bytes,
 * fetchedAt, features: string[]}]}`). Rather than fight over the shape, we
 * read either shape, key by sha256, and write back their array shape with our
 * richer data added under keys they don't use:
 *
 *   features   string[]          — their tag list, kept (we produce a superset)
 *   inventory  FeatureInventory  — our part-level inventory, added
 *   urls       string[]          — union of every URL this sha was fetched from
 *   source     string            — provenance note
 *
 * Nothing they write is ever dropped. Fields we don't understand are carried
 * through verbatim.
 */
export interface ManifestEntry {
  sha256: string;
  /** Filename on disk, relative to corpus/docx/. */
  file: string;
  /** Primary URL (their schema uses a single `url`). */
  url?: string;
  /** Every URL this exact byte sequence was retrieved from. */
  urls: string[];
  /** Human note about where this came from / why it's interesting. */
  source: string;
  bytes: number;
  /** Their key. */
  fetchedAt?: string;
  retrieved: string;
  /** Their coarse tag list. */
  features: string[];
  /** Our part-level inventory. */
  inventory: FeatureInventory;
  [carried: string]: unknown;
}

export interface Manifest {
  note?: string;
  generatedBy?: string;
  updated?: string;
  files: ManifestEntry[];
}

/** Coarse tags, compatible with the other agent's `features: string[]`. */
export function featureTags(f: FeatureInventory): string[] {
  const t: string[] = [];
  if (f.tables > 0) t.push("tables");
  if (f.maxTableDepth > 1) t.push("nested-tables");
  if (f.numbering) t.push("numbering");
  if (f.numberingLevels >= 9) t.push("multi-level-numbering");
  if (f.headers > 0) t.push("headers");
  if (f.footers > 0) t.push("footers");
  if (f.footnotes > 0) t.push("footnotes");
  if (f.endnotes > 0) t.push("endnotes");
  if (f.comments > 0) t.push("comments");
  if (f.revisions > 0) t.push("revisions");
  if (f.images > 0) t.push("images");
  if (f.embeddedObjects > 0) t.push("embedded-objects");
  if (f.sections > 1) t.push("section-breaks");
  if (f.fields > 0) t.push("fields");
  if (f.hyperlinks > 0) t.push("hyperlinks");
  if (f.bookmarks > 0) t.push("bookmarks");
  if (f.textboxes > 0) t.push("textboxes");
  if (f.contentControls > 0) t.push("content-controls");
  if (f.nonLatinText) t.push("non-latin-text");
  if (f.languages.length > 1) t.push("multilingual");
  if (f.rsidAttrs > 0) t.push("rsids");
  if ((f.reportedPages ?? 0) >= 50) t.push("50-plus-pages");
  else if ((f.reportedPages ?? 0) >= 20) t.push("20-plus-pages");
  return t;
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

/** Raw manifest read, tolerating either schema. Returns entries keyed by sha256. */
export async function readManifest(): Promise<Map<string, Partial<ManifestEntry>>> {
  const out = new Map<string, Partial<ManifestEntry>>();
  const f = Bun.file(MANIFEST_PATH);
  if (!(await f.exists())) return out;
  let raw: unknown;
  try {
    raw = await f.json();
  } catch {
    return out; // half-written by a concurrent writer; treat as empty and re-derive
  }
  const filesField = (raw as { files?: unknown }).files;
  const list: unknown[] = Array.isArray(filesField)
    ? filesField
    : filesField && typeof filesField === "object"
      ? Object.values(filesField as Record<string, unknown>)
      : [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const entry = e as Partial<ManifestEntry> & { url?: string };
    const sha = entry.sha256;
    if (!sha) continue;
    out.set(sha, entry);
  }
  return out;
}

/**
 * Append-only provenance journal, private to this rig. MANIFEST.json is shared
 * and another agent rewrites it wholesale; the journal is how our source notes
 * survive that. One JSON object per line, last write per sha wins.
 */
const JOURNAL_PATH = `${CORPUS_DIR}/PROVENANCE.bench.jsonl`;

export async function appendProvenance(
  rows: { sha256: string; file: string; url: string; source: string; retrieved: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  await ensureDir(CORPUS_DIR);
  const existing = (await Bun.file(JOURNAL_PATH).exists())
    ? await Bun.file(JOURNAL_PATH).text()
    : "";
  await Bun.write(JOURNAL_PATH, existing + rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export async function readProvenance(): Promise<Map<string, { urls: Set<string>; source: string; retrieved: string }>> {
  const out = new Map<string, { urls: Set<string>; source: string; retrieved: string }>();
  if (!(await Bun.file(JOURNAL_PATH).exists())) return out;
  for (const line of (await Bun.file(JOURNAL_PATH).text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { sha256: string; url: string; source: string; retrieved: string };
      const cur = out.get(r.sha256) ?? { urls: new Set<string>(), source: r.source, retrieved: r.retrieved };
      cur.urls.add(r.url);
      if (!cur.source) cur.source = r.source;
      if (r.retrieved < cur.retrieved) cur.retrieved = r.retrieved;
      out.set(r.sha256, cur);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/**
 * Re-reads MANIFEST.json immediately before writing and merges into it, so a
 * concurrent agent's entries survive. Their fields are carried through
 * verbatim; ours are added under keys they don't use.
 */
export async function mergeManifest(incoming: Map<string, ManifestEntry>): Promise<ManifestEntry[]> {
  const current = await readManifest();
  for (const [sha, entry] of incoming) {
    const prev = current.get(sha);
    const prevUrls = [
      ...(prev?.urls ?? []),
      ...(prev?.url ? [prev.url] : []),
    ].filter(Boolean) as string[];
    const urls = [...new Set([...prevUrls, ...entry.urls])].sort();
    current.set(sha, {
      ...prev,
      ...entry,
      url: prev?.url ?? entry.url ?? urls[0],
      urls,
      source: (prev?.source && prev.source !== "unknown" ? prev.source : "") || entry.source,
      fetchedAt: prev?.fetchedAt ?? entry.fetchedAt ?? entry.retrieved,
      /* Union of both tag lists — never drop a tag the other agent recorded. */
      features: [...new Set([...(prev?.features ?? []), ...entry.features])].sort(),
    });
  }
  const files = [...current.values()].sort((a, b) => (a.file ?? "").localeCompare(b.file ?? ""));
  await ensureDir(CORPUS_DIR);
  await Bun.write(
    MANIFEST_PATH,
    JSON.stringify(
      {
        note:
          "Real-world public .docx corpus for the round-trip fidelity rig. Keyed by sha256; " +
          "`features` is a coarse tag list, `inventory` is a part-level inventory derived by " +
          "unzipping and inspecting the OOXML parts. Merged from multiple agents — merge, do not overwrite.",
        generatedBy: "packages/ooxml/src/bench/corpus.ts",
        updated: new Date().toISOString(),
        count: files.length,
        files,
      },
      null,
      2,
    ) + "\n",
  );
  return files as ManifestEntry[];
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

export async function fetchCandidate(
  c: Candidate,
  existing: Map<string, Partial<ManifestEntry>>,
): Promise<FetchOutcome> {
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

  const prior = existing.get(v.sha256);
  if (prior?.file) {
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
export async function reinventory(): Promise<ManifestEntry[]> {
  const files = await listCorpusFiles();
  const incoming = new Map<string, ManifestEntry>();
  const existing = await readManifest();
  const journal = await readProvenance();
  const byFile = new Map<string, Partial<ManifestEntry>>();
  for (const e of existing.values()) if (e.file) byFile.set(e.file, e);

  for (const file of files) {
    const bytes = new Uint8Array(await Bun.file(`${CORPUS_DIR}/${file}`).arrayBuffer());
    const v = validateDocx(bytes);
    if ("error" in v) {
      console.warn(`  ! skipping ${file}: ${v.error}`);
      continue;
    }
    const j = journal.get(v.sha256);
    const prev = existing.get(v.sha256) ?? byFile.get(file);
    const inv = inventory(v.entries);
    const prevUrls = [...(prev?.urls ?? []), ...(prev?.url ? [prev.url] : [])].filter(Boolean) as string[];
    incoming.set(v.sha256, {
      ...prev,
      sha256: v.sha256,
      file,
      urls: [...new Set([...prevUrls, ...(j ? [...j.urls] : [])])].sort(),
      source: j?.source ?? prev?.source ?? "unknown (present on disk before this run)",
      bytes: bytes.length,
      retrieved: j?.retrieved ?? prev?.retrieved ?? prev?.fetchedAt ?? new Date().toISOString(),
      features: [...new Set([...(prev?.features ?? []), ...featureTags(inv)])].sort(),
      inventory: inv,
    });
  }
  return mergeManifest(incoming);
}
