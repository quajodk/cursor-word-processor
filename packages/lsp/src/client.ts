import type { DiagnoseResponse, Diagnostic } from "./types";

/**
 * The main-thread half of the diagnostics worker.
 *
 * Three behaviours matter more than the transport:
 *
 * DEBOUNCE, because a checker that runs on every keystroke is both wasteful and distracting —
 * squiggles appearing under a half-typed word are noise, and the writer will finish the word
 * in a moment anyway.
 *
 * VERSIONING, because responses arrive out of order. A slow request issued three keystrokes
 * ago must not overwrite the answer to the current text, or diagnostics visibly flicker
 * between stale and fresh. Every request carries a version and anything older than the newest
 * answer is dropped on arrival.
 *
 * PARTIALS, because the first pass over a long document takes seconds. The worker streams
 * what it knows so far under the same version, and those must be admitted — the naive
 * `version <= answered` guard that protects against out-of-order arrival would otherwise
 * discard every one of them, since a partial and its final answer share a version.
 */

export interface DiagnosticsClientOptions {
  /** Quiet period after the last edit before linting. Default 300 ms. */
  debounceMs?: number;
  /** Called whenever a fresh result arrives for the current text. */
  onDiagnostics: (diagnostics: Diagnostic[], meta: DiagnosticsMeta) => void;
  onError?: (message: string) => void;
}

export interface DiagnosticsMeta {
  elapsedMs: number;
  version: number;
  /** True while the document is still being scanned; more diagnostics are coming. */
  partial: boolean;
  /** Segments checked / reused / still outstanding. Absent from a checker that has no cache. */
  linted?: number;
  cached?: number;
  pending?: number;
}

export class DiagnosticsClient {
  private version = 0;
  /** Newest version for which a COMPLETE answer has been shown. */
  private answered = -1;
  /** Newest version for which anything at all has been shown, complete or partial. */
  private seen = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { text: string; language?: string } | null = null;
  private readonly debounceMs: number;

  constructor(private readonly worker: Worker, private readonly opts: DiagnosticsClientOptions) {
    this.debounceMs = opts.debounceMs ?? 300;
    this.worker.onmessage = (ev: MessageEvent<DiagnoseResponse>) => {
      const res = ev.data;
      // Out-of-order arrival: an older answer must never replace a newer one. A partial for
      // the version already completely answered is stale by the same rule.
      if (res.version < this.seen) return;
      if (res.version === this.answered) return;

      this.seen = res.version;
      if (!res.partial) this.answered = res.version;

      if (res.error) this.opts.onError?.(res.error);
      else {
        this.opts.onDiagnostics(res.diagnostics, {
          elapsedMs: res.elapsedMs,
          version: res.version,
          partial: res.partial === true,
          linted: res.linted,
          cached: res.cached,
          pending: res.pending,
        });
      }
    };
  }

  /** Ask for diagnostics on this text. Coalesces; only the last call in a quiet period runs. */
  request(text: string, language?: string): void {
    this.pending = { text, language };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const p = this.pending;
      if (!p) return;
      this.pending = null;
      this.worker.postMessage({ version: ++this.version, text: p.text, language: p.language });
    }, this.debounceMs);
  }

  /** Drop any queued request, e.g. when the document closes. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  destroy(): void {
    this.cancel();
    this.worker.terminate();
  }
}
