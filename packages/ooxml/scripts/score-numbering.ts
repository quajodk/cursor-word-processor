/**
 * How often do our computed numbering labels agree with Word's own?
 *
 * Word caches the rendered result of a TOC field in the document, so a document with a table
 * of contents carries Word's answer for every heading it lists: "1.2.1Assumptions4" is Word
 * saying that heading is 1.2.1. That is ground truth, produced by Word, sitting inside files
 * nobody selected for this purpose — the best validation set this problem is going to get.
 *
 * It matters because a WRONG number is worse than no number. DOCX-FIDELITY.md §3: "silent
 * misapplication is worse than visible loss." A heading we label 1.1.1 that Word calls 1.2.1
 * is not a cosmetic slip — the writer may type a cross-reference to it.
 *
 * Run: bun packages/ooxml/scripts/score-numbering.ts
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { unzipSync } from "fflate";
import { importDocx } from "../src/import";

function repoRoot(): string {
  let d = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "bun.lock"))) return d;
    d = dirname(d);
  }
  return d;
}

const dir = join(repoRoot(), "corpus", "docx");

/** A cached TOC line: a number, a title, and a page. "1.2.1Assumptions4" */
const TOC_LINE = /^(\d+(?:\.\d+)*)\s*(.+?)\s*(\d{1,4})$/;

interface Cached { label: string; title: string }

/** Word's own rendering, read out of the cached TOC field results. */
function cachedToc(documentXml: string): Cached[] {
  const out: Cached[] = [];
  for (const p of documentXml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []) {
    const text = (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? [])
      .map((t) => t.replace(/<[^>]+>/g, ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length === 0 || text.length > 120) continue;
    const m = TOC_LINE.exec(text);
    if (!m) continue;
    const title = m[2]!.replace(/[.\s]+$/, "").trim();
    // A TOC entry's title is a heading's text. Two characters is not a title.
    if (title.length < 3) continue;
    out.push({ label: m[1]!, title: norm(title) });
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

let docsChecked = 0;
let compared = 0;
let agreed = 0;
const disagreements = new Map<string, { doc: string; title: string; ours: string; word: string }[]>();

for (const name of readdirSync(dir).filter((f) => f.endsWith(".docx")).sort()) {
  let entries: Record<string, Uint8Array>;
  let imported;
  try {
    const bytes = readFileSync(join(dir, name));
    entries = unzipSync(bytes);
    imported = importDocx(bytes);
  } catch { continue; }

  const documentXml = entries["word/document.xml"];
  if (!documentXml) continue;
  const toc = cachedToc(new TextDecoder().decode(documentXml));
  if (toc.length < 3) continue;

  // Our labels, keyed by heading text. A title that appears twice is dropped rather than
  // guessed at: matching the wrong occurrence would score noise.
  const ours = new Map<string, string | null>();
  const seen = new Set<string>();
  for (const block of Object.values(imported.sidecar.blocks)) {
    if (block.kind !== "heading") continue;
    const key = norm(block.text);
    if (key.length < 3) continue;
    if (seen.has(key)) { ours.delete(key); continue; }
    seen.add(key);
    ours.set(key, block.numLabel ?? null);
  }

  let docCompared = 0, docAgreed = 0;
  for (const entry of toc) {
    if (!ours.has(entry.title)) continue;
    const mine = ours.get(entry.title) ?? "(none)";
    docCompared++;
    // Word's TOC prints the label without a trailing separator; ours may carry one.
    if (mine.replace(/[.)\s]+$/, "") === entry.label.replace(/[.)\s]+$/, "")) docAgreed++;
    else {
      const list = disagreements.get(name) ?? [];
      list.push({ doc: name, title: entry.title, ours: mine, word: entry.label });
      disagreements.set(name, list);
    }
  }
  if (docCompared === 0) continue;
  docsChecked++;
  compared += docCompared;
  agreed += docAgreed;
}

console.log(`\n${docsChecked} corpus documents carry a cached TOC we can compare against.`);
console.log(`${compared} headings compared with Word's own rendering.`);
console.log(`${agreed} agree — ${compared > 0 ? ((agreed / compared) * 100).toFixed(1) : "0"}%.\n`);

const worst = [...disagreements.entries()].sort((a, b) => b[1].length - a[1].length);
if (worst.length > 0) {
  console.log(`Disagreements, worst documents first (${worst.length} documents):`);
  for (const [doc, list] of worst.slice(0, 8)) {
    console.log(`\n  ${doc} — ${list.length} wrong`);
    for (const d of list.slice(0, 6)) {
      console.log(`      Word ${d.word.padEnd(10)} ours ${String(d.ours).padEnd(10)} ${JSON.stringify(d.title.slice(0, 44))}`);
    }
  }
}
