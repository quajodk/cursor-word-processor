import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FileStat } from "@scriv/host-api";
import type { Workspace } from "./root";

const ALWAYS_SKIP = new Set([".git", "node_modules", ".DS_Store"]);

export class FsService {
  constructor(private readonly ws: Workspace) {}

  async read(path: string): Promise<string> {
    return await readFile(this.ws.resolve(path), "utf8");
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const buf = await readFile(this.ws.resolve(path));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async write(path: string, data: string): Promise<void> {
    const abs = this.ws.resolve(path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, data, "utf8");
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const abs = this.ws.resolve(path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, data);
  }

  async list(dir: string, opts?: { recursive?: boolean; includeHidden?: boolean }): Promise<FileStat[]> {
    const abs = this.ws.resolve(dir);
    const out: FileStat[] = [];
    const includeHidden = opts?.includeHidden ?? false;
    const recursive = opts?.recursive ?? false;

    const walk = async (current: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return; // unreadable directory: report what we can rather than failing the whole listing
      }
      for (const entry of entries) {
        const name = entry.name;
        if (ALWAYS_SKIP.has(name)) continue;
        if (!includeHidden && name.startsWith(".")) continue;
        const child = join(current, name);
        // A symlink inside the workspace may still point out of it.
        let st;
        try {
          st = await stat(child);
        } catch {
          continue;
        }
        try {
          this.ws.resolve(child);
        } catch {
          continue;
        }
        out.push({
          path: child,
          name,
          isDir: st.isDirectory(),
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
        if (recursive && st.isDirectory() && depth < 32) await walk(child, depth + 1);
      }
    };

    await walk(abs, 0);
    out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return out;
  }

  async stat(path: string): Promise<FileStat | null> {
    const abs = this.ws.resolve(path);
    try {
      const st = await stat(abs);
      return { path: abs, name: basename(abs), isDir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  }

  async mkdirp(path: string): Promise<void> {
    await mkdir(this.ws.resolve(path), { recursive: true });
  }

  async remove(path: string): Promise<void> {
    const abs = this.ws.resolve(path);
    if (abs === this.ws.root) throw new Error("refusing to remove the workspace root");
    await rm(abs, { recursive: true, force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    await rename(this.ws.resolve(from), this.ws.resolve(to));
  }
}
