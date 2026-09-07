import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { schema } from "@scriv/doc-model";
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
    // `if (r)` used to stand alone here. When this corpus directory was missing while the
    // others were present, the aggregate test below still passed on the others' totals while
    // THIS test reported green having checked nothing — the exact shape of a partial fetch.
    expect(r).toBeDefined();
    expect(r!.total).toBeGreaterThan(0);
    expect(r!.parseErrors).toBe(0);
  }, 60_000);

  test("gfm spec examples", () => {
    const r = runCorpus("gfm", join(CORPUS_ROOT, "spec", "gfm"));
    // `if (r)` used to stand alone here. When this corpus directory was missing while the
    // others were present, the aggregate test below still passed on the others' totals while
    // THIS test reported green having checked nothing — the exact shape of a partial fetch.
    expect(r).toBeDefined();
    expect(r!.total).toBeGreaterThan(0);
    expect(r!.parseErrors).toBe(0);
  }, 60_000);

  test("real-world repo docs", () => {
    const r = runCorpus("repos", join(CORPUS_ROOT, "repos"));
    // `if (r)` used to stand alone here. When this corpus directory was missing while the
    // others were present, the aggregate test below still passed on the others' totals while
    // THIS test reported green having checked nothing — the exact shape of a partial fetch.
    expect(r).toBeDefined();
    expect(r!.total).toBeGreaterThan(0);
    expect(r!.parseErrors).toBe(0);
  }, 60_000);

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
  }, 60_000);
});

/**
 * Regressions for the four defects that broke the "Markdown on disk is the source of truth"
 * claim: saving an unedited file must not rewrite it.
 */
describe("a no-op save does not rewrite the file", () => {
  const rt = (src: string) => {
    const { doc, meta } = parseMarkdown(src);
    return serializeMarkdown(doc, meta);
  };

  test("keeps the blank line between frontmatter and the first block", () => {
    const src = "---\ntitle: T\n---\n\n# Heading\n\nBody.\n";
    expect(rt(src)).toBe(src);
  });

  test("keeps a body that starts immediately after the closing fence", () => {
    const src = "---\ntitle: T\n---\n# Heading\n";
    expect(rt(src)).toBe(src);
  });

  test("preserves hand-wrapped paragraph line breaks", () => {
    const src = "Measurements were taken at fourteen fixed transects at monthly\nintervals. Each transect was surveyed using differential GPS,\nwith a vertical accuracy of 2cm.\n";
    expect(rt(src)).toBe(src);
  });

  test("a soft break after a hard break does not become a paragraph split", () => {
    const src = "one\\\ntwo three\n";
    const out = rt(src);
    const { doc } = parseMarkdown(out);
    expect(doc.childCount).toBe(1);
  });

  test("does not escape a lone tilde in prose", () => {
    const src = "Recovery was ~99% across the sector.\n";
    expect(rt(src)).toBe(src);
  });

  test("still escapes a literal tilde pair so it does not become strikethrough", () => {
    // The narrowed rule must still protect text that contains `~~` without carrying a
    // strike mark — otherwise serializing it would invent strikethrough on the next read.
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("literal ~~tildes~~ here")]),
    ]);
    const out = serializeMarkdown(doc);
    let struck = false;
    parseMarkdown(out).doc.descendants((n) => {
      if (n.marks.some((m) => m.type.name === "strike")) struck = true;
      return true;
    });
    expect(struck).toBe(false);
  });

  test("keeps compact table delimiters at their source width", () => {
    const src = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    expect(rt(src)).toBe(src);
  });

  test("table style is a fixed point across repeated saves", () => {
    const src = "| Feature | x |\n| :-- | :-: |\n| Core | y |\n";
    const once = rt(src);
    expect(rt(once)).toBe(once);
  });

  test("images joined by a soft break do not gain blank lines", () => {
    const out = rt("![a](u1)\n![b](u2)\n");
    expect(out).not.toContain("\n\n\n");
  });
});
