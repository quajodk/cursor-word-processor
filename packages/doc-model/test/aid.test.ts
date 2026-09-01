import { test, expect } from "bun:test";
import { EditorState } from "prosemirror-state";
import { schema, aidPlugin, aidIndex, repairAids } from "../src/index";

function mkState(...paras: string[]) {
  const doc = schema.node("doc", null, paras.map((p) => schema.node("paragraph", null, p ? [schema.text(p)] : [])));
  return EditorState.create({ doc, plugins: [aidPlugin()] });
}
/** Apply a transaction and let appendTransaction run, as the real editor would. */
function apply(state: EditorState, f: (tr: ReturnType<EditorState["tr"]["setMeta"]> extends never ? never : any) => any) {
  const tr = state.tr; f(tr); return state.apply(tr);
}

test("assigns an aid to every block", () => {
  let s = mkState("alpha", "beta");
  const r = repairAids(s)!;
  s = s.apply(r.tr);
  const ids = [...aidIndex(s.doc).keys()];
  expect(ids.length).toBe(2);
  expect(new Set(ids).size).toBe(2);
});

test("typing does not change any aid, and costs no rescan", () => {
  let s = mkState("alpha", "beta");
  s = s.apply(repairAids(s)!.tr);
  const before = [...aidIndex(s.doc).keys()];
  s = apply(s, (tr: any) => tr.insertText("X", 3));
  const after = [...aidIndex(s.doc).keys()];
  expect(after).toEqual(before);
});

test("splitting a paragraph keeps identity on the first half and mints a new one for the second", () => {
  let s = mkState("alphabeta");
  s = s.apply(repairAids(s)!.tr);
  const original = [...aidIndex(s.doc).keys()][0]!;
  s = apply(s, (tr: any) => tr.split(6));
  const ids = [...aidIndex(s.doc).keys()];
  expect(ids.length).toBe(2);
  expect(ids[0]).toBe(original);          // first half keeps the anchor
  expect(ids[1]).not.toBe(original);      // second half is new
});

test("pasting a duplicated block does not produce duplicate identities", () => {
  let s = mkState("alpha");
  s = s.apply(repairAids(s)!.tr);
  const original = [...aidIndex(s.doc).keys()][0]!;
  const copy = schema.node("paragraph", { aid: original }, [schema.text("alpha")]);
  s = apply(s, (tr: any) => tr.insert(s.doc.content.size, copy));
  const ids = [...aidIndex(s.doc).keys()];
  expect(ids.length).toBe(2);
  expect(new Set(ids).size).toBe(2);
  expect(ids[0]).toBe(original);
});

test("deleting a block leaves the others untouched", () => {
  let s = mkState("alpha", "beta", "gamma");
  s = s.apply(repairAids(s)!.tr);
  const before = [...aidIndex(s.doc).keys()];
  s = apply(s, (tr: any) => tr.delete(0, 7));
  const after = [...aidIndex(s.doc).keys()];
  expect(after).toEqual(before.slice(1));
});
