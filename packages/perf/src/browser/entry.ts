/**
 * Calibration page entry.
 *
 * This is NOT a mock of the editor. It is the real @scriv/doc-model schema, the real
 * aidPlugin, real prosemirror-history/keymap/commands and a real prosemirror-view mounted
 * on the real 40k-word corpus document. Everything here is code that ships.
 *
 * What it is missing, versus apps/web, is everything apps/web adds on top: the React
 * chrome, decoration-producing plugins (diagnostics squiggles, comment highlights, AI
 * ghost text), the CSS that determines layout cost, and whatever keymaps land. So a
 * keystroke→paint number measured here is a FLOOR for the real app, and the harness
 * labels it `calibration` rather than `app` so nobody reads it as the shipping number.
 *
 * The moment apps/web serves an editor, point SCRIV_PERF_URL at it and the same driver
 * measures the real thing.
 */

import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Node as PMNode } from "prosemirror-model";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { schema, aidPlugin } from "@scriv/doc-model";

declare global {
  interface Window {
    __scrivPerf: {
      ready: boolean;


      view: EditorView;
      placeCaret(fraction: number): void;
    };
  }
}

async function main() {
  const res = await fetch("/doc.json");
  const json = await res.json();
  const doc = PMNode.fromJSON(schema, json);

  const state = EditorState.create({
    schema,
    doc,
    plugins: [
      aidPlugin(),
      history(),
      keymap({ "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo }),
      keymap(baseKeymap),
    ],
  });

  const mount = document.getElementById("editor")!;
  const view = new EditorView(mount, { state });

  window.__scrivPerf = {
    ready: true,
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
