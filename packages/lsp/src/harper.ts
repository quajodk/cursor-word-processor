import { Dialect, type Lint, type Linter } from "harper.js";
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

/**
 * Region subtag to Harper dialect.
 *
 * Defaulting everyone to American English marks "harbour", "colour" and "realise" as
 * misspellings for most of the English-speaking world — the loudest possible false positive,
 * and one that teaches a writer to ignore the squiggles entirely. The document's own locale
 * decides; plain "en" keeps Harper's own default rather than guessing a region.
 */
const DIALECTS: Record<string, Dialect> = {
  GB: Dialect.British, UK: Dialect.British, IE: Dialect.British,
  AU: Dialect.Australian, NZ: Dialect.Australian,
  CA: Dialect.Canadian,
  IN: Dialect.Indian,
  US: Dialect.American,
};

function dialectFor(language: string | undefined): Dialect | undefined {
  if (!language) return undefined;
  const region = language.toUpperCase().split(/[-_]/)[1];
  return region ? DIALECTS[region] : undefined;
}

export class HarperProvider implements DiagnosticProvider {
  readonly id = "harper";
  /** One linter per dialect: switching dialects means a different rule set, not a flag. */
  private readonly linters = new Map<string, Promise<Linter>>();

  constructor(private readonly makeLinter: (dialect?: Dialect) => Linter) {}

  async setup(dialect?: Dialect): Promise<void> {
    await this.linterFor(dialect);
  }

  private linterFor(dialect?: Dialect): Promise<Linter> {
    const key = String(dialect ?? "default");
    let existing = this.linters.get(key);
    if (!existing) {
      existing = (async () => {
        const linter = this.makeLinter(dialect);
        await linter.setup();
        return linter;
      })();
      this.linters.set(key, existing);
    }
    return existing;
  }

  async diagnose(req: DiagnoseRequest): Promise<Diagnostic[]> {
    // Harper is an English checker. Running it over Hindi or Polish would produce a wall of
    // false spelling errors, which is worse than no diagnostics at all, so it declines.
    if (req.language && !/^en\b/i.test(req.language)) return [];

    const linter = await this.linterFor(dialectFor(req.language));
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
