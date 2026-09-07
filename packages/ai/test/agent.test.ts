import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { Glob } from "bun";
import { planRename, applyChangeSet, staleSites, summarizeChangeSet, siteKey, type SourceFile } from "../src/agent";
import { codeSpans, isMasked } from "../src/mask";

/**
 * A workspace rename, against real Markdown.
 *
 * The properties that matter are not "it replaces the word". They are the ones that decide
 * whether a writer can accept four hundred sites without reading all four hundred:
 *
 *   - it never touches code,
 *   - it never edits a byte it did not show,
 *   - accepting nothing changes nothing,
 *   - accepting everything is the same as one pass of a correct replace,
 *   - and a file that changed under review is skipped, not overwritten.
 */

function repoRoot(): string {
  let d = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "bun.lock"))) return d;
    d = dirname(d);
  }
  return d;
}

function corpus(limit: number): SourceFile[] {
  const dir = join(repoRoot(), "corpus", "md");
  if (!existsSync(dir)) return [];
  const found: { path: string; size: number }[] = [];
  for (const rel of new Glob("**/*.md").scanSync(dir)) {
    const path = join(dir, rel);
    try {
      const size = statSync(path).size;
      if (size >= 2_048 && size <= 400_000) found.push({ path: rel, size });
    } catch { /* unreadable */ }
  }
  found.sort((a, b) => b.size - a.size);
  return found.slice(0, limit).map((f) => ({ path: f.path, text: readFileSync(join(dir, f.path), "utf8") }));
}

const all = (changes: ReturnType<typeof planRename>) =>
  new Set(changes.files.flatMap((f) => f.sites.map(siteKey)));

describe("workspace rename, against the corpus", () => {
  const files = corpus(120);

  test("the corpus is present", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  test("finds real sites for a term that is actually in the corpus", () => {
    const changes = planRename(files, "configuration", "settings");
    const s = summarizeChangeSet(changes);
    expect(s.sites).toBeGreaterThan(50);
    expect(s.files).toBeGreaterThan(5);
    // Reported honestly: scanned is every file, not just the ones that matched.
    expect(changes.scanned).toBe(files.length);
  });

  test("never proposes a site inside code", () => {
    const inside: string[] = [];
    for (const term of ["function", "return", "options", "value", "type", "import"]) {
      const changes = planRename(files, term, "REPLACED");
      for (const f of changes.files) {
        const text = files.find((x) => x.path === f.path)!.text;
        const spans = codeSpans(text);
        for (const site of f.sites) {
          if (isMasked(spans, site.from, site.to)) inside.push(`${term} ${f.path}:${site.lineNumber}`);
        }
      }
    }
    expect(inside).toEqual([]);
  });

  test("every site's `before` is exactly the bytes at its offsets", () => {
    // If this ever drifts, `applyChangeSet` writes the wrong span — and the writer reviewed
    // a line that was not the line being changed.
    const wrong: string[] = [];
    for (const term of ["configuration", "Node", "package", "the"]) {
      const changes = planRename(files, term, "X");
      for (const f of changes.files) {
        const text = files.find((x) => x.path === f.path)!.text;
        for (const s of f.sites) {
          if (text.slice(s.from, s.to) !== s.before) wrong.push(`${f.path}:${s.lineNumber} ${JSON.stringify(s.before)}`);
          if (text.slice(s.from - s.lineOffset, s.from - s.lineOffset + s.line.length) !== s.line) {
            wrong.push(`${f.path}:${s.lineNumber} line context wrong`);
          }
        }
      }
    }
    expect(wrong.slice(0, 8)).toEqual([]);
  });

  test("accepting nothing changes nothing", () => {
    const changes = planRename(files, "configuration", "settings");
    expect(applyChangeSet(files, changes, new Set())).toEqual([]);
  });

  test("accepting everything changes only the shown bytes, and by the shown amount", () => {
    const changes = planRename(files, "configuration", "settings");
    const results = applyChangeSet(files, changes, all(changes));
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      const before = files.find((f) => f.path === r.path)!.text;
      const sites = changes.files.find((f) => f.path === r.path)!.sites;
      const delta = sites.reduce((n, s) => n + (s.after.length - s.before.length), 0);
      expect(`${r.path}: ${r.text.length - before.length}`).toBe(`${r.path}: ${delta}`);

      // And nothing outside the sites moved: rebuilding the origin from the result and the
      // sites must give back the original file exactly.
      let rebuilt = r.text;
      for (const s of [...sites].sort((a, b) => b.from - a.from)) {
        const shift = sites.filter((x) => x.from < s.from).reduce((n, x) => n + (x.after.length - x.before.length), 0);
        rebuilt = rebuilt.slice(0, s.from + shift) + s.before + rebuilt.slice(s.from + shift + s.after.length);
      }
      expect(`${r.path} rebuilt`).toBe(rebuilt === before ? `${r.path} rebuilt` : `${r.path} DIFFERS`);
    }
  });

  test("a partially accepted set applies exactly the accepted sites", () => {
    const changes = planRename(files, "configuration", "settings");
    const every = [...all(changes)];
    const half = new Set(every.filter((_, i) => i % 2 === 0));
    const results = applyChangeSet(files, changes, half);
    const applied = results.reduce((n, r) => n + r.applied, 0);
    expect(applied).toBe(half.size);
  });

  test("a file edited during review is skipped, not overwritten", () => {
    const changes = planRename(files, "configuration", "settings");
    const target = changes.files[0]!;
    const moved = files.map((f) =>
      f.path === target.path ? { ...f, text: "PREFIX INSERTED WHILE REVIEWING\n" + f.text } : f);

    expect(staleSites(moved, changes).length).toBeGreaterThan(0);
    const results = applyChangeSet(moved, changes, all(changes));
    expect(results.some((r) => r.path === target.path)).toBe(false);
    // Every other file still applies: one stale file does not abandon the whole set.
    expect(results.length).toBeGreaterThan(0);
  });

  test("re-planning after an apply finds nothing left", () => {
    const changes = planRename(files, "configuration", "settings");
    const results = applyChangeSet(files, changes, all(changes));
    const after = files.map((f) => {
      const r = results.find((x) => x.path === f.path);
      return r ? { path: f.path, text: r.text } : f;
    });
    // The rename is complete in one pass: nothing was missed and nothing was double-applied.
    expect(summarizeChangeSet(planRename(after, "configuration", "settings")).sites).toBe(0);
  });
});

