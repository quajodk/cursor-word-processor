import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { Glob } from "bun";

/**
 * The layering rule, enforced.
 *
 * ARCHITECTURE.md §1 states the hard rule — "nothing above the seam may import `node:fs`,
 * `node:child_process`, or call `fetch` at an absolute URL" — and then says "the audit agent
 * enforces this with a lint rule, not with good intentions."
 *
 * There was no lint rule. There is no linter in the repo at all. The sentence was good
 * intentions describing itself as their opposite, which is the worst of both: the rule read
 * as enforced, so nobody checked it.
 *
 * This is the enforcement. It runs in `bun test` with everything else, so it fails the build
 * the same way a broken round trip does. It is a source scan rather than a lint plugin
 * deliberately: the rule is about a handful of module specifiers, and a rule you can read in
 * thirty lines is a rule people will keep true.
 *
 * WHY IT MATTERS BEYOND TIDINESS: v2 is Tauri. Every `node:fs` above the seam is a call that
 * has no meaning in a Tauri webview and has to be found and rewritten at port time. The seam
 * exists so that porting is implementing one interface, not auditing forty files.
 */

function repoRoot(): string {
  let d = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "bun.lock"))) return d;
    d = dirname(d);
  }
  return d;
}

const root = repoRoot();

/**
 * Below the seam: these ARE the host implementations, so touching the disk is their job.
 * Everything else in `apps/` and `packages/` is above it.
 */
const BELOW_THE_SEAM = [
  "apps/server/",
  // Benchmarks and corpus tooling read the corpus off disk by definition. They are developer
  // tools that never ship in the app or in a Tauri bundle.
  "packages/perf/",
  "packages/ooxml/src/bench/",
  // A `scripts/` directory is a developer command run by hand, never imported by src and
  // never bundled. Verified below rather than assumed: the test asserts nothing under src/
  // reaches into scripts/, so this exclusion cannot become a hole.
  "packages/ooxml/scripts/",
  "workbench/",
];

/** Node built-ins that mean "I am talking to the machine". */
const FORBIDDEN_MODULES = [
  "node:fs", "node:fs/promises", "node:child_process", "node:os", "node:process",
  "node:net", "node:http", "node:https", "node:dgram", "node:cluster", "node:worker_threads",
];

interface Violation { file: string; line: number; what: string; text: string }

function scan(): Violation[] {
  const out: Violation[] = [];
  for (const rel of new Glob("{apps,packages}/**/*.{ts,tsx}").scanSync(root)) {
    const posix = rel.split("\\").join("/");
    if (posix.includes("/node_modules/") || posix.includes("/dist/")) continue;
    // Tests may read the corpus: they are not shipped and not ported.
    if (/(^|\/)test\//.test(posix) || posix.endsWith(".test.ts") || posix.endsWith(".test.tsx")) continue;
    if (BELOW_THE_SEAM.some((p) => posix.startsWith(p))) continue;

    const text = readFileSync(join(root, rel), "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;

      for (const mod of FORBIDDEN_MODULES) {
        // `from "node:fs"` or `require("node:fs")` — not the string appearing in prose.
        if (new RegExp(`(from|require\\()\\s*["']${mod.replace("/", "\\/")}["']`).test(line)) {
          out.push({ file: posix, line: i + 1, what: mod, text: line.trim() });
        }
      }
      // An absolute URL in a fetch is the network equivalent of reaching for the disk.
      const fetchAbs = /\bfetch\s*\(\s*[`"']https?:\/\//.exec(line);
      if (fetchAbs) out.push({ file: posix, line: i + 1, what: "fetch at an absolute URL", text: line.trim() });
    }
  }
  return out;
}

describe("the host seam (ARCHITECTURE.md §1)", () => {
  test("the scan actually sees the source tree", () => {
    // A glob that matched nothing would make every assertion below vacuous.
    let n = 0;
    for (const rel of new Glob("{apps,packages}/**/*.{ts,tsx}").scanSync(root)) {
      if (!rel.includes("node_modules") && !rel.includes("dist/")) n++;
    }
    expect(n).toBeGreaterThan(80);
  });

  test("nothing above the seam imports the machine", () => {
    const violations = scan();
    expect(violations.map((v) => `${v.file}:${v.line}  ${v.what}  —  ${v.text}`)).toEqual([]);
  });

  test("the rule would catch a violation if one were introduced", () => {
    // The scanner is only worth having if it can fail. This exercises the same regexes the
    // scan uses, against text that should trip every one of them.
    const sample = [
      `import { readFileSync } from "node:fs";`,
      `const cp = require("node:child_process");`,
      `await fetch("https://example.com/x");`,
    ];
    const hits = sample.filter((line) =>
      FORBIDDEN_MODULES.some((m) => new RegExp(`(from|require\\()\\s*["']${m.replace("/", "\\/")}["']`).test(line))
      || /\bfetch\s*\(\s*[`"']https?:\/\//.test(line),
    );
    expect(hits).toEqual(sample);
  });

  test("the excluded developer scripts are not reachable from shipped code", () => {
    // The exclusion above is only safe while nothing above the seam imports them. If some
    // src/ file started pulling in a script, the script's `node:fs` would be back in the
    // shipped graph and the exclusion would be hiding it.
    const leaks: string[] = [];
    for (const rel of new Glob("{apps,packages}/**/src/**/*.{ts,tsx}").scanSync(root)) {
      const posix = rel.split("\\").join("/");
      if (posix.includes("/node_modules/") || posix.includes("/dist/")) continue;
      // A tool importing its own bench modules is not a leak: it is below the seam already.
      if (BELOW_THE_SEAM.some((p) => posix.startsWith(p))) continue;
      const text = readFileSync(join(root, rel), "utf8");
      if (/from\s+["'][^"']*\/(scripts|bench)\//.test(text)) leaks.push(posix);
    }
    expect(leaks).toEqual([]);
  });

  test("no compiled output is sitting beside the sources", () => {
    // A failed `tsc -b` once left .js/.d.ts/.js.map files next to their .ts sources in
    // apps/web/src. That is worse than untidy: Vite resolves a bare specifier to the .js
    // first, so a stale build artifact silently shadows the file you are editing. The cause
    // (packages/perf statically importing apps/web) is fixed; this is the tripwire.
    const stray: string[] = [];
    for (const rel of new Glob("{apps,packages}/**/src/**/*.{js,mjs,cjs,d.ts,js.map}").scanSync(root)) {
      const posix = rel.split("\\").join("/");
      if (posix.includes("/node_modules/") || posix.includes("/dist/")) continue;
      stray.push(posix);
    }
    expect(stray).toEqual([]);
  });

  test("apps/server is below the seam and does import the machine", () => {
    // The inverse check: if the host implementation stopped touching the disk, either it has
    // moved somewhere unexpected or the exclusion list is stale and hiding real violations.
    const server = readFileSync(join(root, "apps/server/src/fsops.ts"), "utf8");
    expect(/from\s+["']node:fs/.test(server)).toBe(true);
  });
});
