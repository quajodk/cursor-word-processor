/**
 * Percentiles, and the honesty checks that go with them.
 *
 * Two rules this file exists to enforce:
 *
 *  1. **No outlier removal.** A 40 ms GC pause is a frame the writer dropped. Trimming it
 *     because it is "not representative" is exactly how a perf gate starts lying. Every
 *     sample collected is in the distribution.
 *  2. **Nearest-rank percentiles, not interpolated.** For a latency tail you want a value
 *     that actually occurred. Interpolating between the 148th and 149th sample invents a
 *     number no keystroke ever took.
 */

export interface Stats {
  n: number;
  /** Samples discarded before measurement began. */
  warmup: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  p999: number;
  max: number;
  mean: number;
  stddev: number;
  /**
   * How many samples sit at or above p99. Below ~30 the p99 is an anecdote; the report
   * prints a warning. This is the number that tells you whether to trust the tail.
   */
  tailSupport: number;
  /**
   * Median absolute deviation / median. A cheap read on how noisy the machine was.
   * Above ~0.5 on a keystroke bench means something else was running.
   */
  relativeMad: number;
}

/** Nearest-rank percentile. `sorted` must be ascending. */
export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil(q * sorted.length);
  const i = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[i]!;
}

export function summarize(samples: readonly number[], warmup = 0): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return {
      n: 0, warmup, min: NaN, p50: NaN, p95: NaN, p99: NaN, p999: NaN, max: NaN,
      mean: NaN, stddev: NaN, tailSupport: 0, relativeMad: NaN,
    };
  }
  let sum = 0;
  for (const v of sorted) sum += v;
  const mean = sum / n;
  let sq = 0;
  for (const v of sorted) sq += (v - mean) * (v - mean);
  const stddev = Math.sqrt(sq / n);

  const p50 = percentile(sorted, 0.5);
  const p99 = percentile(sorted, 0.99);

  const devs = sorted.map((v) => Math.abs(v - p50)).sort((a, b) => a - b);
  const mad = percentile(devs, 0.5);

  let tailSupport = 0;
  for (let i = n - 1; i >= 0 && sorted[i]! >= p99; i--) tailSupport++;

  return {
    n,
    warmup,
    min: sorted[0]!,
    p50,
    p95: percentile(sorted, 0.95),
    p99,
    p999: percentile(sorted, 0.999),
    max: sorted[n - 1]!,
    mean,
    stddev,
    tailSupport,
    relativeMad: p50 > 0 ? mad / p50 : 0,
  };
}

export function fmtMs(v: number): string {
  if (!Number.isFinite(v)) return "   --  ";
  if (v >= 100) return v.toFixed(0).padStart(7);
  if (v >= 10) return v.toFixed(2).padStart(7);
  if (v >= 1) return v.toFixed(3).padStart(7);
  return v.toFixed(4).padStart(7);
}
