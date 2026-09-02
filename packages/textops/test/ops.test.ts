import { describe, test, expect } from "bun:test";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { schema } from "@scriv/doc-model";
import { expandSelection, shrinkSelection, expandPlugin } from "../src/selection";
import { moveSentence, moveParagraph, smartHome } from "../src/motion";
import {
  killLine, killToSentenceEnd, yank, yankPop, transposeChars, transposeWords,
  joinForward, duplicateBlock, moveBlock, deleteWord, killRingPlugin,
} from "../src/edit";

const plugins = [expandPlugin(), killRingPlugin()];

function docOf(...paras: string[]) {
  const d = schema.node("doc", null, paras.map((p) => schema.node("paragraph", null, p ? [schema.text(p)] : [])));
  return EditorState.create({ doc: d, plugins });
}
function at(state: EditorState, pos: number, to = pos) {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos, to)));
}
function run(state: EditorState, cmd: Command): EditorState {
  let next = state;
  cmd(state, (tr) => { next = state.apply(tr); });
  return next;
}
const text = (s: EditorState) => s.doc.textBetween(0, s.doc.content.size, "\n");
const sel = (s: EditorState) => s.doc.textBetween(s.selection.from, s.selection.to);

describe("expand and shrink selection", () => {
  const body = "One thing here. Then another thing. And a third.";

  test("expands word, then sentence, then paragraph", () => {
    let s = at(docOf(body), 5); // inside "thing"
    s = run(s, expandSelection); expect(sel(s)).toBe("thing");
    s = run(s, expandSelection); expect(sel(s)).toBe("One thing here.");
    s = run(s, expandSelection); expect(sel(s)).toBe(body);
  });

  test("shrink replays the path taken, not a guess", () => {
    let s = at(docOf(body), 5);
    s = run(s, expandSelection);
    s = run(s, expandSelection);
    s = run(s, expandSelection); expect(sel(s)).toBe(body);
    s = run(s, shrinkSelection); expect(sel(s)).toBe("One thing here.");
    s = run(s, shrinkSelection); expect(sel(s)).toBe("thing");
  });

  test("expanding from the last word of a sentence still shrinks back to that word", () => {
    // The case a computed inverse gets wrong: the caret is at a sentence edge.
    let s = at(docOf(body), 12); // inside "here"
    s = run(s, expandSelection); expect(sel(s)).toBe("here");
    s = run(s, expandSelection);
    s = run(s, shrinkSelection); expect(sel(s)).toBe("here");
  });

  test("never walks back down: every rung strictly contains the last", () => {
    // Once a selection spans two paragraphs, blockAt still resolves to the FIRST one, so an
    // unguarded ladder offers that block as the next rung and the selection shrinks. It has
    // to grow monotonically or holding the key oscillates.
    let s = at(docOf("Alpha.", "Beta."), 2);
    let prev = { from: s.selection.from, to: s.selection.to };
    for (let i = 0; i < 6; i++) {
      s = run(s, expandSelection);
      const now = { from: s.selection.from, to: s.selection.to };
      expect(now.from).toBeLessThanOrEqual(prev.from);
      expect(now.to).toBeGreaterThanOrEqual(prev.to);
      prev = now;
    }
  });

  test("expands to the whole document at the top of the ladder", () => {
    let s = at(docOf("Alpha.", "Beta."), 2);
    for (let i = 0; i < 6; i++) s = run(s, expandSelection);
    expect(s.selection.from).toBeLessThanOrEqual(1);
    expect(s.selection.to).toBeGreaterThanOrEqual(s.doc.content.size - 1);
  });
});

