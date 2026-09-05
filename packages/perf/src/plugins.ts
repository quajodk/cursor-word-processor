/**
 * The plugin stack under test.
 *
 * A keystroke benchmark that runs a plugin set the app does not actually use measures
 * nothing. As features land — diagnostics decorations, comment anchors, tracked changes,
 * AI ghost text — every one of them adds a `state.apply` and possibly an
 * `appendTransaction` to the hot path, and the benchmark has to see them or it will keep
 * reporting a number that got stale months ago.
 *
 * So the plugin set is a parameter, and the harness prefers the app's own registration:
 *
 *   apps/web/src/perf-plugins.ts   →   export function scrivPlugins(): Plugin[]
 *
 * That file is the contract with whoever owns apps/web. When it does not exist we fall
 * back to the baseline stack and the report says so, in the header, every run — because a
 * number produced from a stack smaller than the real one is a floor, not a measurement.
 */

import type { Plugin } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { aidPlugin } from "@scriv/doc-model";
import { history } from "prosemirror-history";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./paths";

export interface PluginSet {
  plugins: Plugin[];
  /** Where the stack came from. Printed on every report. */
  source: "apps/web" | "baseline";
  names: string[];
  /** Non-empty when we could not use the app's stack. Printed as a warning. */
  note?: string;
}

/**
 * The stack we know exists today: block identity (runs on every transaction, by design)
 * and undo history (runs on every transaction, unavoidably).
 *
 * Deliberately NOT included, because including them would be inventing the app:
 *   - keymaps: `keymap()` contributes only `props.handleKeyDown`, which the view calls.
 *     It costs nothing in `state.apply` and adding it would pad the stack for show.
 *   - input rules: same — `props.handleTextInput`, view-side. See METHODOLOGY.md.
 */
export function baselinePlugins(): PluginSet {
  return {
    plugins: [aidPlugin(), history()],
    source: "baseline",
    names: ["aidPlugin", "history"],
    note:
      "apps/web/src/perf-plugins.ts does not exist. Measured against the baseline stack " +
      "(aidPlugin + history) only. Every number below is a LOWER BOUND on the real editor.",
  };
}

/**
 * Attempts the app's stack, falls back to baseline. Never throws: a broken app must not
 * be able to make the perf gate silently vanish, but it must not crash it either — it
 * degrades to the floor measurement and says so.
 */
export async function resolvePlugins(doc?: PMNode): Promise<PluginSet> {
  const candidate = join(repoRoot(), "apps", "web", "src", "perf-plugins.ts");
  if (!existsSync(candidate)) return baselinePlugins();
  try {
    const mod = (await import(candidate)) as { scrivPlugins?: (doc?: PMNode) => Plugin[] };
    if (typeof mod.scrivPlugins !== "function") {
      const b = baselinePlugins();
      return { ...b, note: `${candidate} exists but exports no scrivPlugins(). ${b.note}` };
    }
    // The document is passed so the app can seed anything whose cost depends on document
    // size — the completion symbol table above all. A stack wired against an empty index
    // measures the cheapest possible completion and reports it as the editor's.
    const plugins = mod.scrivPlugins(doc);
    if (!Array.isArray(plugins) || plugins.length === 0) {
      const b = baselinePlugins();
      return { ...b, note: `${candidate} scrivPlugins() returned nothing usable. ${b.note}` };
    }
    return {
      plugins,
      source: "apps/web",
      names: plugins.map((p, i) => (p.spec.key as { key?: string } | undefined)?.key ?? `plugin[${i}]`),
      // Named even on the success path. `diagnosticsPlugin` builds a `Worker` in `view()`,
      // which a headless process has none of, so the app's own stack omits it here. Saying
      // "source: apps/web" without saying that would overstate the coverage.
      note:
        "diagnosticsPlugin is absent: it constructs a Worker in view(), and this process has " +
        "no view. Its cost is measured separately as diagnostics.refresh.",
    };
  } catch (err) {
    const b = baselinePlugins();
    return { ...b, note: `importing ${candidate} threw: ${String(err)}. ${b.note}` };
  }
}
