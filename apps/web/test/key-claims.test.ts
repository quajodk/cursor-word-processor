import { describe, test, expect, beforeEach } from "bun:test";
import {
  claimEditorKeys, editorKeyClaim, installKeyboard, registerCommand, setContextProvider,
  type CommandContext,
} from "../src/commands/registry";

/**
 * The arbitration between the global dispatcher and the surfaces inside the editor.
 *
 * There are two keyboard systems in this app and only one of them can win by default. The
 * command registry listens on `window` in the CAPTURE phase; ProseMirror's `handleKeyDown`
 * props run on the contenteditable during BUBBLING. Capture-on-window beats every handler in
 * the document, so any key that exists in both systems belongs to the registry and the
 * plugin's handler for it is dead code.
 *
 * It was dead code, four times over, and nothing failed. A coherence audit driving the real
 * app found it: with the completion popup open, `ArrowDown` reached ProseMirror and moved the
 * selection, while `Escape` did not and THE POPUP COULD NOT BE DISMISSED — `cursor.clear` from
 * the text-op binding table had the key. `inline-edit.ts` had the same problem for rejecting a
 * pending AI edit, and carried a second, complete, never-executed implementation of ⌘K whose
 * comment claimed it "beats the command keymap deterministically".
 *
 * None of that is visible to a test that checks bindings as a table — `bindings.test.ts`
 * catches two commands on one chord, which this is not. It is one command and one plugin, in
 * two different event phases, and the only way to catch it is to run the dispatcher.
 *
 * So these tests run the real `installKeyboard` against a fake window and assert the one thing
 * that matters: a key a surface has claimed is LEFT ALONE, so it can go on to bubble into the
 * editor, and an unclaimed key is still consumed exactly as before.
 */

/** `inTextField` does `target instanceof HTMLElement`, and bun has no DOM. */
class FakeElement {
  tagName = "DIV";
  isContentEditable = false;
  closest(): null { return null; }
}
(globalThis as Record<string, unknown>).HTMLElement = FakeElement;

interface FakeWindow {
  listener: ((e: KeyboardEvent) => void) | null;
  addEventListener(type: string, fn: (e: KeyboardEvent) => void): void;
  removeEventListener(type: string, fn: (e: KeyboardEvent) => void): void;
}

function fakeWindow(): FakeWindow {
  return {
    listener: null,
    addEventListener(_t, fn) { this.listener = fn; },
    removeEventListener() { this.listener = null; },
  };
}

/** Only the properties the dispatcher actually reads. */
function keyEvent(key: string, mods: { meta?: boolean; shift?: boolean } = {}) {
  let prevented = false;
  return {
    key,
    metaKey: mods.meta ?? false,
    ctrlKey: false,
    altKey: false,
    shiftKey: mods.shift ?? false,
    target: new FakeElement(),
    get defaultPrevented() { return prevented; },
    preventDefault() { prevented = true; },
    stopPropagation() { /* recorded via defaultPrevented */ },
  } as unknown as KeyboardEvent;
}

const ctx = {
  host: {}, view: null, filePath: null, root: "/",
  ui: { notify() { /* errors would surface here */ } },
} as unknown as CommandContext;

describe("an in-editor surface can claim a key from the global dispatcher", () => {
  let win: FakeWindow;
  let ran: string[];
  const disposers: Array<() => void> = [];

  beforeEach(() => {
    while (disposers.length) disposers.pop()!();
    win = fakeWindow();
    ran = [];
    setContextProvider(() => ctx);
    disposers.push(registerCommand({
      id: "test.clearCursors",
      title: "Collapse to one cursor",
      keybinding: "Escape",
      run: () => { ran.push("command"); },
    }));
    disposers.push(installKeyboard(win as unknown as Window));
  });

  test("with nothing claiming it, the dispatcher takes the key", () => {
    const e = keyEvent("Escape");
    win.listener!(e);
    expect(ran).toEqual(["command"]);
    // Consumed, so it never reaches the editor — the behaviour that killed four handlers.
    expect(e.defaultPrevented).toBe(true);
  });

  test("a claimed key is left entirely alone, so it can bubble to the editor", () => {
    disposers.push(claimEditorKeys("completion", (ev) => ev.key === "Escape"));
    const e = keyEvent("Escape");
    win.listener!(e);
    expect(ran).toEqual([]);
    // NOT preventDefault'd. This is the whole fix: the event has to survive to bubble.
    expect(e.defaultPrevented).toBe(false);
  });

  test("the claim is scoped to the keys it names", () => {
    disposers.push(claimEditorKeys("completion", (ev) => ev.key === "ArrowDown"));
    const e = keyEvent("Escape");
    win.listener!(e);
    expect(ran).toEqual(["command"]);
  });

  test("releasing the claim hands the key straight back", () => {
    const release = claimEditorKeys("inline-edit", (ev) => ev.key === "Escape");
    win.listener!(keyEvent("Escape"));
    expect(ran).toEqual([]);
    release();
    win.listener!(keyEvent("Escape"));
    expect(ran).toEqual(["command"]);
  });

  test("a claim that throws does not swallow every key in the app", () => {
    // A surface with a bug in its predicate would otherwise make the whole keyboard dead.
    disposers.push(claimEditorKeys("broken", () => { throw new Error("bad claim"); }));
    const e = keyEvent("Escape");
    win.listener!(e);
    expect(ran).toEqual(["command"]);
    expect(e.defaultPrevented).toBe(true);
  });

  test("re-registering an id replaces its claim rather than stacking another", () => {
    disposers.push(claimEditorKeys("completion", (ev) => ev.key === "Escape"));
    disposers.push(claimEditorKeys("completion", (ev) => ev.key === "ArrowUp"));
    expect(editorKeyClaim(keyEvent("Escape"))).toBeNull();
    expect(editorKeyClaim(keyEvent("ArrowUp"))).toBe("completion");
  });
});
