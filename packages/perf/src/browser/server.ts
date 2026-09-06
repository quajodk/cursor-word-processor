/**
 * Serves the calibration page. Bundles src/browser/entry.ts with Bun.build (target
 * browser), serves prosemirror-view's real stylesheet, and serves the generated 40k-word
 * document as JSON. Local only; bound to 127.0.0.1.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "../paths";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The calibration page's entry, which lives in apps/web because it imports the app's own
 * plugin stack. Bundled by path rather than imported, so packages/perf never takes a
 * compile-time dependency on the app — the same reason `resolvePlugins` uses a dynamic
 * import. If this file is missing the bundle fails loudly rather than silently measuring a
 * page with no editor on it.
 */
const ENTRY = join(repoRoot(), "apps", "web", "src", "perf-entry.ts");

/**
 * The app's real stylesheets, served into the calibration page.
 *
 * Layout cost is part of keystroke → paint, so a hand-written approximation of the writing
 * surface measures a document nobody reads. `app.css` supplies the design tokens
 * `document.css` is written against; without it every `var(--…)` falls back to nothing and
 * the page lays out at default font and full width, which is a different measurement again.
 */
const APP_STYLES = ["app.css", "document.css"].map((f) =>
  join(repoRoot(), "apps", "web", "src", "styles", f));

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>scriv perf calibration</title>
<style id="pm-css">/* prosemirror-view css injected at runtime */</style>
<style>
  /* Only what the app's own CSS assumes about the page around it. Everything typographic —
     measure, rhythm, faces, list markers, tables — comes from apps/web/src/styles below,
     because approximating it would be measuring a document nobody reads. */
  html,body { margin:0; padding:0; height:100%; }
  body { background: var(--app-bg, #fff); color: var(--ink, #111); }
</style>
<style id="app-css">/* apps/web styles injected at runtime */</style>
</head>
<body><div class="doc-scroll"><article class="doc-page" data-para="book" data-align="ragged"><div id="editor"></div></article></div><script type="module" src="/entry.js"></script></body></html>`;

export interface CalibrationServer {
  url: string;
  stop(): void;
}

export async function startCalibrationServer(docJson: unknown): Promise<CalibrationServer> {
  const built = await Bun.build({
    entrypoints: [ENTRY],
    target: "browser",
    minify: false,
    sourcemap: "none",
  });
  if (!built.success) {
    throw new Error("calibration bundle failed:\n" + built.logs.map(String).join("\n"));
  }
  const js = await built.outputs[0]!.text();

  let pmCss = "";
  try {
    pmCss = readFileSync(require.resolve("prosemirror-view/style/prosemirror.css"), "utf8");
  } catch {
    // Resolve relative to the workspace if require.resolve is unavailable under bun ESM.
    try {
      pmCss = readFileSync(join(here, "../../node_modules/prosemirror-view/style/prosemirror.css"), "utf8");
    } catch { /* the page still works; layout differs slightly and we say so */ }
  }
  let appCss = "";
  for (const f of APP_STYLES) {
    try { appCss += readFileSync(f, "utf8") + "\n"; }
    catch { /* a missing stylesheet is reported by the caller as a note, not a crash */ }
  }
  const html = HTML
    .replace("/* prosemirror-view css injected at runtime */", pmCss)
    .replace("/* apps/web styles injected at runtime */", appCss);
  const docBody = JSON.stringify(docJson);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/entry.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
      if (path === "/doc.json") return new Response(docBody, { headers: { "content-type": "application/json" } });
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/`,
    stop: () => server.stop(true),
  };
}
