/**
 * `bun run roundtrip` — the three-tier fidelity scorer (DOCX-FIDELITY.md §6).
 *
 * Runs T0, T1 and T2 over the real-world corpus in `corpus/docx/`, and runs the same three
 * tiers over pandoc's docx → md → docx round trip on the same files, in two configurations.
 * Writes `bench/out/roundtrip.json` (machine-readable, per-file) and `roundtrip.txt` (a summary
 * a human can read without a JSON viewer).
 *
 * The report embeds the normalisation rules and the T2 weights verbatim, because a similarity
 * score without the rules that produced it is not a measurement, it is a claim.
 *
 * Usage:
 *   bun run roundtrip                  # everything, including the pandoc baseline
 *   bun run roundtrip -- --limit 25    # first 25 files, for iteration
 *   bun run roundtrip -- --no-pandoc   # skip the baseline (about 4x faster)
 *   bun run roundtrip -- --only <s>    # only files whose name contains <s>
 */

import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";

import { importDocx } from "../import.ts";
import { exportDocx } from "../export.ts";
import { summarize, type LedgerEntry } from "../ledger.ts";
import { CORPUS_DIR, OUT_DIR, REPORT_JSON, REPORT_TXT, WORK_DIR, ensureDir, listCorpusFiles } from "./paths.ts";
import { scoreT1, type T1Result } from "./t1.ts";
import { scoreT2, FEATURE_WEIGHTS, type T2Result } from "./t2.ts";
import { NORMALIZATION_RULES, REJECTED_RULES } from "./normalize.ts";
import { editOneWord } from "./edit.ts";
import { pandocToDocx, pandocToMarkdown, pandocVersion } from "./pandoc.ts";

/* ------------------------------------------------------------------ arguments */

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const value = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
};
const LIMIT = Number(value("limit") ?? "0") || 0;
const ONLY = value("only");
const NO_PANDOC = flag("no-pandoc");

/* ------------------------------------------------------------------ report shapes */

interface TierT0 { packageIdentical: boolean; documentXmlIdentical: boolean; bytes: number; outBytes: number }

interface SystemReport {
  ok: boolean;
  error?: string;
  t0?: TierT0;
  t1?: T1Result & { edited: boolean; word?: string };
  t2?: T2Result;
  ms: number;
}

interface FileReport {
  file: string;
  bytes: number;
  blocks: number;
  scriv: SystemReport & {
    splice?: { copied: number; runSpliced: number; rebuilt: number; synthesized: number; deleted: number };
    ledger?: { total: number; degraded: number; dropped: number };
  };
  pandocPlain?: SystemReport & { selfStableT1?: number };
  pandocReference?: SystemReport & { selfStableT1?: number };
}

/* ------------------------------------------------------------------ helpers */

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function docPart(entries: Record<string, Uint8Array>): Uint8Array | null {
  return entries["word/document.xml"] ?? null;
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const pct = (n: number, d: number): number => (d === 0 ? 0 : (100 * n) / d);

/* ------------------------------------------------------------------ the scriv path */

function runScriv(bytes: Uint8Array, originEntries: Record<string, Uint8Array>): FileReport["scriv"] {
  const t0 = Date.now();
  try {
    const imported = importDocx(bytes, { hashParts: false });

    /* T0 — zero edits. */
    const zero = exportDocx(imported.doc, imported.sidecar, imported.origin);

    /* T1 — one word. */
    const edited = editOneWord(imported.doc, imported.sidecar);
    let t1: (T1Result & { edited: boolean; word?: string }) | undefined;
    let t1Bytes: Uint8Array = zero.bytes;
    if (edited) {
      const out = exportDocx(edited.doc, imported.sidecar, imported.origin);
      t1Bytes = out.bytes;
      const originDoc = imported.origin.documentXml;
      t1 = { ...scoreT1(originDoc, out.documentXml), edited: true, word: `${edited.edit.oldWord}→${edited.edit.newWord}` };
    } else {
      t1 = { ...scoreT1(imported.origin.documentXml, zero.documentXml), edited: false };
    }

    /* T2 — semantic, on the zero-edit export: the tier asks what survives a round trip, not
       what survives an edit. */
    const t2 = scoreT2(originEntries, unzipSync(zero.bytes));

    const summary = summarize(zero.ledger as LedgerEntry[]);
    void t1Bytes;
    return {
      ok: true,
      t0: {
        packageIdentical: zero.stats.packageIdentical,
        documentXmlIdentical: zero.stats.documentXmlIdentical,
        bytes: bytes.length,
        outBytes: zero.bytes.length,
      },
      t1,
      t2,
      splice: {
        copied: zero.stats.copied, runSpliced: zero.stats.runSpliced, rebuilt: zero.stats.rebuilt,
        synthesized: zero.stats.synthesized, deleted: zero.stats.deleted,
      },
      ledger: { total: summary.total, degraded: summary.bySeverity.degraded, dropped: summary.bySeverity.dropped },
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200), ms: Date.now() - t0 };
  }
}

