import { describe, expect, test } from "bun:test";
import type { PropBlob } from "../src/sidecar";
import { importDocx } from "../src/import";
import { parseSidecar, serializeSidecar, SIDECAR_VERSION } from "../src/sidecar";
import { summarize } from "../src/ledger";
import { corpusFiles, readCorpus, sample } from "./corpus";

const dec = new TextDecoder("utf-8");

describe("importDocx over the real corpus", () => {
  /**
   * The headline number. Every file here is a real-world .docx collected from the wild; if the
   * importer only survives files we picked, it has not been tested.
   */
  test("imports every corpus file without throwing", () => {
    const files = corpusFiles();
    expect(files.length).toBeGreaterThan(200);
    const failures: string[] = [];
    let ok = 0;
    let blocks = 0;
    const codes = new Map<string, number>();
    for (const f of files) {
      try {
        const r = importDocx(readCorpus(f), { hashParts: false, now: "1970-01-01T00:00:00.000Z" });
        ok++;
        blocks += r.sidecar.stats.blocks;
        for (const e of r.ledger) codes.set(e.code, (codes.get(e.code) ?? 0) + e.count);
      } catch (e) {
        failures.push(`${f.name}: ${(e as Error).message.slice(0, 160)}`);
      }
    }
    console.log(`import: ${ok}/${files.length} files, ${blocks} blocks`);
    console.log("ledger totals: " + [...codes].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));
    if (failures.length) console.log("failures:\n" + failures.join("\n"));
    expect(failures).toEqual([]);
    expect(ok).toBe(files.length);
  }, 900_000);

  /**
   * The body frame must be a gapless partition of `w:body`'s content span. This is what lets the
   * splice engine reassemble the body by concatenation: if items could have holes, an unmodeled
   * element between two paragraphs would vanish on export and nobody would notice until a
   * customer's section break disappeared.
   */
  test("body items partition the body content span exactly", () => {
    for (const f of sample(60)) {
      const r = importDocx(readCorpus(f), { hashParts: false });
      const { items, bodyContent } = r.sidecar.document;
      let cur = bodyContent[0];
      for (const it of items) {
        expect(it.range[0]).toBe(cur);
        expect(it.range[1]).toBeGreaterThanOrEqual(it.range[0]);
        cur = it.range[1];
      }
      expect(cur).toBe(bodyContent[1]);
      expect(r.sidecar.document.prologue[1]).toBe(bodyContent[0]);
      expect(r.sidecar.document.epilogue[0]).toBe(bodyContent[1]);
      expect(r.sidecar.document.epilogue[1]).toBe(r.origin.documentXml.length);
    }
  }, 600_000);

  /** Every recorded byte range must actually contain the element it claims. */
  test("block and property ranges address the original bytes correctly", () => {
    for (const f of sample(60)) {
      const r = importDocx(readCorpus(f), { hashParts: false });
      const xml = r.origin.documentXml;
      for (const item of r.sidecar.document.items) {
        if (item.kind !== "block") continue;
        const rec = r.sidecar.blocks[item.aid!]!;
        expect(rec).toBeTruthy();
        const text = dec.decode(xml.subarray(rec.range![0], rec.range![1]));
        expect(text.startsWith(`<${rec.element}`)).toBe(true);
        expect(text.endsWith(">")).toBe(true);
        for (const run of rec.runs) {
          const rt = dec.decode(xml.subarray(run.range[0], run.range[1]));
          expect(rt.startsWith(`<${run.element}`)).toBe(true);
          if (run.rPrRange) {
            expect(run.rPrRange[0]).toBeGreaterThanOrEqual(run.range[0]);
            expect(run.rPrRange[1]).toBeLessThanOrEqual(run.range[1]);
          }
        }
      }
      for (const bucket of Object.values(r.sidecar.props)) {
        for (const blob of Object.values(bucket) as PropBlob[]) {
          expect(dec.decode(xml.subarray(blob.range[0], blob.range[1]))).toBe(blob.xml);
        }
      }
    }
  }, 600_000);

  /** Property blobs are content-addressed, so the same XML must always intern to the same ref. */
  test("property refs are content-addressed and deduplicated", () => {
    let sawReuse = false;
    for (const f of sample(30)) {
      const r = importDocx(readCorpus(f), { hashParts: false });
      const seen = new Map<string, string>();
      for (const bucket of Object.values(r.sidecar.props)) {
        for (const blob of Object.values(bucket) as PropBlob[]) {
          const prior = seen.get(blob.xml);
          if (prior) expect(prior).toBe(blob.ref);
          seen.set(blob.xml, blob.ref);
          if (blob.uses > 1) sawReuse = true;
        }
      }
      // Interning must actually save something on a real document.
      const paraCount = Object.values(r.sidecar.blocks).filter((b) => b.pPrRef).length;
      const distinct = Object.keys(r.sidecar.props.pPr).length;
      if (paraCount > 50) expect(distinct).toBeLessThan(paraCount);
    }
    expect(sawReuse).toBe(true);
  }, 600_000);

  /** The sidecar must survive JSON exactly - it is written to disk and read by another package. */
  test("sidecar round-trips losslessly through JSON", () => {
    for (const f of sample(25)) {
      const r = importDocx(readCorpus(f), { hashParts: false, now: "1970-01-01T00:00:00.000Z" });
      const json = serializeSidecar(r.sidecar);
      const back = parseSidecar(json);
      expect(back.version).toBe(SIDECAR_VERSION);
      expect(serializeSidecar(back)).toBe(json);
      expect(Object.keys(back.blocks).length).toBe(Object.keys(r.sidecar.blocks).length);
      expect(Object.keys(back.anchors).length).toBe(Object.keys(r.sidecar.anchors).length);
    }
  }, 600_000);

  test("parseSidecar refuses a version it does not understand", () => {
    expect(() => parseSidecar(JSON.stringify({ kind: "scriv.docx.fidelity", version: 999 }))).toThrow(/unsupported fidelity sidecar version/);
    expect(() => parseSidecar(JSON.stringify({ kind: "something-else", version: 1 }))).toThrow(/not a scriv fidelity sidecar/);
  });

  /** Every block in the model has an anchor, and every anchor names a block. */
  test("anchors and blocks are in bijection after import", () => {
    for (const f of sample(40)) {
      const r = importDocx(readCorpus(f), { hashParts: false });
      const b = Object.keys(r.sidecar.blocks).sort();
      const a = Object.keys(r.sidecar.anchors).sort();
      expect(a).toEqual(b);
      for (const aid of a) {
        expect(r.sidecar.anchors[aid]!.aid).toBe(aid);
        expect(r.sidecar.anchors[aid]!.kind).toBe(r.sidecar.blocks[aid]!.kind);
      }
    }
  }, 600_000);

  /** Text must reach the document model, not merely the sidecar. */
  test("document model carries the document's text", () => {
    let totalChars = 0;
    for (const f of sample(40)) {
      const r = importDocx(readCorpus(f), { hashParts: false });
      // `hard_break` is a leaf: it contributes "\n" to the block text the anchors are computed
      // on, so it must contribute "\n" here too or the comparison is against a different string.
      const text = r.doc.textBetween(0, r.doc.content.size, "\n", (leaf) => (leaf.type.name === "hard_break" ? "\n" : ""));
      totalChars += text.length;
      // Every non-empty paragraph record's text must be findable in the model's text.
      const sampleBlocks = Object.values(r.sidecar.blocks)
        .filter((b) => b.kind !== "table" && b.text.trim().length > 20)
        .slice(0, 20);
      for (const b of sampleBlocks) expect(text.includes(b.text.trim().slice(0, 40))).toBe(true);
    }
    expect(totalChars).toBeGreaterThan(100_000);
  }, 600_000);

  /** Every ledger entry is well-formed; the ledger is a product surface, not a debug log. */
  test("ledger entries are well-formed and folded", () => {
    let anyDegraded = false;
    for (const f of sample(60)) {
      const r = importDocx(readCorpus(f), { hashParts: false });
      const keys = new Set<string>();
      for (const e of r.ledger) {
        expect(typeof e.detail).toBe("string");
        expect(e.detail.length).toBeGreaterThan(0);
        expect(e.count).toBeGreaterThan(0);
        expect(["info", "degraded", "dropped"]).toContain(e.severity);
        const k = `${e.stage} ${e.code} ${e.aid ?? ""} ${e.element ?? ""} ${e.part ?? ""}`;
        expect(keys.has(k)).toBe(false);
        keys.add(k);
      }
      const s = summarize(r.ledger);
      if (s.bySeverity.degraded > 0) anyDegraded = true;
      expect(s.total).toBe(r.ledger.reduce((n, e) => n + e.count, 0));
    }
    expect(anyDegraded).toBe(true);
  }, 600_000);

  /** The origin is the substrate: it must be the untouched input. */
  test("origin retains the whole original zip", () => {
    for (const f of sample(15)) {
      const bytes = readCorpus(f);
      const r = importDocx(bytes, { hashParts: false });
      expect(r.origin.bytes).toBe(bytes);
      expect(r.origin.entries.length).toBe(r.sidecar.origin.zipEntryCount);
      expect(r.origin.entries.some((e) => e.name === r.origin.documentPart)).toBe(true);
      expect(r.origin.documentXml.length).toBe(r.sidecar.origin.documentXmlBytes);
    }
  }, 600_000);

  test("comments and tracked changes are captured where the corpus has them", () => {
    let withComments = 0;
    let withRevisions = 0;
    for (const f of corpusFiles()) {
      const r = importDocx(readCorpus(f), { hashParts: false });
      if (r.sidecar.stats.comments > 0) {
        withComments++;
        for (const c of Object.values(r.sidecar.comments)) {
          expect(c.anchorId.startsWith("c:")).toBe(true);
          expect(c.xml.startsWith("<")).toBe(true);
        }
      }
      if (r.sidecar.stats.revisions > 0) {
        withRevisions++;
        for (const rev of Object.values(r.sidecar.revisions)) {
          expect(["ins", "del", "moveFrom", "moveTo", "pPrChange", "rPrChange", "sectPrChange", "tblPrChange"]).toContain(rev.kind);
        }
      }
    }
    console.log(`corpus: ${withComments} files with comments, ${withRevisions} with tracked changes`);
    expect(withComments).toBeGreaterThan(5);
    expect(withRevisions).toBeGreaterThan(3);
  }, 900_000);
});
