/**
 * Serves the calibration page. Bundles src/browser/entry.ts with Bun.build (target
 * browser), serves prosemirror-view's real stylesheet, and serves the generated 40k-word
 * document as JSON. Local only; bound to 127.0.0.1.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>scriv perf calibration</title>
<style id="pm-css">/* prosemirror-view css injected at runtime */</style>
<style>
  /* Layout close to a writing surface: a measured column, real line-height, real font.
     Layout cost is part of keystroke→paint, so this is not decoration. */
  html,body { margin:0; padding:0; background:#fff; color:#111; }
  body { font: 16px/1.65 Georgia, "Iowan Old Style", "Times New Roman", serif; }
  #editor { max-width: 46rem; margin: 0 auto; padding: 4rem 2rem 12rem; }
  .ProseMirror { outline: none; white-space: pre-wrap; word-wrap: break-word; }
  .ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4 { font-family: -apple-system, system-ui, sans-serif; line-height:1.25; margin: 1.8em 0 .6em; }
  .ProseMirror p { margin: 0 0 1em; }
  .ProseMirror pre { background:#f4f4f4; padding:.75em 1em; overflow-x:auto; font: 13px/1.5 ui-monospace, Menlo, monospace; }
  .ProseMirror blockquote { border-left:3px solid #ddd; margin-left:0; padding-left:1em; color:#444; }
  .ProseMirror table { border-collapse: collapse; width:100%; margin: 1em 0; }
  .ProseMirror td,.ProseMirror th { border:1px solid #ccc; padding:.4em .6em; vertical-align: top; font-size: .9em; }
  .ProseMirror .scriv-comment { background: rgba(255,214,0,.28); }
  .ProseMirror .scriv-ins { text-decoration: underline; }
</style></head>
<body><div id="editor"></div><script type="module" src="/entry.js"></script></body></html>`;

export interface CalibrationServer {
  url: string;
  stop(): void;
}

export async function startCalibrationServer(docJson: unknown): Promise<CalibrationServer> {
  const built = await Bun.build({
    entrypoints: [join(here, "entry.ts")],
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
  const html = HTML.replace("/* prosemirror-view css injected at runtime */", pmCss);
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
