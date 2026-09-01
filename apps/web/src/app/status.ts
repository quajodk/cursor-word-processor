/**
 * The status store.
 *
 * This exists so that typing never touches React. Word counts, the dirty flag, the caret
 * position and the measured keystroke latency all change on every transaction; routing them
 * through `useState` would re-render the tree on the keystroke path, which the latency budget
 * in docs/ARCHITECTURE.md §5 does not have room for. Instead they land in a plain object here
 * and are published to `useSyncExternalStore` on a coalescing timer.
 *
 * Consequence to keep in mind: the status bar lags reality by up to `PUBLISH_MS`. That is the
 * correct trade — nobody reads a word count at 60fps, and everybody feels a dropped frame.
 */

const PUBLISH_MS = 220;

export interface Status {
  root: string;
  path: string | null;
  dirty: boolean;
  codecId: string;
  codecStructural: boolean;
  words: number;
  chars: number;
  blocks: number;
  line: number;
  col: number;
  /** Keystroke → state commit, milliseconds. `-1` until there are samples. */
  p50: number;
  p99: number;
  samples: number;
  host: "checking" | "connected" | "unreachable";
  ai: string;
  message: string;
}

const initial: Status = {
  root: "",
  path: null,
  dirty: false,
  codecId: "—",
  codecStructural: false,
  words: 0,
  chars: 0,
  blocks: 0,
  line: 1,
  col: 1,
  p50: -1,
  p99: -1,
  samples: 0,
  host: "checking",
  ai: "none",
  message: "",
};

let state: Status = initial;
let pending: Partial<Status> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

export function getStatus(): Status {
  return state;
}

export function subscribeStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Coalesced by default; pass `immediate` for changes a human caused directly (open, save). */
export function setStatus(patch: Partial<Status>, immediate = false): void {
  pending = pending ? { ...pending, ...patch } : { ...patch };
  if (immediate) {
    flush();
    return;
  }
  timer ??= setTimeout(flush, PUBLISH_MS);
}

function flush(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!pending) return;
  const next = { ...state, ...pending };
  pending = null;
  // Cheap identity check: nothing re-renders when nothing moved.
  let changed = false;
  for (const key of Object.keys(next) as (keyof Status)[]) {
    if (next[key] !== state[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = next;
  for (const l of listeners) l();
}

// ---------------------------------------------------------------------------
// Latency samples
// ---------------------------------------------------------------------------

/**
 * A fixed ring buffer, so the measurement itself never allocates on the keystroke path. 1024
 * samples is about two minutes of continuous typing, which is the window over which a p99 is
 * worth quoting.
 */
const CAPACITY = 1024;
const samples = new Float32Array(CAPACITY);
let count = 0;
let cursor = 0;

export function recordLatency(ms: number): void {
  samples[cursor] = ms;
  cursor = (cursor + 1) % CAPACITY;
  if (count < CAPACITY) count++;
}

export function resetLatency(): void {
  count = 0;
  cursor = 0;
}

const scratch = new Float32Array(CAPACITY);

export function latencyPercentiles(): { p50: number; p99: number; samples: number } {
  if (count === 0) return { p50: -1, p99: -1, samples: 0 };
  scratch.set(samples.subarray(0, count));
  const slice = scratch.subarray(0, count);
  slice.sort();
  const at = (q: number) => slice[Math.min(count - 1, Math.floor(q * count))] ?? 0;
  return { p50: at(0.5), p99: at(0.99), samples: count };
}
