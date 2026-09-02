/// <reference lib="webworker" />
import { LocalLinter } from "harper.js";
import { binaryInlined } from "harper.js/binaryInlined";
import { HarperProvider } from "./harper";
import type { DiagnoseRequest, DiagnoseResponse } from "./types";

/**
 * The diagnostics worker.
 *
 * Diagnostics run off the main thread because ARCHITECTURE.md §5 budgets them at 150 ms and
 * the keystroke path at 8 ms — a checker that took even 40 ms on the main thread would be
 * five keystrokes' worth of budget spent on something the writer did not ask for.
 *
 * The WebAssembly binary is INLINED rather than fetched. Local-first means the editor works
 * with the network unplugged, and a checker that silently stops working offline is a checker
 * you cannot trust.
 */

const provider = new HarperProvider(() => new LocalLinter({ binary: binaryInlined }));

/** Only the newest request matters; anything older is answered but marked stale by version. */
let latest = 0;

self.onmessage = async (ev: MessageEvent<DiagnoseRequest>) => {
  const req = ev.data;
  latest = Math.max(latest, req.version);
  const started = performance.now();
  try {
    const diagnostics = await provider.diagnose(req);
    const res: DiagnoseResponse = {
      version: req.version,
      diagnostics,
      elapsedMs: performance.now() - started,
    };
    (self as unknown as Worker).postMessage(res);
  } catch (e) {
    const res: DiagnoseResponse = {
      version: req.version,
      diagnostics: [],
      elapsedMs: performance.now() - started,
      error: (e as Error).message,
    };
    (self as unknown as Worker).postMessage(res);
  }
};

// Warm the binary immediately so the first real request does not pay the compile.
void provider.setup();
