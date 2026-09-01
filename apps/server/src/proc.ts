/** Thin, honest wrapper around Bun.spawn. Never a shell — argv only, so nothing is quoted or interpolated. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(cmd: string[], opts?: { cwd?: string; input?: string }): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd,
    stdin: opts?.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Streams stdout line by line so a long ripgrep run can be cut short without buffering it all. */
export async function* runLines(cmd: string[], opts?: { cwd?: string }): AsyncGenerator<string, void, void> {
  const proc = Bun.spawn(cmd, { cwd: opts?.cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        yield buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer.length > 0) yield buffer;
  } finally {
    try {
      reader.cancel();
    } catch {
      /* already closed */
    }
    proc.kill();
  }
}

let binaryCache: Map<string, boolean> | null = null;
export async function hasBinary(name: string): Promise<boolean> {
  binaryCache ??= new Map();
  const cached = binaryCache.get(name);
  if (cached !== undefined) return cached;
  const res = await run(["/usr/bin/env", "which", name]);
  const ok = res.code === 0 && res.stdout.trim().length > 0;
  binaryCache.set(name, ok);
  return ok;
}
