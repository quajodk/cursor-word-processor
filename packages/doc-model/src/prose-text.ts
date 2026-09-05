import type { Node as PMNode } from "prosemirror-model";

/**
 * The document as a prose checker should see it.
 *
 * Character-for-character identical to `doc.textBetween(0, size, "\n")` except that every
 * character of code is replaced by a space. Same length, same offsets, so `OffsetMap` maps a
 * diagnostic back to the same document position it always did — this masks, it never removes.
 * `test/prose-text.test.ts` asserts that equality against the real corpus, because a length
 * that drifts by one puts every squiggle after it on the wrong word.
 *
 * WHY, measured: on a 17,000-word Node.js API document the checker produced 2,986 marks and
 * 1,469 of them — very nearly half — were inside code blocks. `beforeExit` is not a
 * misspelling; `import process from 'node:process';` is not a sentence that forgot its
 * capital letter. Harper's `Capitalization` rule alone fired 1,582 times, almost entirely on
 * lines of source. Spell-checking code produces a page of red that is wrong on its own terms,
 * and it teaches the writer that every mark on the page can be ignored — which costs them the
 * one misspelling that was real.
 *
 * This is the same principle as `HarperProvider` declining a document that is not in English:
 * a checker with nothing useful to say about a span should say nothing, rather than say
 * something false about it.
 */

/** Node types whose text is code. */
const CODE_BLOCKS = new Set(["code_block"]);
/** Marks that make an inline span code. */
const CODE_MARKS = new Set(["code"]);

export interface ProseTextOptions {
  /**
   * Extra node types to mask. A caller with an extended schema (formulas, embeds, addresses)
   * can name them without this module having to know they exist.
   */
  maskBlocks?: Iterable<string>;
  maskMarks?: Iterable<string>;
}

export function proseText(doc: PMNode, opts: ProseTextOptions = {}): string {
  const blocks = opts.maskBlocks ? new Set([...CODE_BLOCKS, ...opts.maskBlocks]) : CODE_BLOCKS;
  const marks = opts.maskMarks ? new Set([...CODE_MARKS, ...opts.maskMarks]) : CODE_MARKS;

  const from = 0;
  const to = doc.content.size;
  let out = "";
  let first = true;

  doc.nodesBetween(from, to, (node, pos) => {
    // `textBetween` puts the separator before every textblock except the first — NOT before
    // every block. A blockquote wrapping a paragraph contributes one separator, not two, and
    // getting this wrong shifts every offset after the first list in the document.
    const isBlockText = node.isBlock && (node.isTextblock || (node.isLeaf && leafTextOf(node).length > 0));
    if (isBlockText) {
      if (first) first = false;
      else out += "\n";
    }

    if (node.isText) {
      const text = node.text!.slice(Math.max(from, pos) - pos, to - pos);
      const masked = node.marks.some((m) => marks.has(m.type.name)) || insideMaskedBlock(doc, pos, blocks);
      out += masked ? " ".repeat(text.length) : text;
      return false;
    }
    if (node.isLeaf) out += leafTextOf(node);
    return true;
  });

  return out;
}

/** What `textBetween` contributes for a leaf node when no explicit `leafText` is passed. */
function leafTextOf(node: PMNode): string {
  const spec = (node.type.spec as { leafText?: (n: PMNode) => string }).leafText;
  return spec ? spec(node) : "";
}

/** True when the text node at `pos` has a masked block among its ancestors. */
function insideMaskedBlock(doc: PMNode, pos: number, blocks: Set<string>): boolean {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    if (blocks.has($pos.node(depth).type.name)) return true;
  }
  return false;
}
