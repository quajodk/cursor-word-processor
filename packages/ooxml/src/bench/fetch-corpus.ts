#!/usr/bin/env bun
/**
 * Corpus fetcher.
 *
 *   bun run src/bench/fetch-corpus.ts                 # fetch the curated list
 *   bun run src/bench/fetch-corpus.ts --list urls.tsv # fetch "url<TAB>source" lines
 *   bun run src/bench/fetch-corpus.ts --reinventory    # re-scan what's on disk
 *
 * Idempotent: files already in the manifest (by sha256) are skipped, and the
 * manifest is merged rather than rewritten so a concurrent agent's downloads
 * survive.
 */

import {
  appendProvenance,
  fetchCandidate,
  readManifest,
  reinventory,
  type Candidate,
  type FetchOutcome,
} from "./corpus.ts";
import { CANDIDATES } from "./sources.ts";
import { CORPUS_DIR } from "./paths.ts";

const args = process.argv.slice(2);

async function loadList(path: string): Promise<Candidate[]> {
  const text = await Bun.file(path).text();
  const out: Candidate[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [url, source, name] = t.split("\t");
    if (!url) continue;
    out.push({ url, source: source?.trim() || "(no provenance note)", name: name?.trim() });
  }
  return out;
}

async function main(): Promise<void> {
  if (args.includes("--reinventory")) {
    const files = await reinventory();
    console.log(`Re-inventoried ${files.length} files in ${CORPUS_DIR}`);
    return;
  }

  let candidates = CANDIDATES;
  const li = args.indexOf("--list");
  if (li >= 0 && args[li + 1]) candidates = await loadList(args[li + 1]!);

  const manifest = await readManifest();
  const known = new Set(
    [...manifest.values()].flatMap((e) => [...(e.urls ?? []), ...(e.url ? [e.url] : [])]),
  );
  const todo = candidates.filter((c) => !known.has(c.url) || args.includes("--force"));

  console.log(`${candidates.length} candidates, ${todo.length} to try, ${manifest.size} already in manifest`);

  const CONCURRENCY = 6;
  const results: FetchOutcome[] = [];
  const journal: { sha256: string; file: string; url: string; source: string; retrieved: string }[] = [];

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      const c = todo[i];
      if (!c) return;
      const r = await fetchCandidate(c, manifest);
      results.push(r);
      if (r.ok && r.file && r.sha256) {
        journal.push({
          sha256: r.sha256,
          file: r.file,
          url: c.url,
          source: c.source,
          retrieved: new Date().toISOString(),
        });
        console.log(`  ok   ${r.duplicateOf ? "(dup) " : ""}${((r.bytes ?? 0) / 1024).toFixed(0).padStart(6)}K  ${r.file}`);
      } else {
        console.log(`  FAIL  ${r.reason}\n        ${c.url}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  await appendProvenance(journal);
  const files = await reinventory();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${todo.length} retrieved. Corpus now ${files.length} unique files.`);
}

await main();
