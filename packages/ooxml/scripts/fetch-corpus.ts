/**
 * Corpus collector.
 *
 * The house rule is that no .docx we test against may be authored by us. This script downloads
 * real-world public documents (government forms, university templates, court filings, agency
 * protocols) and records provenance so the corpus is reproducible and auditable.
 *
 * This file is the ONLY place in @scriv/ooxml permitted to do I/O or network access. It is a
 * build-time tool, never imported by the library (see packages/ooxml/src — pure logic only).
 *
 *   bun run packages/ooxml/scripts/fetch-corpus.ts [--seeds path] [--per-domain N] [--max N]
 */

import { unzipSync, strFromU8 } from "fflate";

const ROOT = new URL("../../../", import.meta.url).pathname;
const CORPUS = `${ROOT}corpus/docx`;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

interface ManifestEntry {
  file: string;
  url: string;
  fetchedAt: string;
  sha256: string;
  bytes: number;
  /** Coarse feature flags, derived from the document part. Drives corpus-coverage reporting. */
  features: string[];
}

function arg(name: string, dflt: string): string {
  const i = Bun.argv.indexOf(`--${name}`);
  return i >= 0 && Bun.argv[i + 1] ? Bun.argv[i + 1]! : dflt;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A file is only accepted into the corpus if it is genuinely a WordprocessingML package. */
function inspect(bytes: Uint8Array): { ok: boolean; features: string[] } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    return { ok: false, features: [] };
  }
  const doc = files["word/document.xml"];
  if (!doc) return { ok: false, features: [] };
  const xml = strFromU8(doc);
  const f: string[] = [];
  const has = (needle: string, flag: string) => {
    if (xml.includes(needle)) f.push(flag);
  };
  has("<w:tbl>", "tables");
  has("<w:numPr>", "numbering");
  has("w:commentRangeStart", "comments");
  has("<w:ins ", "tracked-insertions");
  has("<w:del ", "tracked-deletions");
  has("<w:drawing>", "drawings");
  has("<w:hyperlink", "hyperlinks");
  has("<w:sectPr", "sections");
  has("<w:fldChar", "fields");
  has("<w:footnoteReference", "footnotes");
  if (files["word/header1.xml"] || files["word/footer1.xml"]) f.push("headers-footers");
  if (files["word/numbering.xml"]) f.push("numbering-part");
  if (files["word/comments.xml"]) f.push("comments-part");
  // Non-ASCII content is what exercises the byte-offset path in xmlindex.
  if (/[^\x00-\x7f]/.test(xml)) f.push("non-ascii");
  return { ok: true, features: f };
}

/**
 * Some publishers (notably 3GPP, whose change requests are the best public source of real
 * tracked-changes documents) distribute .docx inside an outer .zip. Unwrap one level.
 */
function unwrap(bytes: Uint8Array): Uint8Array | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    return null;
  }
  if (files["word/document.xml"]) return bytes;
  const inner = Object.keys(files)
    .filter((n) => n.toLowerCase().endsWith(".docx"))
    .sort((a, b) => (files[b]!.length ?? 0) - (files[a]!.length ?? 0))[0];
  return inner ? files[inner]! : null;
}

function slug(url: string): string {
  const u = new URL(url);
  const base = decodeURIComponent(u.pathname.split("/").pop() ?? "doc.docx")
    .replace(/\.docx?$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const host = u.hostname.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-");
  return `${host}__${base || "doc"}.docx`;
}

async function main() {
  const seedsPath = arg("seeds", `${CORPUS}/SEEDS.txt`);
  const perDomain = Number(arg("per-domain", "8"));
  const max = Number(arg("max", "60"));

  const seeds = (await Bun.file(seedsPath).text())
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));

  const manifestFile = Bun.file(`${CORPUS}/MANIFEST.json`);
  let existing: ManifestEntry[] = [];
  if (await manifestFile.exists()) {
    try {
      const parsed = JSON.parse(await manifestFile.text());
      if (Array.isArray(parsed?.files)) existing = parsed.files;
    } catch {
      /* start fresh */
    }
  }
  const haveUrl = new Set(existing.map((e) => e.url));
  const haveHash = new Set(existing.map((e) => e.sha256));
  const domainCount = new Map<string, number>();
  for (const e of existing) {
    const h = new URL(e.url).hostname;
    domainCount.set(h, (domainCount.get(h) ?? 0) + 1);
  }

  const out: ManifestEntry[] = [...existing];
  let added = 0;

  for (const url of seeds) {
    if (out.length >= max) break;
    if (haveUrl.has(url)) continue;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if ((domainCount.get(host) ?? 0) >= perDomain) continue;

    let bytes: Uint8Array;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
      if (!res.ok) {
        console.log(`skip ${res.status}  ${url}`);
        continue;
      }
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      console.log(`skip ERR    ${url} :: ${(err as Error).message}`);
      continue;
    }

    const unwrapped = unwrap(bytes);
    if (!unwrapped) {
      console.log(`skip !docx ${url}`);
      continue;
    }
    bytes = unwrapped;

    const { ok, features } = inspect(bytes);
    if (!ok) {
      console.log(`skip !docx ${url}`);
      continue;
    }
    const hash = await sha256(bytes);
    if (haveHash.has(hash)) {
      console.log(`skip dup   ${url}`);
      continue;
    }

    const file = slug(url);
    await Bun.write(`${CORPUS}/${file}`, bytes);
    out.push({
      file,
      url,
      fetchedAt: new Date().toISOString(),
      sha256: hash,
      bytes: bytes.length,
      features,
    });
    haveUrl.add(url);
    haveHash.add(hash);
    domainCount.set(host, (domainCount.get(host) ?? 0) + 1);
    added++;
    console.log(`ok   ${String(bytes.length).padStart(8)}  ${file}  [${features.join(",")}]`);
  }

  await Bun.write(
    `${CORPUS}/MANIFEST.json`,
    JSON.stringify(
      {
        note: "Real-world public .docx files collected from the wild. No fixture in this corpus was authored by this project.",
        generatedBy: "packages/ooxml/scripts/fetch-corpus.ts",
        files: out.sort((a, b) => a.file.localeCompare(b.file)),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\n${added} added, ${out.length} total in corpus.`);
}

await main();