describe("rename rules", () => {
  const one = (text: string, term: string, to: string, opts = {}) =>
    planRename([{ path: "a.md", text }], term, to, opts).files[0]?.sites ?? [];

  test("respects word boundaries in both directions", () => {
    const sites = one("widget subwidget widgetise a widget.", "widget", "gadget");
    expect(sites.map((s) => s.before)).toEqual(["widget", "widget"]);
  });

  test("a multi-word term is matched as a phrase", () => {
    const sites = one("The Working Group met. The working group agreed.", "Working Group", "Committee");
    expect(sites.map((s) => `${s.before}→${s.after}`)).toEqual(["Working Group→Committee", "working group→committee"]);
  });

  test("preserves case and marks the ones that are not exact", () => {
    const sites = one("Widget, widget, WIDGET.", "Widget", "Gadget");
    expect(sites.map((s) => `${s.before}→${s.after} (${s.confidence})`)).toEqual([
      "Widget→Gadget (exact)",
      "widget→gadget (variant)",
      "WIDGET→GADGET (uncertain)",
    ]);
    // The all-caps one says why it is uncertain rather than leaving the writer to guess.
    expect(sites[2]!.note).toContain("acronym");
  });

  test("carries plurals and possessives, adjusting for the replacement's ending", () => {
    expect(one("one widget, two widgets, the widget's edge", "widget", "box").map((s) => s.after))
      .toEqual(["box", "boxes", "box's"]);
    expect(one("two boxes", "box", "widget").map((s) => s.after)).toEqual(["widgets"]);
  });

  test("leaves fenced code, inline code and link targets alone", () => {
    const text = [
      "Use the widget here.",
      "",
      "```js",
      "const widget = require('widget');",
      "```",
      "",
      "Call `widget()` and see [the widget](https://example.com/widget/docs).",
      "",
      "    indented widget code",
      "",
    ].join("\n");
    const sites = one(text, "widget", "gadget");
    // Only the prose occurrences: the sentence, and the link TEXT (not its destination).
    expect(sites.map((s) => s.lineNumber)).toEqual([1, 7]);
    expect(text.slice(sites[1]!.from, sites[1]!.to)).toBe("widget");
    expect(sites[1]!.line).toContain("[the widget]");
  });

  test("leaves frontmatter alone unless asked", () => {
    const text = "---\ntitle: Widget report\nslug: widget-report\n---\n\nThe widget works.\n";
    expect(one(text, "widget", "gadget").map((s) => s.lineNumber)).toEqual([6]);
    expect(one(text, "widget", "gadget", { frontmatter: true }).map((s) => s.lineNumber)).toEqual([2, 3, 6]);
  });

  test("refuses a term too short to review", () => {
    const changes = planRename([{ path: "a.md", text: "a a a a" }], "a", "b");
    expect(changes.files).toEqual([]);
    expect(changes.skipped[0]!.reason).toContain("too short");
  });

  test("an empty term is a no-op, not a match on everything", () => {
    expect(summarizeChangeSet(planRename([{ path: "a.md", text: "hello" }], "  ", "x")).sites).toBe(0);
  });

  test("the site cap is reported rather than silently truncating", () => {
    const text = "widget ".repeat(200);
    const changes = planRename([{ path: "a.md", text }, { path: "b.md", text }], "widget", "gadget", { maxSites: 250 });
    expect(changes.files.length).toBe(1);
    expect(changes.skipped[0]!.reason).toContain("review cap");
  });
});
