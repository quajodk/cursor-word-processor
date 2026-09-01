/**
 * The gate. Turns measurements into an exit code.
 *
 * Two independent checks per metric:
 *
 *   ABSOLUTE   — p99 against the ARCHITECTURE §5 budget. Catches "this is now too slow
 *                for a human". Machine-independent in intent, machine-dependent in fact.
 *
 *   RELATIVE   — p99 (and p50) against the stored baseline for THIS machine. Catches the
 *                commit that doubled latency while staying inside budget, which is the
 *                commit you actually want to find: budgets are cliffs, baselines are the
 *                slope leading to them.
 *
 * Baselines are stored PER MACHINE. A baseline recorded on an M-series laptop compared
 * against a shared CI runner is not a regression signal, it is a hardware difference
 * wearing one. When the fingerprint does not match, the relative check is skipped and the
 * report says so rather than firing a false alarm — a perf gate that cries wolf gets
 * disabled within a month, and then the house rule is a comment in a markdown file.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { BUDGETS, REGRESSION, type Budget } from "./budgets";
import type { Stats } from "./stats";
import { baselinePath, benchOutDir } from "./paths";

export interface Fingerprint {
  platform: string;
  arch: string;
  cpu: string;
  cores: number;
  totalMemGb: number;
  runtime: string;
}

export function fingerprint(): Fingerprint {
  const cpus = os.cpus();
  return {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: cpus[0]?.model ?? "unknown",
    cores: cpus.length,
    totalMemGb: Math.round(os.totalmem() / 1073741824),
    runtime: `bun ${typeof Bun !== "undefined" ? Bun.version : "?"}`,
  };
}

export function fingerprintKey(f: Fingerprint): string {
  return createHash("sha256")
    .update([f.platform, f.arch, f.cpu, f.cores, f.totalMemGb, f.runtime].join("|"))
    .digest("hex")
    .slice(0, 16);
}

export interface BaselineMetric { p50: number; p95: number; p99: number; n: number }
export interface BaselineMachine {
  fingerprint: Fingerprint;
  updatedAt: string;
  gitCommit?: string;
  metrics: Record<string, BaselineMetric>;
}
export interface BaselineFile {
  version: 1;
  note: string;
  machines: Record<string, BaselineMachine>;
}

export async function loadBaseline(): Promise<BaselineFile | null> {
  const p = baselinePath();
  if (!existsSync(p)) return null;
  try { return JSON.parse(await readFile(p, "utf8")) as BaselineFile; }
  catch { return null; }
}

export async function saveBaseline(
  metrics: Record<string, Stats>,
  gitCommit?: string,
): Promise<string> {
  const fp = fingerprint();
  const key = fingerprintKey(fp);
  const existing = (await loadBaseline()) ?? {
    version: 1 as const,
    note:
      "Per-machine perf baselines for scriv. Regression checks compare only within the " +
      "same fingerprint; a different machine skips the relative check rather than " +
      "reporting a false regression. Regenerate with: bun run perf --update-baseline",
    machines: {},
  };
  const out: Record<string, BaselineMetric> = {};
  for (const [id, s] of Object.entries(metrics)) {
    if (!Number.isFinite(s.p99)) continue;
    out[id] = { p50: s.p50, p95: s.p95, p99: s.p99, n: s.n };
  }
  existing.machines[key] = { fingerprint: fp, updatedAt: new Date().toISOString(), gitCommit, metrics: out };
  await mkdir(benchOutDir(), { recursive: true });
  await writeFile(baselinePath(), JSON.stringify(existing, null, 2) + "\n", "utf8");
  return key;
}

export type Verdict = "pass" | "fail" | "partial" | "not-implemented" | "no-measurement";

export interface Check {
  id: string;
  budget: Budget;
  stats?: Stats;
  verdict: Verdict;
  reasons: string[];
  /** Rendered lines describing each check performed, pass or fail. */
  detail: string[];
}

