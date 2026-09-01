import { describe, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { XmlIndex, W_NS, deepText } from "../src/xmlindex.ts";
import { corpusFiles, readCorpus, sample, nonAsciiCandidates, type CorpusFile } from "./corpus.ts";

const dec = new TextDecoder("utf-8");

function documentXml(f: CorpusFile): Uint8Array | null {
  const zip = unzipSync(readCorpus(f), { filter: (e) => e.name === "word/document.xml" });
  return zip["word/document.xml"] ?? null;
}

/**
 * The invariant that makes byte-fidelity possible: for EVERY element, the byte slice
 * `[start,end)` of the original buffer must decode to exactly the raw markup of that element.
 * If byte offsets were secretly JS string indices this fails on the first non-ASCII character.
 */
function checkEveryElement(ix: XmlIndex): { elements: number; nonAsciiShift: number } {
  let elements = 0;
  let shifted = 0;
  const walk = (n: ReturnType<typeof XmlIndex.parse>["root"]): void => {
    for (const c of n.children) {
      elements++;
      if (c.start !== c.charStart) shifted++;
      const byBytes = dec.decode(ix.bytes.subarray(c.start, c.end));
      const byChars = ix.src.slice(c.charStart, c.charEnd);
      if (byBytes !== byChars) {
        throw new Error(`byte/char mismatch on <${c.name}> at ${c.start}: ${JSON.stringify(byBytes.slice(0, 60))} vs ${JSON.stringify(byChars.slice(0, 60))}`);
      }
      if (!byBytes.startsWith(`<${c.name}`)) throw new Error(`slice for <${c.name}> does not start with its tag: ${JSON.stringify(byBytes.slice(0, 40))}`);
      if (!byBytes.endsWith(">")) throw new Error(`slice for <${c.name}> does not end with '>'`);
      if (c.parent && c.parent.depth >= 0) {
        if (c.start < c.parent.contentStart || c.end > c.parent.contentEnd) {
          throw new Error(`<${c.name}> escapes its parent <${c.parent.name}> content span`);
        }
      }
      walk(c);
    }
  };
  walk(ix.root);
  return { elements, nonAsciiShift: shifted };
}

describe("XmlIndex byte offsets", () => {
  test("corpus is present", () => {
    expect(corpusFiles().length).toBeGreaterThan(200);
  });

  test("every element's byte span decodes to its raw markup, across a corpus spread", () => {
    const files = sample(40);
    let totalElements = 0;
    for (const f of files) {
      const xml = documentXml(f);
      if (!xml) continue;
      const ix = XmlIndex.parse(xml);
      const r = checkEveryElement(ix);
      totalElements += r.elements;
      expect(r.elements).toBeGreaterThan(0);
    }
    expect(totalElements).toBeGreaterThan(10000);
  }, 120_000);

  test("byte offsets diverge from string indices on non-ASCII documents", () => {
    const cands = nonAsciiCandidates();
    expect(cands.length).toBeGreaterThan(0);
    let filesWithShift = 0;
    let checked = 0;
    for (const f of cands.slice(0, 25)) {
      const xml = documentXml(f);
      if (!xml) continue;
      const ix = XmlIndex.parse(xml);
      if (ix.stats.ascii) continue; // some are only non-ASCII in the filename
      checked++;
      const r = checkEveryElement(ix);
      if (r.nonAsciiShift > 0) filesWithShift++;
    }
    expect(checked).toBeGreaterThan(0);
    // If offsets were char indices this would be 0 for every file.
    expect(filesWithShift).toBe(checked);
  }, 120_000);

  test("non-ASCII text survives the index and re-slices to identical bytes", () => {
    const enc = new TextEncoder();
    let sawNonAscii = false;
    for (const f of nonAsciiCandidates().slice(0, 25)) {
      const xml = documentXml(f);
      if (!xml) continue;
      const ix = XmlIndex.parse(xml);
      if (ix.stats.ascii) continue;
      const body = ix.root.children[0];
      expect(body).toBeTruthy();
      const paras: typeof ix.root.children = [];
      const walk = (n: typeof ix.root): void => {
        for (const c of n.children) { if (c.local === "p" && c.uri === W_NS) paras.push(c); walk(c); }
      };
      walk(ix.root);
      for (const p of paras.slice(0, 200)) {
        const t = deepText(p);
        if (/[^\x00-\x7F]/.test(t)) {
          sawNonAscii = true;
          const slice = ix.bytes.subarray(p.start, p.end);
          expect(Array.from(enc.encode(ix.src.slice(p.charStart, p.charEnd)))).toEqual(Array.from(slice));
        }
      }
    }
    expect(sawNonAscii).toBe(true);
  }, 120_000);

  test("whole document reconstructs from top-level byte spans plus gaps", () => {
    for (const f of sample(12)) {
      const xml = documentXml(f);
      if (!xml) continue;
      const ix = XmlIndex.parse(xml);
      // Concatenating the raw bytes of the root element with everything before and after it
      // must reproduce the file exactly. This is the splice engine's core operation.
      const root = ix.root.children[ix.root.children.length - 1]!;
      const out = new Uint8Array(xml.length);
      out.set(xml.subarray(0, root.start), 0);
      out.set(ix.rawBytes(root), root.start);
      out.set(xml.subarray(root.end), root.end);
      expect(Array.from(out)).toEqual(Array.from(xml));
    }
  }, 120_000);

  test("parses every corpus document.xml without throwing", () => {
    const failures: string[] = [];
    let ok = 0;
    for (const f of corpusFiles()) {
      try {
        const xml = documentXml(f);
        if (!xml) { failures.push(`${f.name}: no word/document.xml`); continue; }
        const ix = XmlIndex.parse(xml);
        if (ix.stats.elements === 0) failures.push(`${f.name}: zero elements`);
        else ok++;
      } catch (e) {
        failures.push(`${f.name}: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    if (failures.length) console.log(`xmlindex parse failures (${failures.length}):\n` + failures.join("\n"));
    console.log(`xmlindex: ${ok}/${corpusFiles().length} document.xml parsed`);
    expect(ok).toBe(corpusFiles().length);
  }, 300_000);
});
