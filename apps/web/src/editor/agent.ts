import type { HostApi } from "@scriv/host-api";
import {
  applyChangeSet, planRename, siteKey, staleSites, summarizeChangeSet,
  type ChangeSet, type RenameOptions, type Site, type SourceFile,
} from "@scriv/ai";
import { relativeTo } from "../host";

/**
 * Agent mode, wired to the workspace.
 *
 * `@scriv/ai` owns the thinking and takes files as values; this owns the I/O, because nothing
 * above the host seam may touch the disk (ARCHITECTURE.md §1). The split is not ceremony: it
 * is why `planRename` can be tested against 120 real corpus documents without a filesystem.
 *
 * READING IS CAPPED AND THE CAP IS REPORTED. A workspace with ten thousand Markdown files
 * should degrade to "searched the first thousand" rather than to a frozen tab, and the writer
 * should be told which it was — an agent that quietly searched half the project and reported
 * success is worse than one that refused.
 */

const MARKDOWN = /\.(md|markdown|mdown|mkd|qmd|rmd)$/i;
const MAX_FILES = 2000;
const MAX_BYTES = 2_000_000;

export interface WorkspaceScan {
  files: SourceFile[];
  skipped: { path: string; reason: string }[];
}

/** Read every Markdown file under `root`. Paths are workspace-relative, for display. */
export async function readWorkspace(host: HostApi, root: string): Promise<WorkspaceScan> {
  const skipped: { path: string; reason: string }[] = [];
  let entries;
  try {
    entries = await host.fs.list(root, { recursive: true });
  } catch (err) {
    return { files: [], skipped: [{ path: root, reason: err instanceof Error ? err.message : String(err) }] };
  }

  const candidates = entries.filter((e) => !e.isDir && MARKDOWN.test(e.name));
  const files: SourceFile[] = [];
  for (const entry of candidates) {
    if (files.length >= MAX_FILES) {
      skipped.push({ path: relativeTo(root, entry.path), reason: `beyond the ${MAX_FILES}-file scan limit` });
      continue;
    }
    if (entry.size > MAX_BYTES) {
      skipped.push({ path: relativeTo(root, entry.path), reason: `larger than ${(MAX_BYTES / 1e6).toFixed(0)} MB` });
      continue;
    }
    try {
      files.push({ path: relativeTo(root, entry.path), text: await host.fs.read(entry.path) });
    } catch (err) {
      skipped.push({ path: relativeTo(root, entry.path), reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { files, skipped };
}

export interface PlanResult {
  changes: ChangeSet;
  files: SourceFile[];
  summary: ReturnType<typeof summarizeChangeSet>;
}

export async function planWorkspaceRename(
  host: HostApi,
  root: string,
  term: string,
  replacement: string,
  options?: RenameOptions,
): Promise<PlanResult> {
  const scan = await readWorkspace(host, root);
  const changes = planRename(scan.files, term, replacement, options);
  // The scan's own skips belong in the same list the plan's do: from the writer's side there
  // is one question — "what did you not look at?" — and it has one answer.
  changes.skipped.push(...scan.skipped);
  return { changes, files: scan.files, summary: summarizeChangeSet(changes) };
}

export interface ApplyReport {
  written: string[];
  /** Sites whose file changed under review. Named, not counted. */
  stale: Site[];
  failed: { path: string; reason: string }[];
}

/**
 * Write the accepted sites.
 *
 * Re-reads every file it is about to write and re-checks the plan against it, because a
 * change set is a proposal about a state of the disk that may have moved on — the writer may
 * have edited a file while reviewing, or a watcher may have pulled one. A site that no longer
 * matches is skipped and named; the rest still apply. Abandoning the whole set because one
 * file moved would make the feature unusable in exactly the situation it is for.
 */
export async function applyWorkspaceRename(
  host: HostApi,
  root: string,
  changes: ChangeSet,
  accepted: ReadonlySet<string>,
): Promise<ApplyReport> {
  const wanted = new Set(changes.files.map((f) => f.path));
  const fresh: SourceFile[] = [];
  const failed: { path: string; reason: string }[] = [];

  for (const path of wanted) {
    try { fresh.push({ path, text: await host.fs.read(join(root, path)) }); }
    catch (err) { failed.push({ path, reason: err instanceof Error ? err.message : String(err) }); }
  }

  const stale = staleSites(fresh, changes).filter((s) => accepted.has(siteKey(s)));
  const results = applyChangeSet(fresh, changes, accepted);
  const written: string[] = [];

  for (const r of results) {
    try {
      await host.fs.write(join(root, r.path), r.text);
      written.push(r.path);
    } catch (err) {
      failed.push({ path: r.path, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { written, stale, failed };
}

/** Join a workspace-relative path back onto the root. The host takes absolute paths. */
function join(root: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  return root.endsWith("/") ? root + rel : `${root}/${rel}`;
}

export { siteKey };
