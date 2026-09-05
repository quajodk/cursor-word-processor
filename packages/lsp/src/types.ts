/**
 * Prose diagnostics, behind an LSP-shaped interface.
 *
 * Harper is the checker we ship, but the interface is deliberately checker-agnostic. Vale
 * enforces a house style, textlint has its own rule ecosystem, and a project will eventually
 * want more than one at once. Shaping this like `textDocument/publishDiagnostics` from the
 * start means adding the second checker is a new provider rather than a refactor — and it is
 * what makes the feature read as IDE machinery rather than as a spell-check widget.
 *
 * Deliberately NOT the real LSP wire protocol: there is no process to talk to. Harper is
 * WebAssembly running in a worker, so the transport is `postMessage` and the protocol is the
 * subset of LSP that has meaning here.
 */

export type Severity = "error" | "warning" | "info" | "hint";

export interface Diagnostic {
  /** Character offsets into the text that was linted. */
  from: number;
  to: number;
  message: string;
  severity: Severity;
  /** Which checker produced this, e.g. "harper". Shown to the reader. */
  source: string;
  /** The rule, e.g. "Spelling". Used for filtering and for ignore-rules. */
  code: string;
  /** Replacements that resolve it, best first. */
  fixes: Fix[];
}

export interface Fix {
  title: string;
  /** Replacement for [from, to). Empty string means "delete the range". */
  replacement: string;
}

export interface DiagnoseRequest {
  /** Monotonic; a response for an older version than the latest is discarded. */
  version: number;
  text: string;
  /** BCP-47. A checker with no support for it should return nothing, not guesses. */
  language?: string;
}

export interface DiagnoseResponse {
  version: number;
  diagnostics: Diagnostic[];
  /** Milliseconds spent inside the checker, for the latency budget. */
  elapsedMs: number;
  /**
   * A result for part of the document, sent while the rest is still being checked.
   *
   * A long document takes seconds on its first pass. Withholding everything until the end
   * means the writer stares at unmarked text for that whole time; sending what is known so
   * far means the squiggles fill in from the top. A partial NEVER carries fewer diagnostics
   * than a previous partial of the same version, so the display only ever grows.
   */
  partial?: boolean;
  /** Segments run through the checker this pass. Zero on a fully cached refresh. */
  linted?: number;
  /** Segments answered from cache. */
  cached?: number;
  /** Segments not yet reached. Non-zero only on a partial. */
  pending?: number;
  error?: string;
}

/** A checker. Implementations must be pure with respect to the text they are given. */
export interface DiagnosticProvider {
  readonly id: string;
  /** Called once; may download or compile. */
  setup(): Promise<void>;
  diagnose(req: DiagnoseRequest): Promise<Diagnostic[]>;
}
