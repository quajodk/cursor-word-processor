import type {
  AiChunk,
  AiRequest,
  BlameLine,
  FileStat,
  GitFileStatus,
  HostApi,
  SearchHit,
} from "./index";

/**
 * The web implementation of the seam.
 *
 * `apps/server` fulfils `HostApi` over HTTP + one WebSocket; this is the client half. Note
 * what it does *not* do: it never names a host. `baseUrl` arrives as a parameter, which is
 * exactly the layering rule from docs/ARCHITECTURE.md — packages above the seam may not fetch
 * an absolute URL of their own choosing. The Tauri implementation will swap this module for
 * `invoke` calls and nothing above it changes.
 */

export class HostError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

/**
 * Only the shape this module actually uses. Deliberately narrower than `typeof fetch`, whose
 * exact type differs between the DOM lib and bun's, so either can be injected.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpHostOptions {
  /** Injectable for tests and for non-browser hosts. Defaults to the ambient globals. */
  fetchImpl?: FetchLike;
  webSocketImpl?: typeof WebSocket;
}

interface RpcEnvelope<T> {
  ok: boolean;
  value?: T;
  error?: { message?: string; code?: string };
}

export function createHttpHost(baseUrl: string, opts: HttpHostOptions = {}): HostApi {
  const base = baseUrl.replace(/\/+$/, "");
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const WS = opts.webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;

  async function rpc<T>(method: string, args: unknown[] = []): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, args }),
      });
    } catch (err) {
      throw new HostError(
        `cannot reach the scriv host at ${base} — is \`bun run --cwd apps/server dev\` running? (${errText(err)})`,
        "EHOSTUNREACH",
      );
    }
    let envelope: RpcEnvelope<T>;
    try {
      envelope = (await res.json()) as RpcEnvelope<T>;
    } catch {
      throw new HostError(`host returned a non-JSON response (${res.status}) for ${method}`);
    }
    if (!envelope.ok) throw new HostError(envelope.error?.message ?? `${method} failed`, envelope.error?.code);
    return envelope.value as T;
  }

  const watchHub = new WatchHub(base, WS);

  return {
    root: () => rpc<string>("root.get"),

    fs: {
      read: (path) => rpc<string>("fs.read", [path]),

      async readBinary(path) {
        const res = await doFetch(`${base}/api/fs/read-binary`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path }),
        });
        if (!res.ok) throw await httpError(res, `readBinary(${path})`);
        return new Uint8Array(await res.arrayBuffer());
      },

      write: (path, data) => rpc<void>("fs.write", [path, data]),

      async writeBinary(path, data) {
        // The bytes are the body; the path rides in a base64 header so any filename that is
        // legal on disk survives header encoding intact.
        const res = await doFetch(`${base}/api/fs/write-binary`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream", "x-scriv-path": base64Utf8(path) },
          body: data.slice().buffer as ArrayBuffer,
        });
        if (!res.ok) throw await httpError(res, `writeBinary(${path})`);
      },

      list: (dir, o) => rpc<FileStat[]>("fs.list", [dir, o ?? null]),
      stat: (path) => rpc<FileStat | null>("fs.stat", [path]),
      mkdirp: (path) => rpc<void>("fs.mkdirp", [path]),
      remove: (path) => rpc<void>("fs.remove", [path]),
      rename: (from, to) => rpc<void>("fs.rename", [from, to]),
      watch: (dir, cb) => watchHub.subscribe(dir, cb),
    },

    git: {
      isRepo: (root) => rpc<boolean>("git.isRepo", [root]),
      status: (root) => rpc<GitFileStatus[]>("git.status", [root]),
      show: (root, path, rev) => rpc<string | null>("git.show", [root, path, rev]),
      blame: (root, path) => rpc<BlameLine[]>("git.blame", [root, path]),
      log: (root, path, limit) => rpc("git.log", [root, path, limit]),
    },

    search: {
      text: (root, query, o) => rpc<SearchHit[]>("search.text", [root, query, o ?? null]),
      files: (root, o) => rpc<string[]>("search.files", [root, o ?? null]),
    },

    ai: {
      available: () => rpc<boolean>("ai.available"),
      providerName: () => rpc<string>("ai.providerName"),
      stream: (req) => streamAi(base, doFetch, req),
    },
  };
}

