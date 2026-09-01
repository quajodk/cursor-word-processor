/**
 * Headless keystroke benchmark: keystroke → ProseMirror state commit.
 *
 * WHAT IS TIMED, exactly, per sample:
 *
 *     t0 = Bun.nanoseconds()
 *     tr = state.tr.insertText(ch, from, to)      // transaction construction + ReplaceStep
 *     state = state.apply(tr)                     // step application, position mapping,
 *                                                 // every plugin's state.apply, and the
 *                                                 // full appendTransaction loop (aid repair)
 *     t1 = Bun.nanoseconds()
 *
 * That is the real code path. No stand-ins: real schema, real aidPlugin, real
 * prosemirror-history, real 40k-word document built from real prose.
 *
 * WHAT IS NOT TIMED — see METHODOLOGY.md, but the short version, because it matters:
 *   - prosemirror-view: DOM diff, DOM write, selection sync. This is the "→ DOM commit"
 *     half of the §5 row and it is NOT here. That is why this metric is `lower-bound`.
 *   - input rules and keymaps (view-side props, not state.apply).
 *   - decorations from view plugins.
 *   - style, layout, paint, composite.
 *
 * OUTLIERS ARE NOT REMOVED. A GC pause is a frame the writer dropped.
 */

import { EditorState, TextSelection, type Plugin } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "@scriv/doc-model";
import { SAMPLING } from "../budgets";
import { summarize, type Stats } from "../stats";
import { rng } from "../gendoc";

/**
 * The keystroke mix. Fixed and seeded: p99 over a mixed distribution depends on the mix,
 * so the mix is part of the measurement definition, not an accident of the run.
 *
 * Enter is the expensive keystroke — it splits a block, which is the ONE case where
 * aidPlugin leaves its O(1) fast path and repairs identity. Excluding it would be
 * measuring only the easy 95%.
 */
export const KEYSTROKE_MIX = {
  character: 0.92,
  backspace: 0.05,
  enter: 0.03,
} as const;

export type KeystrokeKind = "character" | "backspace" | "enter";

export interface KeystrokeResult {
  all: Stats;
  byKind: Record<KeystrokeKind, Stats>;
  mix: Record<KeystrokeKind, number>;
  pluginNames: string[];
  doc: {
    wordsBefore: number;
    blocksBefore: number;
    blocksAfter: number;
    sizeBefore: number;
    sizeAfter: number;
  };
  memory: {
    heapUsedBeforeMb: number;
    heapUsedAfterMb: number;
    /** Net retained bytes per measured keystroke. NOT allocation rate — see below. */
    netBytesPerKeystroke: number;
    rssDeltaMb: number;
    /**
     * Samples more than 8x the median. Not proof of GC, but on a bench whose median is
     * tens of microseconds a 8x sample is almost always a collection or a scheduler
     * preemption. Reported, never removed.
     */
    suspectedPauses: number;
    suspectedPauseTotalMs: number;
  };
}

interface Op { kind: KeystrokeKind; ch: string }

/** Words to type, drawn from the corpus, so keystroke content is real text. */
function typingStream(source: string, seed: number): () => Op {
  const words = source.split(/\s+/).filter((w) => w.length > 0 && w.length < 20);
  const r = rng(seed);
  let wi = Math.floor(r() * words.length);
  let ci = 0;
  let queued: string | null = null;
  return () => {
    const roll = r();
    if (roll >= KEYSTROKE_MIX.character + KEYSTROKE_MIX.backspace) return { kind: "enter", ch: "\n" };
    if (roll >= KEYSTROKE_MIX.character) return { kind: "backspace", ch: "" };
    if (queued !== null) { const c = queued; queued = null; return { kind: "character", ch: c }; }
    const w = words[wi % words.length]!;
    if (ci >= w.length) { wi++; ci = 0; queued = w[0] ?? "x"; return { kind: "character", ch: " " }; }
    return { kind: "character", ch: w[ci++]! };
  };
}

/** A caret position inside a real textblock. Not timed. */
function pickCaret(doc: PMNode, r: () => number): number {
  for (let attempt = 0; attempt < 60; attempt++) {
    const pos = 1 + Math.floor(r() * Math.max(1, doc.content.size - 2));
    try {
      const $p = doc.resolve(pos);
      if ($p.parent.isTextblock && $p.parent.type.name !== "code_block" && $p.parent.content.size > 2) {
        return pos;
      }
    } catch { /* position not resolvable mid-node; try again */ }
  }
  // Fall back to the end of the first textblock we can find.
  let found = 1;
  doc.descendants((n, pos) => {
    if (found > 1) return false;
    if (n.isTextblock && n.content.size > 2) { found = pos + 1; return false; }
    return true;
  });
  return found;
}

