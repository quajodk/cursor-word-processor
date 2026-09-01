/**
 * THE budget file. Every threshold the perf gate enforces lives here and nowhere else.
 *
 * Numbers come from docs/ARCHITECTURE.md §5. If you change one, change §5 in the same
 * commit and say why — the table is the contract, this file is its executable form.
 */

export type GateMode =
  /** The measurement covers the whole path named. Can pass, can fail. */
  | "exact"
  /**
   * The measurement covers a strict SUBSET of the path named, so it under-reports.
   * It may therefore FAIL the budget (a lower bound over budget is definitive) but it may
   * never CERTIFY a pass. Reported as `partial`.
   */
  | "lower-bound"
  /** The subsystem does not exist yet. Reported, never gated, never faked. */
  | "not-implemented";

export interface Budget {
  /** Stable key. Also the key under which baselines are stored. */
  id: string;
  /** The row in ARCHITECTURE.md §5 this enforces. */
  path: string;
  /** p99 budget in milliseconds. §5 is a p99 table; means are not budgeted. */
  p99Ms: number;
  /**
   * Optional p50 budget. Not in §5, but a p50 that creeps while p99 holds is a real
   * regression and the relative check below is the primary defence.
   */
  p50Ms?: number;
  mode: GateMode;
  /** What the harness actually times. Printed in the report; keep it honest. */
  measures: string;
  /** What it does NOT time. Printed in the report. This is the important half. */
  excludes: string[];
}

export const BUDGETS: Record<string, Budget> = {
  "keystroke.state-commit": {
    id: "keystroke.state-commit",
    path: "Keystroke → DOM commit (8 ms p99)",
    p99Ms: 8,
    p50Ms: 2,
    // "lower-bound": §5 budgets keystroke→DOM commit. A headless bun process has no DOM,
    // so this measures the state half only. It can prove we are over budget; it cannot
    // prove we are under it. The DOM half is covered by keystroke.to-paint.
    mode: "lower-bound",
    measures:
      "EditorState.apply() for one typed character on a 40k-word doc, including every " +
      "plugin's state.apply and appendTransaction (aid repair, history), transaction " +
      "construction, and step position mapping.",
    excludes: [
      "prosemirror-view DOM diffing and the DOM write itself",
      "style/layout/paint/composite",
      "browser input event dispatch and IME/composition handling",
      "decoration recomputation by view plugins (no view exists headlessly)",
    ],
  },

  "keystroke.to-paint": {
    id: "keystroke.to-paint",
    path: "Keystroke → paint, end to end (16 ms p99, one frame)",
    p99Ms: 16,
    mode: "exact",
    measures:
      "CDP trace: from the renderer's keydown EventDispatch to the compositor frame that " +
      "carries its result, in a real Chromium with real compositing.",
    excludes: [
      "OS-level input latency before the browser sees the key",
      "display scan-out after the frame is swapped",
    ],
  },

  "completion.popup-open": {
    id: "completion.popup-open",
    path: "Completion popup open (40 ms p99)",
    p99Ms: 40,
    mode: "not-implemented",
    measures: "(@scriv/intellisense has no implementation yet)",
    excludes: [],
  },

  "diagnostics.refresh": {
    id: "diagnostics.refresh",
    path: "Diagnostics refresh, debounced (150 ms p99, off main thread)",
    p99Ms: 150,
    mode: "not-implemented",
    measures: "(@scriv/lsp has no implementation yet)",
    excludes: [],
  },

  "doc.open-40k": {
    id: "doc.open-40k",
    path: "Open 40k-word doc (400 ms p99)",
    p99Ms: 400,
    mode: "lower-bound",
    measures:
      "Node.fromJSON on the 40k-word corpus doc + EditorState.create with the full plugin " +
      "stack (every plugin's state.init runs).",
    excludes: [
      "reading the .md off disk",
      "mdast parse and mdast→doc-model conversion (@scriv/md not implemented)",
      "fidelity sidecar load",
      "EditorView construction and the initial DOM render",
    ],
  },

  "docx.import-50p": {
    id: "docx.import-50p",
    path: "docx import, 50-page (1200 ms p99)",
    p99Ms: 1200,
    mode: "exact",
    measures: "(@scriv/ooxml has no implementation yet)",
    excludes: [],
  },
};

/**
 * Relative regression detection.
 *
 * Absolute budgets alone are not enough: a change that doubles p99 from 0.4 ms to 0.8 ms
 * stays far under the 8 ms budget and is still the moment the regression entered. Baselines
 * catch that; budgets catch the day it finally matters.
 */
export const REGRESSION = {
  /** Fail when p99 exceeds baseline p99 by more than this fraction. */
  p99Tolerance: 0.25,
  /** Fail when p50 exceeds baseline p50 by more than this fraction. */
  p50Tolerance: 0.3,
  /**
   * Absolute floor. Below this delta the machine noise dominates the ratio, so a 25%
   * "regression" on a 0.02 ms metric is meaningless. Both the ratio AND this must be
   * exceeded to fail.
   */
  minDeltaMs: 0.1,
} as const;

/** Sampling. Set high enough that p99 is an estimate rather than an anecdote. */
export const SAMPLING = {
  /**
   * Discarded. Covers JIT tier-up, the first-touch page faults on the 40k-word doc's
   * node tree, and the initial heap growth. The first few hundred applies on a cold
   * process are 5-20x the steady-state cost; including them would make the gate a
   * warm-up detector.
   */
  keystrokeWarmup: 3000,
  /**
   * Measured. p99 is the 99th of these, so the tail is estimated from ~150 samples at
   * n=15000. Fewer than ~5000 and the p99 wanders by tens of percent run to run.
   */
  keystrokeSamples: 15000,
  docOpenWarmup: 3,
  docOpenSamples: 25,
  /** Browser: real key events are slow to dispatch, so the budget here is wall-clock. */
  paintWarmup: 30,
  paintSamples: 240,
} as const;

export const CORPUS = {
  /** Target size for the synthetic document. §5 says "40k-word doc". */
  targetWords: 40_000,
  /** Target top-level block count. §5's companion figure from the task brief. */
  targetBlocks: 2_000,
  /** Fixed seed: the gate compares runs, so the document must be byte-identical run to run. */
  seed: 0x5c817,
} as const;
