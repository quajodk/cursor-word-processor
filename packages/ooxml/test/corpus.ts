/**
 * Corpus access for tests. Test rig, not library code: it may touch the filesystem.
 *
 * Every file here is a real-world .docx collected from the wild (see corpus/docx/MANIFEST.json).
 * Nothing in this directory was authored to make our parser pass.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");
export const CORPUS_DIR = resolve(REPO_ROOT, "corpus/docx");

export interface CorpusFile {
  name: string;
  path: string;
  bytes: number;
}

let cache: CorpusFile[] | null = null;

export function corpusFiles(): CorpusFile[] {
  if (cache) return cache;
  let names: string[];
  try {
    names = readdirSync(CORPUS_DIR);
  } catch {
    return (cache = []);
  }
  cache = names
    .filter((n) => /\.docx$/i.test(n))
    .sort()
    .map((name) => {
      const path = resolve(CORPUS_DIR, name);
      return { name, path, bytes: statSync(path).size };
    });
  return cache;
}

export function readCorpus(f: CorpusFile): Uint8Array {
  return new Uint8Array(readFileSync(f.path));
}

/**
 * Deterministic spread over the corpus: sorted by name, strided. Gives a stable sample that
 * still covers the whole alphabet of sources rather than the first N of one publisher.
 */
export function sample(n: number): CorpusFile[] {
  const all = corpusFiles();
  if (all.length <= n) return all;
  const out: CorpusFile[] = [];
  const stride = all.length / n;
  for (let i = 0; i < n; i++) out.push(all[Math.floor(i * stride)]!);
  return out;
}

/** Files whose names carry a non-ASCII-language marker, plus any with non-ASCII in the name. */
export function nonAsciiCandidates(): CorpusFile[] {
  return corpusFiles().filter((f) => /hindi|polish|ska-ka|arab|chin|czech|russ|greek|turk|deutsch|espa/i.test(f.name) || /[^\x00-\x7F]/.test(f.name));
}
