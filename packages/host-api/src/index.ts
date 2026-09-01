/**
 * @scriv/host-api — the seam.
 *
 * Nothing above this line touches the disk, git, or a process. Packages that need the host
 * take a `HostApi` as a parameter. v1 fulfils it with a local bun server over HTTP/WS; v2
 * fulfils it with Tauri `invoke`. Neither the editor nor any feature package knows which.
 *
 * If you are about to `import "node:fs"` in a package, you want a method here instead.
 */

export interface FileStat {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface FsApi {
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  write(path: string, data: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  list(dir: string, opts?: { recursive?: boolean; includeHidden?: boolean }): Promise<FileStat[]>;
  stat(path: string): Promise<FileStat | null>;
  mkdirp(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Fires on external modification. Returns an unsubscribe. */
  watch(dir: string, cb: (ev: { type: "create" | "change" | "delete"; path: string }) => void): () => void;
}

export interface GitFileStatus {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
}

export interface BlameLine {
  line: number;
  commit: string;
  author: string;
  timestamp: number;
  summary: string;
}

export interface GitApi {
  isRepo(root: string): Promise<boolean>;
  status(root: string): Promise<GitFileStatus[]>;
  /** Contents of `path` at `rev` (default HEAD). Null if absent at that rev. */
  show(root: string, path: string, rev?: string): Promise<string | null>;
  blame(root: string, path: string): Promise<BlameLine[]>;
  log(root: string, path: string, limit?: number): Promise<
    { commit: string; author: string; timestamp: number; summary: string }[]
  >;
}

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface SearchApi {
  /** Content search across the workspace. Implementations should use ripgrep when present. */
  text(root: string, query: string, opts?: { regex?: boolean; caseSensitive?: boolean; glob?: string; limit?: number }): Promise<SearchHit[]>;
  /** Filename search for fuzzy-open. Returns candidate paths; ranking happens client-side. */
  files(root: string, opts?: { limit?: number }): Promise<string[]>;
}

/** A single streamed chunk from a completion. */
export type AiChunk = { type: "text"; text: string } | { type: "done" } | { type: "error"; message: string };

export interface AiRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * Pluggable behind one interface, keyed by env var. With no key configured, `available()`
 * is false and every non-AI feature must still work.
 */
export interface AiApi {
  available(): Promise<boolean>;
  providerName(): Promise<string>;
  stream(req: AiRequest): AsyncIterable<AiChunk>;
}

export interface HostApi {
  fs: FsApi;
  git: GitApi;
  search: SearchApi;
  ai: AiApi;
  /** Absolute path of the open workspace root. */
  root(): Promise<string>;
}