/* ------------------------------------------------------------------ the pandoc path */

function runPandoc(
  docxPath: string,
  originBytes: Uint8Array,
  originEntries: Record<string, Uint8Array>,
  originDocumentXml: Uint8Array,
  markdown: string,
  editedMarkdown: string | null,
  workDir: string,
  variant: "plain" | "reference",
): SystemReport & { selfStableT1?: number } {
  const t0 = Date.now();
  const plainOut = pandocToDocx(markdown, workDir, variant, docxPath);
  if (!plainOut.ok || !plainOut.docx) return { ok: false, error: plainOut.error ?? "unknown", ms: Date.now() - t0 };

  let entries: Record<string, Uint8Array>;
  let outDoc: Uint8Array | null;
  try {
    entries = unzipSync(plainOut.docx);
    outDoc = docPart(entries);
  } catch (e) {
    return { ok: false, error: `output is not a readable package: ${(e as Error).message.slice(0, 120)}`, ms: Date.now() - t0 };
  }
  if (!outDoc) return { ok: false, error: "output has no word/document.xml", ms: Date.now() - t0 };

  const report: SystemReport & { selfStableT1?: number } = {
    ok: true,
    t0: {
      packageIdentical: bytesEqual(plainOut.docx, originBytes),
      documentXmlIdentical: bytesEqual(outDoc, originDocumentXml),
      bytes: originBytes.length,
      outBytes: plainOut.docx.length,
    },
    t2: scoreT2(originEntries, entries),
    ms: Date.now() - t0,
  };

  if (editedMarkdown !== null) {
    // Reuse the same working directory but a distinct name so the unedited output survives.
    const editedOut = pandocToDocx(editedMarkdown, workDir, variant === "plain" ? "plain" : "reference", docxPath);
    if (editedOut.ok && editedOut.docx) {
      try {
        const editedDoc = docPart(unzipSync(editedOut.docx));
        if (editedDoc) {
          report.t1 = { ...scoreT1(originDocumentXml, editedDoc), edited: true };
          /* How stable pandoc is against ITSELF: the same comparison with pandoc's own
             unedited output as the reference. It is not the tier — the tier asks about the
             user's document — but reporting it forecloses "you measured the wrong thing". */
          report.selfStableT1 = scoreT1(outDoc, editedDoc).score;
        }
      } catch { /* an unreadable edited output leaves T1 unreported, not faked */ }
    }
  }
  return report;
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  await ensureDir(OUT_DIR);
  await ensureDir(WORK_DIR);

  let files = await listCorpusFiles();
  if (ONLY) files = files.filter((f) => f.includes(ONLY));
  if (LIMIT > 0) files = files.slice(0, LIMIT);
  if (files.length === 0) {
    console.error(`no .docx files in ${CORPUS_DIR}`);
    process.exit(1);
  }

  const pandocVer = NO_PANDOC ? null : pandocVersion();
  if (!NO_PANDOC && !pandocVer) console.error("pandoc not found; the baseline will be absent from the report");

  console.log(`scoring ${files.length} files from ${CORPUS_DIR}${pandocVer ? ` (baseline: ${pandocVer})` : ""}`);

  const reports: FileReport[] = [];
  const started = Date.now();

  for (let i = 0; i < files.length; i++) {
    const name = files[i]!;
    const path = join(CORPUS_DIR, name);
    const bytes = new Uint8Array(readFileSync(path));
    let originEntries: Record<string, Uint8Array>;
    try {
      originEntries = unzipSync(bytes);
    } catch (e) {
      reports.push({ file: name, bytes: bytes.length, blocks: 0, scriv: { ok: false, error: `unreadable: ${(e as Error).message.slice(0, 120)}`, ms: 0 } });
      continue;
    }
    const originDocumentXml = docPart(originEntries);
    if (!originDocumentXml) {
      reports.push({ file: name, bytes: bytes.length, blocks: 0, scriv: { ok: false, error: "no word/document.xml", ms: 0 } });
      continue;
    }

    const scriv = runScriv(bytes, originEntries);
    const report: FileReport = {
      file: name,
      bytes: bytes.length,
      blocks: scriv.splice ? scriv.splice.copied + scriv.splice.runSpliced + scriv.splice.rebuilt + scriv.splice.deleted : 0,
      scriv,
    };

    if (pandocVer) {
      const workDir = join(WORK_DIR, "pandoc");
      const md = pandocToMarkdown(path, workDir);
      if (!md.ok || md.markdown === undefined) {
        const err = { ok: false as const, error: `docx→md: ${md.error ?? "unknown"}`, ms: md.ms };
        report.pandocPlain = err;
        report.pandocReference = err;
      } else {
        /* The SAME word the scriv path changed, applied by literal substitution. When the word
           does not survive pandoc's markdown (a field result, a footnote, text in a shape) the
           edit is skipped and T1 is simply absent for that file rather than invented. */
        const word = scriv.t1?.word;
        let editedMd: string | null = null;
        if (word) {
          const [oldW, newW] = word.split("→");
          if (oldW && newW && md.markdown.includes(oldW)) editedMd = md.markdown.replace(oldW, newW);
        }
        report.pandocPlain = runPandoc(path, bytes, originEntries, originDocumentXml, md.markdown, editedMd, join(workDir, "plain"), "plain");
        report.pandocReference = runPandoc(path, bytes, originEntries, originDocumentXml, md.markdown, editedMd, join(workDir, "ref"), "reference");
      }
    }

    reports.push(report);
    if ((i + 1) % 10 === 0 || i === files.length - 1) {
      const done = i + 1;
      const rate = (Date.now() - started) / done;
      console.log(`  ${done}/${files.length}  (${Math.round(rate)}ms/file, ~${Math.round((rate * (files.length - done)) / 1000)}s left)`);
    }
  }

  rmSync(join(WORK_DIR, "pandoc"), { recursive: true, force: true });

  /* -------------------------------------------------- aggregate */

  const ok = reports.filter((r) => r.scriv.ok);
  const t0Identical = ok.filter((r) => r.scriv.t0?.packageIdentical).length;
  const t0DocIdentical = ok.filter((r) => r.scriv.t0?.documentXmlIdentical).length;
  const t1s = ok.map((r) => r.scriv.t1).filter((x): x is NonNullable<typeof x> => !!x && x.edited);
  const t2s = ok.map((r) => r.scriv.t2).filter((x): x is T2Result => !!x);

  const featureMeans = (list: T2Result[]): Record<string, { similarity: number; applicableFiles: number }> => {
    const out: Record<string, { similarity: number; applicableFiles: number }> = {};
    for (const f of Object.keys(FEATURE_WEIGHTS)) {
      const vals = list.map((t) => t.features[f]).filter((x) => x && x.applicable).map((x) => x!.similarity);
      out[f] = { similarity: Number(mean(vals).toFixed(6)), applicableFiles: vals.length };
    }
    return out;
  };
  const diagMeans = (list: T2Result[]): Record<string, number> => {
    const keys = ["docPropsRetained", "latentStylesRetained", "partsRetained", "mediaIdentical", "bytesRatio"] as const;
    const out: Record<string, number> = {};
    for (const k of keys) out[k] = Number(mean(list.map((t) => t.diagnostics[k])).toFixed(6));
    return out;
  };

  const baselineOf = (key: "pandocPlain" | "pandocReference") => {
    const runs = reports.map((r) => r[key]).filter((x): x is NonNullable<typeof x> => !!x);
    const good = runs.filter((r) => r.ok);
    const bt1 = good.map((r) => r.t1).filter((x): x is NonNullable<typeof x> => !!x);
    const bt2 = good.map((r) => r.t2).filter((x): x is T2Result => !!x);
    const selfStable = good.map((r) => r.selfStableT1).filter((x): x is number => typeof x === "number");
    return {
      files: runs.length,
      converted: good.length,
      failed: runs.length - good.length,
      t0: {
        percentIdentical: Number(pct(good.filter((r) => r.t0?.packageIdentical).length, runs.length).toFixed(4)),
        filesIdentical: good.filter((r) => r.t0?.packageIdentical).length,
        documentXmlIdentical: good.filter((r) => r.t0?.documentXmlIdentical).length,
      },
      t1: {
        meanScore: Number(mean(bt1.map((x) => x.score)).toFixed(6)),
        percentClean: Number(pct(bt1.filter((x) => x.clean).length, bt1.length).toFixed(4)),
        filesEdited: bt1.length,
        /** Pandoc measured against its own unedited output rather than the user's document. */
        meanSelfStable: Number(mean(selfStable).toFixed(6)),
      },
      t2: {
        weighted: Number(mean(bt2.map((x) => x.weighted)).toFixed(6)),
        byFeature: featureMeans(bt2),
        diagnostics: diagMeans(bt2),
      },
    };
  };

  const totalBytes = reports.reduce((n, r) => n + r.bytes, 0);
  const out = {
    generatedAt: new Date().toISOString(),
    generator: "@scriv/ooxml bench/score.ts",
    pandoc: pandocVer,
    durationMs: Date.now() - started,

    corpus: { count: files.length, dir: "corpus/docx", totalBytes, imported: ok.length, failed: reports.length - ok.length },

    /** T0: import → export with zero edits → byte compare. Percentage of the whole corpus. */
    t0: {
      percentIdentical: Number(pct(t0Identical, reports.length).toFixed(4)),
      filesIdentical: t0Identical,
      documentXmlIdentical: t0DocIdentical,
      files: reports.length,
    },

    /** T1: one word changed; every other paragraph must be byte-identical. */
    t1: {
      meanScore: Number(mean(t1s.map((x) => x.score)).toFixed(6)),
      percentClean: Number(pct(t1s.filter((x) => x.clean).length, t1s.length).toFixed(4)),
      filesClean: t1s.filter((x) => x.clean).length,
      filesEdited: t1s.length,
      filesWithNoEditableWord: ok.length - t1s.length,
      meanParagraphsChanged: Number(mean(t1s.map((x) => x.originParagraphs - x.identical)).toFixed(4)),
    },

    /** T2: weighted semantic similarity of normalised OOXML trees. */
    t2: {
      weighted: Number(mean(t2s.map((x) => x.weighted)).toFixed(6)),
      min: t2s.length ? Number(Math.min(...t2s.map((x) => x.weighted)).toFixed(6)) : 0,
      byFeature: featureMeans(t2s),
      diagnostics: diagMeans(t2s),
    },

    baseline: pandocVer ? { pandocPlain: baselineOf("pandocPlain"), pandocReference: baselineOf("pandocReference") } : null,

    /** The rules that produced the T2 number, emitted so it cannot be read without them. */
    scoring: {
      weights: FEATURE_WEIGHTS,
      normalizationRules: NORMALIZATION_RULES,
      rejectedRules: REJECTED_RULES,
    },

    files: reports,
  };

  writeFileSync(REPORT_JSON, JSON.stringify(out, null, 2));
  writeFileSync(REPORT_TXT, summaryText(out));
  console.log(`\n${summaryText(out)}`);
  console.log(`report: ${REPORT_JSON}`);
}

