/**
 * Diagnostics refresh benchmark.
 *
 * WHAT IS TIMED, exactly, per sample — the whole path from an edit to squiggles on screen,
 * minus the two pieces a headless process cannot hold:
 *
 *     type one character into a real block of the real 40k-word document
 *     t0
 *       proseText(doc)                          // what diagnosticsPlugin sends
 *       IncrementalLinter.run(...)              // what the worker does: 1 block, 493 cached
 *       new OffsetMap(doc, 0, size)             // text offsets -> document positions
 *       DecorationSet.create(doc, ...)          // what the plugin draws
 *     t1
 *
 * That is the real code path with the real checker: real Harper WebAssembly, real corpus
 * prose, real ProseMirror document. Nothing is stubbed, and the linter is the same class the
 * worker instantiates.
 *
 * WHAT IS NOT TIMED, which is why this is a lower bound:
 *   - `postMessage` in both directions, and the structured clone of the diagnostic array.
 *   - the 300 ms debounce, which is a deliberate wait rather than work.
 *   - style/layout/paint of the squiggles themselves.
 *
 * THE COLD PASS IS REPORTED SEPARATELY and is not the budgeted number. Opening a 40k-word
 * document for the first time means checking all 494 blocks, which cannot happen in 150 ms
 * and is not what §5's row is about — that row is the refresh a writer feels while typing.
 * The cold number is printed anyway, because hiding it would be the more flattering choice.
 */

import { EditorState, TextSelection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { Decoration, DecorationSet } from "prosemirror-view";
import { OffsetMap, proseText, schema } from "@scriv/doc-model";
import { createHarperProvider, IncrementalLinter, type Diagnostic } from "@scriv/lsp";
import { summarize, type Stats } from "../stats";
import { rng } from "../gendoc";

export interface DiagnosticsBenchResult {
  /** Steady-state refresh after a one-character edit. This is the gated metric. */
  refresh: Stats;
  /** First pass over the whole document, with an empty cache. Reported, never gated. */
  cold: Stats;
  /** Diagnostics standing on the full document, by severity. Volume is its own problem. */
  bySeverity: Record<string, number>;
  total: number;
  blocks: number;
  /** Blocks re-checked per refresh. The design claim is 1; a drift here is the regression. */
  lintedPerRefresh: Stats;
  detail: string;
}

const COLD_SAMPLES = 3;
const REFRESH_WARMUP = 8;
const REFRESH_SAMPLES = 80;

export async function benchDiagnostics(doc: PMNode): Promise<DiagnosticsBenchResult> {
  const provider = createHarperProvider();
  await provider.setup();

  const language = "en-US";
  // Exactly what diagnosticsPlugin sends, code masked and all.
  const docText = (d: PMNode) => proseText(d);

  // ---- cold: an empty cache over the whole document ---------------------------------
  const coldSamples: number[] = [];
  let full: Diagnostic[] = [];
  let blocks = 0;
  for (let i = 0; i < COLD_SAMPLES; i++) {
    const linter = new IncrementalLinter(provider);
    const text = docText(doc);
    const t0 = Bun.nanoseconds();
    const res = await linter.run({ version: 1, text, language });
    coldSamples.push((Bun.nanoseconds() - t0) / 1e6);
    full = res.diagnostics;
    blocks = res.linted + res.cached;
  }

  const bySeverity: Record<string, number> = {};
  for (const d of full) bySeverity[d.severity] = (bySeverity[d.severity] ?? 0) + 1;

  // ---- refresh: one character typed, everything else cached --------------------------
  //
  // The cache is warm from a full pass, exactly as it is in the app a moment after the
  // document opens. Each sample edits a DIFFERENT block, so the measurement is not one
  // block's cache entry being rebuilt over and over.
  const linter = new IncrementalLinter(provider);
  await linter.run({ version: 0, text: docText(doc), language });

  let state = EditorState.create({ schema, doc, plugins: [] });
  const r = rng(0xd1a6);
  const durations: number[] = [];
  const lintedCounts: number[] = [];

  for (let i = 0; i < REFRESH_WARMUP + REFRESH_SAMPLES; i++) {
    // Not timed: moving the caret and typing. The keystroke itself is a different budget.
    const pos = pickTextblock(state.doc, r);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
    state = state.apply(state.tr.insertText(LETTERS[i % LETTERS.length]!, pos));

    const t0 = Bun.nanoseconds();
    const text = docText(state.doc);
    const res = await linter.run({ version: i + 2, text, language });
    const map = new OffsetMap(state.doc, 0, state.doc.content.size);
    const decos: Decoration[] = [];
    for (const d of res.diagnostics) {
      const a = map.pos(d.from);
      const b = map.pos(d.to);
      if (b > a) decos.push(Decoration.inline(a, b, { class: "scriv-diag" }));
    }
    DecorationSet.create(state.doc, decos);
    const ms = (Bun.nanoseconds() - t0) / 1e6;

    if (i >= REFRESH_WARMUP) {
      durations.push(ms);
      lintedCounts.push(res.linted);
    }
  }

  const refresh = summarize(durations, 0);
  return {
    refresh,
    cold: summarize(coldSamples, 0),
    bySeverity,
    total: full.length,
    blocks,
    lintedPerRefresh: summarize(lintedCounts, 0),
    detail:
      `${blocks} blocks, ${full.length} diagnostics on the full document ` +
      `(${Object.entries(bySeverity).sort().map(([k, v]) => `${v} ${k}`).join(", ")}); ` +
      `cold pass p50 ${summarize(coldSamples, 0).p50.toFixed(0)} ms, ` +
      `refresh re-checks p50 ${summarize(lintedCounts, 0).p50} block(s)`,
  };
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** A caret position inside a real textblock. Not timed. */
function pickTextblock(doc: PMNode, r: () => number): number {
  for (let attempt = 0; attempt < 80; attempt++) {
    const pos = 1 + Math.floor(r() * Math.max(1, doc.content.size - 2));
    try {
      const $p = doc.resolve(pos);
      if ($p.parent.isTextblock && $p.parent.content.size > 2) return pos;
    } catch { /* mid-node; try again */ }
  }
  let found = 1;
  doc.descendants((n, pos) => {
    if (found > 1) return false;
    if (n.isTextblock && n.content.size > 2) { found = pos + 1; return false; }
    return true;
  });
  return found;
}
