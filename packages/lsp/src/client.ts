import type { DiagnoseResponse, Diagnostic } from "./types";

/**
 * The main-thread half of the diagnostics worker.
 *
 * Two behaviours matter more than the transport:
 *
 * DEBOUNCE, because a checker that runs on every keystroke is both wasteful and distracting —
 * squiggles appearing under a half-typed word are noise, and the writer will finish the word
 * in a moment anyway.
 *
 * VERSIONING, because responses arrive out of order. A slow request issued three keystrokes
 * ago must not overwrite the answer to the current text, or diagnostics visibly flicker
 * between stale and fresh. Every request carries a version and anything older than the newest
 * answer is dropped on arrival.
 */

export interface DiagnosticsClientOptions {
  /** Quiet period after the last edit before linting. Default 300 ms. */
  debounceMs?: number;
  /** Called whenever a fresh result arrives for the current text. */
  onDiagnostics: (diagnostics: Diagnostic[], meta: { elapsedMs: number; version: number }) => void;
  onError?: (message: string) => void;
}

export class DiagnosticsClient {
  private version = 0;
  private answered = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { text: string; language?: string } | null = null;
  private readonly debounceMs: number;

  constructor(private readonly worker: Worker, private readonly opts: DiagnosticsClientOptions) {
    this.debounceMs = opts.debounceMs ?? 300;
    this.worker.onmessage = (ev: MessageEvent<DiagnoseResponse>) => {
      const res = ev.data;
      // Out-of-order arrival: an older answer must never replace a newer one.
      if (res.version <= this.answered) return;
      this.answered = res.version;
      if (res.error) this.opts.onError?.(res.error);
      else this.opts.onDiagnostics(res.diagnostics, { elapsedMs: res.elapsedMs, version: res.version });
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