/* ------------------------------------------------------------------ human summary */

function summaryText(o: ReturnType<typeof Object> extends never ? never : any): string {
  const L: string[] = [];
  const f = (n: number, d = 4): string => Number(n).toFixed(d);
  L.push(`corpus: ${o.corpus.count} real .docx files, ${(o.corpus.totalBytes / 1e6).toFixed(1)} MB, ${o.corpus.imported} imported, ${o.corpus.failed} failed`);
  L.push("");
  L.push(`                       scriv        pandoc          pandoc`);
  L.push(`                                    (default)       (--reference-doc)`);
  const b = o.baseline;
  const col = (v: unknown): string => String(v).padEnd(15);
  L.push(`T0 byte-identical %    ${col(f(o.t0.percentIdentical, 2))}${col(b ? f(b.pandocPlain.t0.percentIdentical, 2) : "-")}${b ? f(b.pandocReference.t0.percentIdentical, 2) : "-"}`);
  L.push(`T1 mean score          ${col(f(o.t1.meanScore))}${col(b ? f(b.pandocPlain.t1.meanScore) : "-")}${b ? f(b.pandocReference.t1.meanScore) : "-"}`);
  L.push(`T1 clean %             ${col(f(o.t1.percentClean, 2))}${col(b ? f(b.pandocPlain.t1.percentClean, 2) : "-")}${b ? f(b.pandocReference.t1.percentClean, 2) : "-"}`);
  L.push(`T2 weighted            ${col(f(o.t2.weighted))}${col(b ? f(b.pandocPlain.t2.weighted) : "-")}${b ? f(b.pandocReference.t2.weighted) : "-"}`);
  L.push("");
  L.push(`T2 by feature (scriv | pandoc default | pandoc reference):`);
  for (const k of Object.keys(FEATURE_WEIGHTS)) {
    const s = o.t2.byFeature[k];
    L.push(`  ${k.padEnd(16)} w=${String((FEATURE_WEIGHTS as Record<string, number>)[k]).padEnd(6)} ${f(s.similarity).padEnd(10)} ${b ? f(b.pandocPlain.t2.byFeature[k].similarity).padEnd(10) : ""} ${b ? f(b.pandocReference.t2.byFeature[k].similarity) : ""}   (${s.applicableFiles} files)`);
  }
  L.push("");
  L.push(`unweighted diagnostics (scriv | pandoc default | pandoc reference):`);
  for (const k of Object.keys(o.t2.diagnostics)) {
    L.push(`  ${k.padEnd(24)} ${f(o.t2.diagnostics[k]).padEnd(10)} ${b ? f(b.pandocPlain.t2.diagnostics[k]).padEnd(10) : ""} ${b ? f(b.pandocReference.t2.diagnostics[k]) : ""}`);
  }
  if (b) {
    L.push("");
    L.push(`pandoc conversions: default ${b.pandocPlain.converted}/${b.pandocPlain.files} ok, reference ${b.pandocReference.converted}/${b.pandocReference.files} ok`);
    L.push(`pandoc T1 measured against its OWN unedited output instead: ${f(b.pandocPlain.t1.meanSelfStable)} / ${f(b.pandocReference.t1.meanSelfStable)}`);
  }
  L.push("");
  L.push(`T1: ${o.t1.filesClean}/${o.t1.filesEdited} files where exactly one paragraph changed and nothing else moved`);
  L.push(`T2 worst file: ${f(o.t2.min)}`);
  return L.join("\n");
}

await main();