// ---------------------------------------------------------------------------
// fs.watch over one shared WebSocket
// ---------------------------------------------------------------------------

type WatchCb = (ev: { type: "create" | "change" | "delete"; path: string }) => void;

/**
 * `HostApi.watch` is synchronous and returns an unsubscribe, so subscriptions are recorded
 * immediately and flushed to the socket once it opens. One socket serves every subscription,
 * and it reconnects with backoff — a host restart during `--hot` reload must not silently
 * leave the file tree stale forever.
 */
class WatchHub {
  private socket: WebSocket | null = null;
  private readonly subs = new Map<string, { dir: string; cb: WatchCb }>();
  private seq = 0;
  private backoff = 250;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly base: string,
    private readonly WS: typeof WebSocket | undefined,
  ) {}

  subscribe(dir: string, cb: WatchCb): () => void {
    const id = `w${++this.seq}`;
    this.subs.set(id, { dir, cb });
    this.ensureSocket();
    this.send({ t: "watch", id, dir });
    return () => {
      this.subs.delete(id);
      this.send({ t: "unwatch", id });
      if (this.subs.size === 0) this.closeSocket();
    };
  }

  private ensureSocket(): void {
    if (this.socket || !this.WS) return;
    const url = this.base.replace(/^http/, "ws") + "/api/ws";
    const sock = new this.WS(url);
    this.socket = sock;

    sock.onopen = () => {
      this.backoff = 250;
      for (const [id, sub] of this.subs) this.rawSend(sock, { t: "watch", id, dir: sub.dir });
    };
    sock.onmessage = (event: MessageEvent) => {
      let msg: { t?: string; id?: string; ev?: { type: "create" | "change" | "delete"; path: string } };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.t !== "event" || !msg.id || !msg.ev) return;
      const sub = this.subs.get(msg.id);
      if (sub) sub.cb(msg.ev);
    };
    const drop = () => {
      if (this.socket !== sock) return;
      this.socket = null;
      if (this.subs.size > 0) this.scheduleReconnect();
    };
    sock.onclose = drop;
    sock.onerror = drop;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, delay);
  }

  private closeSocket(): void {
    const sock = this.socket;
    this.socket = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      sock?.close();
    } catch {
      /* already closing */
    }
  }

  private send(msg: unknown): void {
    const sock = this.socket;
    if (sock && sock.readyState === 1) this.rawSend(sock, msg);
    // Otherwise `onopen` replays every live subscription, so nothing is lost.
  }

  private rawSend(sock: WebSocket, msg: unknown): void {
    try {
      sock.send(JSON.stringify(msg));
    } catch {
      /* socket died between the readyState check and the send */
    }
  }
}

// ---------------------------------------------------------------------------
// ai.stream over NDJSON
// ---------------------------------------------------------------------------

/** One `AiChunk` per line. Aborting the iteration cancels the request end to end. */
function streamAi(base: string, doFetch: FetchLike, req: AiRequest): AsyncIterable<AiChunk> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<AiChunk, void, void> {
      let res: Response;
      try {
        res = await doFetch(`${base}/api/ai/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            system: req.system,
            prompt: req.prompt,
            maxTokens: req.maxTokens,
            temperature: req.temperature,
          }),
          signal: req.signal,
        });
      } catch (err) {
        yield { type: "error", message: errText(err) };
        return;
      }
      if (!res.ok || !res.body) {
        yield { type: "error", message: `ai stream failed: ${res.status}` };
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let chunk: AiChunk;
            try {
              chunk = JSON.parse(line) as AiChunk;
            } catch {
              continue;
            }
            yield chunk;
            if (chunk.type === "done" || chunk.type === "error") return;
          }
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------

async function httpError(res: Response, what: string): Promise<HostError> {
  let message = `${what}: ${res.status}`;
  let code: string | undefined;
  try {
    const body = (await res.json()) as RpcEnvelope<unknown>;
    if (body.error?.message) message = body.error.message;
    code = body.error?.code;
  } catch {
    /* keep the status-line message */
  }
  return new HostError(message, code);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** btoa is latin1-only, so encode to UTF-8 bytes first. */
function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
