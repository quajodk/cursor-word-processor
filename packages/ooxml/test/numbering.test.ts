import { describe, test, expect } from "bun:test";
import { computeLabels, format, type LevelDef, type NumberingTable, type NumDef } from "../src/numbering";

/**
 * Numbering labels.
 *
 * Every case here is a rule from ECMA-376 that produces a visibly wrong document when it is
 * missed — and most of them are wrong in a way a reader would act on rather than notice.
 * The `%1` token naming level 0 is the one that is easiest to get backwards and hardest to
 * spot: it produces a plausible-looking document with every sub-section numbered as if it
 * were a section.
 */

function level(ilvl: number, over: Partial<LevelDef> = {}): LevelDef {
  return { ilvl, numFmt: "decimal", lvlText: `%${ilvl + 1}`, start: 1, lvlRestart: null, isLgl: false, suff: null, ...over };
}

function table(defs: { numId: string; abstractNumId?: string | null; levels: LevelDef[]; startOverride?: [number, number][] }[]): NumberingTable {
  const byNumId = new Map<string, NumDef>();
  for (const d of defs) {
    byNumId.set(d.numId, {
      numId: d.numId,
      abstractNumId: d.abstractNumId === undefined ? `abs-${d.numId}` : d.abstractNumId,
      levels: new Map(d.levels.map((l) => [l.ilvl, l])),
      startOverride: new Map(d.startOverride ?? []),
    });
  }
  return { byNumId, unmodeled: [] };
}

const seq = (numId: string, ...ilvls: number[]) => ilvls.map((ilvl) => ({ numId, ilvl }));

