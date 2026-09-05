/**
 * Completion benchmark: keystroke to a populated item list.
 *
 * WHAT IS TIMED, exactly, per sample — the body of `computeAt` in
 * `apps/web/src/editor/completion.ts`, which is what runs inside `state.apply` on every
 * transaction while the popup is live:
 *
 *     t0
 *       blockAt($from)                 // the block text under the caret
 *       triggerAt(ctx, explicit)       // should anything open at all
 *       index.symbols()                // the merged workspace symbol table
 *       complete(symbols, ctx)         // fuzzy match + score + sort + slice
 *     t1
 *
 * The index is built from the real 40k-word corpus document, so `complete` walks a real
 * symbol table rather than a handful of invented entries. That matters more than it sounds:
 * the cost is linear in the number of symbols, and a bench against a toy index would be
 * measuring an empty loop.
 *
 * WHAT IS NOT TIMED, which is why this is a lower bound:
 *   - building and positioning the popup element, and `coordsAtPos` (needs a layout).
 *   - the paint of the list itself.
 *
 * TWO MIXES ARE MEASURED, because they are different questions:
 *   sigil    — `@`, `[[`, `:`: the popup is opening because the writer asked for a name.
 *   typing   — ordinary prose characters, where the answer is almost always "stay shut".
 * The second is the one that runs on every keystroke of ordinary writing, so a regression
 * there is a regression in typing, not in completion. Both are reported; the gate takes the
 * worse of them, because a budget met only on the cheap case is not met.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import type { Node as PMNode } from "prosemirror-model";
import { complete, triggerAt, WorkspaceIndex, type ProseSymbol } from "@scriv/intellisense";
import { parseMarkdown } from "@scriv/md";
import { summarize, type Stats } from "../stats";
import { rng } from "../gendoc";
import { repoRoot } from "../paths";

export interface CompletionBenchResult {
  /** The gated metric: the worse of the two mixes below. */
  worst: Stats;
  sigil: Stats;
  typing: Stats;
  symbols: number;
  /** Non-empty results produced, so a bench that silently matched nothing is visible. */
  offered: number;
  /** Time to build the merged symbol table once, at document-open time. Not per keystroke. */
  indexBuildMs: number;
  /** Documents in the index. One is not a workspace; the number belongs in the report. */
  documents: number;
  detail: string;
}

/**
 * Index real Markdown from the corpus. Returns how many files went in.
 *
 * The corpus is gitignored, so this can legitimately find nothing — in which case the bench
 * still runs against the single document and the report says `1 document`, which is the
 * signal that the number is not the workspace number.
 */
function indexWorkspace(index: WorkspaceIndex): number {
  const dir = join(repoRoot(), "corpus", "md");
  if (!existsSync(dir)) return 0;

  // Biggest first, and nothing under 2 KB.
  //
  // The first cut of this took files in glob order, which handed it 374 CommonMark spec
  // fixtures — files like `0170-html-blocks.md`, three lines each, no prose — and 400
  // "documents" produced 13 symbols between them. The bench was then reporting a workspace
  // number that was really the single-document number, which is the exact failure the
  // workspace was added to avoid. A writer's project is prose files; the bench indexes prose
  // files.
  const files: { path: string; size: number }[] = [];
  for (const rel of new Glob("**/*.md").scanSync(dir)) {
    const path = join(dir, rel);
    try {
      const size = statSync(path).size;
      if (size >= 2_048 && size <= 400_000) files.push({ path, size });
    } catch { /* unreadable; skip */ }
  }
  files.sort((a, b) => b.size - a.size);

  let n = 0;
  for (const f of files) {
    try {
      index.setDocument(f.path, parseMarkdown(readFileSync(f.path, "utf8")).doc);
      n++;
    } catch { /* a file that will not parse is not a reason to abandon the bench */ }
    if (n >= WORKSPACE_FILES) break;
  }
  return n;
}

const WARMUP = 500;
const SAMPLES = 4000;

/**
 * Workspace documents pulled into the index alongside the document under test.
 *
 * Benching against a single document gave 220 symbols, and `complete()` is linear in the
 * symbol count — so that number was measuring an almost-empty loop and reporting it as the
 * feature. `WorkspaceSymbols` indexes up to 1000 files, and the whole premise of prose
 * completion is that a name defined in chapter one completes in chapter nine, so the bench
 * has to carry a workspace or it is not benching the thing that ships.
 */
const WORKSPACE_FILES = 400;

export function benchCompletion(doc: PMNode): CompletionBenchResult {
  const index = new WorkspaceIndex();
  index.setDocument("bench.md", doc);
  const documents = 1 + indexWorkspace(index);
  const t0 = Bun.nanoseconds();
  const symbols: ProseSymbol[] = index.symbols();
  const indexBuildMs = (Bun.nanoseconds() - t0) / 1e6;

  // Real block text from the document: the completion context a writer is actually in.
  const blocks: string[] = [];
  doc.descendants((n) => {
    if (n.isTextblock && n.textContent.length > 40) blocks.push(n.textContent);
    return true;
  });

  // Queries drawn from the symbol table's own labels, so the fuzzy matcher does real work
  // rather than failing at the first character on every sample.
  const labels = symbols.map((s) => s.label.replace(/^@/, "")).filter((l) => l.length >= 3);

  const sigilDurations: number[] = [];
  const typingDurations: number[] = [];
  let offered = 0;

  const r = rng(0xc0117e);
  const sigils = ["@", "[[", ":"];

  for (let i = 0; i < WARMUP + SAMPLES; i++) {
    const isSigil = i % 2 === 0;
    const block = blocks[Math.floor(r() * blocks.length)] ?? "The quick brown fox.";

    let blockText: string;
    let offset: number;
    let explicit: boolean;

    if (isSigil) {
      const label = labels[Math.floor(r() * labels.length)] ?? "chapter";
      const typed = label.slice(0, 1 + Math.floor(r() * Math.min(6, label.length)));
      const sigil = sigils[Math.floor(r() * sigils.length)]!;
      const head = block.slice(0, Math.floor(r() * Math.max(1, block.length - 1)));
      blockText = `${head} ${sigil}${typed}`;
      offset = blockText.length;
      explicit = false;
    } else {
      // Ordinary typing: caret somewhere in real prose, no sigil in front of it.
      blockText = block;
      offset = 1 + Math.floor(r() * (block.length - 1));
      explicit = false;
    }

    const ctx = { blockText, offset, path: "bench.md" as string | null, limit: 10 };

    const t = Bun.nanoseconds();
    const trigger = triggerAt(ctx, explicit);
    const items = trigger ? complete(symbols, ctx, explicit) : [];
    const ms = (Bun.nanoseconds() - t) / 1e6;

    if (i >= WARMUP) {
      (isSigil ? sigilDurations : typingDurations).push(ms);
      if (items.length > 0) offered++;
    }
  }

  const sigil = summarize(sigilDurations, 0);
  const typing = summarize(typingDurations, 0);
  const worst = sigil.p99 >= typing.p99 ? sigil : typing;

  return {
    worst,
    sigil,
    typing,
    symbols: symbols.length,
    offered,
    indexBuildMs,
    documents,
    detail:
      `${symbols.length.toLocaleString()} symbols across ${documents} documents, merged in ` +
      `${indexBuildMs.toFixed(0)} ms; ` +
      `sigil p99 ${sigil.p99.toFixed(3)} ms, plain typing p99 ${typing.p99.toFixed(3)} ms; ` +
      `${offered} of ${SAMPLES} samples produced a non-empty list`,
  };
}
