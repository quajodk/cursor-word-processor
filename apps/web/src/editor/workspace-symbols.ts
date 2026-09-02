import type { HostApi } from "@scriv/host-api";
import { WorkspaceIndex } from "@scriv/intellisense";
import { parseMarkdown } from "@scriv/md";
import type { Node as PMNode } from "prosemirror-model";

/**
 * Builds the workspace symbol table from disk.
 *
 * Completion is only worth having if it knows the whole project — a citation key defined in
 * chapter one has to complete in chapter nine. So this walks the workspace rather than
 * indexing only the open file.
 *
 * It is deliberately unhurried: indexing yields between files so a large workspace cannot
 * block typing, and it is capped, because a folder that happens to contain ten thousand
 * Markdown files should degrade to "indexed the first thousand" rather than to a frozen tab.
 */

const MARKDOWN = /\.(md|markdown|mdown|mkd|qmd|rmd)$/i;
const BIBLIOGRAPHY = /\.bib$/i;
const MAX_FILES = 1000;
const MAX_BYTES = 400_000;

export interface IndexProgress {
  indexed: number;
  total: number;
  done: boolean;
}

export class WorkspaceSymbols {
  readonly index = new WorkspaceIndex();
  private generation = 0;

  constructor(private readonly host: HostApi) {}

  /** Index the document currently open, immediately: its own names matter most. */
  setOpenDocument(path: string | null, doc: PMNode): void {
    if (path) this.index.setDocument(path, doc);
  }

  /**
   * Walk the workspace. Safe to call again; a second call supersedes the first rather than
   * racing it, so switching folders mid-scan does not blend two workspaces together.
   */
  async scan(root: string, onProgress?: (p: IndexProgress) => void): Promise<IndexProgress> {
    const generation = ++this.generation;
    let entries;
    try {
      entries = await this.host.fs.list(root, { recursive: true });
    } catch {
      return { indexed: 0, total: 0, done: true };
    }

    const files = entries
      .filter((e) => !e.isDir && e.size <= MAX_BYTES && (MARKDOWN.test(e.name) || BIBLIOGRAPHY.test(e.name)))
      .slice(0, MAX_FILES);

    let indexed = 0;
    for (const file of files) {
      if (generation !== this.generation) return { indexed, total: files.length, done: false };
      try {
        const text = await this.host.fs.read(file.path);
        if (BIBLIOGRAPHY.test(file.name)) this.index.setBibliography(file.path, text);
        else this.index.setDocument(file.path, parseMarkdown(text).doc);
        indexed++;
      } catch {
        // A file that will not parse is not a reason to abandon the workspace.
      }
      if (indexed % 25 === 0) {
        onProgress?.({ indexed, total: files.length, done: false });
        // Yield to the event loop so a large scan never blocks a keystroke.
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    const final = { indexed, total: files.length, done: true };
    onProgress?.(final);
    return final;
  }

  remove(path: string): void {
    this.index.remove(path);
  }
}
