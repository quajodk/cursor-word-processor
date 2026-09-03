import type { ServerWebSocket } from "bun";
import type { AiChunk } from "@scriv/host-api";
import { AiService } from "./ai";
import { FsService } from "./fsops";
import { GitService } from "./git";
import { PathOutsideRootError, Workspace, resolveRootFromEnv } from "./root";
import { SearchService } from "./search";
import { WatchService } from "./watch";

/**
 * The host: the one place in scriv where I/O lives.
 *
 * Everything above the seam (apps/web, packages/*) reaches disk, git and processes only by
 * calling `HostApi`. This process is v1's implementation of that interface, exposed as:
 *
 *   POST /api/rpc              one JSON envelope for every non-streaming method
 *   POST /api/fs/read-binary   raw bytes out
 *   POST /api/fs/write-binary  raw bytes in
 *   POST /api/ai/stream        NDJSON of AiChunk
 *   GET  /api/ws               fs.watch subscriptions, pushed
 *
 * v2 replaces this file with Tauri `invoke` handlers and nothing above the seam changes.
 */

const argv = Bun.argv.slice(2);
const workspace = new Workspace(resolveRootFromEnv(argv, Bun.env, process.cwd()));
const port = Number(Bun.env.SCRIV_PORT ?? portFromArgv(argv) ?? 4300);

const fs = new FsService(workspace);
const git = new GitService(workspace);
const search = new SearchService(workspace);
const ai = new AiService(Bun.env);
const watcher = new WatchService(workspace);

type Handler = (args: unknown[]) => Promise<unknown>;

/**
 * The dispatch table *is* the HostApi surface. Adding a method to the interface without
 * adding it here is a compile-time-invisible but runtime-obvious gap, so the table is kept
 * in the same order as the interface for review.
 */
const methods: Record<string, Handler> = {
  "root.get": async () => workspace.root,

  "fs.read": async ([path]) => await fs.read(str(path)),
  "fs.write": async ([path, data]) => await fs.write(str(path), str(data)),
  "fs.list": async ([dir, opts]) => await fs.list(str(dir), opts as never),
  "fs.stat": async ([path]) => await fs.stat(str(path)),
  "fs.mkdirp": async ([path]) => await fs.mkdirp(str(path)),
  "fs.remove": async ([path]) => await fs.remove(str(path)),
  "fs.rename": async ([from, to]) => await fs.rename(str(from), str(to)),

  "git.isRepo": async ([root]) => await git.isRepo(str(root)),
  "git.status": async ([root]) => await git.status(str(root)),
  // `== null` rather than `=== undefined`: JSON.stringify turns an `undefined` element of an
  // array into `null`, so an omitted trailing argument arrives here as null and never matched
  // the stricter check. Every optional argument across this table has the same hazard.
  "git.show": async ([root, path, rev]) => await git.show(str(root), str(path), rev == null ? undefined : str(rev)),
  "git.blame": async ([root, path]) => await git.blame(str(root), str(path)),
  "git.log": async ([root, path, limit]) => await git.log(str(root), str(path), limit == null ? undefined : Number(limit)),

  "search.text": async ([root, query, opts]) => await search.text(str(root), str(query), opts as never),
  "search.files": async ([root, opts]) => await search.files(str(root), opts as never),

  "ai.available": async () => ai.available(),
  "ai.providerName": async () => ai.providerName(),
};

function str(v: unknown): string {
  if (typeof v !== "string") throw new TypeError(`expected a string argument, got ${typeof v}`);
  return v;
}

function portFromArgv(args: string[]): number | undefined {
  const i = args.indexOf("--port");
  if (i >= 0 && args[i + 1]) return Number(args[i + 1]);
  const flag = args.find((a) => a.startsWith("--port="));
  return flag ? Number(flag.slice("--port=".length)) : undefined;
}

// ---------------------------------------------------------------------------
// CORS — loopback origins only.
// ---------------------------------------------------------------------------

/**
 * The dev web app is served by vite on another port, so it is cross-origin to this server.
 * Only loopback origins are allowed: a page on the public internet must not be able to read
 * the user's disk through a server that happens to be listening on their machine.
 */
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin) return {};
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return {};
  }
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-scriv-path",
    "vary": "origin",
  };
}

/**
 * Is this request from a page we are willing to act for?
 *
 * CORS is NOT a defence here. It withholds the *response* from a hostile origin, but the
 * handler has already run by then — and a POST with `content-type: text/plain` is a
 * CORS-simple request, so there is no preflight to block it. A page on the public internet
 * could therefore call `fs.write`, `fs.remove` or `fs.rename` against this workspace and
 * never need to read the reply. Writing the file IS the attack.
 *
 * So the Origin is checked before dispatch, not after. A request with no Origin at all is
 * allowed: that is curl, a test, or the Tauri shell, none of which is a browser being driven
 * by somebody else's page.
 */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(req) },
  });
}

