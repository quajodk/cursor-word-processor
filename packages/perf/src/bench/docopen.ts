/**
 * Cold-open bench for the 40k-word document (ARCHITECTURE §5: 400 ms p99).
 *
 * TIMED: Node.fromJSON(schema, json) + EditorState.create({ doc, plugins }), which runs
 * every plugin's `state.init` — including aidPlugin's, and history's.
 *
 * NOT TIMED, and this is most of the real budget:
 *   - reading report.md off disk (host-api)
 *   - mdast parse + mdast→doc-model (@scriv/md: not implemented)
 *   - fidelity sidecar load (@scriv/ooxml: not implemented)
 *   - EditorView construction and the first DOM render — on a 2,000-block document this
 *     is very plausibly the dominant term
 *
 * Hence `mode: "lower-bound"`. If this number alone exceeds 400 ms we are definitively
 * over budget; if it does not, we have proved nothing about the real open path.
 */

import { EditorState, type Plugin } from "prosemirror-state";
import { Node as PMNode } from "prosemirror-model";
import { schema } from "@scriv/doc-model";
import { SAMPLING } from "../budgets";
import { summarize, type Stats } from "../stats";

export interface DocOpenResult {
  fromJson: Stats;
  stateCreate: Stats;
  total: Stats;
}

export function benchDocOpen(json: unknown, plugins: () => Plugin[]): DocOpenResult {
  const warmup = SAMPLING.docOpenWarmup;
  const samples = SAMPLING.docOpenSamples;
  const total = warmup + samples;

  const parseMs: number[] = [];
  const createMs: number[] = [];
  const totalMs: number[] = [];

  for (let i = 0; i < total; i++) {
    // Fresh plugin instances every iteration: plugin construction and state.init are part
    // of opening a document, and reusing warm plugin objects would flatter the number.
    const ps = plugins();
    const t0 = Bun.nanoseconds();
    const doc = PMNode.fromJSON(schema, json as never);
    const t1 = Bun.nanoseconds();
    EditorState.create({ schema, doc, plugins: ps });
    const t2 = Bun.nanoseconds();
    if (i >= warmup) {
      parseMs.push((t1 - t0) / 1e6);
      createMs.push((t2 - t1) / 1e6);
      totalMs.push((t2 - t0) / 1e6);
    }
  }

  // warmup is already excluded by the `i >= warmup` guard above; passing it again would
  // discard a second warmup's worth of real samples (and empty the array when
  // samples <= warmup, which is how this silently reported "no measurement").
  return {
    fromJson: summarize(parseMs),
    stateCreate: summarize(createMs),
    total: summarize(totalMs),
  };
}
