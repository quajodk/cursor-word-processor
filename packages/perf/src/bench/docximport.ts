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

/** ~500 body paragraphs is a reasonable stand-in for a 50-page report. */
const LARGE_PARAGRAPHS = 500;

export interface DocxImportResult {
  available: boolean;
  detail: string;
  all?: Stats;
  large?: Stats;
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
  let paragraphs = 0;
  let totalMs = 0;

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
    if (paras >= LARGE_PARAGRAPHS) large.push(ms);
  }

  return {
    available: true,
    detail:
      `${all.length} real corpus documents imported; ${large.length} of them are ` +
      `>= ${LARGE_PARAGRAPHS} body paragraphs (the 50-page band).`,
    all: summarize(all),
    large: large.length > 0 ? summarize(large) : undefined,
    files: all.length,
    largeFiles: large.length,
    msPerParagraph: paragraphs > 0 ? totalMs / paragraphs : undefined,
  };
}
