import { realpathSync, existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Workspace containment.
 *
 * This is a local-first tool, but "local" is not "unauthenticated shell". The server is a real
 * HTTP surface on the loopback interface and any page in the browser can talk to it, so every
 * path that arrives from the client is resolved and then proved to live under the workspace
 * root before a single syscall touches it.
 *
 * Two escapes have to be closed, not one:
 *   1. lexical — `../../etc/passwd`, absolute paths, `.` games.  Closed by `resolve()` + prefix.
 *   2. symbolic — `workspace/link -> /etc`.  Closed by realpath-ing the deepest existing
 *      ancestor and re-checking containment on the *real* path. A component that does not
 *      exist yet cannot be a symlink, so realpathing the existing prefix is sufficient.
 */
export class PathOutsideRootError extends Error {
  readonly code = "EOUTSIDEROOT";
  constructor(requested: string) {
    super(`refusing path outside workspace root: ${requested}`);
    this.name = "PathOutsideRootError";
  }
}

export class Workspace {
  /** Absolute, symlink-resolved path of the workspace root. */
  readonly root: string;

  constructor(input: string) {
    const abs = resolve(input);
    if (!existsSync(abs)) throw new Error(`workspace root does not exist: ${abs}`);
    this.root = realpathSync.native(abs);
  }

  /**
   * Resolve a client-supplied path (absolute or root-relative) to an absolute path that is
   * proven to be inside the workspace. Throws `PathOutsideRootError` otherwise.
   */
  resolve(input: string): string {
    if (typeof input !== "string") throw new PathOutsideRootError(String(input));
    const candidate = isAbsolute(input) ? resolve(input) : resolve(this.root, input);
    if (!this.contains(candidate)) throw new PathOutsideRootError(input);

    // Walk up to the deepest component that actually exists and resolve symlinks there.
    let existing = candidate;
    const tail: string[] = [];
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) break;
      tail.unshift(basename(existing));
      existing = parent;
    }
    let real: string;
    try {
      real = realpathSync.native(existing);
    } catch {
      throw new PathOutsideRootError(input);
    }
    const resolvedReal = tail.length ? join(real, ...tail) : real;
    if (!this.contains(resolvedReal)) throw new PathOutsideRootError(input);

    return candidate;
  }

  /** Root-relative form, using forward slashes. Used for display and for git arguments. */
  relative(abs: string): string {
    if (abs === this.root) return "";
    return abs.startsWith(this.root + sep) ? abs.slice(this.root.length + 1) : abs;
  }

  private contains(p: string): boolean {
    return p === this.root || p.startsWith(this.root + sep);
  }
}

/** `--root <path>` / `SCRIV_ROOT` / cwd, in that order of precedence. */
export function resolveRootFromEnv(argv: string[], env: Record<string, string | undefined>, cwd: string): string {
  const i = argv.indexOf("--root");
  if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
  const flag = argv.find((a) => a.startsWith("--root="));
  if (flag) return flag.slice("--root=".length);
  if (env.SCRIV_ROOT) return env.SCRIV_ROOT;
  return cwd;
}
