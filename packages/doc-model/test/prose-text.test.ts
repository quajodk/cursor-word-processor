import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { Glob } from "bun";
import { parseMarkdown } from "@scriv/md";
import { schema } from "../src/schema";
import { OffsetMap } from "../src/offset";
import { proseText } from "../src/prose-text";

/**
 * `proseText` has exactly one hard requirement: it must be the same length as
 * `textBetween`, character for character, so that offsets computed against it map back
 * through `OffsetMap` to the positions they always did.
 *
 * That is easy to get subtly wrong — `textBetween` puts its separator before every
 * TEXTBLOCK, not before every block, so a blockquote or a list contributes one newline where
 * a naive walk contributes two or three. A single character of drift puts every diagnostic
 * after the first list in the document under the wrong word, silently. So the equality is
 * checked against real documents rather than hand-written ones.
 */

function repoRoot(): string {
  let d = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "bun.lock"))) return d;
    d = dirname(d);
  }
  return d;
}

function corpusDocs(limit: number) {
  const dir = join(repoRoot(), "corpus", "md");
  const out: { path: string; doc: ReturnType<typeof parseMarkdown>["doc"] }[] = [];
  if (!existsSync(dir)) return out;
  const files: { path: string; size: number }[] = [];
  for (const rel of new Glob("**/*.md").scanSync(dir)) {
    const path = join(dir, rel);
    try {
      const size = statSync(path).size;
      if (size >= 2_048 && size <= 400_000) files.push({ path, size });
    } catch { /* unreadable */ }
  }
  files.sort((a, b) => b.size - a.size);
  for (const f of files.slice(0, limit)) {
    try { out.push({ path: f.path, doc: parseMarkdown(readFileSync(f.path, "utf8")).doc }); }
    catch { /* a file that will not parse is not this test's subject */ }
  }
  return out;
}

describe("proseText", () => {
  const docs = corpusDocs(60);

  test("the corpus is present, or the equality below is untested", () => {
    expect(docs.length).toBeGreaterThan(20);
  });

  test("is the same length as textBetween on every real document", () => {
    const drifted: string[] = [];
    for (const { path, doc } of docs) {
      const a = doc.textBetween(0, doc.content.size, "\n");
      const b = proseText(doc);
      if (a.length !== b.length) drifted.push(`${path}: textBetween ${a.length} vs proseText ${b.length}`);
    }
    expect(drifted).toEqual([]);
  });

  test("masks only code: every other character is unchanged", () => {
    const wrong: string[] = [];
    for (const { path, doc } of docs) {
      const a = doc.textBetween(0, doc.content.size, "\n");
      const b = proseText(doc);
      for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        // The only permitted difference is an original character replaced by a space.
        if (b[i] !== " ") { wrong.push(`${path}@${i}: ${JSON.stringify(a[i])} -> ${JSON.stringify(b[i])}`); break; }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("actually masks something, or it is a very expensive identity function", () => {
    const withCode = docs.filter(({ doc }) => {
      const a = doc.textBetween(0, doc.content.size, "\n");
      return a !== proseText(doc);
    });
    expect(withCode.length).toBeGreaterThan(10);
  });

  test("a code block is blanked and a paragraph beside it is not", () => {
    const doc = schema.nodes.doc!.create(null, [
      schema.nodes.paragraph!.create(null, schema.text("Before the code.")),
      schema.nodes.code_block!.create(null, schema.text("beforeExit(v0)")),
      schema.nodes.paragraph!.create(null, schema.text("After the code.")),
    ]);
    expect(proseText(doc)).toBe("Before the code.\n              \nAfter the code.");
  });

  test("an inline code mark is blanked inside an ordinary paragraph", () => {
    const code = schema.marks.code!;
    const doc = schema.nodes.doc!.create(null, [
      schema.nodes.paragraph!.create(null, [
        schema.text("Call "),
        schema.text("beforeExit", [code.create()]),
        schema.text(" first."),
      ]),
    ]);
    expect(proseText(doc)).toBe("Call            first.");
  });

  test("every offset resolves through OffsetMap to the character it names", () => {
    // EXHAUSTIVE, not sampled. The first version of this sampled every 40th character and
    // still caught the drift, but a sampled check on a map that is right for the first
    // paragraph and wrong after the first list is a check that passes by luck.
    const wrong: string[] = [];
    for (const { path, doc } of docs.slice(0, 25)) {
      const text = doc.textBetween(0, doc.content.size, "\n");
      const map = new OffsetMap(doc, 0, doc.content.size);
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") continue;
        const pos = map.pos(i);
        const got = doc.textBetween(pos, Math.min(pos + 1, doc.content.size));
        if (got !== text[i]) {
          wrong.push(`${path}@${i}: text has ${JSON.stringify(text[i])}, map points at ${JSON.stringify(got)}`);
          break;
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("agrees with textBetween when a leafText is supplied too", () => {
    const wrong: string[] = [];
    for (const { path, doc } of docs.slice(0, 15)) {
      const text = doc.textBetween(0, doc.content.size, "\n", " ");
      const map = new OffsetMap(doc, 0, doc.content.size, { leafText: " " });
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n" || text[i] === " ") continue;
        const pos = map.pos(i);
        const got = doc.textBetween(pos, Math.min(pos + 1, doc.content.size));
        if (got !== text[i]) { wrong.push(`${path}@${i}: ${JSON.stringify(text[i])} vs ${JSON.stringify(got)}`); break; }
      }
    }
    expect(wrong).toEqual([]);
  });
});
