import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * Every colour and font the app draws with must actually exist.
 *
 * CSS custom properties fail silently and invisibly. `var(--surface)` with no `--surface`
 * defined does not warn, does not throw, and does not fall back — the declaration is dropped at
 * computed-value time and the element simply renders without that property. A panel with no
 * background looks, on a light theme, almost exactly like a panel with the right background.
 *
 * So they accumulated. A coherence pass driving the real app found twenty references that
 * resolved to nothing, including `--surface` seven times — the completion popup, the inline
 * edit bar, the agent pane in three places, the fidelity pane and the changes pane were ALL
 * rendering with no background of their own. It also found `--warn` referenced with two
 * different hard-coded fallback hexes in two different files, which is the same bug wearing a
 * disguise: a fallback is what you write when you are not sure the token exists.
 *
 * The worst of them took out a whole design. `document.css` styled tracked changes with
 * `color-mix(in srgb, var(--good) 16%, transparent)`, and `--good` was defined nowhere — so
 * `color-mix()` was invalid, the background was dropped, and the competing stylesheet's colours
 * showed through instead. The document rendered a hybrid of two designs and neither author's.
 *
 * This test is the tripwire. It is deliberately dumb: read the stylesheets, collect what is
 * defined, collect what is referenced, and require the second to be a subset of the first.
 */

function repoRoot(): string {
  let d = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "bun.lock"))) return d;
    d = dirname(d);
  }
  return d;
}

const STYLES = join(repoRoot(), "apps/web/src/styles");

/** Comments discuss tokens that no longer exist on purpose; they are not references. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const sheets = readdirSync(STYLES)
  .filter((f) => f.endsWith(".css"))
  .sort()
  .map((name) => ({ name, css: stripComments(readFileSync(join(STYLES, name), "utf8")) }));

const allCss = sheets.map((s) => s.css).join("\n");
const defined = new Set([...allCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));

describe("theme tokens", () => {
  test("the stylesheets are being read at all", () => {
    // Without this every assertion below is a loop over an empty array reporting green.
    expect(sheets.length).toBeGreaterThan(1);
    expect(defined.size).toBeGreaterThan(20);
  });

  test("every referenced token is defined somewhere", () => {
    const dangling: string[] = [];
    for (const { name, css } of sheets) {
      for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*[,)]/g)) {
        if (!defined.has(m[1]!)) dangling.push(`${name}: ${m[1]}`);
      }
    }
    expect([...new Set(dangling)].sort()).toEqual([]);
  });

  test("no token is referenced with a hard-coded fallback", () => {
    // `var(--warn, #B8862C)` is how a token ends up with two different values in two files, and
    // how a missing token hides: the fallback works, so nobody notices the token was never
    // defined. If the token exists the fallback is dead code; if it does not, define it.
    const withFallback: string[] = [];
    for (const { name, css } of sheets) {
      for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,/g)) withFallback.push(`${name}: ${m[1]}`);
    }
    expect([...new Set(withFallback)].sort()).toEqual([]);
  });

  test("every token is defined in both themes", () => {
    // The app stamps data-theme on <html> rather than using prefers-color-scheme in CSS
    // (see app/prefs.ts), so a token defined only in :root renders light-mode colours on a
    // dark panel — legible enough in review to survive, wrong enough to matter.
    // Every block matching the selector, not just the first: `document.css` opens a `:root`
    // of its own for the document serif, and reading only one of them would compare the wrong
    // set. (Finding that was this test's first catch — it flagged a duplicate `--serif` being
    // added to `app.css` while `document.css` already had one.)
    const block = (selector: string): Set<string> => {
      const out = new Set<string>();
      for (let i = allCss.indexOf(selector); i >= 0; i = allCss.indexOf(selector, i + 1)) {
        const open = allCss.indexOf("{", i);
        const close = allCss.indexOf("}", open);
        if (open < 0 || close < 0) continue;
        for (const m of allCss.slice(open, close).matchAll(/(--[a-z0-9-]+)\s*:/g)) out.add(m[1]!);
      }
      return out;
    };
    const light = block(":root {");
    const dark = block(':root[data-theme="dark"]');
    expect(light.size).toBeGreaterThan(20);
    expect(dark.size).toBeGreaterThan(20);

    // Only COLOURS need a dark variant. Fonts, sizes and geometry are theme-independent, and
    // deciding which is which by NAME is a guess that goes wrong the first time someone adds
    // `--sidebar-w`. The value says it plainly, so ask the value.
    const valueOf = (token: string): string => {
      const m = new RegExp(`${token}\\s*:([^;]*);`).exec(allCss);
      return m ? m[1]!.trim() : "";
    };
    const isColour = (v: string) =>
      /^#[0-9a-f]{3,8}$/i.test(v) || /^(rgb|rgba|hsl|hsla|oklab|oklch|color-mix)\(/i.test(v);

    const missing = [...light].filter((t) => !dark.has(t) && isColour(valueOf(t)));
    expect(missing.sort()).toEqual([]);
  });
});
