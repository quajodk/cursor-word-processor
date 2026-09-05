/**
 * The perf gate entry point. `bun run perf`.
 *
 * Exits NON-ZERO when a budget is exceeded or a real regression is detected, so the gate
 * can fail a build (ARCHITECTURE.md §5, house rule 4).
 *
 * The honesty contract, enforced by `budgets.ts` and reported on every line:
 *   exact           — the measurement covers the whole path. Can pass, can fail.
 *   lower-bound     — covers a strict subset, so it under-reports. May FAIL (a lower bound
 *                     over budget is definitive) but may never CERTIFY a pass.
 *   not-implemented — the subsystem does not exist. Reported, never gated, never faked.
 */
import { mkdir } from "node:fs/promises";
import { BUDGETS } from "./budgets";
import { generateDoc, loadSentences } from "./gendoc";
import { resolvePlugins } from "./plugins";
import { benchKeystroke } from "./bench/keystroke";
import { benchDocOpen } from "./bench/docopen";
import { benchDiagnostics } from "./bench/diagnostics";
import { benchCompletion } from "./bench/completion";
import { benchDocxImport } from "./bench/docximport";
import { evaluate, loadBaseline, saveBaseline, fingerprint } from "./gate";
import { fmtMs } from "./stats";
import type { Stats } from "./stats";

const argv = Bun.argv.slice(2);
const updateBaseline = argv.includes("--update-baseline");
const json = argv.includes("--json");

const fp = fingerprint();
if (!json) {
  console.log(`\nscriv perf gate`);
  console.log(`  machine   ${fp.platform} ${fp.arch} · ${fp.cpu} · ${fp.cores} cores · ${fp.runtime}`);
}

// ---- build the document under test -------------------------------------------------
const gen = await generateDoc();
const pluginSet = await resolvePlugins(gen.doc);
// The typing stream is real corpus prose, so character frequency and word lengths match
// what a writer actually types rather than a synthetic alphabet.
const { sentences } = await loadSentences();
const typingSource = sentences.all.slice(0, 400).join(" ");
if (!json) {
  const st = gen.stats;
  console.log(`  document  ${st.words.toLocaleString()} words · ${st.topLevelBlocks.toLocaleString()} blocks · ${st.markedTextNodes.toLocaleString()} marked runs`);
  console.log(`  corpus    ${st.corpus.map((c) => c.title).join(", ")}`);
  console.log(`  plugins   ${pluginSet.names.join(", ")} (${pluginSet.source})`);
  if (pluginSet.note) console.log(`  NOTE      ${pluginSet.note}`);
  console.log("");
}

// ---- measure ------------------------------------------------------------------------
const measurements: Record<string, Stats | undefined> = {};

const ks = benchKeystroke({
  doc: gen.doc,
  plugins: pluginSet.plugins,
  pluginNames: pluginSet.names,
  typingSource,
});
measurements["keystroke.state-commit"] = ks.all;

const open = benchDocOpen(gen.json, () => pluginSet.plugins);
measurements["doc.open-40k"] = open.total;

// docx import is real now, so it is measured against the real corpus rather than slotted.
const docx = await benchDocxImport();
if (docx.available && docx.large) measurements["docx.import-50p"] = docx.large;
else if (docx.available && docx.all) measurements["docx.import-50p"] = docx.all;
if (docx.available && docx.perParagraph) measurements["docx.import-throughput"] = docx.perParagraph;
if (!json && docx.available) {
  console.log(`  docx      ${docx.detail}`);
  if (docx.cold) console.log(`            cold (first import in a fresh process): p50 ${docx.cold.p50.toFixed(0)} ms, p99 ${docx.cold.p99.toFixed(0)} ms`);
  if (docx.huge) console.log(`            above the band: n=${docx.huge.n}, p50 ${docx.huge.p50.toFixed(0)} ms, p99 ${docx.huge.p99.toFixed(0)} ms`);
  console.log("");
}

