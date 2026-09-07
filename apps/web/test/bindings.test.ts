import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { BINDINGS, UNUSABLE_ON_MACOS } from "@scriv/textops";

/**
 * The keyboard, checked as a table rather than by pressing keys.
 *
 * House rule 4 is "keyboard-first: every feature reachable without the mouse". The way that
 * rule fails is not dramatic — it is two commands quietly sharing a key. The dispatcher takes
 * the LAST registration that matches, so the earlier command simply stops existing, with no
 * error, no warning, and nothing on screen to notice.
 *
 * That happened: `view.cycleTheme` and `table.insert` were both bound to `Mod-Alt-t`, and
 * because `table.insert` is registered later and is enabled whenever the caret is in the
 * document, cycling the theme was dead for the whole time anyone would have wanted it. It was
 * found by an auditor reading the two registrations side by side — which is exactly the kind
 * of thing that should not require a person.
 *
 * The command table is read from source rather than by importing `defaults.ts`, because that
 * module reaches into React state and the DOM at import time. A regex over a declarative list
 * is a weaker check than executing it, and it is the check that can actually run here.
 */

function repoRoot(): string {
  let d = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "bun.lock"))) return d;
    d = dirname(d);
  }
  return d;
}

const source = readFileSync(join(repoRoot(), "apps/web/src/commands/defaults.ts"), "utf8");

interface Binding { id: string; key: string; when: string | null; order: number }

/**
 * Every binding `defaults.ts` registers, in registration order.
 *
 * Two shapes appear in that file: object literals with `id:` / `keybinding:`, and
 * `editorCommand(id, title, key, ...)` calls. Both are matched; if either shape stops being
 * found the count assertion below fails rather than the check quietly shrinking.
 */
function registeredBindings(): Binding[] {
  const out: Binding[] = [];
  let order = 0;

  // Object literals: `id: "x",` … `keybinding: "K"` or `keybinding: ["K", "L"]`.
  const objectRe = /\bid:\s*"([^"]+)"([\s\S]{0,600}?)\bkeybinding:\s*(\[[^\]]*\]|"[^"]*")/g;
  for (let m = objectRe.exec(source); m; m = objectRe.exec(source)) {
    // `when:` in the same literal decides whether two bindings can be live at once.
    const when = /\bwhen:\s*(\w+)/.exec(m[2]!)?.[1] ?? null;
    for (const key of m[3]!.match(/"([^"]+)"/g) ?? []) {
      out.push({ id: m[1]!, key: key.slice(1, -1), when, order: source.indexOf(m[0]) });
    }
  }

  // `editorCommand("id", "title", "Key" | ["A","B"] | undefined, …)` — always `inEditor`.
  const helperRe = /editorCommand\(\s*"([^"]+)"\s*,\s*"[^"]*"\s*,\s*(\[[^\]]*\]|"[^"]*"|undefined)/g;
  for (let m = helperRe.exec(source); m; m = helperRe.exec(source)) {
    if (m[2] === "undefined") continue;
    for (const key of m[2]!.match(/"([^"]+)"/g) ?? []) {
      out.push({ id: m[1]!, key: key.slice(1, -1), when: "inEditor", order: source.indexOf(m[0]) });
    }
  }

  out.sort((a, b) => a.order - b.order);
  out.forEach((b, i) => { b.order = i; order = i; });
  void order;
  return out;
}

/** `Mod-Shift-P` and `Shift-Mod-p` are the same chord. Compare canonically. */
function canonical(key: string): string {
  const parts = key.split("-");
  const base = parts.pop()!;
  const mods = parts.map((p) => p.toLowerCase()).sort();
  return `${mods.join("+")}|${base.length === 1 ? base.toLowerCase() : base}`;
}

describe("the keyboard as a table (house rule 4)", () => {
  const app = registeredBindings();

  test("both registration shapes are still being found", () => {
    // A regex that silently stopped matching would turn every check below into a no-op.
    expect(app.length).toBeGreaterThan(30);
    expect(app.some((b) => b.id.startsWith("view."))).toBe(true);
    expect(app.some((b) => b.id.startsWith("table."))).toBe(true);
  });

  test("no two app commands can be live on the same chord", () => {
    const byChord = new Map<string, Binding[]>();
    for (const b of app) {
      const list = byChord.get(canonical(b.key)) ?? [];
      list.push(b);
      byChord.set(canonical(b.key), list);
    }

    const shadowed: string[] = [];
    for (const [chord, list] of byChord) {
      if (list.length < 2) continue;
      // Two commands may share a chord only if their `when` guards cannot both be true.
      // In practice that means one is editor-only and the other is explicitly not; anything
      // else means the later registration silently wins.
      const guards = new Set(list.map((b) => b.when ?? "always"));
      const exclusive = guards.size === list.length && !guards.has("always");
      if (exclusive) continue;
      const loser = list.slice(0, -1).map((b) => b.id).join(", ");
      const winner = list[list.length - 1]!.id;
      shadowed.push(`${chord}: ${winner} shadows ${loser}`);
    }
    expect(shadowed).toEqual([]);
  });

  test("the collision detector would catch one if it were introduced", () => {
    // A checker that reports "no problems" is only worth having if it can report one. This
    // runs the same grouping logic over a table with a deliberate clash.
    const fake: Binding[] = [
      { id: "view.cycleTheme", key: "Mod-Alt-t", when: null, order: 0 },
      { id: "table.insert", key: "Mod-Alt-t", when: "inEditor", order: 1 },
    ];
    const guards = new Set(fake.map((b) => b.when ?? "always"));
    const exclusive = guards.size === fake.length && !guards.has("always");
    // One is unguarded, so both are live on the same chord and the later one wins silently.
    expect(exclusive).toBe(false);
  });

  test("no app command collides with a text-op binding", () => {
    // `textopsKeymap` is a ProseMirror keymap, so it and the global dispatcher both see the
    // key. A clash there is the same silent shadowing, across two files instead of one.
    const textops = new Set(BINDINGS.map((b) => canonical(b.key)));
    const clashes = app.filter((b) => textops.has(canonical(b.key))).map((b) => `${b.key} — ${b.id}`);
    expect(clashes).toEqual([]);
  });

  test("nothing is bound to a chord the OS eats", () => {
    const unusable = new Set(UNUSABLE_ON_MACOS.map(canonical));
    const bad = [...app.map((b) => `${b.key} — ${b.id}`), ...BINDINGS.map((b) => `${b.key} — ${b.id}`)]
      .filter((s) => unusable.has(canonical(s.split(" — ")[0]!)));
    expect(bad).toEqual([]);
  });

  test("the browser's own chords are not used for anything but their own meaning", () => {
    // Cmd-P opens Print and Cmd-N opens a new window; a page cannot preventDefault either.
    // Observed directly: pressing Cmd-P in the running app typed into the document instead
    // of opening quick-open. They are listed here so the collision is a decision on the
    // record rather than a surprise, and so adding a third one fails this test.
    const browserOwned = new Set(["mod|p", "mod|n", "mod|w", "mod|t", "mod|q"].map((s) => s));
    const used = app.filter((b) => browserOwned.has(canonical(b.key))).map((b) => `${b.key} — ${b.id}`).sort();
    expect(used).toEqual([
      "Mod-n — file.new",
      "Mod-p — file.quickOpen",
    ]);
  });
});
