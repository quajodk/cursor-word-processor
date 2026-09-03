import { describe, test, expect } from "bun:test";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { schema } from "@scriv/doc-model";
import {
  addNextOccurrence, allRanges, clearCursors, cursorCount, forEachCursor,
  multiCursorKey, multiCursorPlugin, selectAllOccurrences,
} from "../src/multicursor";
import { deleteWord } from "../src/edit";

function docOf(...paras: string[]) {
  return EditorState.create({
    doc: schema.node("doc", null, paras.map((p) => schema.node("paragraph", null, p ? [schema.text(p)] : []))),
    plugins: [multiCursorPlugin()],
  });
}
const at = (s: EditorState, a: number, b = a) =>
  s.apply(s.tr.setSelection(TextSelection.create(s.doc, a, b)));
const run = (s: EditorState, cmd: Command): EditorState => {
  let next = s;
  cmd(s, (tr) => { next = s.apply(tr); });
  return next;
};
const text = (s: EditorState) => s.doc.textBetween(0, s.doc.content.size, "\n");
const selText = (s: EditorState) => s.doc.textBetween(s.selection.from, s.selection.to);

describe("multiple cursors", () => {
  test("Cmd-D on an empty selection selects the word first", () => {
    let s = at(docOf("alpha beta gamma"), 8); // inside "beta"
    s = run(s, addNextOccurrence);
    expect(selText(s)).toBe("beta");
    expect(cursorCount(s)).toBe(1);
  });

  test("Cmd-D again adds the next occurrence as a second cursor", () => {
    let s = at(docOf("beta and beta and beta"), 1, 5); // "beta"
    expect(selText(s)).toBe("beta");
    s = run(s, addNextOccurrence);
    expect(cursorCount(s)).toBe(2);
    s = run(s, addNextOccurrence);
    expect(cursorCount(s)).toBe(3);
  });

  test("it does not add the same occurrence twice", () => {
    let s = at(docOf("beta and beta"), 1, 5);
    s = run(s, addNextOccurrence);
    const before = cursorCount(s);
    s = run(s, addNextOccurrence); // wraps, finds only the primary again
    expect(cursorCount(s)).toBe(before);
  });

  test("select all occurrences finds every one at once", () => {
    let s = at(docOf("one two one three one"), 1, 4); // "one"
    s = run(s, selectAllOccurrences);
    expect(cursorCount(s)).toBe(3);
  });

  test("occurrences are found across block boundaries", () => {
    let s = at(docOf("alpha here", "alpha there"), 1, 6); // "alpha"
    s = run(s, selectAllOccurrences);
    expect(cursorCount(s)).toBe(2);
    const ranges = allRanges(s);
    // The second must be in the second paragraph, not a mis-mapped position.
    expect(s.doc.textBetween(ranges[1]!.from, ranges[1]!.to)).toBe("alpha");
  });

  test("Escape collapses back to one cursor", () => {
    let s = at(docOf("beta and beta"), 1, 5);
    s = run(s, addNextOccurrence);
    expect(cursorCount(s)).toBe(2);
    s = run(s, clearCursors);
    expect(cursorCount(s)).toBe(1);
  });

  test("cursors survive an edit elsewhere in the document", () => {
    let s = at(docOf("beta and beta"), 1, 5);
    s = run(s, addNextOccurrence);
    const before = allRanges(s).map((r) => s.doc.textBetween(r.from, r.to));
    // Insert text BEFORE both cursors; they must still point at the same words.
    s = s.apply(s.tr.insertText("XX ", 1));
    const after = allRanges(s).map((r) => s.doc.textBetween(r.from, r.to));
    expect(after).toEqual(before);
  });

  test("a command wrapped in forEachCursor runs at every cursor", () => {
    let s = at(docOf("alpha beta alpha beta"), 1, 6); // "alpha"
    s = run(s, selectAllOccurrences);
    expect(cursorCount(s)).toBe(2);
    // Delete the word backward from the end of each occurrence.
    s = run(s, forEachCursor((st, dispatch) => {
      if (dispatch) dispatch(st.tr.insertText("X", st.selection.from, st.selection.to));
      return true;
    }));
    expect(text(s)).toBe("X beta X beta");
  });

  test("a multi-cursor edit is one undo step", () => {
    let s = at(docOf("alpha beta alpha"), 1, 6);
    s = run(s, selectAllOccurrences);
    let steps = 0;
    const wrapped = forEachCursor((st, dispatch) => {
      if (dispatch) dispatch(st.tr.insertText("X", st.selection.from, st.selection.to));
      return true;
    });
    wrapped(s, (tr) => { steps = tr.steps.length; });
    // Several steps, but they arrive in ONE transaction, which is what history groups on.
    expect(steps).toBeGreaterThan(1);
  });

  test("forEachCursor falls through to the plain command with a single cursor", () => {
    const s = at(docOf("alpha beta"), 11);
    const out = run(s, forEachCursor(deleteWord(-1)));
    expect(text(out)).toBe("alpha ");
  });

  test("a plain click collapses the cursors", () => {
    let s = at(docOf("beta and beta"), 1, 5);
    s = run(s, addNextOccurrence);
    expect(cursorCount(s)).toBe(2);
    // A selection change with no keep-flag is a click.
    s = at(s, 3);
    expect(cursorCount(s)).toBe(1);
  });
});
