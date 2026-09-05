/**
 * The plugin stack, exposed to the perf gate.
 *
 * `packages/perf/src/plugins.ts` looks for exactly this file and exactly this export. Until
 * it existed the gate measured `aidPlugin + history` — two plugins out of the eighteen the
 * editor actually runs — and every keystroke number in the report was a lower bound on a
 * stack nobody uses. The header said so on every run, which is not the same as fixing it.
 *
 * This is a thin adapter over `editorPlugins()`, NOT a second stack. If it ever drifts from
 * what the app builds, the gate starts defending a fiction, so it must keep calling the same
 * function the app calls and differ only where a headless process cannot follow:
 *
 *   language — omitted. `diagnosticsPlugin` constructs a `Worker` in its `view()`, and there
 *              is no view here. Diagnostics are measured directly by `bench/diagnostics.ts`
 *              against the real provider instead, which is the honest place for them: their
 *              cost is a worker round-trip on a debounce, not a `state.apply`.
 *
 * Everything else is included, and the completion plugin especially: it recomputes on every
 * `docChanged` transaction inside `state.apply`, so it is on the keystroke path whether or
 * not the popup is visible. Leaving it out was most of the difference between the reported
 * number and the real one.
 */

import { WorkspaceIndex } from "@scriv/intellisense";
import type { Plugin } from "prosemirror-state";
import { editorPlugins } from "./editor/setup";
import { schema } from "@scriv/doc-model";
import type { Node as PMNode } from "prosemirror-model";

/**
 * The gate's entry point.
 *
 * `doc` is optional so the harness can seed the symbol index from the same document it is
 * about to type into. Completion scoring walks every symbol in the workspace, so an empty
 * index would measure the cheapest possible case and call it the editor.
 */
export function scrivPlugins(doc?: PMNode): Plugin[] {
  const index = new WorkspaceIndex();
  index.setDocument("bench.md", doc ?? schema.nodes.doc!.create(null, [schema.nodes.paragraph!.create()]));
  // Warm the merge so the first keystroke is not charged for building the whole table. The
  // app pays that cost once at open time, not per keystroke, and charging it here would put
  // a one-off into a p99 that is supposed to describe steady-state typing.
  index.symbols();

  return editorPlugins({
    locale: "en-US",
    symbols: { index },
    currentPath: () => "bench.md",
  });
}
