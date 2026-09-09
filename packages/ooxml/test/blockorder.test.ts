import { describe, test, expect } from "bun:test";
import { zipSync } from "fflate";
import { importDocx } from "../src/import";

/**
 * Document order is not key order, and this file exists so nobody has to rediscover that.
 *
 * Aids are minted fresh on every import, and roughly one in a hundred comes out as an all-digit
 * string — measured across the whole docx corpus: 1,235 integer-like aids in 131,862 blocks,
 * 0.94%. JavaScript hoists integer-like keys to the FRONT of an object's key order, ascending
 * numerically, ahead of every string key regardless of insertion order. So
 * `Object.keys(sidecar.blocks)` silently reports a different order from the one the blocks were
 * inserted in, and a different one on every import, because the aids are random.
 *
 * That is not a hypothetical. It was already corrupting a measurement: `anchor.test.ts` built
 * its block list from `Object.entries(sidecar.blocks)` and was scoring the alignment engine
 * against documents whose paragraphs had been shuffled, with results that drifted run to run.
 *
 * `export.ts` sorts by `range` and the importer keeps an `orderedAids` array, so the machinery
 * to do this correctly is already there. What was missing was anything that fails when someone
 * reaches for the object's own key order instead.
 */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function para(text: string, inner = ""): string {
  return `<w:p>${inner}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/** The smallest package `importDocx` will accept, plus a comments part. */
function makeDocx(bodyXml: string, commentsXml?: string): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": new TextEncoder().encode(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="xml" ContentType="application/xml"/></Types>`,
    ),
    "word/document.xml": new TextEncoder().encode(
      `<?xml version="1.0"?><w:document ${W}><w:body>${bodyXml}</w:body></w:document>`,
    ),
  };
  if (commentsXml) {
    files["word/comments.xml"] = new TextEncoder().encode(
      `<?xml version="1.0"?><w:comments ${W}>${commentsXml}</w:comments>`,
    );
  }
  return zipSync(files);
}

/**
 * Mint an integer-like aid for exactly one paragraph, so the hoisting this file is about
 * happens deterministically instead of once in a hundred blocks.
 */
function aidsWithIntegerAt(target: number): (ordinal: number) => string {
  return (ordinal) => (ordinal === target ? "66030358" : `aid${String(ordinal).padStart(3, "0")}`);
}

describe("block order does not come from object key order", () => {
  const body = [para("First paragraph."), para("Second paragraph."), para("Third paragraph."), para("Fourth paragraph.")].join("");

  test("an integer-like aid really is hoisted — the hazard is live, not theoretical", () => {
    // If this ever stops being true, the tests below stop testing anything, so it is asserted
    // directly rather than assumed. The aid is minted for the LAST paragraph and JavaScript
    // still reports it first.
    const { sidecar } = importDocx(makeDocx(body), { mintAid: aidsWithIntegerAt(3) });
    const keys = Object.keys(sidecar.blocks);
    expect(keys.length).toBe(4);
    expect(keys[0]).toBe("66030358");
    expect(sidecar.blocks["66030358"]!.text).toBe("Fourth paragraph.");
  });

  test("`ordinal` and `range` both give the true document order", () => {
    // The two supported ways to recover it. Both must agree, and both must disagree with the
    // key order above.
    const { sidecar } = importDocx(makeDocx(body), { mintAid: aidsWithIntegerAt(3) });
    const byOrdinal = Object.values(sidecar.blocks).slice().sort((a, b) => a.ordinal - b.ordinal);
    const byRange = Object.values(sidecar.blocks).slice().sort((a, b) => a.range![0] - b.range![0]);
    const expected = ["First paragraph.", "Second paragraph.", "Third paragraph.", "Fourth paragraph."];
    expect(byOrdinal.map((b) => b.text)).toEqual(expected);
    expect(byRange.map((b) => b.text)).toEqual(expected);
    // And the naive reading is wrong, which is the whole point.
    expect(Object.values(sidecar.blocks).map((b) => b.text)).not.toEqual(expected);
  });

  test("a comment binds to the first paragraph of its range, not the hoisted one", () => {
    // THE REGRESSION. `commentToBlock` is "first block wins" and is meant to mean "first in the
    // document". It iterated `Object.entries(blocks)`, so a hoisted block won instead.
    //
    // A range that is opened twice under one id is what makes the tie-break observable. Word
    // does not normally write that — across all 288 corpus documents no comment anchor appears
    // in more than one block — so this is a constructed case, and the fix is a latent-bug fix
    // rather than one that changes what the corpus does today. It is still the difference
    // between a rule that holds by luck and one that holds by construction.
    const withRanges = [
      para("First paragraph.", '<w:commentRangeStart w:id="1"/>'),
      para("Second paragraph."),
      para("Third paragraph."),
      para("Fourth paragraph.", '<w:commentRangeStart w:id="1"/>'),
    ].join("") + '<w:p><w:r><w:commentReference w:id="1"/></w:r></w:p>';

    const { sidecar } = importDocx(
      makeDocx(withRanges, '<w:comment w:id="1" w:author="A" w:initials="A"><w:p><w:r><w:t>note</w:t></w:r></w:p></w:comment>'),
      { mintAid: aidsWithIntegerAt(3) },
    );

    // The hoisted block is the fourth paragraph and it does carry the anchor, so the tie-break
    // is genuinely being exercised.
    expect(Object.keys(sidecar.blocks)[0]).toBe("66030358");
    expect(sidecar.blocks["66030358"]!.commentAnchors ?? []).toContain("c:1");

    const thread = sidecar.comments["c:1"];
    expect(thread).toBeDefined();
    expect(sidecar.blocks[thread!.aid!]!.text).toBe("First paragraph.");
  });

  test("every block the importer records is reachable in document order", () => {
    // `orderedAids` is what the comment, numbering and anchor passes all walk. If a block can
    // exist in `blocks` without being in that order, those passes skip it silently.
    const { sidecar } = importDocx(makeDocx(body), { mintAid: aidsWithIntegerAt(2) });
    const ordinals = Object.values(sidecar.blocks).map((b) => b.ordinal).sort((a, b) => a - b);
    expect(ordinals).toEqual([0, 1, 2, 3]);
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });
});