export function evaluate(
  measurements: Record<string, Stats | undefined>,
  baseline: BaselineFile | null,
): { checks: Check[]; failed: boolean } {
  const key = fingerprintKey(fingerprint());
  const base = baseline?.machines[key];
  const checks: Check[] = [];

  for (const budget of Object.values(BUDGETS)) {
    const stats = measurements[budget.id];
    const reasons: string[] = [];
    const detail: string[] = [];

    if (budget.mode === "not-implemented") {
      checks.push({ id: budget.id, budget, verdict: "not-implemented", reasons: [], detail: [] });
      continue;
    }
    if (!stats || !Number.isFinite(stats.p99)) {
      checks.push({
        id: budget.id, budget, verdict: "no-measurement",
        reasons: ["no samples were collected"], detail: [],
      });
      continue;
    }

    // --- absolute ---
    const overBudget = stats.p99 > budget.p99Ms;
    detail.push(
      `absolute p99 ${stats.p99.toFixed(3)} ms vs budget ${budget.p99Ms} ms — ` +
      (overBudget ? "OVER" : `under (${((1 - stats.p99 / budget.p99Ms) * 100).toFixed(0)}% headroom)`),
    );
    if (overBudget) reasons.push(`p99 ${stats.p99.toFixed(3)} ms exceeds the ${budget.p99Ms} ms budget`);

    if (budget.p50Ms !== undefined) {
      const over50 = stats.p50 > budget.p50Ms;
      detail.push(`absolute p50 ${stats.p50.toFixed(3)} ms vs budget ${budget.p50Ms} ms — ${over50 ? "OVER" : "under"}`);
      if (over50) reasons.push(`p50 ${stats.p50.toFixed(3)} ms exceeds the ${budget.p50Ms} ms p50 budget`);
    }

    // --- relative ---
    const b = base?.metrics[budget.id];
    if (!base) {
      detail.push("relative: no baseline for this machine yet — run with --update-baseline to record one");
    } else if (!b) {
      detail.push(`relative: no baseline entry for ${budget.id} on this machine`);
    } else {
      const dP99 = stats.p99 - b.p99;
      const rP99 = b.p99 > 0 ? dP99 / b.p99 : 0;
      const regressed99 = rP99 > REGRESSION.p99Tolerance && dP99 > REGRESSION.minDeltaMs;
      detail.push(
        `relative p99 ${stats.p99.toFixed(3)} vs baseline ${b.p99.toFixed(3)} ms ` +
        `(${rP99 >= 0 ? "+" : ""}${(rP99 * 100).toFixed(1)}%, tolerance +${(REGRESSION.p99Tolerance * 100).toFixed(0)}% ` +
        `and >${REGRESSION.minDeltaMs} ms) — ${regressed99 ? "REGRESSED" : "ok"}`,
      );
      if (regressed99) {
        reasons.push(
          `p99 regressed ${(rP99 * 100).toFixed(1)}% against this machine's baseline ` +
          `(${b.p99.toFixed(3)} → ${stats.p99.toFixed(3)} ms), still under the ${budget.p99Ms} ms budget`,
        );
      }

      const dP50 = stats.p50 - b.p50;
      const rP50 = b.p50 > 0 ? dP50 / b.p50 : 0;
      const regressed50 = rP50 > REGRESSION.p50Tolerance && dP50 > REGRESSION.minDeltaMs;
      detail.push(
        `relative p50 ${stats.p50.toFixed(3)} vs baseline ${b.p50.toFixed(3)} ms ` +
        `(${rP50 >= 0 ? "+" : ""}${(rP50 * 100).toFixed(1)}%) — ${regressed50 ? "REGRESSED" : "ok"}`,
      );
      if (regressed50) {
        reasons.push(`p50 regressed ${(rP50 * 100).toFixed(1)}% against baseline (${b.p50.toFixed(3)} → ${stats.p50.toFixed(3)} ms)`);
      }
    }

    // --- tail credibility ---
    if (stats.tailSupport < 30) {
      detail.push(`tail support: only ${stats.tailSupport} samples at or above p99 — the p99 is weakly estimated`);
    }
    if (stats.relativeMad > 0.5) {
      detail.push(`noise: relative MAD ${stats.relativeMad.toFixed(2)} — the machine was busy; treat this run as soft`);
    }

    const verdict: Verdict = reasons.length > 0 ? "fail" : budget.mode === "lower-bound" ? "partial" : "pass";
    checks.push({ id: budget.id, budget, stats, verdict, reasons, detail });
  }

  return { checks, failed: checks.some((c) => c.verdict === "fail") };
}
