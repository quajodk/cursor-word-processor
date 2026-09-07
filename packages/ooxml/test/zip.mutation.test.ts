import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spliceZip } from "../src/zip";

/**
 * The splice must not touch its input.
 *
 * It did. `buf.slice(...)` on a Node Buffer — which is what `readFileSync` and most host
 * file reads return — is the legacy alias for `subarray` and yields a VIEW, so patching the
 * central directory's local-header offsets wrote through into the caller's bytes. The
 * exported package was always correct and the ORIGIN was destroyed, which meant the second
 * save of an open .docx spliced from a package whose central directory pointed at nothing.
 *
 * The test is written against a Buffer specifically. With a plain Uint8Array `.slice()`
 * copies and the bug is invisible, which is exactly why it survived.
 */

function repoRoot(): string {
  let d = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "bun.lock"))) return d;
    d = dirname(d);
  }
  return d;
}

describe("spliceZip input safety", () => {
  const dir = join(repoRoot(), "corpus", "docx");
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".docx")).sort().slice(0, 12) : [];

  test("the corpus is present", () => {
    expect(names.length).toBeGreaterThan(5);
  });

  test("leaves the caller's bytes untouched, even when handed a Node Buffer", () => {
    const damaged: string[] = [];
    // Counted, not assumed. Every iteration below can `continue`, so without this the test
    // would pass having spliced nothing at all — which is how a zip64 regression, or a
    // rename of the document part, would hide from the very check written to catch it.
    let spliced = 0;
    for (const name of names) {
      const buf = readFileSync(join(dir, name));
      const copy = new Uint8Array(buf);
      let out: Uint8Array;
      try { out = spliceZip(buf, { "word/document.xml": new TextEncoder().encode("<x/>") }).bytes; }
      catch { continue; } // zip64, or no such entry: not this test's subject
      expect(out.length).toBeGreaterThan(0);
      spliced++;
      for (let i = 0; i < copy.length; i++) {
        if (buf[i] !== copy[i]) { damaged.push(`${name} @${i}`); break; }
      }
    }
    expect(damaged).toEqual([]);
    expect(spliced).toBeGreaterThan(5);
  }, 120_000);

  test("a no-op splice is byte-identical and still leaves the input alone", () => {
    let checked = 0;
    for (const name of names.slice(0, 5)) {
      const buf = readFileSync(join(dir, name));
      const copy = new Uint8Array(buf);
      let r;
      try { r = spliceZip(buf, {}); } catch { continue; }
      checked++;
      expect(r.report.identical).toBe(true);
      expect(Array.from(buf)).toEqual(Array.from(copy));
    }
    expect(checked).toBeGreaterThan(2);
  }, 120_000);
});
