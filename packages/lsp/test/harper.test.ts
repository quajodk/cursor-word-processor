import { describe, test, expect } from "bun:test";
import { LocalLinter, type Dialect } from "harper.js";
import { binaryInlined } from "harper.js/binaryInlined";
import { HarperProvider } from "../src/harper";

/**
 * Runs the real checker against real text. Harper is WebAssembly with no network dependency,
 * so there is nothing here to stub — and stubbing it would test only that our mapping code
 * agrees with our own assumptions about output we invented.
 */
const provider = new HarperProvider((dialect?: Dialect) =>
  new LocalLinter(dialect === undefined ? { binary: binaryInlined } : { binary: binaryInlined, dialect }));
const diagnose = (text: string, language = "en") => provider.diagnose({ version: 1, text, language });

describe("harper diagnostics", () => {
  test("finds a misspelling and offers a replacement", async () => {
    const d = await diagnose("I beleive this is correct.");
    const spelling = d.find((x) => x.code === "Spelling");
    expect(spelling).toBeDefined();
    expect("I beleive this is correct.".slice(spelling!.from, spelling!.to)).toBe("beleive");
    expect(spelling!.fixes.map((f) => f.replacement)).toContain("believe");
  }, 60_000);

  test("finds a repeated word", async () => {
    const d = await diagnose("This is a a test.");
    expect(d.some((x) => x.code === "Repetition")).toBe(true);
  }, 60_000);

  test("offsets point at the actual problem text", async () => {
    const text = "The quick brown fox jumpd over teh lazy dog.";
    for (const d of await diagnose(text)) {
      expect(d.from).toBeGreaterThanOrEqual(0);
      expect(d.to).toBeGreaterThan(d.from);
      expect(d.to).toBeLessThanOrEqual(text.length);
      expect(text.slice(d.from, d.to).trim().length).toBeGreaterThan(0);
    }
  }, 60_000);

  test("clean prose produces no warnings or errors", async () => {
    const d = await diagnose("The committee approved the revised budget on Tuesday.");
    expect(d.filter((x) => x.severity === "warning" || x.severity === "error")).toEqual([]);
  }, 60_000);

  test("declines non-English rather than flooding it with false positives", async () => {
    expect(await diagnose("यह एक वाक्य है। यह दूसरा वाक्य है।", "hi")).toEqual([]);
    expect(await diagnose("Dies ist ein deutscher Satz.", "de")).toEqual([]);
  }, 60_000);

  test("severity is assigned per rule, and unknown rules stay quiet", async () => {
    const d = await diagnose("I beleive this is a a test of teh checker.");
    expect(d.length).toBeGreaterThan(0);
    for (const x of d) expect(["error", "warning", "info", "hint"]).toContain(x.severity);
    expect(d.some((x) => x.severity === "warning")).toBe(true);
  }, 60_000);

  test("British spellings are not misspellings in British English", () => {
    // Defaulting everyone to American English marks "harbour" and "realise" as errors for
    // most of the English-speaking world -- the loudest possible false positive.
    return (async () => {
      const text = "The boat left the harbour before we could realise it.";
      const british = await diagnose(text, "en-GB");
      expect(british.filter((d) => d.code === "Spelling").map((d) => text.slice(d.from, d.to))).toEqual([]);
    })();
  }, 60_000);

  test("stays within the 150 ms diagnostics budget on a realistic paragraph", async () => {
    const para = "The survey team has completed its second season of measurement along the " +
      "eastern shoreline. This interim report summarises findings and sets out the working " +
      "group's recommendations. Retreat was concentrated in the northern sector, where the " +
      "dune toe migrated landward past the 2019 marker at transect seven.";
    await diagnose(para);
    const t0 = performance.now();
    await diagnose(para);
    const elapsed = performance.now() - t0;
    console.log(`\n[lsp] harper on a 4-sentence paragraph: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(150);
  }, 60_000);
});
