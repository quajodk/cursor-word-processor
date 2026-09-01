import { watch, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "./root";

export type WatchEvent = { type: "create" | "change" | "delete"; path: string };

/**
 * Directory watching, pushed to the client over the WebSocket.
 *
 * `fs.watch` reports "rename" for both creation and deletion, so the type is recovered by
 * asking the filesystem whether the path exists now. Bursts are coalesced on a short timer:
 * a single save from an editor commonly produces several raw events for one file, and the
 * consumer of this API wants "this file changed", not a transcript of the syscalls.
 */
export class WatchService {
  private readonly watchers = new Map<string, { fsw: FSWatcher; subs: Set<(ev: WatchEvent) => void> }>();
  private readonly pending = new Map<string, { type: WatchEvent["type"]; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly ws: Workspace) {}

  subscribe(dir: string, cb: (ev: WatchEvent) => void): () => void {
    const abs = this.ws.resolve(dir);
    let entry = this.watchers.get(abs);
    if (!entry) {
      const subs = new Set<(ev: WatchEvent) => void>();
      const fsw = watch(abs, { recursive: true, persistent: false }, (rawType, filename) => {
        if (!filename) return;
        const name = String(filename);
        if (isIgnored(name)) return;
        const path = join(abs, name);
        let safe: string;
        try {
          safe = this.ws.resolve(path);
        } catch {
          return;
        }
        this.emitCoalesced(subs, safe, rawType === "rename" ? "rename" : "change");
      });
      fsw.on("error", () => this.close(abs));
      entry = { fsw, subs };
      this.watchers.set(abs, entry);
    }
    entry.subs.add(cb);

    return () => {
      const current = this.watchers.get(abs);
      if (!current) return;
      current.subs.delete(cb);
      if (current.subs.size === 0) this.close(abs);
    };
  }

  closeAll(): void {
    for (const dir of [...this.watchers.keys()]) this.close(dir);
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
  }

  private close(dir: string): void {
    const entry = this.watchers.get(dir);
    if (!entry) return;
    try {
      entry.fsw.close();
    } catch {
      /* already closed */
    }
    this.watchers.delete(dir);
  }

  /**
   * `fs.watch` distinguishes only "rename" (a directory-entry change: creation, deletion, move)
   * from "change" (contents written). Creation and deletion are then separated by asking
   * whether the path exists — the one question the kernel event does not answer.
   */
  private emitCoalesced(subs: Set<(ev: WatchEvent) => void>, path: string, rawType: "rename" | "change"): void {
    const type: WatchEvent["type"] = rawType === "change" ? "change" : existsSync(path) ? "create" : "delete";
    const prior = this.pending.get(path);
    if (prior) {
      clearTimeout(prior.timer);
      // A create followed immediately by a write is still, to the consumer, a create.
      if (prior.type === "create" && type === "change") {
        this.schedule(subs, path, "create");
        return;
      }
    }
    this.schedule(subs, path, type);
  }

  private schedule(subs: Set<(ev: WatchEvent) => void>, path: string, type: WatchEvent["type"]): void {
    const timer = setTimeout(() => {
      this.pending.delete(path);
      // Re-check at fire time: within the coalescing window the file may have been created
      // and removed again (or the reverse), and the last observation is the truthful one.
      const finalType: WatchEvent["type"] = existsSync(path) ? (type === "delete" ? "create" : type) : "delete";
      for (const cb of subs) {
        try {
          cb({ type: finalType, path });
        } catch {
          /* a broken subscriber must not take down the watcher */
        }
      }
    }, 40);
    this.pending.set(path, { type, timer });
  }
}

const IGNORED = [".git/", "node_modules/", ".DS_Store", ".scriv/index.db"];
function isIgnored(relative: string): boolean {
  const normalized = relative.split("\\").join("/");
  return IGNORED.some((i) => (i.endsWith("/") ? normalized.startsWith(i) || normalized.includes("/" + i) : normalized.endsWith(i)));
}