describe("computeLabels", () => {
  test("numbers a flat list", () => {
    const t = table([{ numId: "1", levels: [level(0)] }]);
    expect(computeLabels(t, seq("1", 0, 0, 0))).toEqual(["1", "2", "3"]);
  });

  test("%1 names level 0 — the token is one-based, the level is zero-based", () => {
    const t = table([{
      numId: "1",
      levels: [level(0, { lvlText: "%1." }), level(1, { lvlText: "%1.%2" }), level(2, { lvlText: "%1.%2.%3" })],
    }]);
    expect(computeLabels(t, seq("1", 0, 1, 1, 2, 0, 1)))
      .toEqual(["1.", "1.1", "1.2", "1.2.1", "2.", "2.1"]);
  });

  test("a deeper level restarts when a shallower one advances", () => {
    const t = table([{ numId: "1", levels: [level(0, { lvlText: "%1" }), level(1, { lvlText: "%1.%2" })] }]);
    expect(computeLabels(t, seq("1", 0, 1, 1, 0, 1))).toEqual(["1", "1.1", "1.2", "2", "2.1"]);
  });

  test("lvlRestart=0 means never restart", () => {
    const t = table([{
      numId: "1",
      levels: [level(0, { lvlText: "%1" }), level(1, { lvlText: "%2", lvlRestart: 0 })],
    }]);
    // The sub-level keeps counting across sections: 1, 2, 3 rather than 1, 1, 1.
    expect(computeLabels(t, seq("1", 0, 1, 0, 1, 0, 1))).toEqual(["1", "1", "2", "2", "3", "3"]);
  });

  test("lvlRestart=n restarts only when level n-1 advances", () => {
    const t = table([{
      numId: "1",
      levels: [level(0, { lvlText: "%1" }), level(1, { lvlText: "%2" }), level(2, { lvlText: "%3", lvlRestart: 2 })],
    }]);
    // Level 2 restarts on level 1, not on level 0.
    expect(computeLabels(t, seq("1", 0, 1, 2, 2, 1, 2))).toEqual(["1", "1", "1", "2", "2", "1"]);
  });

  test("start is honoured, and so is a per-instance startOverride", () => {
    const t = table([
      { numId: "1", levels: [level(0, { start: 5 })] },
      { numId: "2", levels: [level(0, { start: 5 })], startOverride: [[0, 100]] },
    ]);
    expect(computeLabels(t, seq("1", 0, 0))).toEqual(["5", "6"]);
    expect(computeLabels(t, seq("2", 0, 0))).toEqual(["100", "101"]);
  });

  test("two numIds sharing an abstract definition continue one sequence", () => {
    // Word restarts on the abstract definition, not on the instance. Keying counters by
    // numId would give "1, 1, 1" for a document that alternates between two styles.
    const t = table([
      { numId: "1", abstractNumId: "shared", levels: [level(0)] },
      { numId: "2", abstractNumId: "shared", levels: [level(0)] },
    ]);
    expect(computeLabels(t, [
      { numId: "1", ilvl: 0 }, { numId: "2", ilvl: 0 }, { numId: "1", ilvl: 0 },
    ])).toEqual(["1", "2", "3"]);
  });

  test("separate abstract definitions count separately", () => {
    const t = table([
      { numId: "1", levels: [level(0)] },
      { numId: "2", levels: [level(0)] },
    ]);
    expect(computeLabels(t, [
      { numId: "1", ilvl: 0 }, { numId: "2", ilvl: 0 }, { numId: "1", ilvl: 0 },
    ])).toEqual(["1", "1", "2"]);
  });

  test("a bullet has no label, and does not disturb the sequence", () => {
    const t = table([{
      numId: "1",
      levels: [level(0, { lvlText: "%1" }), level(1, { numFmt: "bullet", lvlText: "" })],
    }]);
    // Inventing "1." for a bullet would be a fabrication a cross-reference could point at.
    expect(computeLabels(t, seq("1", 0, 1, 1, 0))).toEqual(["1", null, null, "2"]);
  });

  test("isLgl renders every component as decimal", () => {
    const t = table([{
      numId: "1",
      levels: [
        level(0, { numFmt: "upperRoman", lvlText: "%1" }),
        level(1, { lvlText: "%1.%2", isLgl: true }),
      ],
    }]);
    expect(computeLabels(t, seq("1", 0, 1))).toEqual(["I", "1.1"]);
  });

  test("an unknown numId produces no label rather than a guess", () => {
    expect(computeLabels(table([]), seq("99", 0))).toEqual([null]);
  });

  test("a level with no template falls back to its own number", () => {
    const t = table([{ numId: "1", levels: [level(0, { lvlText: null })] }]);
    expect(computeLabels(t, seq("1", 0, 0))).toEqual(["1", "2"]);
  });

  test("a deep level referencing an ancestor that has not appeared uses its start", () => {
    // A document whose first numbered paragraph is at level 2 still has to render %1 and %2.
    const t = table([{
      numId: "1",
      levels: [level(0), level(1), level(2, { lvlText: "%1.%2.%3" })],
    }]);
    expect(computeLabels(t, seq("1", 2))).toEqual(["1.1.1"]);
  });
});

describe("number formats", () => {
  test("roman", () => {
    expect([1, 4, 9, 14, 40, 90, 400, 1990, 2024].map((n) => format(n, "lowerRoman")))
      .toEqual(["i", "iv", "ix", "xiv", "xl", "xc", "cd", "mcmxc", "mmxxiv"]);
    expect(format(9, "upperRoman")).toBe("IX");
  });

  test("letters repeat rather than carrying, which is what Word does", () => {
    // 27 is "aa", not "ba": Word's alphabetic sequence is not base-26.
    expect([1, 26, 27, 28, 52, 53].map((n) => format(n, "lowerLetter")))
      .toEqual(["a", "z", "aa", "bb", "zz", "aaa"]);
    expect(format(27, "upperLetter")).toBe("AA");
  });

  test("decimalZero pads only below ten", () => {
    expect([1, 9, 10, 99].map((n) => format(n, "decimalZero"))).toEqual(["01", "09", "10", "99"]);
  });

  test("ordinal handles the teens", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map((n) => format(n, "ordinal")))
      .toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th"]);
  });

  test("chicago is the footnote sequence, doubled after four", () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => format(n, "chicago"))).toEqual(["*", "†", "‡", "§", "**", "***"]);
  });

  test("roman falls back to decimal outside its range rather than emitting nonsense", () => {
    expect(format(0, "lowerRoman")).toBe("0");
    expect(format(4000, "upperRoman")).toBe("4000");
  });
});
