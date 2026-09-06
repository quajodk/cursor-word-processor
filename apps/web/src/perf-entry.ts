/**
 * Calibration page entry.
 *
 * This is NOT a mock of the editor. It mounts a real `prosemirror-view` on the real
 * 40k-word corpus document, running THE APP'S OWN PLUGIN STACK via
 * `apps/web/src/perf-plugins.ts` — the same seventeen plugins `editorPlugins()` builds,
 * the same completion index, the same input rules and keymaps. Everything here is code
 * that ships.
 *
 * It used to run four plugins (aidPlugin, history, two keymaps) and call the result a
 * floor. That is the same mistake the headless keystroke bench made: a number measured
 * against a stack nobody uses tells you about the harness.
 *
 * What it is still missing, versus apps/web: the React chrome around the editor, the
 * app's own CSS (layout cost is real cost), and the diagnostics plugin, which builds a
 * Worker and is measured separately as `diagnostics.refresh`. So this is labelled
 * `calibration` rather than `app`, and the harness says so.
 *
 * Point SCRIV_PERF_URL at a running apps/web and the same driver measures the real thing.
 *
 * LIVES IN apps/web, NOT IN packages/perf. It imports the app's plugin stack, and a perf
 * package that statically imported apps/web would invert the dependency in the typecheck
 * graph — which is why `resolvePlugins` reaches for `perf-plugins.ts` through a dynamic
 * import. `packages/perf/src/browser/server.ts` bundles this file by path; nothing in the
 * app imports it back.
 */

import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Node as PMNode } from "prosemirror-model";
import { schema } from "@scriv/doc-model";
import { scrivPlugins } from "./perf-plugins";

declare global {
  interface Window {
    __scrivPerf: {
      ready: boolean;
      /** So the report can state what stack the number came from rather than assuming. */
      pluginCount: number;


      view: EditorView;
      placeCaret(fraction: number): void;
    };
  }
}

async function main() {
  const res = await fetch("/doc.json");
  const json = await res.json();
  const doc = PMNode.fromJSON(schema, json);

  const plugins = scrivPlugins(doc);
  const state = EditorState.create({ schema, doc, plugins });

  const mount = document.getElementById("editor")!;
  const view = new EditorView(mount, { state });

  window.__scrivPerf = {
    ready: true,
    pluginCount: plugins.length,
    view,
    placeCaret(fraction: number) {
      const size = view.state.doc.content.size;
      let pos = Math.max(1, Math.floor(size * fraction));
      for (let i = 0; i < 500; i++) {
        try {
          const $p = view.state.doc.resolve(pos);
          if ($p.parent.isTextblock && $p.parent.content.size > 2) break;
        } catch { /* keep walking */ }
        pos++;
        if (pos >= size - 1) { pos = 1; }
      }
      const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, pos));
      view.dispatch(tr.scrollIntoView());
      view.focus();
    },
  };

  document.body.setAttribute("data-scriv-ready", "1");
}

main().catch((err) => {
  document.body.setAttribute("data-scriv-error", String(err));
  // eslint-disable-next-line no-console
  console.error(err);
});
