/**
 * Harness slots for subsystems that do not exist yet.
 *
 * These are deliberately empty of measurement. The temptation with a slot like
 * "completion popup open: 40 ms" is to time *something* — a stub, a fixture, a synthetic
 * filter over a fake symbol table — so the report has a green row. That number would be
 * a measurement of the harness measuring itself, and the first person to read the report
 * would believe scriv had a working completion engine that met budget.
 *
 * So each slot probes for the real implementation and reports `not-implemented` until it
 * finds one. The wiring below is the whole contract: land the export, get the number.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../paths";

export interface SlotProbe {
  id: string;
  pkg: string;
  /** The export this slot will call once it exists. */
  expects: string;
  implemented: boolean;
  detail: string;
}

function pkgHasSource(pkg: string): { has: boolean; files: string[] } {
  const dir = join(repoRoot(), "packages", pkg, "src");
  if (!existsSync(dir)) return { has: false, files: [] };
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
  return { has: files.length > 0, files };
}

export function probeSlots(): SlotProbe[] {
  const specs: Omit<SlotProbe, "implemented" | "detail">[] = [
    {
      id: "completion.popup-open",
      pkg: "intellisense",
      expects: "@scriv/intellisense → completionSources() / a source with resolve(state, pos)",
    },
    {
      id: "diagnostics.refresh",
      pkg: "lsp",
      expects: "@scriv/lsp → a worker entry + client with diagnose(text): Promise<Diagnostic[]>",
    },
    {
      id: "docx.import-50p",
      pkg: "ooxml",
      expects: "@scriv/ooxml → importDocx(bytes): { doc, sidecar }",
    },
  ];

  return specs.map((s) => {
    const { has, files } = pkgHasSource(s.pkg);
    return {
      ...s,
      implemented: has,
      detail: has
        ? `packages/${s.pkg}/src has ${files.length} file(s) — wire the slot in src/bench/slots.ts`
        : `packages/${s.pkg}/src is empty. Nothing to measure; nothing measured.`,
    };
  });
}

/**
 * Diagnostics has a second, non-latency assertion in §5: "off main thread". When
 * @scriv/lsp lands, this slot must ALSO verify that the diagnostics round-trip happens in
 * a Worker — a 150 ms budget met on the main thread is 150 ms of dropped frames and
 * passes the latency check while violating the actual requirement. The check is a
 * long-task observation in the browser harness during a diagnostics refresh, not a
 * code-inspection.
 */
export const DIAGNOSTICS_OFF_MAIN_THREAD_CHECK =
  "unimplemented: requires @scriv/lsp worker + browser long-task observation";
