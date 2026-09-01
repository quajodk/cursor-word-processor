import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { SearchHit } from "@scriv/host-api";
import { hasBinary, runLines } from "./proc";
import type { Workspace } from "./root";

const SKIP_DIRS = new Set([".git", "node_modules", ".scriv", "dist", "build", ".next", ".cache", "target"]);

/**
 * Content and filename search.
 *
 * ripgrep when it is present (its `--json` output is a stable, documented NDJSON protocol, so
 * there is no output scraping and no surprises on binary files or odd encodings). A plain walk
 * when it is not, so the feature degrades rather than disappears.
 */
export class SearchService {
  constructor(private readonly ws: Workspace) {}

  async text(
    root: string,
    query: string,
    opts?: { regex?: boolean; caseSensitive?: boolean; glob?: string; limit?: number },
  ): Promise<SearchHit[]> {
    const dir = this.ws.resolve(root || this.ws.root);
    if (!query) return [];
    const limit = opts?.limit ?? 500;
    if (await hasBinary("rg")) return await this.rgText(dir, query, opts ?? {}, limit);
    return await this.walkText(dir, query, opts ?? {}, limit);
  }

  async files(root: string, opts?: { limit?: number }): Promise<string[]> {
    const dir = this.ws.resolve(root || this.ws.root);
    const limit = opts?.limit ?? 20000;
    const out: string[] = [];
    if (await hasBinary("rg")) {
      for await (const line of runLines(["rg", "--files", "--hidden", "--glob", "!.git/**"], { cwd: dir })) {
        if (!line) continue;
        out.push(join(dir, line));
        if (out.length >= limit) break;
      }
      return out;
    }
    await walkFiles(dir, out, limit, 0);
    return out;
  }

  private async rgText(
    dir: string,
    query: string,
    opts: { regex?: boolean; caseSensitive?: boolean; glob?: string },
    limit: number,
  ): Promise<SearchHit[]> {
    const args = ["rg", "--json", "--line-number", "--column"];
    if (!opts.regex) args.push("--fixed-strings");
    args.push(opts.caseSensitive ? "--case-sensitive" : "--ignore-case");
    if (opts.glob) args.push("--glob", opts.glob);
    args.push("--glob", "!.git/**", "--hidden", "--", query, ".");

    const out: SearchHit[] = [];
    for await (const line of runLines(args, { cwd: dir })) {
      if (!line.startsWith("{")) continue;
      let ev: RgEvent;
      try {
        ev = JSON.parse(line) as RgEvent;
      } catch {
        continue;
      }
      if (ev.type !== "match") continue;
      const data = ev.data;
      const path = rgText(data.path);
      const text = rgText(data.lines);
      if (path === null || text === null) continue; // non-UTF8 payload; rg sends bytes instead
      const absolute = join(dir, path.startsWith("./") ? path.slice(2) : path);
      for (const sm of data.submatches ?? []) {
        out.push({
          path: absolute,
          line: data.line_number ?? 0,
          // rg reports byte offsets; convert to a character column for the editor.
          column: byteOffsetToColumn(text, sm.start) + 1,
          text: text.replace(/\r?\n$/, ""),
        });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  private async walkText(
    dir: string,
    query: string,
    opts: { regex?: boolean; caseSensitive?: boolean; glob?: string },
    limit: number,
  ): Promise<SearchHit[]> {
    const files: string[] = [];
    await walkFiles(dir, files, 50000, 0);
    const flags = opts.caseSensitive ? "g" : "gi";
    const re = opts.regex ? new RegExp(query, flags) : new RegExp(escapeRegExp(query), flags);
    const globRe = opts.glob ? globToRegExp(opts.glob) : null;

    const out: SearchHit[] = [];
    for (const file of files) {
      if (globRe && !globRe.test(relative(dir, file))) continue;
      let content: string;
      try {
        const st = await stat(file);
        if (st.size > 4 * 1024 * 1024) continue;
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) continue; // binary
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i]!;
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(lineText))) {
          out.push({ path: file, line: i + 1, column: m.index + 1, text: lineText });
          if (out.length >= limit) return out;
          if (m[0].length === 0) re.lastIndex++;
        }
      }
    }
    return out;
  }
}

interface RgEvent {
  type: string;
  data: {
    path: RgData;
    lines: RgData;
    line_number?: number;
    submatches?: { start: number; end: number }[];
  };
}
type RgData = { text?: string; bytes?: string };

function rgText(d: RgData | undefined): string | null {
  if (!d) return null;
  if (typeof d.text === "string") return d.text;
  if (typeof d.bytes === "string") {
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(atob(d.bytes), (c) => c.charCodeAt(0)));
    } catch {
      return null;
    }
  }
  return null;
}

function byteOffsetToColumn(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  const bytes = new TextEncoder().encode(text);
  const prefix = new TextDecoder().decode(bytes.slice(0, byteOffset));
  return prefix.length;
}

async function walkFiles(dir: string, out: string[], limit: number, depth: number): Promise<void> {
  if (out.length >= limit || depth > 32) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(child, out, limit, depth + 1);
    else if (entry.isFile()) out.push(child);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Minimal glob → RegExp for the no-ripgrep fallback: `**`, `*`, `?`. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += escapeRegExp(c);
  }
  return new RegExp("^" + re + "$");
}
