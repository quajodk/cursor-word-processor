/**
 * Which corpus document should the blind comparison start from?
 *
 * BLIND-COMPARISON.md specifies it exactly: "a real 12–20 page Word document from the corpus
 * (a standards draft or a committee report — something with numbered headings, tables,
 * footnotes and at least one existing comment thread)".
 *
 * That is five hard requirements at once, and whether any of the 288 corpus documents meets
 * all five is a question with an answer, not a matter of taste. Choosing the starting
 * document by eye would also quietly choose the result: a document with no tables makes the
 * table comparison vacuous, and a document with no comment thread makes step 5 of the task
 * impossible — which is exactly the trap this project already fell into once, when the
 * comment importer could not read a reply and the corpus happened to contain none.
 *
 * Run: bun packages/ooxml/scripts/pick-comparison-doc.ts
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { unzipSync } from "fflate";
import { importDocx } from "../src/import";
import { readCommentThreading } from "../src/comments";

function repoRoot(): string {
  let d = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "bun.lock"))) return d;
    d = dirname(d);
  }
  return d;
}

const dir = join(repoRoot(), "corpus", "docx");

/** A Word page is ~500 words of body text; the band the task asks for is 12-20 pages. */
const WORDS_PER_PAGE = 500;
const PAGE_BAND: [number, number] = [12, 20];

interface Candidate {
  name: string;
  words: number;
  pages: number;
  headings: number;
  numberedHeadings: number;
  tables: number;
  footnotes: number;
  comments: number;
  images: number;
  score: number;
  missing: string[];
}

const out: Candidate[] = [];
const files = readdirSync(dir).filter((f) => f.endsWith(".docx")).sort();

for (const name of files) {
  const bytes = readFileSync(join(dir, name));
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(bytes); } catch { continue; }

  let imported;
  try { imported = importDocx(bytes); } catch { continue; }
  const { doc, sidecar } = imported;

  const text = doc.textBetween(0, doc.content.size, " ");
  const words = (text.match(/\S+/g) ?? []).length;
  const pages = words / WORDS_PER_PAGE;

  let headings = 0, numberedHeadings = 0, tables = 0, images = 0;
  doc.descendants((n) => {
    if (n.type.name === "heading") {
      headings++;
      // A numbered heading either carries a numbering reference from Word's list machinery
      // or literally begins with a section number. Both count: the task cares about what the
      // reader sees, not which mechanism produced it.
      const t = n.textContent.trim();
      if (n.attrs.listRef || /^\d+(\.\d+)*[.)\s]/.test(t) || /^(Article|Section|Clause)\s+\d/i.test(t)) {
        numberedHeadings++;
      }
    }
    if (n.type.name === "table") tables++;
    if (n.type.name === "image") images++;
    return true;
  });

  const footnotes = entries["word/footnotes.xml"]
    ? (new TextDecoder().decode(entries["word/footnotes.xml"]).match(/<w:footnote\b(?![^>]*w:type=)/g) ?? []).length
    : 0;

  const threading = readCommentThreading(entries);
  // Only threads Word can actually take a reply and a resolution on.
  const comments = [...threading.values()].filter((t) => t.paraId).length;

  const missing: string[] = [];
  if (pages < PAGE_BAND[0] || pages > PAGE_BAND[1]) missing.push(`${pages.toFixed(0)} pages, outside 12-20`);
  if (numberedHeadings < 3) missing.push("numbered headings");
  if (tables < 1) missing.push("tables");
  if (footnotes < 1) missing.push("footnotes");
  if (comments < 1) missing.push("a usable comment thread");

  const inBand = pages >= PAGE_BAND[0] && pages <= PAGE_BAND[1];
  const score =
    (inBand ? 40 : Math.max(0, 40 - Math.abs(pages - 16) * 3)) +
    Math.min(20, numberedHeadings * 2) +
    Math.min(15, tables * 5) +
    Math.min(15, footnotes * 3) +
    Math.min(10, comments * 3);

  out.push({ name, words, pages, headings, numberedHeadings, tables, footnotes, comments, images, score, missing });
}

out.sort((a, b) => b.score - a.score);

const complete = out.filter((c) => c.missing.length === 0);
console.log(`\n${files.length} corpus documents examined.`);
console.log(`${complete.length} meet EVERY requirement in BLIND-COMPARISON.md.\n`);

const show = (c: Candidate) =>
  `  ${c.score.toFixed(0).padStart(3)}  ${c.pages.toFixed(0).padStart(2)}pp  ` +
  `${String(c.numberedHeadings).padStart(3)} numbered  ${String(c.tables).padStart(2)} tbl  ` +
  `${String(c.footnotes).padStart(3)} fn  ${String(c.comments).padStart(3)} cmt  ${c.name}` +
  (c.missing.length ? `\n         missing: ${c.missing.join("; ")}` : "");

if (complete.length > 0) {
  console.log("MEETS EVERY REQUIREMENT:");
  for (const c of complete.slice(0, 10)) console.log(show(c));
} else {
  console.log("NOTHING meets every requirement. Closest, with what each lacks:");
  for (const c of out.slice(0, 12)) console.log(show(c));
}

// What is scarce is what constrains the choice, so say which requirement is the binding one.
const counts = {
  "in the 12-20 page band": out.filter((c) => c.pages >= 12 && c.pages <= 20).length,
  "3+ numbered headings": out.filter((c) => c.numberedHeadings >= 3).length,
  "1+ table": out.filter((c) => c.tables >= 1).length,
  "1+ footnote": out.filter((c) => c.footnotes >= 1).length,
  "1+ usable comment thread": out.filter((c) => c.comments >= 1).length,
};
console.log("\nHow many documents satisfy each requirement on its own:");
for (const [k, v] of Object.entries(counts)) console.log(`  ${String(v).padStart(3)} / ${out.length}  ${k}`);
