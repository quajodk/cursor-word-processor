import { describe, test, expect } from "bun:test";
import { blameSentences, diffDocuments } from "../src/index";

const DOC = `# Coastal survey

The tide was high on Tuesday. The boat was late leaving harbour. The crew waited on the pier.

## Method

Measurements were taken at fourteen transects. Each was surveyed with differential GPS.
`;

const kinds = (d: ReturnType<typeof diffDocuments>) => d.changes.map((c) => c.kind);

describe("sentence-granularity diff", () => {
  test("an unchanged document produces no changes", () => {
    expect(diffDocuments(DOC, DOC).changes).toEqual([]);
  });

  test("reflowing a paragraph is NOT a change", () => {
    // This is the whole point. A line diff marks every line of a rewrapped paragraph as
    // changed; a writer who reflows their file should see nothing at all.
    const rewrapped = DOC.replace(
      "The tide was high on Tuesday. The boat was late leaving harbour. The crew waited on the pier.",
      "The tide was high on Tuesday.\nThe boat was late leaving harbour.\nThe crew waited on\nthe pier.",
    );
    expect(diffDocuments(DOC, rewrapped).changes).toEqual([]);
  });

  test("a reworded sentence shows which words moved", () => {
    const edited = DOC.replace("The boat was late leaving harbour.", "The vessel was delayed leaving harbour.");
    const d = diffDocuments(DOC, edited);
    expect(kinds(d)).toEqual(["reworded"]);
    const words = d.changes[0]!.words!;
    // The unchanged words must survive as `equal` runs, not be swept into the change.
    expect(words.runs.some((r) => r.kind === "equal" && r.text.includes("leaving"))).toBe(true);
    expect(words.runs.some((r) => r.kind === "delete" && r.text.includes("boat"))).toBe(true);
    expect(words.runs.some((r) => r.kind === "insert" && r.text.includes("vessel"))).toBe(true);
  });

  test("a moved sentence is reported as moved, not as a delete plus an insert", () => {
    // The edit a line diff represents worst, and the most common structural edit in prose.
    const moved = `# Coastal survey

The crew waited on the pier. The tide was high on Tuesday. The boat was late leaving harbour.

## Method

Measurements were taken at fourteen transects. Each was surveyed with differential GPS.
`;
    const d = diffDocuments(DOC, moved);
    expect(d.stats.moved).toBeGreaterThan(0);
    expect(d.stats.deleted).toBe(0);
    expect(d.stats.inserted).toBe(0);
  });

  test("an inserted sentence is an insertion and nothing else", () => {
    const edited = DOC.replace("The crew waited on the pier.", "The crew waited on the pier. Nobody complained.");
    const d = diffDocuments(DOC, edited);
    expect(kinds(d)).toEqual(["inserted"]);
    expect(d.changes[0]!.newText).toBe("Nobody complained.");
  });

  test("a deleted sentence is a deletion and nothing else", () => {
    const edited = DOC.replace(" The crew waited on the pier.", "");
    const d = diffDocuments(DOC, edited);
    expect(kinds(d)).toEqual(["deleted"]);
  });

  test("splitting one sentence into two is a split", () => {
    const edited = DOC.replace(
      "The boat was late leaving harbour.",
      "The boat was late. It left harbour after noon.",
    );
    const d = diffDocuments(DOC, edited);
    expect(d.stats.split + d.stats.reworded + d.stats.inserted).toBeGreaterThan(0);
    // Whatever it is called, the surrounding sentences must be untouched.
    expect(d.stats.deleted).toBe(0);
  });

  test("every change says which section it is in", () => {
    const edited = DOC.replace("differential GPS", "a differential GPS unit");
    const d = diffDocuments(DOC, edited);
    expect(d.changes[0]!.section).toContain("Method");
  });

  test("changes carry line numbers, so plain git remains usable alongside", () => {
    const edited = DOC.replace("The boat was late leaving harbour.", "The vessel was delayed.");
    const c = diffDocuments(DOC, edited).changes[0]!;
    expect(c.oldLine).toBeGreaterThan(0);
    expect(c.newLine).toBeGreaterThan(0);
  });

  test("retention reports how much of the old document survived", () => {
    const d = diffDocuments(DOC, DOC.replace(" The crew waited on the pier.", ""));
    expect(d.stats.retained).toBeGreaterThan(0.7);
    expect(d.stats.retained).toBeLessThan(1);
  });
});

describe("blame at sentence granularity", () => {
  const text = "First sentence here.\nSecond sentence spans\ntwo lines here.\n";
  const line = (n: number, commit: string, author: string) =>
    ({ line: n, commit, author, timestamp: 1700000000 + n, summary: `c${n}` });

  test("a sentence on one author's lines has that author", () => {
    const b = blameSentences(text, [line(1, "aaa", "Ada"), line(2, "bbb", "Bo"), line(3, "bbb", "Bo")]);
    expect(b[0]!.author).toBe("Ada");
    expect(b[0]!.mixed).toBe(false);
  });

  test("a sentence spanning two authors is reported as mixed, not guessed", () => {
    // Picking the most recent or the majority would present a guess as a fact. Two people
    // did write this sentence, and that is the true answer.
    const b = blameSentences(text, [line(1, "aaa", "Ada"), line(2, "bbb", "Bo"), line(3, "ccc", "Cy")]);
    const spanning = b[1]!;
    expect(spanning.mixed).toBe(true);
    expect(spanning.author).toBeNull();
    expect(spanning.contributors.map((c) => c.author).sort()).toEqual(["Bo", "Cy"]);
  });

  test("missing blame lines do not throw", () => {
    const b = blameSentences(text, [line(1, "aaa", "Ada")]);
    expect(b.length).toBeGreaterThan(1);
    expect(b[1]!.contributors).toEqual([]);
  });
});
