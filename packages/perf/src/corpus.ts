/**
 * Real prose, not lorem ipsum.
 *
 * Lorem ipsum has a wrong word-length distribution, no sentence-length variance worth the
 * name, no punctuation density, no long words, and no repeated vocabulary. Every one of
 * those shapes the cost of the thing we are measuring: ProseMirror text node sizes, the
 * length of the runs a step touches, and how often a typed character lands on a word
 * boundary. Measuring on lorem ipsum measures a document nobody will ever write.
 *
 * So: Project Gutenberg plain text, public domain, fetched once and cached in corpus/text/.
 * The fetch is the only network access in this package and it happens exactly once per
 * checkout. Everything after it is offline. (House rule 3: local-first. This is a
 * build-time corpus acquisition, and it is cached in-tree.)
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "./paths";

export interface CorpusBook {
  id: number;
  title: string;
  /** Why it is in the mix — the corpus should span registers, not just Victorian novels. */
  register: string;
}

/**
 * Four registers, deliberately: dialogue-heavy fiction, long-sentence 19th-century
 * exposition, technical/scientific argument with enumeration, and plain reflective essay.
 * A 40k-word "report" in scriv is far closer to Darwin than to Austen, but real documents
 * are mixed and the tail of the sentence-length distribution is what matters.
 */
export const BOOKS: CorpusBook[] = [
  { id: 1342, title: "Pride and Prejudice", register: "dialogue-heavy fiction, short sentences" },
  { id: 2009, title: "On the Origin of Species", register: "scientific exposition, long clauses, enumeration" },
  { id: 205, title: "Walden", register: "reflective essay, dense vocabulary" },
  { id: 1661, title: "The Adventures of Sherlock Holmes", register: "narrative + dialogue, mid-length sentences" },
];

const UA = "scriv-perf-harness/0.1 (corpus fetch, one-time, cached)";

export function corpusDir(): string {
  return join(repoRoot(), "corpus", "text");
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Strips the Project Gutenberg licence header and footer, leaving the work itself.
 * The markers are stable across the whole archive.
 */
function stripGutenbergBoilerplate(raw: string): string {
  const startRe = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i;
  const endRe = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i;
  let text = raw;
  const s = text.match(startRe);
  if (s && s.index !== undefined) text = text.slice(s.index + s[0].length);
  const e = text.match(endRe);
  if (e && e.index !== undefined) text = text.slice(0, e.index);
  // Transcriber's notes and the produced-by line add noise but not much; drop the obvious.
  text = text.replace(/^\s*Produced by[^\n]*\n/gim, "");
  return text.trim();
}

async function fetchBook(book: CorpusBook): Promise<string> {
  const urls = [
    `https://www.gutenberg.org/cache/epub/${book.id}/pg${book.id}.txt`,
    `https://www.gutenberg.org/files/${book.id}/${book.id}-0.txt`,
    `https://www.gutenberg.org/ebooks/${book.id}.txt.utf-8`,
  ];
  let lastErr: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(45_000) });
      if (!res.ok) { lastErr = new Error(`${url} -> HTTP ${res.status}`); continue; }
      const raw = await res.text();
      if (raw.length < 50_000) { lastErr = new Error(`${url} -> suspiciously short (${raw.length}b)`); continue; }
      return raw;
    } catch (err) { lastErr = err; }
  }
  throw new Error(`could not fetch Gutenberg #${book.id} (${book.title}): ${String(lastErr)}`);
}

export interface CorpusText extends CorpusBook {
  text: string;
  words: number;
  path: string;
}

/**
 * Loads the corpus, fetching and caching anything missing.
 *
 * Throws if a text is missing AND the network is unavailable. That is deliberate: the
 * alternative is silently substituting generated filler, which would make every number
 * this harness prints a measurement of a document that does not exist. A perf gate that
 * quietly changes its own input is worse than one that refuses to run.
 */
export async function loadCorpus(opts: { allowFetch?: boolean } = {}): Promise<CorpusText[]> {
  const allowFetch = opts.allowFetch ?? true;
  const dir = corpusDir();
  await mkdir(dir, { recursive: true });

  const out: CorpusText[] = [];
  for (const book of BOOKS) {
    const path = join(dir, `pg${book.id}.txt`);
    let text: string;
    if (await exists(path)) {
      text = await readFile(path, "utf8");
    } else {
      if (!allowFetch) {
        throw new Error(
          `corpus text missing: ${path}\n` +
          `Run once with network access to populate corpus/text/, or commit the cache.`,
        );
      }
      process.stderr.write(`  fetching Gutenberg #${book.id} — ${book.title} ...\n`);
      const raw = await fetchBook(book);
      text = stripGutenbergBoilerplate(raw);
      await writeFile(path, text, "utf8");
    }
    out.push({ ...book, text, path, words: countWords(text) });
  }
  return out;
}

export function countWords(s: string): number {
  const m = s.match(/[^\s]+/g);
  return m ? m.length : 0;
}
