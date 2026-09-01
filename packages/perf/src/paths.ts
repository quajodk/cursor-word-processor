import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

/**
 * Repo root, found by walking up from this file to the directory holding the workspace
 * root package.json. Not cwd — `bun run perf` runs with cwd=packages/perf, and the
 * corpus and baselines live at the root.
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg) && existsSync(join(dir, "packages")) && existsSync(join(dir, "apps"))) return dir;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  throw new Error("could not locate scriv repo root from " + import.meta.url);
}

export const benchOutDir = () => join(repoRoot(), "bench", "out");
export const baselinePath = () => join(benchOutDir(), "perf-baseline.json");
export const reportPath = () => join(benchOutDir(), "perf-report.json");
export const docCachePath = () => join(benchOutDir(), "corpus-doc-40k.json");
