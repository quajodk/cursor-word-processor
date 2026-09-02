/**
 * docx import latency, measured against the real corpus.
 *
 * ARCHITECTURE.md §5 budgets a 50-page document at 1200 ms. "50 pages" is not a property
 * a .docx exposes — pagination is a rendering result, not a stored fact — so we band by
 * body paragraph count, which is what the importer actually walks. The band and the
 * observed page-equivalent are reported so the number cannot be read as more precise
 * than it is.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../paths";
import { summarize, type Stats } from "../stats";

/**
 * The 50-page band, as a RANGE.
 *
 * "50 pages" is not a property a .docx exposes — pagination is a rendering result, not a
 * stored fact — so the band is defined by body paragraph count. It needs an upper bound as
 * well as a lower one: an open-ended ">= 500 paragraphs" swept in 8,000- and 11,000-paragraph
 * documents (several hundred pages) and gated the 50-page budget on their p99, reporting a
 * failure three times worse than the thing §5 actually describes.
 *
 * Documents above the band are still measured — see `huge` — but against throughput, which
 * is the only size-independent way to hold them to anything.
 */
const BAND_MIN = 400;
const BAND_MAX = 900;

export interface DocxImportResult {
  available: boolean;
  detail: string;
  all?: Stats;
  large?: Stats;
  /** First imports in a fresh process, carrying JIT cost. A real cost, measured separately. */
  cold?: Stats;
  /** Documents above the band — hundreds of pages. Reported, gated only on throughput. */
  huge?: Stats;
  /** Milliseconds per body paragraph: the size-independent figure. */
  perParagraph?: Stats;
  files?: number;
  largeFiles?: number;
  msPerParagraph?: number;
}

export async function benchDocxImport(): Promise<DocxImportResult> {
  const dir = join(repoRoot(), "corpus", "docx");
  if (!existsSync(dir)) {
    return { available: false, detail: "corpus/docx is absent. Nothing measured." };
  }
  let importDocx: (b: Uint8Array) => { doc: { descendants: (f: (n: any) => boolean) => void } };
  try {
    ({ importDocx } = (await import("@scriv/ooxml/src/import")) as never);
  } catch {
    try {
      ({ importDocx } = (await import(join(repoRoot(), "packages/ooxml/src/import.ts"))) as never);
    } catch (e) {
      return { available: false, detail: `@scriv/ooxml importDocx not importable: ${(e as Error).message}` };
    }
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".docx"));
  if (files.length === 0) return { available: false, detail: "corpus/docx is empty." };

  const all: number[] = [];
  const large: number[] = [];
  const cold: number[] = [];
  const huge: number[] = [];
  const perPara: number[] = [];
  let paragraphs = 0;
  let totalMs = 0;

  // Warm-up, discarded. Without it the first few files carry the process's JIT-compilation
  // cost and land in the p99 tail, which reports a number three times the steady state and
  // blames the importer for it. The keystroke bench already discards warm-up; this one did
  // not, and the difference was the whole of an apparent budget failure.
  //
  // Cold cost is not thereby hidden — it is a real thing a user feels on the first document
  // after launch, so it is measured separately below and reported in its own right.
  const warmupFiles = files.slice(0, Math.min(3, files.length));
  for (const f of warmupFiles) {
    const bytes = new Uint8Array(readFileSync(join(dir, f)));
    const t0 = Bun.nanoseconds();
    try { importDocx(bytes); } catch { continue; }
    cold.push((Bun.nanoseconds() - t0) / 1e6);
  }

  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(join(dir, f)));
    let doc;
    const t0 = Bun.nanoseconds();
    try { ({ doc } = importDocx(bytes)); } catch { continue; }
    const ms = (Bun.nanoseconds() - t0) / 1e6;

    let paras = 0;
    doc.descendants((n: any) => { if (n.type?.name === "paragraph") paras++; return true; });
    all.push(ms);
    paragraphs += paras;
    totalMs += ms;
    if (paras >= BAND_MIN && paras < BAND_MAX) large.push(ms);
    if (paras >= BAND_MAX) huge.push(ms);
    if (paras > 50) perPara.push(ms / paras);
  }

  return {
    available: true,
    cold: cold.length > 0 ? summarize(cold) : undefined,
    detail:
      `${all.length} real corpus documents imported; ${large.length} in the ` +
      `${BAND_MIN}-${BAND_MAX} paragraph band (~50 pages), ${huge.length} larger still. ` +
      `Steady state, after a ` +
      `3-document warm-up; first-import-after-launch is reported separately as \`cold\`.`,
    all: summarize(all),
    large: large.length > 0 ? summarize(large) : undefined,
    huge: huge.length > 0 ? summarize(huge) : undefined,
    perParagraph: perPara.length > 0 ? summarize(perPara) : undefined,
    files: all.length,
    largeFiles: large.length,
    msPerParagraph: paragraphs > 0 ? totalMs / paragraphs : undefined,
  };
}
