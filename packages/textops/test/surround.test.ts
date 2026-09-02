import { describe, test, expect } from "bun:test";
import { EditorState, TextSelection } from "prosemirror-state";
import { schema } from "@scriv/doc-model";
import { handleSurround } from "../src/surround";

/** A document of one paragraph, with a selection from `a` to `b` in character offsets. */
function doc(text: string, a?: number, b?: number) {
  const d = schema.node("doc", null, [schema.node("paragraph", null, text ? [schema.text(text)] : [])]);
  let state = EditorState.create({ doc: d });
  if (a !== undefined) {
    const from = 1 + a, to = 1 + (b ?? a);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  }
  return state;
}
const apply = (state: EditorState, ch = '"', locale = "en") => {
  const { from, to } = state.selection;
  const tr = handleSurround(state, from, to, ch, { locale });
  return tr ? state.apply(tr) : null;
};
const textOf = (s: EditorState) => s.doc.textBetween(0, s.doc.content.size, "\n");

describe("selection-aware surrounds", () => {
  test("a double quote wraps the selection instead of replacing it", () => {
    const out = apply(doc("say hello there", 4, 9))!;
    expect(textOf(out)).toBe("say “hello” there");
  });

  test("wrapping keeps the inner text selected so surrounds nest", () => {
    let s = apply(doc("say hello there", 4, 9))!;
    expect(s.doc.textBetween(s.selection.from, s.selection.to)).toBe("hello");
    s = apply(s, "(")!;
    expect(textOf(s)).toBe("say “(hello)” there");
  });

  test("a quote inside a quotation uses the nested form", () => {
    const out = apply(doc("“he said no to that”", 9, 11))!;
    expect(textOf(out)).toBe("“he said ‘no’ to that”");
  });

  test("brackets wrap", () => {
    expect(textOf(apply(doc("alpha beta", 6, 10), "(")!)).toBe("alpha (beta)");
  });

  test("asterisk applies emphasis as a mark, not a literal character", () => {
    const out = apply(doc("make this bold", 5, 9), "*")!;
    expect(textOf(out)).toBe("make this bold");
    expect(out.doc.rangeHasMark(6, 10, schema.marks.em!)).toBe(true);
  });

  test("asterisk on already-emphasised text removes the emphasis", () => {
    let s = apply(doc("make this bold", 5, 9), "*")!;
    s = apply(s, "*")!;
    expect(s.doc.rangeHasMark(6, 10, schema.marks.em!)).toBe(false);
  });

  test("locale-aware: German uses low-high quotes", () => {
    expect(textOf(apply(doc("sag hallo dort", 4, 9), '"', "de")!)).toBe("sag „hallo“ dort");
  });

  test("with no selection an opener auto-closes", () => {
    const out = apply(doc("alpha ", 6), "(")!;
    expect(textOf(out)).toBe("alpha ()");
    expect(out.selection.from).toBe(8);
  });

  test("typing a closer over an existing one moves past it rather than doubling", () => {
    const s = doc("alpha ()", 7);
    const out = apply(s, ")")!;
    expect(textOf(out)).toBe("alpha ()");
    expect(out.selection.from).toBe(9);
  });

  test("an apostrophe inside a word is a contraction, not an opening quote", () => {
    const out = apply(doc("don", 3), "'")!;
    expect(textOf(out)).toBe("don’");
  });

  test("does not surround inside a code block", () => {
    const d = schema.node("doc", null, [schema.node("code_block", null, [schema.text("let x = 1")])]);
    let s = EditorState.create({ doc: d });
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 5, 6)));
    expect(handleSurround(s, s.selection.from, s.selection.to, '"')).toBeNull();
  });

  test("wraps a selection that spans a mark boundary", () => {
    const d = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("plain "),
        schema.text("bold", [schema.marks.strong!.create()]),
        schema.text(" tail"),
      ]),
    ]);
    let s = EditorState.create({ doc: d });
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1, 11)));
    const out = apply(s, '"')!;
    expect(textOf(out)).toBe("“plain bold” tail");
  });
});