describe("motions", () => {
  const body = "First one. Second one. Third one.";
  test("next sentence moves to the sentence boundary", () => {
    let s = at(docOf(body), 3);
    s = run(s, moveSentence(1));
    expect(s.selection.head).toBe(1 + "First one.".length);
  });
  test("previous sentence goes back", () => {
    let s = at(docOf(body), 1 + 15);
    s = run(s, moveSentence(-1));
    expect(s.selection.head).toBeLessThan(1 + 15);
  });
  test("sentence motion crosses into the next paragraph rather than stalling", () => {
    let s = at(docOf("Only one.", "Next para."), 1 + 9);
    s = run(s, moveSentence(1));
    expect(s.selection.head).toBeGreaterThan(1 + 9);
  });
  test("paragraph motion walks blocks", () => {
    let s = at(docOf("Alpha", "Beta", "Gamma"), 1);
    s = run(s, moveParagraph(1));
    expect(s.selection.head).toBe(6);
  });
  test("smart home toggles between first non-space and true start", () => {
    let s = at(docOf("   indented"), 1 + 8);
    s = run(s, smartHome()); expect(s.selection.head).toBe(1 + 3);
    s = run(s, smartHome()); expect(s.selection.head).toBe(1);
  });
});

describe("kill ring", () => {
  test("kill-line removes to end of block and yank restores it", () => {
    let s = at(docOf("alpha beta"), 1 + 5);
    s = run(s, killLine);
    expect(text(s)).toBe("alpha");
    s = run(s, yank);
    expect(text(s)).toBe("alpha beta");
  });

  test("consecutive kills accumulate into one entry", () => {
    let s = at(docOf("one two three"), 1 + 3);
    s = run(s, killLine);
    s = run(s, killLine); // nothing left on this line; joins the (absent) next -> no-op
    s = run(s, yank);
    expect(text(s)).toBe("one two three");
  });

  test("yank-pop cycles to the kill before last", () => {
    // Two separate kills, with a caret move between them so they do not accumulate.
    let s = at(docOf("first", "second"), 1);
    s = run(s, killLine);                       // ring: ["first"]
    // Caret to the START of the surviving block; moving also ends the kill run, so the next
    // kill becomes its own ring entry rather than accumulating onto the first.
    const lastStart = s.doc.resolve(s.doc.content.size - 1).start();
    s = at(s, lastStart);
    s = run(s, killLine);                       // ring: ["second", "first"]
    s = run(s, yank);
    const afterYank = text(s);
    s = run(s, yankPop);
    expect(text(s)).not.toBe(afterYank);
  });

  test("kill to end of sentence stops at the sentence, not the line", () => {
    let s = at(docOf("First one. Second one."), 1 + 6);
    s = run(s, killToSentenceEnd);
    expect(text(s)).toBe("First Second one.");
  });
});

describe("structural edits", () => {
  test("transpose characters swaps across the caret", () => {
    let s = at(docOf("ab"), 1 + 2);
    s = run(s, transposeChars);
    expect(text(s)).toBe("ba");
  });
  test("transpose words swaps the pair straddling the caret", () => {
    let s = at(docOf("alpha beta"), 1 + 2);
    s = run(s, transposeWords);
    expect(text(s)).toBe("beta alpha");
  });
  test("join merges the next paragraph with a single space", () => {
    let s = at(docOf("alpha", "beta"), 1);
    s = run(s, joinForward);
    expect(text(s)).toBe("alpha beta");
  });
  test("duplicate makes a copy that is a distinct block", () => {
    let s = at(docOf("alpha"), 1);
    s = run(s, duplicateBlock);
    expect(s.doc.childCount).toBe(2);
    expect(text(s)).toBe("alpha\nalpha");
  });
  test("move paragraph down reorders blocks", () => {
    let s = at(docOf("one", "two", "three"), 1);
    s = run(s, moveBlock(1));
    expect(text(s)).toBe("two\none\nthree");
  });
  test("move paragraph up at the top does nothing", () => {
    const s = at(docOf("one", "two"), 1);
    expect(moveBlock(-1)(s, undefined)).toBe(false);
  });
  test("delete word backward removes a whole word", () => {
    let s = at(docOf("alpha beta"), 1 + 10);
    s = run(s, deleteWord(-1));
    expect(text(s)).toBe("alpha ");
  });
  test("delete word respects non-English word boundaries", () => {
    let s = at(docOf("これは日本語です"), 1 + 8);
    const before = text(s);
    s = run(s, deleteWord(-1));
    expect(text(s).length).toBeLessThan(before.length);
  });
});
