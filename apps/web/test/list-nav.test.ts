import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { listAction } from "../src/app/list-nav";

/**
 * The list dialect, checked as a table, plus the check that every list actually speaks it.
 *
 * This is the gap `bindings.test.ts` names and cannot close: it audits the command registry for
 * collisions, and the five list panels navigate with local handlers that are deliberately not
 * commands — so nothing in the repo could see them, and nothing noticed when the palette,
 * comments and the tree ended up with three different words for "move down". A pure decision
 * function can be tested directly; that the panels import it can be checked in the same way
 * `bindings.test.ts` checks `defaults.ts`, by reading the source.
 */

function repoRoot(): string {
  let d = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "bun.lock"))) return d;
    d = dirname(d);
  }
  return d;
}

const read = (rel: string) => readFileSync(join(repoRoot(), rel), "utf8");

describe("the list dialect", () => {
  const three = { index: 0, count: 3 };

  test("arrows and Ctrl-n/Ctrl-p are the same movement", () => {
    expect(listAction({ key: "ArrowDown" }, three)).toEqual({ kind: "move", to: 1 });
    expect(listAction({ key: "n", ctrlKey: true }, three)).toEqual({ kind: "move", to: 1 });
    expect(listAction({ key: "ArrowUp" }, { index: 2, count: 3 })).toEqual({ kind: "move", to: 1 });
    expect(listAction({ key: "p", ctrlKey: true }, { index: 2, count: 3 })).toEqual({ kind: "move", to: 1 });
  });

  test("movement clamps rather than wrapping", () => {
    expect(listAction({ key: "ArrowDown" }, { index: 2, count: 3 })).toEqual({ kind: "move", to: 2 });
    expect(listAction({ key: "ArrowUp" }, { index: 0, count: 3 })).toEqual({ kind: "move", to: 0 });
  });

  test("a list with no active item yet enters from the end you came from", () => {
    expect(listAction({ key: "ArrowDown" }, { index: -1, count: 3 })).toEqual({ kind: "move", to: 0 });
    expect(listAction({ key: "ArrowUp" }, { index: -1, count: 3 })).toEqual({ kind: "move", to: 2 });
  });

  test("Home and End are left to the query field", () => {
    // Same reason as j/k: two of the five lists are navigated while the caret is in a text
    // field, and in a text field those two keys are the field's.
    expect(listAction({ key: "Home" }, { index: 2, count: 3 })).toBeNull();
    expect(listAction({ key: "End" }, three)).toBeNull();
  });

  test("Enter activates and Escape dismisses", () => {
    expect(listAction({ key: "Enter" }, three)).toEqual({ kind: "activate" });
    expect(listAction({ key: "Escape" }, three)).toEqual({ kind: "dismiss" });
  });

  test("Escape is offered even when there is nothing to move through", () => {
    // The palette's one-line input mode declares a list of length zero and still has to cancel.
    expect(listAction({ key: "Escape" }, { index: 0, count: 0 })).toEqual({ kind: "dismiss" });
    expect(listAction({ key: "ArrowDown" }, { index: 0, count: 0 })).toBeNull();
  });

  test("j and k are not the dialect", () => {
    // Deliberate: two of the five lists are navigated while the caret is in their query field,
    // where `j` has to mean the letter `j`. If this ever passes, the comments pane has quietly
    // reintroduced a dialect only it speaks.
    expect(listAction({ key: "j" }, three)).toBeNull();
    expect(listAction({ key: "k" }, three)).toBeNull();
  });

  test("a list does not swallow the app's own chords", () => {
    // ⌘S has to keep saving while the file tree has focus, and Alt-arrow belongs to whatever
    // else claims it. A list that claims every key it is handed is how a binding silently dies.
    expect(listAction({ key: "n", ctrlKey: true, metaKey: true }, three)).toBeNull();
    expect(listAction({ key: "ArrowDown", altKey: true }, three)).toBeNull();
    expect(listAction({ key: "Enter", shiftKey: true }, three)).toBeNull();
    expect(listAction({ key: "a" }, three)).toBeNull();
  });
});

describe("every list panel speaks it", () => {
  const panels = [
    "apps/web/src/app/Palette.tsx",
    "apps/web/src/app/FileTree.tsx",
    "apps/web/src/app/CommentsPane.tsx",
    "apps/web/src/app/SearchPane.tsx",
    "apps/web/src/app/AgentPane.tsx",
  ];

  for (const panel of panels) {
    test(`${panel.split("/").pop()} imports the dialect`, () => {
      expect(read(panel)).toContain('from "./list-nav"');
    });
  }

  test("no panel re-implements movement locally", () => {
    // The shape that made this a finding: a `switch (event.key)` with its own ArrowDown case.
    for (const panel of panels) {
      const source = read(panel);
      expect(source).not.toContain('case "ArrowDown"');
      expect(source).not.toContain('case "ArrowUp"');
    }
  });
});

describe("the panel contract", () => {
  const panels = [
    "apps/web/src/app/AgentPane.tsx",
    "apps/web/src/app/FidelityPane.tsx",
    "apps/web/src/app/DiffPane.tsx",
  ];

  test("all three panels in the main column are built from Panel", () => {
    for (const panel of panels) {
      expect(read(panel)).toContain('from "./Panel"');
      // Its own `<section role="dialog">` is what having three focus policies looked like.
      expect(read(panel)).not.toContain('role="dialog"');
    }
  });

  test("there is one word for close, and it is not a key name", () => {
    const shell = read("apps/web/src/app/Panel.tsx");
    expect(shell).toContain('className="panel-close"');
    expect(shell).toMatch(/>\s*Close\s*<\/button>/);
    // `esc` on a button was a second word for the same act that also documented a key which,
    // at the time, did not work.
    for (const panel of panels) expect(read(panel)).not.toContain(">esc<");
  });

  test("the panel is focusable, so its own Escape handler can fire", () => {
    const source = read("apps/web/src/app/Panel.tsx");
    expect(source).toContain("tabIndex={-1}");
    expect(source).toContain("ref.current?.focus()");
    expect(source).toContain('event.key !== "Escape"');
  });
});

describe("an address is somewhere you can go", () => {
  test("the three panels that print an address import the verb", () => {
    expect(read("apps/web/src/app/SearchPane.tsx")).toContain("revealSource");
    expect(read("apps/web/src/app/AgentPane.tsx")).toContain("revealSource");
    expect(read("apps/web/src/app/FidelityPane.tsx")).toContain("revealBlock");
  });
});

describe("the changes pane explains every dead end it can reach", () => {
  test("including the one where git meets a binary codec", () => {
    const source = read("apps/web/src/app/DiffPane.tsx");
    for (const explanation of [
      "not a git repository",
      "not yet tracked by git",
      "No changes against HEAD",
      "bytes rather ",
    ]) {
      expect(source).toContain(explanation);
    }
  });
});