function errorPayload(err: unknown): { message: string; code?: string } {
  if (err instanceof PathOutsideRootError) return { message: err.message, code: err.code };
  if (err instanceof Error) return { message: err.message, code: (err as NodeJS.ErrnoException).code };
  return { message: String(err) };
}

// ---------------------------------------------------------------------------
// WebSocket: fs.watch subscriptions
// ---------------------------------------------------------------------------

interface SocketData {
  subs: Map<string, () => void>;
}

const server = Bun.serve<SocketData, never>({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 240,

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });

    if (url.pathname === "/api/ws") {
      if (server.upgrade(req, { data: { subs: new Map<string, () => void>() } })) return undefined as never;
      return new Response("expected a websocket upgrade", { status: 426 });
    }

    if (url.pathname === "/api/health") {
      return json(req, { ok: true, root: workspace.root, ai: { available: ai.available(), provider: ai.providerName() } });
    }

    if (req.method === "POST" && !originAllowed(req)) {
      return json(req, { ok: false, error: { message: "cross-origin request refused", code: "EFORBIDDENORIGIN" } }, 403);
    }

    try {
      if (url.pathname === "/api/rpc" && req.method === "POST") {
        const body = (await req.json()) as { method?: string; args?: unknown[] };
        const handler = body.method ? methods[body.method] : undefined;
        if (!handler) return json(req, { ok: false, error: { message: `unknown method: ${body.method}` } }, 404);
        const value = await handler(Array.isArray(body.args) ? body.args : []);
        return json(req, { ok: true, value });
      }

      if (url.pathname === "/api/fs/read-binary" && req.method === "POST") {
        const { path } = (await req.json()) as { path: string };
        const bytes = await fs.readBinary(path);
        return new Response(bytes as unknown as BodyInit, {
          headers: { "content-type": "application/octet-stream", ...corsHeaders(req) },
        });
      }

      if (url.pathname === "/api/fs/write-binary" && req.method === "POST") {
        // The path travels in a base64 header so arbitrary unicode filenames survive
        // header encoding, and so the body stays exactly the bytes to be written.
        const header = req.headers.get("x-scriv-path");
        if (!header) return json(req, { ok: false, error: { message: "missing x-scriv-path" } }, 400);
        const path = new TextDecoder().decode(Uint8Array.from(atob(header), (c) => c.charCodeAt(0)));
        await fs.writeBinary(path, new Uint8Array(await req.arrayBuffer()));
        return json(req, { ok: true, value: null });
      }

      if (url.pathname === "/api/ai/stream" && req.method === "POST") {
        return aiStreamResponse(req);
      }
    } catch (err) {
      return json(req, { ok: false, error: errorPayload(err) }, err instanceof PathOutsideRootError ? 403 : 500);
    }

    return json(req, { ok: false, error: { message: "not found" } }, 404);
  },

  websocket: {
    message(ws: ServerWebSocket<SocketData>, raw) {
      let msg: { t?: string; id?: string; dir?: string };
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      } catch {
        return;
      }
      if (msg.t === "watch" && msg.id && msg.dir) {
        const id = msg.id;
        try {
          const off = watcher.subscribe(msg.dir, (ev) => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ t: "event", id, ev }));
          });
          ws.data.subs.get(id)?.();
          ws.data.subs.set(id, off);
          ws.send(JSON.stringify({ t: "ok", id }));
        } catch (err) {
          ws.send(JSON.stringify({ t: "error", id, error: errorPayload(err) }));
        }
      } else if (msg.t === "unwatch" && msg.id) {
        ws.data.subs.get(msg.id)?.();
        ws.data.subs.delete(msg.id);
      }
    },
    close(ws: ServerWebSocket<SocketData>) {
      for (const off of ws.data.subs.values()) off();
      ws.data.subs.clear();
    },
  },
});

/** NDJSON: one `AiChunk` per line. Cancels the upstream request when the client disconnects. */
function aiStreamResponse(req: Request): Response {
  const controller = new AbortController();
  req.signal?.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const encoder = new TextEncoder();
      const emit = (chunk: AiChunk) => ctrl.enqueue(encoder.encode(JSON.stringify(chunk) + "\n"));
      try {
        const body = (await req.json()) as { system?: string; prompt?: string; maxTokens?: number; temperature?: number };
        for await (const chunk of ai.stream({
          system: body.system,
          prompt: body.prompt ?? "",
          maxTokens: body.maxTokens,
          temperature: body.temperature,
          signal: controller.signal,
        })) {
          emit(chunk);
          if (chunk.type === "done" || chunk.type === "error") break;
        }
      } catch (err) {
        if (!controller.signal.aborted) emit({ type: "error", message: errorPayload(err).message });
      } finally {
        ctrl.close();
      }
    },
    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", ...corsHeaders(req) },
  });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    watcher.closeAll();
    server.stop(true);
    process.exit(0);
  });
}

console.log(`scriv host  http://127.0.0.1:${server.port}`);
console.log(`  workspace root : ${workspace.root}`);
console.log(`  ai provider    : ${ai.providerName()}${ai.available() ? "" : "  (no key set — offline; nothing will be sent anywhere)"}`);
