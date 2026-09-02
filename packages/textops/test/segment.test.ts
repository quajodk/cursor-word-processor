import { describe, test, expect } from "bun:test";
import { sentences, words, sentenceAt, wordAt } from "../src/segment";

const texts = (s: string, locale = "en") => sentences(s, locale).map((r) => s.slice(r.start, r.end));

describe("sentence segmentation", () => {
  test("splits ordinary sentences", () => {
    expect(texts("One thing. Then another. And a third.")).toEqual(["One thing.", "Then another.", "And a third."]);
  });

  test("does not break on titles or abbreviations", () => {
    expect(texts("Dr. Smith went to Washington, D.C. in 1999. He stayed.")).toEqual([
      "Dr. Smith went to Washington, D.C. in 1999.",
      "He stayed.",
    ]);
  });

  test("does not break on e.g. or i.e. or etc.", () => {
    expect(texts("Use a tool, e.g. a hammer, or etc. as needed. Then stop.")).toEqual([
      "Use a tool, e.g. a hammer, or etc. as needed.",
      "Then stop.",
    ]);
  });

  test("does not break inside a decimal", () => {
    expect(texts("The value was 3.14 exactly. Good.")).toEqual(["The value was 3.14 exactly.", "Good."]);
  });

  test("does not break on initials", () => {
    expect(texts("J. R. R. Tolkien wrote it. Later.")).toEqual(["J. R. R. Tolkien wrote it.", "Later."]);
  });

  test("keeps the closing quote with its sentence", () => {
    expect(texts('She said "no." Then she left.')).toEqual(['She said "no."', "Then she left."]);
  });

  test("excludes trailing whitespace so repeated expansion does not creep", () => {
    const s = "First.   Second.";
    const r = sentences(s)[0]!;
    expect(s.slice(r.start, r.end)).toBe("First.");
  });

  test("works on non-English text", () => {
    // German: "z.B." is a suppression; the corpus contains German documents.
    expect(texts("Das ist z.B. ein Test. Noch einer.", "de")).toEqual(["Das ist z.B. ein Test.", "Noch einer."]);
    // Hindi uses the danda as a sentence terminator.
    expect(texts("यह एक वाक्य है। यह दूसरा है।", "hi").length).toBe(2);
  });

  test("a single unterminated sentence is still a sentence", () => {
    expect(texts("no terminator here")).toEqual(["no terminator here"]);
  });
});

describe("word segmentation", () => {
  test("finds words, not whitespace or punctuation", () => {
    const s = "Hello, world — again!";
    expect(words(s).map((r) => s.slice(r.start, r.end))).toEqual(["Hello", "world", "again"]);
  });

  test("handles scripts without spaces", () => {
    expect(words("これは日本語です", "ja").length).toBeGreaterThan(1);
  });

  test("wordAt finds the containing word", () => {
    const s = "alpha beta gamma";
    const w = wordAt(s, 7)!;
    expect(s.slice(w.start, w.end)).toBe("beta");
  });

  test("sentenceAt finds the containing sentence", () => {
    const s = "One. Two. Three.";
    const r = sentenceAt(s, 6)!;
    expect(s.slice(r.start, r.end)).toBe("Two.");
  });
});

describe("known limits, asserted so they cannot drift silently", () => {
  test("abbreviations longer than three letters are not suppressed", () => {
    // "Prof." is a real abbreviation and this is a real defect. Suppressing it requires
    // admitting 4-letter list entries, which re-admits pragmatic_segmenter's German "test."
    // and produces false MERGES — the worse failure, because a merged sentence corrupts
    // selection, diff and blame for the rest of the paragraph. Separating "Prof." from
    // "Test." needs a lexicon, which this package does not have.
    const s = "Prof. Smith arrived. Then left.";
    expect(sentences(s).map((r) => s.slice(r.start, r.end))).toEqual(["Prof.", "Smith arrived.", "Then left."]);
  });

  test("three-letter and shorter titles do work", () => {
    const s = "Mr. Smith arrived. Then left.";
    expect(sentences(s).map((r) => s.slice(r.start, r.end))).toEqual(["Mr. Smith arrived.", "Then left."]);
  });
});
