import { LocalLinter, type Lint, type Linter } from "harper.js";
import type { Diagnostic, DiagnoseRequest, DiagnosticProvider, Fix, Severity } from "./types";

/**
 * Harper, wrapped as a diagnostic provider.
 *
 * Harper is Rust compiled to WebAssembly and runs entirely locally, which is why it was
 * chosen over LanguageTool: no process to manage, no network, and the same build works in the
 * browser today and inside Tauri later.
 */

/**
 * Harper's lint kinds mapped onto severities.
 *
 * A misspelling is worth interrupting for; a readability note is not. Everything unrecognised
 * falls to "info" rather than being assumed important — Harper adds rules between releases,
 * and a new rule should not start out shouting.
 */
const SEVERITY: Record<string, Severity> = {
  Spelling: "warning",
  Typo: "warning",
  Agreement: "warning",
  BoundaryError: "warning",
  Capitalization: "warning",
  Grammar: "warning",
  Malapropism: "warning",
  Punctuation: "info",
  Repetition: "warning",
  Redundancy: "info",
  Enhancement: "hint",
  Readability: "hint",
  Style: "hint",
  WordChoice: "hint",
  Regionalism: "hint",
  Formatting: "hint",
  Miscellaneous: "info",
};

export class HarperProvider implements DiagnosticProvider {
  readonly id = "harper";
  private linter: Linter | null = null;
  private ready: Promise<void> | null = null;

  constructor(private readonly makeLinter: () => Linter) {}

  async setup(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const linter = this.makeLinter();
        await linter.setup();
        this.linter = linter;
      })();
    }
    return this.ready;
  }

  async diagnose(req: DiagnoseRequest): Promise<Diagnostic[]> {
    // Harper is an English checker. Running it over Hindi or Polish would produce a wall of
    // false spelling errors, which is worse than no diagnostics at all, so it declines.
    if (req.language && !/^en\b/i.test(req.language)) return [];

    await this.setup();
    const linter = this.linter;
    if (!linter) return [];

    const lints = await linter.lint(req.text);
    return lints.map((l) => toDiagnostic(l, this.id));
  }
}

function toDiagnostic(lint: Lint, source: string): Diagnostic {
  const span = lint.span();
  const kind = lint.lint_kind();
  const fixes: Fix[] = lint.suggestions().map((s) => {
    const replacement = s.get_replacement_text();
    return {
      title: replacement.length > 0 ? `Replace with “${replacement}”` : "Remove",
      replacement,
    };
  });
  return {
    from: span.start,
    to: span.end,
    message: lint.message(),
    severity: SEVERITY[kind] ?? "info",
    source,
    code: kind,
    fixes,
  };
}
