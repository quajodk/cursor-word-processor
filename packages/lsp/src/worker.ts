/// <reference lib="webworker" />
import { createHarperProvider } from "./harper";
import { IncrementalLinter } from "./incremental";
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
 *
 * Requests are served INCREMENTALLY (see `incremental.ts`) and PREEMPTIVELY. Preemption is
 * the part that is easy to leave out and expensive to omit: a first pass over a long document
 * takes seconds, and without a yield point the worker cannot even receive the message saying
 * the text has moved on. Every keystroke during that window would queue, and the writer would
 * watch stale squiggles for as long as the backlog took to drain.
 */

const provider = createHarperProvider();
const linter = new IncrementalLinter(provider);

/** Only the newest request matters; an older pass abandons itself at its next yield point. */
let latest = 0;

self.onmessage = async (ev: MessageEvent<DiagnoseRequest>) => {
  const req = ev.data;
  latest = Math.max(latest, req.version);
  const started = performance.now();

  const post = (res: DiagnoseResponse) => (self as unknown as Worker).postMessage(res);

  try {
    const result = await linter.run(req, {
      isStale: () => req.version < latest,
      // Partial results are posted as they are computed so a long document fills in from the
      // top rather than staying blank. They carry the same version, and the client's
      // `res.version <= answered` guard would drop every one of them as a duplicate — so
      // they are marked `partial` and the client admits them explicitly.
      onProgress: (p) =>
        post({
          version: req.version,
          diagnostics: p.diagnostics,
          elapsedMs: performance.now() - started,
          partial: true,
          linted: p.linted,
          cached: p.cached,
          pending: p.pending,
        }),
    });

    // An abandoned pass is not an answer. Posting it would let a half-scanned document
    // overwrite a complete one, and the squiggles below the abandonment point would vanish.
    if (!result.done) return;

    post({
      version: req.version,
      diagnostics: result.diagnostics,
      elapsedMs: performance.now() - started,
      linted: result.linted,
      cached: result.cached,
      pending: 0,
    });
  } catch (e) {
    post({
      version: req.version,
      diagnostics: [],
      elapsedMs: performance.now() - started,
      error: (e as Error).message,
    });
  }
};

// Warm the binary immediately so the first real request does not pay the compile.
void provider.setup();