export interface KeystrokeOpts {
  doc: PMNode;
  plugins: Plugin[];
  pluginNames: string[];
  /** Text used as the typing stream. Real corpus prose. */
  typingSource: string;
  warmup?: number;
  samples?: number;
  seed?: number;
  /** Keystrokes typed before the caret jumps somewhere else, as a real writer does. */
  burst?: [number, number];
}

export function benchKeystroke(opts: KeystrokeOpts): KeystrokeResult {
  const warmup = opts.warmup ?? SAMPLING.keystrokeWarmup;
  const samples = opts.samples ?? SAMPLING.keystrokeSamples;
  const seed = opts.seed ?? 0xbeef01;
  const [burstLo, burstHi] = opts.burst ?? [25, 90];

  let state = EditorState.create({ schema, doc: opts.doc, plugins: opts.plugins });
  const wordsBefore = countWordsIn(opts.doc);
  const blocksBefore = opts.doc.childCount;
  const sizeBefore = opts.doc.content.size;

  const nextOp = typingStream(opts.typingSource, seed);
  const r = rng(seed ^ 0x9e3779b9);

  const durations = new Float64Array(samples);
  const kinds = new Uint8Array(samples);
  const KIND_ID: Record<KeystrokeKind, number> = { character: 0, backspace: 1, enter: 2 };
  const KIND_NAME: KeystrokeKind[] = ["character", "backspace", "enter"];

  let burstLeft = 0;
  const total = warmup + samples;

  // Let the process settle and start from a known heap. This is BEFORE warmup, so nothing
  // measured is affected by it.
  if (typeof Bun !== "undefined" && typeof Bun.gc === "function") Bun.gc(true);
  const memBefore = process.memoryUsage();

  for (let i = 0; i < total; i++) {
    if (burstLeft <= 0) {
      // Not timed: repositioning the caret. A real writer's cursor moves; measuring the
      // move would conflate two different budgets.
      const pos = pickCaret(state.doc, r);
      state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
      burstLeft = burstLo + Math.floor(r() * (burstHi - burstLo + 1));
    }
    burstLeft--;

    const op = nextOp();
    const sel = state.selection;
    const from = sel.from;

    const t0 = Bun.nanoseconds();
    if (op.kind === "backspace") {
      const start = Math.max(1, from - 1);
      state = start < from ? state.apply(state.tr.delete(start, from)) : state;
    } else if (op.kind === "enter") {
      state = state.apply(state.tr.split(from));
    } else {
      state = state.apply(state.tr.insertText(op.ch, from, sel.to));
    }
    const t1 = Bun.nanoseconds();

    if (i >= warmup) {
      const idx = i - warmup;
      durations[idx] = (t1 - t0) / 1e6;
      kinds[idx] = KIND_ID[op.kind];
    }
  }

  const memAfter = process.memoryUsage();

  const all = Array.from(durations);
  const buckets: Record<KeystrokeKind, number[]> = { character: [], backspace: [], enter: [] };
  for (let i = 0; i < samples; i++) buckets[KIND_NAME[kinds[i]!]!].push(durations[i]!);

  const allStats = summarize(all, warmup);
  const pauseThreshold = allStats.p50 * 8;
  let suspectedPauses = 0, suspectedPauseTotalMs = 0;
  for (const v of all) if (v > pauseThreshold) { suspectedPauses++; suspectedPauseTotalMs += v; }

  return {
    all: allStats,
    byKind: {
      character: summarize(buckets.character, 0),
      backspace: summarize(buckets.backspace, 0),
      enter: summarize(buckets.enter, 0),
    },
    mix: {
      character: buckets.character.length / samples,
      backspace: buckets.backspace.length / samples,
      enter: buckets.enter.length / samples,
    },
    pluginNames: opts.pluginNames,
    doc: {
      wordsBefore,
      blocksBefore,
      blocksAfter: state.doc.childCount,
      sizeBefore,
      sizeAfter: state.doc.content.size,
    },
    memory: {
      heapUsedBeforeMb: memBefore.heapUsed / 1048576,
      heapUsedAfterMb: memAfter.heapUsed / 1048576,
      netBytesPerKeystroke: (memAfter.heapUsed - memBefore.heapUsed) / total,
      rssDeltaMb: (memAfter.rss - memBefore.rss) / 1048576,
      suspectedPauses,
      suspectedPauseTotalMs,
    },
  };
}

function countWordsIn(doc: PMNode): number {
  const t = doc.textBetween(0, doc.content.size, " ", " ");
  const m = t.match(/[^\s]+/g);
  return m ? m.length : 0;
}
