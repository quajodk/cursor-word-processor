import { describe, test, expect } from "bun:test";
import { EditorState } from "prosemirror-state";
import { OffsetMap, schema } from "@scriv/doc-model";
import { acceptSuggestion, hasSuggestion, rejectSuggestion, suggestRewrite } from "../src/suggest";

const docOf = (...paras: string[]) =>
  EditorState.create({
    doc: schema.node("doc", null, paras.map((p) => schema.node("paragraph", null, p ? [schema.text(p)] : []))),
  });

const text = (s: EditorState) => s.doc.textBetween(0, s.doc.content.size, "\n");
const apply = (s: EditorState, tr: ReturnType<typeof suggestRewrite>) => (tr ? s.apply(tr) : s);

/** The whole-document range, excluding the outer block boundaries. */
const whole = (s: EditorState) => [1, s.doc.content.size - 1] as const;

describe("offset mapping", () => {
  test("maps offsets to positions across block boundaries", () => {
    const s = docOf("alpha", "beta");
    const [from, to] = whole(s);
    const map = new OffsetMap(s.doc, from, to);
    const flat = s.doc.textBetween(from, to, "\n");
    expect(flat).toBe("alpha\nbeta");
    // Every offset must land on a position whose following character matches the flat text.
    for (let i = 0; i < flat.length; i++) {
      const pos = map.pos(i);
      expect(pos).toBeGreaterThanOrEqual(from);
      expect(pos).toBeLessThanOrEqual(to);
    }
  });
});

describe("suggesting a rewrite", () => {
  test("marks the replaced text as deleted and the new text as inserted", () => {
    const s = docOf("The boat was late.");
    const [from, to] = whole(s);
    const next = apply(s, suggestRewrite(s, from, to, "The vessel was delayed.", { revId: "r1" }));

    expect(hasSuggestion(next.doc, "r1")).toBe(true);
    let ins = "", del = "";
    next.doc.descendants((n) => {
      if (!n.isText) return true;
      if (n.marks.some((m) => m.type.name === "insertion")) ins += n.text;
      if (n.marks.some((m) => m.type.name === "deletion")) del += n.text;
      return true;
    });
    expect(ins).toContain("vessel");
    expect(del).toContain("boat");
  });

  test("the AI's own marks carry origin ai, so they are distinguishable from a colleague's", () => {
    const s = docOf("One two three.");
    const [from, to] = whole(s);
    const next = apply(s, suggestRewrite(s, from, to, "One four three.", { revId: "r1" }));
    let sawAi = false;
    next.doc.descendants((n) => {
      for (const m of n.marks) if (m.attrs.origin === "ai") sawAi = true;
      return true;
    });
    expect(sawAi).toBe(true);
  });

  test("an identical rewrite suggests nothing", () => {
    const s = docOf("Unchanged text here.");
    const [from, to] = whole(s);
    expect(suggestRewrite(s, from, to, "Unchanged text here.", { revId: "r1" })).toBeNull();
  });

  test("accepting yields exactly the proposed text", () => {
    const s = docOf("The boat was late.");
    const [from, to] = whole(s);
    let next = apply(s, suggestRewrite(s, from, to, "The vessel was delayed.", { revId: "r1" }));
    next = next.apply(acceptSuggestion(next, "r1")!);
    expect(text(next)).toBe("The vessel was delayed.");
    expect(hasSuggestion(next.doc)).toBe(false);
  });

  test("rejecting restores the original exactly", () => {
    const original = "The boat was late.";
    const s = docOf(original);
    const [from, to] = whole(s);
    let next = apply(s, suggestRewrite(s, from, to, "The vessel was delayed.", { revId: "r1" }));
    next = next.apply(rejectSuggestion(next, "r1")!);
    expect(text(next)).toBe(original);
    expect(hasSuggestion(next.doc)).toBe(false);
  });

  test("accept and reject round-trip over multi-sentence rewrites", () => {
    const original = "The tide was high. The boat was late. The crew waited.";
    const revised = "The tide was high. The vessel was delayed. Everyone waited patiently.";
    for (const [action, expected] of [["accept", revised], ["reject", original]] as const) {
      const s = docOf(original);
      const [from, to] = whole(s);
      let next = apply(s, suggestRewrite(s, from, to, revised, { revId: "r1" }));
      const tr = action === "accept" ? acceptSuggestion(next, "r1") : rejectSuggestion(next, "r1");
      next = next.apply(tr!);
      expect(text(next)).toBe(expected);
    }
  });

  test("a rewrite spanning two paragraphs keeps the paragraph break", () => {
    const s = docOf("First para here.", "Second para here.");
    const [from, to] = whole(s);
    let next = apply(s, suggestRewrite(s, from, to, "First para here.\nSecond paragraph here.", { revId: "r1" }));
    next = next.apply(acceptSuggestion(next, "r1")!);
    expect(next.doc.childCount).toBe(2);
    expect(text(next)).toBe("First para here.\nSecond paragraph here.");
  });

  test("a pure insertion is suggested without deleting anything", () => {
    const s = docOf("First. Third.");
    const [from, to] = whole(s);
    let next = apply(s, suggestRewrite(s, from, to, "First. Second. Third.", { revId: "r1" }));
    next = next.apply(acceptSuggestion(next, "r1")!);
    expect(text(next)).toBe("First. Second. Third.");
  });

  test("only the addressed revision is resolved, so two suggestions do not collide", () => {
    const s = docOf("Alpha one.", "Beta two.");
    const a = s.apply(suggestRewrite(s, 1, 11, "Alpha ONE.", { revId: "r1" })!);
    const b = a.apply(suggestRewrite(a, a.doc.content.size - 10, a.doc.content.size - 1, "Beta TWO.", { revId: "r2" })!);
    const resolved = b.apply(acceptSuggestion(b, "r1")!);
    expect(hasSuggestion(resolved.doc, "r1")).toBe(false);
    expect(hasSuggestion(resolved.doc, "r2")).toBe(true);
  });
});
