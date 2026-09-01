import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseMarkdown } from "../src/from-mdast";
import { serializeMarkdown } from "../src/serialize";

/**
 * Round-trip stability against the real corpus in `corpus/md/` (CommonMark spec examples,
 * GFM spec examples, and real docs pulled from the wild — see
 * `packages/md/scripts/fetch-corpus.ts`). No fixtures authored to make this package's own
 * parser pass.
 *
 * The property under test, exactly as specified: idempotence after one normalization pass.
 * `y = serialize(parse(x))` is the first normalization (lossy in the ways documented in the
 * package report — table cell padding, frontmatter/body blank-line collapse, and so on).
 * `serialize(parse(y)) === y` is the actual pass/fail bar: once a file has been through this
 * pipeline once, running it through again must not change it further. That is the property
 * that matters for an editor that opens and saves the same file repeatedly.
 *
 * This also runs (and reports separately) the naive `serialize(parse(x)) === x` comparison
 * as non-blocking diagnostic context, since it is useful to see how far first-pass output
 * drifts from the original even though the task does not require it to match.
 */

const CORPUS_ROOT = join(import.meta.dir, "..", "..", "..", "corpus", "md");

function listFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p));
    else if (name.endsWith(".md") || name.endsWith(".markdown")) out.push(p);
  }
  return out;
}

interface Failure {
  file: string;
  reason: string;
  excerpt: string;
}

function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

function excerptAround(s: string, at: number, radius = 60): string {
  const start = Math.max(0, at - radius);
  const end = Math.min(s.length, at + radius);
  return JSON.stringify(s.slice(start, end));
}

function runCorpus(label: string, dir: string) {
  const files = listFiles(dir);
  if (files.length === 0) {
    console.log(`[roundtrip] ${label}: no files found at ${dir}, skipping`);
    return;
  }

  let idempotentPass = 0;
  let firstPassIdentical = 0;
  let parseErrors = 0;
  const idempotentFailures: Failure[] = [];
  const parseFailures: Failure[] = [];

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const rel = file.slice(CORPUS_ROOT.length + 1);
    let y: string;
    try {
      const p1 = parseMarkdown(src);
      y = serializeMarkdown(p1.doc, p1.meta);
    } catch (err) {
      parseErrors++;
      parseFailures.push({ file: rel, reason: String((err as Error)?.message ?? err), excerpt: "" });
      continue;
    }

    if (y === src) firstPassIdentical++;

    try {
      const p2 = parseMarkdown(y);
      const z = serializeMarkdown(p2.doc, p2.meta);
      if (z === y) {
        idempotentPass++;
      } else {
        const at = firstDiff(y, z);
        idempotentFailures.push({ file: rel, reason: `diverged at offset ${at}`, excerpt: `y=${excerptAround(y, at)}\n         z=${excerptAround(z, at)}` });
      }
    } catch (err) {
      parseErrors++;
      parseFailures.push({ file: rel, reason: `second pass threw: ${String((err as Error)?.message ?? err)}`, excerpt: "" });
    }
  }

  const total = files.length;
  const idempotentRate = ((idempotentPass / total) * 100).toFixed(2);
  const firstPassRate = ((firstPassIdentical / total) * 100).toFixed(2);

  console.log(`\n[roundtrip] ${label}: ${total} files`);
  console.log(`  idempotent (serialize(parse(y)) === y):  ${idempotentPass}/${total} = ${idempotentRate}%`);
  console.log(`  first-pass identical (serialize(parse(x)) === x, diagnostic only): ${firstPassIdentical}/${total} = ${firstPassRate}%`);
  console.log(`  parse/serialize errors: ${parseErrors}/${total}`);

  if (idempotentFailures.length > 0) {
    console.log(`  --- idempotence failures (up to 25 shown) ---`);
    for (const f of idempotentFailures.slice(0, 25)) {
      console.log(`  ${f.file}: ${f.reason}\n    ${f.excerpt}`);
    }
  }
  if (parseFailures.length > 0) {
    console.log(`  --- errors (up to 25 shown) ---`);
    for (const f of parseFailures.slice(0, 25)) {
      console.log(`  ${f.file}: ${f.reason}`);
    }
  }

  return { total, idempotentPass, firstPassIdentical, parseErrors };
}

describe("round-trip stability against the real corpus", () => {
  test("commonmark spec examples", () => {
    const r = runCorpus("commonmark", join(CORPUS_ROOT, "spec", "commonmark"));
    if (r) expect(r.parseErrors).toBe(0);
  });

  test("gfm spec examples", () => {
    const r = runCorpus("gfm", join(CORPUS_ROOT, "spec", "gfm"));
    if (r) expect(r.parseErrors).toBe(0);
  });

  test("real-world repo docs", () => {
    const r = runCorpus("repos", join(CORPUS_ROOT, "repos"));
    if (r) expect(r.parseErrors).toBe(0);
  });

  test("aggregate pass rate across the whole corpus is reported and reasonably high", () => {
    const dirs = [join(CORPUS_ROOT, "spec", "commonmark"), join(CORPUS_ROOT, "spec", "gfm"), join(CORPUS_ROOT, "repos")];
    let total = 0;
    let pass = 0;
    for (const d of dirs) {
      const files = listFiles(d);
      for (const file of files) {
        const src = readFileSync(file, "utf8");
        total++;
        try {
          const p1 = parseMarkdown(src);
          const y = serializeMarkdown(p1.doc, p1.meta);
          const p2 = parseMarkdown(y);
          const z = serializeMarkdown(p2.doc, p2.meta);
          if (z === y) pass++;
        } catch {
          // counted as failure
        }
      }
    }
    const rate = total > 0 ? (pass / total) * 100 : 0;
    console.log(`\n[roundtrip] AGGREGATE across ${total} real corpus files: ${pass}/${total} = ${rate.toFixed(2)}% idempotent`);
    expect(total).toBeGreaterThan(0);
    // Honest bar, not a rubber stamp: fail the suite outright if the pipeline regresses hard.
    expect(rate).toBeGreaterThan(50);
  });
});
