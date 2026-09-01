/**
 * The pandoc baseline.
 *
 * DOCX-FIDELITY.md §6: "Pandoc is the fidelity oracle and the number to beat; if we are not
 * decisively ahead of it on T1 and T2, this design has failed and we should know that early
 * rather than late."
 *
 * Two variants are run, because a baseline that is easy to beat proves nothing:
 *
 *   plain      docx → md → docx. What pandoc does out of the box, and what a user who types
 *              `pandoc in.docx -o out.docx` actually gets.
 *   reference  docx → md → docx with `--reference-doc=<the original>`. Pandoc's strongest
 *              configuration for this task: it takes styles, numbering, headers, footers and
 *              theme from the original package and only regenerates the body. Running it
 *              forecloses the objection that we compared against a strawman.
 *
 * Bench tooling: allowed to spawn processes and touch the filesystem (ARCHITECTURE.md §1 binds
 * library code, not the rig).
 */

import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const PANDOC = "/usr/local/bin/pandoc";

export type PandocVariant = "plain" | "reference";

export interface PandocRun {
  ok: boolean;
  error?: string;
  /** The intermediate Markdown, so the same one-word edit can be applied to it. */
  markdown?: string;
  /** The regenerated package. */
  docx?: Uint8Array;
  ms: number;
}

export function pandocVersion(): string | null {
  if (!existsSync(PANDOC)) return null;
  const r = Bun.spawnSync([PANDOC, "--version"]);
  if (r.exitCode !== 0) return null;
  return new TextDecoder().decode(r.stdout).split("\n")[0] ?? null;
}

function run(args: string[], cwd: string, timeoutMs: number): { ok: boolean; err: string } {
  const p = Bun.spawnSync([PANDOC, ...args], { cwd, timeout: timeoutMs, stderr: "pipe", stdout: "pipe" });
  if (p.exitCode === 0) return { ok: true, err: "" };
  return { ok: false, err: new TextDecoder().decode(p.stderr).replace(/\s+/g, " ").slice(0, 200) || `exit ${p.exitCode}` };
}

/**
 * docx → markdown. Media is extracted rather than dropped, so the return leg has images to
 * re-embed; without it pandoc's baseline would lose every picture for a reason that is an
 * artefact of how we invoked it rather than of what it can do.
 */
export function pandocToMarkdown(docxPath: string, workDir: string, timeoutMs = 120_000): PandocRun {
  const t0 = Date.now();
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const mdPath = join(workDir, "doc.md");
  const r = run(["-f", "docx", "-t", "markdown", "--wrap=none", "--extract-media=media", docxPath, "-o", "doc.md"], workDir, timeoutMs);
  if (!r.ok) return { ok: false, error: r.err, ms: Date.now() - t0 };
  return { ok: true, markdown: readFileSync(mdPath, "utf8"), ms: Date.now() - t0 };
}

export function pandocToDocx(
  markdown: string,
  workDir: string,
  variant: PandocVariant,
  referenceDocx: string,
  timeoutMs = 120_000,
): PandocRun {
  const t0 = Date.now();
  const name = `out-${variant}`;
  writeFileSync(join(workDir, `${name}.md`), markdown);
  const args = ["-f", "markdown", "-t", "docx", `${name}.md`, "-o", `${name}.docx`];
  if (variant === "reference") args.push(`--reference-doc=${referenceDocx}`);
  const r = run(args, workDir, timeoutMs);
  if (!r.ok) return { ok: false, error: r.err, ms: Date.now() - t0 };
  const out = join(workDir, `${name}.docx`);
  if (!existsSync(out)) return { ok: false, error: "pandoc produced no output file", ms: Date.now() - t0 };
  return { ok: true, docx: new Uint8Array(readFileSync(out)), ms: Date.now() - t0 };
}
