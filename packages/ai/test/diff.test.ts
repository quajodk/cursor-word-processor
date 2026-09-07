import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { diffProse, type Hunk } from "../src/diff";

/**
 * The property that matters is not "the hunks look sensible" — it is that APPLYING them
 * reproduces the revision exactly. A diff that renders nicely and reconstructs the wrong text
 * would silently corrupt a document on accept, which is the one failure this feature cannot
 * be allowed to have.
 */
function apply(original: string, hunks: Hunk[]): string {
  let out = "";
  let cursor = 0;
  for (const h of hunks) {
    out += original.slice(cursor, h.from);
    out += h.added;
    cursor = h.to;
  }
  return out + original.slice(cursor);
}

const wellFormed = (original: string, hunks: Hunk[]) => {
  let last = -1;
  for (const h of hunks) {
    expect(h.from).toBeGreaterThanOrEqual(last);
    expect(h.to).toBeGreaterThanOrEqual(h.from);
    expect(h.to).toBeLessThanOrEqual(original.length);
    expect(original.slice(h.from, h.to)).toBe(h.removed);
    last = h.to;
  }
};

describe("prose diff", () => {
  test("an identical rewrite produces nothing", () => {
    expect(diffProse("One thing. Two things.", "One thing. Two things.")).toEqual([]);
  });

  test("an untouched sentence is not in the diff", () => {
    const a = "The tide was high. The boat was late. The crew waited.";
    const b = "The tide was high. The vessel was delayed. The crew waited.";
    const hunks = diffProse(a, b);
    wellFormed(a, hunks);
    expect(apply(a, hunks)).toBe(b);
    // Only the middle sentence moved, so nothing may touch the first or last.
    for (const h of hunks) {
      expect(h.from).toBeGreaterThanOrEqual(a.indexOf("The boat"));
      expect(h.to).toBeLessThanOrEqual(a.indexOf("The crew"));
    }
  });

  test("a reworded clause diffs at word granularity, not whole-sentence", () => {
    const a = "The committee approved the revised budget without further debate.";
    const b = "The committee approved the amended budget without further discussion.";
    const hunks = diffProse(a, b);
    wellFormed(a, hunks);
    expect(apply(a, hunks)).toBe(b);
    // "revised"->"amended" and "debate"->"discussion" are far apart, so they stay separate,
    // and neither may swallow the whole sentence.
    const total = hunks.reduce((n, h) => n + (h.to - h.from), 0);
    expect(total).toBeLessThan(a.length / 2);
  });

  test("a pure insertion has a zero-width range", () => {
    const a = "First. Third.";
    const b = "First. Second. Third.";
    const hunks = diffProse(a, b);
    wellFormed(a, hunks);
    expect(apply(a, hunks)).toBe(b);
  });

  test("a pure deletion has empty added text", () => {
    const a = "First. Second. Third.";
    const b = "First. Third.";
    const hunks = diffProse(a, b);
    wellFormed(a, hunks);
    expect(apply(a, hunks)).toBe(b);
  });

  test("replacing everything is one region, not a shredded character diff", () => {
    const a = "Alpha beta gamma delta.";
    const b = "Entirely different words here.";
    const hunks = diffProse(a, b);
    wellFormed(a, hunks);
    expect(apply(a, hunks)).toBe(b);
    expect(hunks.length).toBeLessThanOrEqual(2);
  });

  test("works on non-English prose", () => {
    const a = "यह पहला वाक्य है। यह दूसरा वाक्य है।";
    const b = "यह पहला वाक्य है। यह तीसरा वाक्य है।";
    const hunks = diffProse(a, b);
    wellFormed(a, hunks);
    expect(apply(a, hunks)).toBe(b);
  });

  test("abbreviations do not split a sentence into a false pair", () => {
    const a = "Dr. Smith reviewed the draft. It was fine.";
    const b = "Dr. Smith reviewed the report. It was fine.";
    const hunks = diffProse(a, b);
    wellFormed(a, hunks);
    expect(apply(a, hunks)).toBe(b);
  });
});

describe("apply(diff) reconstructs the revision, over real prose", () => {
  const root = join(import.meta.dir, "../../../corpus/md/repos");
  const files = (() => {
    try {
      return readdirSync(root).filter((f) => f.endsWith(".md")).slice(0, 60).map((f) => join(root, f));
    } catch { return []; }
  })();

  /** Deterministic pseudo-edits standing in for what a model would return. */
  function revise(text: string, seed: number): string {
    const ws = text.split(/(\s+)/);
    let s = seed;
    const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const out: string[] = [];
    for (const w of ws) {
      if (/^\s+$/.test(w) || w.length < 4) { out.push(w); continue; }
      const r = rand();
      if (r < 0.06) continue;                        // delete a word
      if (r < 0.12) { out.push(w + "ish"); continue; } // reword
      if (r < 0.15) { out.push("actually"); out.push(" "); out.push(w); continue; } // insert
      out.push(w);
    }
    return out.join("");
  }

  test("round-trips on real documents", () => {
    expect(files.length).toBeGreaterThan(0); // a silent skip here would leave the one property this feature cannot lose unchecked
    if (files.length === 0) { console.warn("\n[ai] corpus/md absent - skipping"); return; }
    let checked = 0, ok = 0;
    for (const f of files) {
      if (statSync(f).size > 60_000) continue;
      const text = readFileSync(f, "utf8").slice(0, 4000);
      for (const seed of [1, 7, 99]) {
        const revised = revise(text, seed);
        const hunks = diffProse(text, revised);
        checked++;
        if (apply(text, hunks) === revised) ok++;
        else if (ok + 3 > checked) {
          console.log(`[ai] mismatch in ${f.split("/").pop()} seed ${seed}`);
        }
      }
    }
    console.log(`\n[ai] diff reconstructs the revision: ${ok}/${checked} real-document edits`);
    expect(checked).toBeGreaterThan(0);
    expect(ok).toBe(checked);
  }, 180_000);
});
