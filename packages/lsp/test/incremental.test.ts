import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHarperProvider, IncrementalLinter, splitSegments, type Diagnostic, type DiagnosticProvider } from "../src";

/**
 * The claim `incremental.ts` makes is that splitting a document into blocks and linting them
 * separately produces the SAME diagnostics as linting the whole thing. It is a plausible
 * claim — Harper's rules are sentence-scoped and a paragraph break ends a sentence — and a
 * plausible claim about someone else's rule set is exactly the kind of thing that is quietly
 * false in the cases nobody checked.
 *
 * So it is checked, against real books rather than sentences written to make it pass.
 */

function repoRoot(): string {
  let d = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "bun.lock")) || existsSync(join(d, "corpus"))) return d;
    d = dirname(d);
  }
  return d;
}

/** Real prose, wrapped into paragraphs the way a document is. */
function corpusParagraphs(limit: number): string[] {
  const dir = join(repoRoot(), "corpus", "text");
  const out: string[] = [];
  for (const name of ["pg1342.txt", "pg1661.txt", "pg2009.txt", "pg205.txt"]) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    for (const para of raw.split(/\n\s*\n/)) {
      const t = para.replace(/\s+/g, " ").trim();
      if (t.length > 200 && t.length < 1800) out.push(t);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

const key = (d: Diagnostic) => `${d.from}:${d.to}:${d.code}:${d.message}`;

describe("incremental linting", () => {
  const paragraphs = corpusParagraphs(40);

  test("the corpus is present, or this file is not testing anything", () => {
    // A comparison against an empty document passes trivially and would have hidden every
    // failure below. The corpus is gitignored, so its absence has to be loud.
    expect(paragraphs.length).toBeGreaterThan(20);
  });

  test("differs from a whole-document lint only where that lint ran a sentence across a block break", async () => {
    // The original claim here was equality. It is very nearly true and it is not exactly
    // true, and the difference is worth keeping because it runs the OTHER way to the one
    // you would fear.
    //
    // Harper does not treat a bare newline as a sentence boundary. Linting the joined
    // document therefore merges the last sentence of one paragraph with the first of the
    // next, and on real prose that produced a "this sentence is 52 words long" warning
    // spanning two different speakers' dialogue -- while hiding three genuine findings
    // (a lowercase sentence start, a misspelling, a repeated word) inside the paragraphs it
    // had glued together.
    //
    // So the assertion is not "the same answers". It is "every difference is a block
    // boundary artefact of the whole-document lint", which is a claim that would break
    // loudly if the split ever started losing real diagnostics.
    const provider = createHarperProvider();
    const text = paragraphs.join("\n");

    const whole = await provider.diagnose({ version: 1, text, language: "en-US" });
    const linter = new IncrementalLinter(provider);
    const inc = await linter.run({ version: 2, text, language: "en-US" });

    expect(inc.done).toBe(true);
    expect(inc.linted).toBe(paragraphs.length);

    const a = new Set(whole.map(key));
    const b = new Set(inc.diagnostics.map(key));
    const onlyWhole = whole.filter((d) => !b.has(key(d)));
    const onlyInc = inc.diagnostics.filter((d) => !a.has(key(d)));

    // Agreement is the headline, and it has to be high or the split is simply wrong.
    expect(whole.length).toBeGreaterThan(100);
    expect(onlyWhole.length / whole.length).toBeLessThan(0.02);

    // Every diagnostic the whole-document pass had and the incremental pass did not must be
    // one that straddles a block break -- i.e. one the incremental pass could not have seen
    // because it does not exist within any single block.
    for (const d of onlyWhole) {
      expect(text.slice(d.from, d.to)).toContain("\n");
    }

    // Every diagnostic the incremental pass found and the whole-document pass did not must
    // be one the whole-document pass could not have reported, because the sentence it was
    // reading there spanned a block break. That is checked CAUSALLY rather than by
    // proximity: re-lint the block with its predecessor glued on, exactly as the joined
    // document presents it, and the finding must still be absent. If it shows up under the
    // glued reading, the incremental pass invented it and this test has to fail.
    const bounds = splitSegments(text);
    for (const d of onlyInc) {
      const bi = bounds.findLastIndex((b) => b.start <= d.from);
      expect(bi).toBeGreaterThanOrEqual(0);
      const block = bounds[bi]!;
      const glued = bi > 0 ? `${bounds[bi - 1]!.text}\n${block.text}` : block.text;
      const shift = bi > 0 ? bounds[bi - 1]!.text.length + 1 : 0;
      const gluedDiags = await provider.diagnose({ version: 3, text: glued, language: "en-US" });
      const rebased = new Set(gluedDiags.map((g) => `${g.from - shift}:${g.to - shift}:${g.code}:${g.message}`));
      expect({ diagnostic: key(d), text: text.slice(d.from, d.to), survivesGluedReading: rebased.has(key(d)) })
        .toEqual({ diagnostic: key(d), text: text.slice(d.from, d.to), survivesGluedReading: false });
    }
  }, 300_000);

  test("offsets point at the same text they did before rebasing", async () => {
    const provider = createHarperProvider();
    const text = paragraphs.slice(0, 8).join("\n");
    const inc = await new IncrementalLinter(provider).run({ version: 1, text, language: "en-US" });
    expect(inc.diagnostics.length).toBeGreaterThan(0);
    for (const d of inc.diagnostics) {
      expect(d.to).toBeGreaterThan(d.from);
      expect(d.to).toBeLessThanOrEqual(text.length);
      // The span must not straddle a block boundary — that would mean the rebase is wrong.
      expect(text.slice(d.from, d.to)).not.toContain("\n");
    }
  }, 300_000);

  test("editing one paragraph re-lints one paragraph", async () => {
    const counting = new CountingProvider();
    const linter = new IncrementalLinter(counting);
    const text = paragraphs.slice(0, 12).join("\n");

    await linter.run({ version: 1, text, language: "en" });
    expect(counting.calls).toBe(12);

    counting.calls = 0;
    const edited = paragraphs.slice(0, 12).map((p, i) => (i === 5 ? p + " One more sentence." : p)).join("\n");
    const second = await linter.run({ version: 2, text: edited, language: "en" });

    // This is the whole point of the class: 1 of 12, not 12 of 12.
    expect(counting.calls).toBe(1);
    expect(second.linted).toBe(1);
    expect(second.cached).toBe(11);
  });

  test("a reordered document is entirely cache hits", async () => {
    const counting = new CountingProvider();
    const linter = new IncrementalLinter(counting);
    const blocks = paragraphs.slice(0, 10);

    await linter.run({ version: 1, text: blocks.join("\n"), language: "en" });
    counting.calls = 0;

    const moved = [blocks[9]!, ...blocks.slice(0, 9)];
    const after = await linter.run({ version: 2, text: moved.join("\n"), language: "en" });
    expect(counting.calls).toBe(0);
    expect(after.cached).toBe(10);
  });

  test("a stale pass abandons itself instead of answering a question nobody asked", async () => {
    const counting = new CountingProvider(30);
    const linter = new IncrementalLinter(counting, { sliceMs: 0 });
    const text = paragraphs.slice(0, 20).join("\n");

    let checks = 0;
    const result = await linter.run(
      { version: 1, text, language: "en" },
      { isStale: () => ++checks >= 2 },
    );
    expect(result.done).toBe(false);
    expect(result.pending).toBeGreaterThan(0);
    expect(counting.calls).toBeLessThan(20);
  });

  test("partial results are reported as they are computed", async () => {
    const linter = new IncrementalLinter(new CountingProvider(20), { sliceMs: 0 });
    const text = paragraphs.slice(0, 10).join("\n");
    const seen: number[] = [];
    const final = await linter.run({ version: 1, text, language: "en" }, { onProgress: (p) => seen.push(p.pending) });
    expect(seen.length).toBeGreaterThan(0);
    // Monotonically closer to done, and never claiming to be done early.
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeLessThan(seen[i - 1]!);
    expect(final.pending).toBe(0);
  });

  test("the cache is bounded and evicts the least recently used segment", async () => {
    const counting = new CountingProvider();
    const linter = new IncrementalLinter(counting, { maxSegments: 3 });
    await linter.run({ version: 1, text: "alpha one\nbravo two\ncharlie three", language: "en" });
    expect(linter.size).toBe(3);

    // Touch the first so it is no longer least-recent, then push a fourth in.
    await linter.run({ version: 2, text: "alpha one", language: "en" });
    await linter.run({ version: 3, text: "delta four", language: "en" });
    expect(linter.size).toBe(3);

    counting.calls = 0;
    await linter.run({ version: 4, text: "alpha one", language: "en" });
    expect(counting.calls).toBe(0); // kept: it was used most recently
    await linter.run({ version: 5, text: "bravo two", language: "en" });
    expect(counting.calls).toBe(1); // evicted: it was the oldest
  });

  test("the same text in a different language is a different cache entry", async () => {
    const counting = new CountingProvider();
    const linter = new IncrementalLinter(counting);
    await linter.run({ version: 1, text: "Colour the harbour.", language: "en-GB" });
    await linter.run({ version: 2, text: "Colour the harbour.", language: "en-US" });
    // Harper uses a different dictionary per dialect, so a cache that ignored the language
    // would show British spellings as correct in an American document and vice versa.
    expect(counting.calls).toBe(2);
  });
});

describe("splitSegments", () => {
  test("segment starts are offsets into the original string", () => {
    const text = "one\ntwo\n\nfour";
    for (const s of splitSegments(text)) {
      expect(text.slice(s.start, s.start + s.text.length)).toBe(s.text);
    }
  });

  test("segments plus separators reconstruct the input exactly", () => {
    for (const text of ["", "a", "\n", "a\n", "\na", "a\n\nb", "trailing\n"]) {
      expect(splitSegments(text).map((s) => s.text).join("\n")).toBe(text);
    }
  });
});

/** Counts calls so cache behaviour can be asserted without paying for the real checker. */
class CountingProvider implements DiagnosticProvider {
  readonly id = "counting";
  calls = 0;
  constructor(private readonly delayMs = 0) {}
  async setup(): Promise<void> {}
  async diagnose(req: { text: string }): Promise<Diagnostic[]> {
    this.calls++;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const at = req.text.indexOf("teh");
    return at < 0
      ? []
      : [{ from: at, to: at + 3, message: "typo", severity: "warning", source: "counting", code: "Spelling", fixes: [] }];
  }
}
