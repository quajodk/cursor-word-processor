import { join } from "node:path";
import type { BlameLine, GitFileStatus } from "@scriv/host-api";
import { run } from "./proc";
import type { Workspace } from "./root";

/**
 * git, by shelling out to the real binary.
 *
 * Everything here parses a *machine* format (`--porcelain`, `--line-porcelain`, explicit
 * `--format` with control-character separators) rather than human output, and every field
 * separator is a byte that cannot appear in a path or a commit subject. There is no regex
 * guessing at rename records or at paths containing spaces, quotes or newlines.
 */
export class GitService {
  constructor(private readonly ws: Workspace) {}

  private async git(root: string, args: string[]) {
    const cwd = this.ws.resolve(root || this.ws.root);
    return await run(["git", "-C", cwd, ...args]);
  }

  /** The repository top level for `root`, or null when `root` is not in a work tree. */
  private async top(root: string): Promise<string | null> {
    const res = await this.git(root, ["rev-parse", "--show-toplevel"]);
    if (res.code !== 0) return null;
    const top = res.stdout.trim();
    return top.length > 0 ? top : null;
  }

  async isRepo(root: string): Promise<boolean> {
    const res = await this.git(root, ["rev-parse", "--is-inside-work-tree"]);
    return res.code === 0 && res.stdout.trim() === "true";
  }

  async status(root: string): Promise<GitFileStatus[]> {
    const top = await this.top(root);
    if (!top) return [];
    // `-z` gives NUL-terminated records; `status.relativePaths=false` makes every path
    // repo-root-relative regardless of which subdirectory we invoked from.
    const res = await this.git(root, [
      "-c",
      "status.relativePaths=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (res.code !== 0) return [];

    const out: GitFileStatus[] = [];
    const fields = res.stdout.split("\0");
    for (let i = 0; i < fields.length; i++) {
      const record = fields[i];
      if (!record || record.length < 4) continue;
      const x = record[0]!;
      const y = record[1]!;
      const path = record.slice(3);
      // Rename and copy records are two NUL-separated fields: `XY <new>\0<orig>`.
      // Consume (and discard) the original path so it is not mistaken for a record.
      if (x === "R" || x === "C" || y === "R" || y === "C") i++;
      out.push({ path: join(top, path), status: classify(x, y) });
    }
    return out;
  }

  async show(root: string, path: string, rev = "HEAD"): Promise<string | null> {
    const top = await this.top(root);
    if (!top) return null;
    const abs = this.ws.resolve(path);
    const rel = relativeTo(top, abs);
    if (!rel) return null; // outside the repo, or the repo root itself
    // `rev:./path` is unambiguous even when the path looks like a revision.
    const res = await this.git(root, ["show", `${rev}:${gitPath(rel)}`]);
    return res.code === 0 ? res.stdout : null;
  }

  async blame(root: string, path: string): Promise<BlameLine[]> {
    const abs = this.ws.resolve(path);
    const res = await this.git(root, ["blame", "--line-porcelain", "--", abs]);
    if (res.code !== 0) return [];
    return parseBlamePorcelain(res.stdout);
  }

  async log(
    root: string,
    path: string,
    limit = 50,
  ): Promise<{ commit: string; author: string; timestamp: number; summary: string }[]> {
    const abs = this.ws.resolve(path);
    // US (0x1f) between fields, RS (0x1e) between commits: neither can occur in %an/%s.
    const res = await this.git(root, [
      "log",
      `--max-count=${Math.max(1, Math.floor(limit))}`,
      "--format=%H%x1f%an%x1f%at%x1f%s%x1e",
      "--",
      abs,
    ]);
    if (res.code !== 0) return [];
    const out: { commit: string; author: string; timestamp: number; summary: string }[] = [];
    for (const record of res.stdout.split("\x1e")) {
      const trimmed = record.replace(/^\n+/, "");
      if (!trimmed) continue;
      const [commit, author, at, summary] = trimmed.split("\x1f");
      if (!commit || at === undefined) continue;
      out.push({
        commit,
        author: author ?? "",
        timestamp: Number(at) * 1000,
        summary: summary ?? "",
      });
    }
    return out;
  }
}

function classify(x: string, y: string): GitFileStatus["status"] {
  if (x === "?" && y === "?") return "untracked";
  // Unmerged: any U, or the AA / DD double-same cases.
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflicted";
  if (x === "R" || y === "R" || x === "C" || y === "C") return "renamed";
  const code = x !== " " && x !== "?" ? x : y;
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  return "modified"; // M, T (typechange), and anything else git may add later
}

function relativeTo(top: string, abs: string): string | null {
  if (abs === top) return "";
  if (!abs.startsWith(top.endsWith("/") ? top : top + "/")) return null;
  return abs.slice(top.length + 1);
}

/** git object paths always use forward slashes. */
function gitPath(p: string): string {
  return p.split("\\").join("/");
}

/**
 * `git blame --line-porcelain` emits, per line:
 *   <sha> <origLine> <finalLine> [<numLinesInGroup>]
 *   key value            (repeated; `boundary` is a bare key with no value)
 *   \t<the line's content>
 *
 * `--line-porcelain` repeats the headers for every line, but we still cache per-sha so the
 * parser also copes with plain `--porcelain`, which omits repeats.
 */
export function parseBlamePorcelain(stdout: string): BlameLine[] {
  const out: BlameLine[] = [];
  const commits = new Map<string, { author: string; timestamp: number; summary: string }>();
  const lines = stdout.split("\n");

  let current: { sha: string; finalLine: number } | null = null;
  let meta: { author?: string; timestamp?: number; summary?: string } = {};

  for (const line of lines) {
    if (line.startsWith("\t")) {
      if (!current) continue;
      const cached = commits.get(current.sha) ?? { author: "", timestamp: 0, summary: "" };
      const merged = {
        author: meta.author ?? cached.author,
        timestamp: meta.timestamp ?? cached.timestamp,
        summary: meta.summary ?? cached.summary,
      };
      commits.set(current.sha, merged);
      out.push({ line: current.finalLine, commit: current.sha, ...merged });
      current = null;
      meta = {};
      continue;
    }

    const headerMatch = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(line);
    if (headerMatch) {
      current = { sha: headerMatch[1]!, finalLine: Number(headerMatch[3]) };
      meta = {};
      continue;
    }
    if (!current) continue;

    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? "" : line.slice(sp + 1);
    if (key === "author") meta.author = value;
    else if (key === "author-time") meta.timestamp = Number(value) * 1000;
    else if (key === "summary") meta.summary = value;
  }
  return out;
}