// Completion runs inside state.apply on every keystroke, so it is measured against the real
// symbol table of the document above rather than a token index.
const completion = benchCompletion(gen.doc);
measurements["completion.popup-open"] = completion.worst;
if (!json) {
  console.log(`  complete  ${completion.detail}`);
  console.log("");
}

// Diagnostics: the real Harper WebAssembly over the real document. Slow enough to be worth
// saying out loud that this is where the run spends its time.
const diagnostics = await benchDiagnostics(gen.doc);
measurements["diagnostics.refresh"] = diagnostics.refresh;
if (!json) {
  console.log(`  diagnose  ${diagnostics.detail}`);
  console.log(`            cold (whole document, empty cache): p50 ${diagnostics.cold.p50.toFixed(0)} ms — reported, never gated`);
  console.log("");
}

// ---- evaluate -----------------------------------------------------------------------
const baseline = await loadBaseline();
const { checks, failed } = evaluate(measurements, baseline);

if (!json) {
  for (const c of checks) {
    const mark = { pass: "PASS", fail: "FAIL", partial: "PARTIAL", "not-implemented": "n/a", "no-measurement": "n/a" }[c.verdict];
    const head = `  ${mark.padEnd(8)} ${c.budget.path}`;
    console.log(head);
    if (c.stats) {
      console.log(`           p50 ${fmtMs(c.stats.p50)}  p95 ${fmtMs(c.stats.p95)}  p99 ${fmtMs(c.stats.p99)}   n=${c.stats.n}`);
    }
    for (const d of c.detail) console.log(`           · ${d}`);
    for (const r of c.reasons) console.log(`           ! ${r}`);
    if (c.verdict === "partial") {
      console.log(`           measures: ${c.budget.measures}`);
      console.log(`           EXCLUDES: ${c.budget.excludes.join("; ")}`);
    }
    if (c.verdict === "not-implemented") console.log(`           subsystem not built yet — reported, not gated`);
    console.log("");
  }
}

// ---- persist for the workbench page --------------------------------------------------
await mkdir("bench/out", { recursive: true }).catch(() => {});
const payload = {
  generatedAt: new Date().toISOString(),
  machine: fp,
  document: { words: gen.stats.words, blocks: gen.stats.topLevelBlocks, blockMix: gen.stats.blockMix, corpus: gen.stats.corpus },
  plugins: { source: pluginSet.source, names: pluginSet.names, note: pluginSet.note ?? null },
  keystroke: ks.all,
  docOpen: { total: open.total, fromJson: open.fromJson, stateCreate: open.stateCreate },
  docxImport: docx,
  completion: {
    worst: completion.worst, sigil: completion.sigil, typing: completion.typing,
    symbols: completion.symbols, offered: completion.offered, indexBuildMs: completion.indexBuildMs,
  },
  diagnostics: {
    refresh: diagnostics.refresh, cold: diagnostics.cold, bySeverity: diagnostics.bySeverity,
    total: diagnostics.total, blocks: diagnostics.blocks, lintedPerRefresh: diagnostics.lintedPerRefresh,
  },
  checks: checks.map((c) => ({
    id: c.id, verdict: c.verdict, path: c.budget.path, p99Budget: c.budget.p99Ms,
    mode: c.budget.mode, stats: c.stats ?? null, reasons: c.reasons,
    measures: c.budget.measures, excludes: c.budget.excludes,
  })),
  failed,
};
await Bun.write("bench/out/perf.json", JSON.stringify(payload, null, 2));

if (updateBaseline) {
  const solid: Record<string, Stats> = {};
  for (const [k, v] of Object.entries(measurements)) if (v) solid[k] = v;
  const commit = (await Bun.$`git rev-parse --short HEAD`.text().catch(() => "")).trim();
  const path = await saveBaseline(solid, commit || undefined);
  if (!json) console.log(`  baseline updated → ${path}\n`);
}

if (json) console.log(JSON.stringify(payload, null, 2));
else console.log(failed ? "  GATE: FAIL\n" : "  GATE: pass\n");

process.exit(failed ? 1 : 0);
