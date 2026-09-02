/**
 * T1 SURGICAL.
 *
 * DOCX-FIDELITY.md §6: "import → edit one word → export → compare all *other* paragraphs;
 * target 100% byte-identical outside the edited `<w:p>`."
 *
 * This is the tier that separates splicing from regenerating, and it is deliberately measured
 * at the byte level with NO normalisation at all. Not "semantically equivalent", not "renders
 * the same" — the same bytes. An exporter that rewrites `<w:b/>` as `<w:b w:val="1"/>` in a
 * paragraph the writer never touched has changed that paragraph, and this tier says so.
 *
 * The comparison is a longest-common-subsequence over the raw byte spans of every `<w:p>` in
 * document order, which handles the two things that can happen: a paragraph whose bytes changed
 * (it drops out of the subsequence) and paragraphs added or removed (the sequences differ in
 * length). Matching by index would report nonsense the moment a tool inserts a paragraph.
 */

import { XmlIndex, W_NS, type XmlNode } from "../xmlindex";
import { lcsLength } from "./t2";

export interface T1Result {
  originParagraphs: number;
  outputParagraphs: number;
  /** Origin paragraphs whose exact bytes reappear, in order, in the output. */
  identical: number;
  /**
   * `identical / (originParagraphs - 1)`, capped at 1: of the paragraphs the edit did not
   * touch, the fraction that came back byte-identical. This is the tier's headline number.
   */
  score: number;
  /** True when exactly one paragraph differs and everything outside the paragraphs is identical. */
  clean: boolean;
  /** Bytes of the part outside every `<w:p>` — the section properties, tables' own markup, the
   *  body frame — compared as one string. */
  spineIdentical: boolean;
  /** False when the LCS fell back to its order-blind bound on a very large document. */
  exact: boolean;
}

/** Raw byte spans of every `w:p` in document order, at any nesting depth. */
function paragraphSpans(bytes: Uint8Array): { spans: string[]; spine: string } {
  const ix = XmlIndex.parse(bytes);
  const spans: string[] = [];
  const ranges: Array<[number, number]> = [];
  const walk = (n: XmlNode): void => {
    for (const c of n.children) {
      if (c.local === "p" && c.uri === W_NS) {
        spans.push(ix.raw(c));
        ranges.push([c.charStart, c.charEnd]);
        // Do not descend: a paragraph nested inside a textbox belongs to its owner's bytes.
        continue;
      }
      walk(c);
    }
  };
  walk(ix.root);

  let spine = "";
  let cur = 0;
  for (const [a, b] of ranges) { spine += ix.src.slice(cur, a); cur = b; }
  spine += ix.src.slice(cur);
  return { spans, spine };
}

export function scoreT1(originDocumentXml: Uint8Array, outputDocumentXml: Uint8Array): T1Result {
  const a = paragraphSpans(originDocumentXml);
  const b = paragraphSpans(outputDocumentXml);
  const { len, exact } = lcsLength(a.spans, b.spans);
  const denominator = Math.max(1, a.spans.length - 1);
  const spineIdentical = a.spine === b.spine;
  return {
    originParagraphs: a.spans.length,
    outputParagraphs: b.spans.length,
    identical: len,
    score: Math.min(1, len / denominator),
    clean: a.spans.length === b.spans.length && len === a.spans.length - 1 && spineIdentical,
    spineIdentical,
    exact,
  };
}
