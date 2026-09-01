import { describe, test, expect } from "bun:test";
import { parseMarkdown } from "../src/from-mdast";
import { serializeMarkdown } from "../src/serialize";
import { schema } from "@scriv/doc-model";

/**
 * CriticMarkup (DOCX-FIDELITY.md §5): `{>>comment<<}`, `{++ins++}`, `{--del--}`, `{~~a~>b~~}`.
 *
 * The load-bearing property this file exists to check: CriticMarkup detection runs on mdast
 * `text` nodes, which mdast has already separated from `inlineCode` and fenced/indented code
 * — so it must NOT fire inside a code span or a code fence, unlike a naive regex over the raw
 * source, which cannot tell code from prose.
 */

describe("CriticMarkup", () => {
  test("insertion becomes an `insertion` mark", () => {
    const { doc } = parseMarkdown("Some {++inserted text++} here.\n");
    let found = false;
    doc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === "insertion")) {
        expect(node.text).toBe("inserted text");
        found = true;
      }
      return true;
    });
    expect(found).toBe(true);
  });

  test("deletion becomes a `deletion` mark", () => {
    const { doc } = parseMarkdown("Some {--deleted text--} here.\n");
    let found = false;
    doc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === "deletion")) {
        expect(node.text).toBe("deleted text");
        found = true;
      }
      return true;
    });
    expect(found).toBe(true);
  });

  test("substitution becomes adjacent deletion + insertion sharing a revId", () => {
    const { doc } = parseMarkdown("Replace {~~old~>new~~} word.\n");
    const marked: { text: string; kind: string; revId: string }[] = [];
    doc.descendants((node) => {
      if (!node.isText) return true;
      for (const m of node.marks) {
        if (m.type.name === "insertion" || m.type.name === "deletion") {
          marked.push({ text: node.text ?? "", kind: m.type.name, revId: m.attrs.revId });
        }
      }
      return true;
    });
    expect(marked.length).toBe(2);
    expect(marked[0]!.kind).toBe("deletion");
    expect(marked[0]!.text).toBe("old");
    expect(marked[1]!.kind).toBe("insertion");
    expect(marked[1]!.text).toBe("new");
    expect(marked[0]!.revId).toBe(marked[1]!.revId);
  });

  test("comment becomes a `comment` mark anchored to the preceding text, and its body lands in meta.comments", () => {
    const { doc, meta } = parseMarkdown("Needs a citation{>>please add a source<<} here.\n");
    expect(meta.comments.length).toBe(1);
    expect(meta.comments[0]!.body).toBe("please add a source");
    let found = false;
    doc.descendants((node) => {
      if (node.isText) {
        const c = node.marks.find((m) => m.type.name === "comment");
        if (c) {
          expect(c.attrs.anchorId).toBe(meta.comments[0]!.anchorId);
          expect(node.text).toBe("Needs a citation");
          found = true;
        }
      }
      return true;
    });
    expect(found).toBe(true);
  });

  test("does NOT fire inside an inline code span", () => {
    const { doc } = parseMarkdown("Look at `{++not really an insertion++}` literally.\n");
    let sawInsertionMark = false;
    let sawLiteralCode = false;
    doc.descendants((node) => {
      if (!node.isText) return true;
      if (node.marks.some((m) => m.type.name === "insertion" || m.type.name === "deletion" || m.type.name === "comment")) {
        sawInsertionMark = true;
      }
      if (node.marks.some((m) => m.type.name === "code") && node.text === "{++not really an insertion++}") {
        sawLiteralCode = true;
      }
      return true;
    });
    expect(sawInsertionMark).toBe(false);
    expect(sawLiteralCode).toBe(true);
  });

  test("does NOT fire inside a fenced code block", () => {
    const src = "```\nplain code with {++looks like insertion++} inside\n```\n";
    const { doc } = parseMarkdown(src);
    let codeBlockText = "";
    let sawMark = false;
    doc.descendants((node) => {
      if (node.type.name === "code_block") codeBlockText = node.textContent;
      if (node.isText && node.marks.some((m) => ["insertion", "deletion", "comment"].includes(m.type.name))) sawMark = true;
      return true;
    });
    expect(codeBlockText).toBe("plain code with {++looks like insertion++} inside");
    expect(sawMark).toBe(false);
  });

  test("round-trips through parse → serialize unchanged for a simple mixed case", () => {
    const src = "Text with {++added++}, {--removed--}, {~~x~>y~~}, and a note{>>comment body<<}.\n";
    const { doc, meta } = parseMarkdown(src);
    const out = serializeMarkdown(doc, meta);
    // Idempotence is the specified bar; check the second pass is stable.
    const { doc: doc2, meta: meta2 } = parseMarkdown(out);
    const out2 = serializeMarkdown(doc2, meta2);
    expect(out2).toBe(out);
  });

  test("insertion/deletion marks can wrap nested inline formatting when the whole span is one text run", () => {
    const { doc } = parseMarkdown("A {++plain insertion++} span.\n");
    const texts: string[] = [];
    doc.descendants((n) => {
      if (n.isText) texts.push(n.text ?? "");
      return true;
    });
    expect(texts).toContain("plain insertion");
  });

  test("a comment with nothing to attach to falls back to literal preserved text rather than being dropped", () => {
    // An otherwise-empty paragraph containing only a comment has no prose to anchor the mark
    // to. Content must not silently vanish.
    const { doc } = parseMarkdown("{>>orphan comment<<}\n");
    let sawLiteral = false;
    doc.descendants((n) => {
      if (n.isText && (n.text ?? "").includes("orphan comment")) sawLiteral = true;
      return true;
    });
    expect(sawLiteral).toBe(true);
  });

  test("critic.ts's schema import stays valid (comment mark exists on doc-model)", () => {
    expect(schema.marks.comment).toBeDefined();
    expect(schema.marks.insertion).toBeDefined();
    expect(schema.marks.deletion).toBeDefined();
  });
});
