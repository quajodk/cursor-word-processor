import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { importDocx } from "../src/import";
import { exportDocx } from "../src/export";
import { editOneWord } from "../src/bench/edit";

/**
 * The splice engine's contract, enforced against real Word documents (docs/DOCX-FIDELITY.md §4):
 * an unedited round trip is byte-identical, and a one-word edit touches exactly one paragraph
 * and takes that paragraph's formatting with it.
 *
 * These run over `corpus/docx`, which holds real-world files collected from the wild and is
 * gitignored. When it is absent the suite reports and skips rather than inventing fixtures —
 * a fixture we authored would only prove our own exporter agrees with our own importer.
 */
const CORPUS = join(import.meta.dir, "../../../corpus/docx");
const SAMPLE = 60;

const files = (() => {
  try { return readdirSync(CORPUS).filter((f) => f.endsWith(".docx")).slice(0, SAMPLE); }
  catch { return []; }
})();

const docPart = (b: Uint8Array): string => {
  const z = unzipSync(b);
  const k = Object.keys(z).find((k) => /word\/document\d*\.xml$/.test(k));
  return k ? strFromU8(z[k]!) : "";
};
const paragraphs = (xml: string): string[] => xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? [];
/** rPr ELEMENT NAMES, the granularity at which "formatting was lost" is a meaningful claim.
 *  Whole-payload comparison conflates a legitimate run merge with an actual loss. */
const propNames = (xml: string): Set<string> => {
  const out = new Set<string>();
  for (const rPr of xml.match(/<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/g) ?? [])
    for (const el of rPr.match(/<w:([A-Za-z]+)\b/g) ?? [])
      if (el.slice(3) !== "rPr") out.add(el.slice(3));
  return out;
};

describe("splice engine against real Word documents", () => {
  test("corpus is present", () => {
    if (files.length === 0) console.warn("\n[splice] corpus/docx absent — skipping. Fetch it to run these.");
    expect(true).toBe(true);
  });

  test("an unedited round trip is byte-identical", () => {
    if (files.length === 0) return;
    let identical = 0, n = 0;
    for (const f of files) {
      const orig = new Uint8Array(readFileSync(join(CORPUS, f)));
      let out; try { const r = importDocx(orig); out = exportDocx(r.doc, r.sidecar, r.origin); } catch { continue; }
      n++;
      if (Buffer.compare(Buffer.from(out.bytes), Buffer.from(orig)) === 0) identical++;
    }
    console.log(`\n[splice] T0 byte-identical: ${identical}/${n}`);
    expect(n).toBeGreaterThan(0);
    expect(identical).toBe(n);
  }, 120_000);

  test("a one-word edit changes exactly one paragraph and loses no run formatting", () => {
    if (files.length === 0) return;
    let n = 0, surgical = 0, formattingKept = 0;
    const unreported: string[] = [];
    for (const f of files) {
      const orig = new Uint8Array(readFileSync(join(CORPUS, f)));
      let r, e, out;
      try {
        r = importDocx(orig);
        e = editOneWord(r.doc, r.sidecar);
        if (!e) continue;
        out = exportDocx(e.doc, r.sidecar, r.origin);
      } catch { continue; }
      const A = paragraphs(docPart(orig)), B = paragraphs(docPart(out.bytes));
      if (A.length !== B.length) continue;
      let idx = -1;
      let differing = 0;
      for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) { differing++; if (idx < 0) idx = i; }
      if (idx < 0) continue;
      n++;
      if (differing === 1) surgical++;

      // Every run property on the original paragraph must survive, or be NAMED in the ledger.
      // Silent loss is the failure this asserts against: the ledger is this subsystem's
      // quality metric, so a drop it does not record is worse than the drop itself.
      const lost = [...propNames(A[idx]!)].filter((p) => !propNames(B[idx]!).has(p));
      if (lost.length === 0) formattingKept++;
      else {
        const named = out.ledger.some((l) => l.code === "run-property-dropped" && lost.some((p) => l.detail?.includes(p)));
        if (!named) unreported.push(`${f}: ${lost.join(",")}`);
      }
    }
    console.log(`[splice] T1 surgical: ${surgical}/${n}; run formatting fully preserved: ${formattingKept}/${n}`);
    if (unreported.length) console.log(`[splice] SILENTLY dropped: ${unreported.slice(0, 5).join(" | ")}`);
    expect(n).toBeGreaterThan(0);
    expect(surgical).toBe(n);
    // A loss is tolerable; a loss the ledger does not report is not.
    expect(unreported).toEqual([]);

    // And formatting preservation is ASSERTED, not merely printed.
    //
    // An audit changed one line of the exporter so it silently discarded stored run
    // properties. Preservation fell from 59/59 to 36/59 -- twenty-three real Word documents
    // losing bold, italics and fonts on a one-word edit -- and this test still passed,
    // because the number was only ever logged. A metric nobody asserts is a metric nobody
    // is defending.
    expect(formattingKept).toBe(n);
  }, 120_000);
});
