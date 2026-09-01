/** Shared filesystem locations for the fidelity rig. Bench tooling only. */

import { mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Repo root: packages/ooxml/src/bench -> ../../../.. */
export const REPO_ROOT = resolve(here, "../../../..");

export const CORPUS_DIR = resolve(REPO_ROOT, "corpus/docx");
export const MANIFEST_PATH = resolve(CORPUS_DIR, "MANIFEST.json");

/** Canonical report location — root bench/out, which .gitignore already covers. */
export const OUT_DIR = resolve(REPO_ROOT, "bench/out");
export const REPORT_JSON = resolve(OUT_DIR, "roundtrip.json");
export const REPORT_TXT = resolve(OUT_DIR, "roundtrip.txt");

/** Scratch space for pandoc intermediates and export artifacts. */
export const WORK_DIR = resolve(REPO_ROOT, ".scriv-cache/bench");

export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

export async function listCorpusFiles(): Promise<string[]> {
  try {
    const names = await readdir(CORPUS_DIR);
    return names.filter((n) => /\.(docx|docm)$/i.test(n)).sort();
  } catch {
    return [];
  }
}
