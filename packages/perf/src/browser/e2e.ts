/**
 * Browser end-to-end latency: keystroke → paint. Budget 16 ms p99 (ARCHITECTURE §5).
 *
 * Three independent measurements, because no single one is trustworthy on its own:
 *
 *  A. `InputLatency::KeyDown` async trace events (category `latencyInfo`). Chromium's own
 *     end-to-end input latency instrumentation: begins when the browser process receives
 *     the key, ends at frame swap. This is the number Chrome's own perf team uses. When
 *     present it is authoritative and the gate uses it.
 *
 *  B. `EventDispatch(keydown)` → the next renderer `Commit`, then → the next
 *     `DrawFrame`/`ActivateLayerTree`. Structural correlation over `devtools.timeline`.
 *     Used when (A) is unavailable.
 *
 *  C. An in-page probe: `keydown.timeStamp` → `rAF` → `setTimeout(0)`, i.e. input event
 *     creation to main-thread frame completion. Cheap, robust, and excludes compositor
 *     draw, so it reads slightly LOW versus (A). Reported always as a cross-check: if C
 *     and A disagree wildly, the trace correlation is wrong and the report says so.
 *
 * Input is dispatched with CDP `Input.dispatchKeyEvent` via Playwright's keyboard, which
 * enters Chromium through the real browser input pipeline — not a synthetic DOM event.
 */

import { chromium, type Browser, type Page, type CDPSession } from "playwright";
import { summarize, type Stats } from "../stats";
import { SAMPLING } from "../budgets";

export type PaintSource = "app" | "calibration";
export type PaintMethod = "InputLatency::KeyDown" | "EventDispatch→DrawFrame" | "rAF+task probe";

export interface PaintResult {
  source: PaintSource;
  url: string;
  /** The measurement the gate uses. */
  method: PaintMethod;
  stats: Stats;
  /** Every method that produced samples, for cross-checking. */
  methods: { method: PaintMethod; stats: Stats }[];
  browser: string;
  notes: string[];
  /** Long tasks (>50 ms) observed on the main thread while typing. */
  longTasks: { count: number; totalMs: number; maxMs: number };
}

interface TraceEvent {
  name?: string; cat?: string; ph?: string; ts?: number; dur?: number;
  pid?: number; tid?: number; id?: string; id2?: { local?: string; global?: string };
  args?: Record<string, unknown>;
}

const PROBE = `
window.__scrivPaint = (() => {
  const s = { samples: [], armed: false, longTasks: [], };
  addEventListener('keydown', (e) => {
    if (!s.armed) return;
    const t0 = e.timeStamp;
    requestAnimationFrame(() => { setTimeout(() => { s.samples.push(performance.now() - t0); }, 0); });
  }, true);
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (s.armed) s.longTasks.push(e.duration); })
      .observe({ entryTypes: ['longtask'] });
  } catch (_) {}
  return s;
})();
`;

async function findEditor(page: Page, selector: string, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs, state: "attached" });
    return true;
  } catch { return false; }
}

/** Reachability probe for a candidate app URL. No retries, no waiting around. */
export async function isUp(url: string, timeoutMs = 1200): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch { return false; }
}

export interface PaintOpts {
  url: string;
  source: PaintSource;
  selector?: string;
  samples?: number;
  warmup?: number;
  /** Gap between keystrokes. Must exceed a frame or Chromium coalesces the input. */
  keyDelayMs?: number;
  headed?: boolean;
}

export async function benchKeystrokeToPaint(opts: PaintOpts): Promise<PaintResult> {
  const selector = opts.selector ?? process.env.SCRIV_PERF_SELECTOR ?? ".ProseMirror";
  const samples = opts.samples ?? SAMPLING.paintSamples;
  const warmup = opts.warmup ?? SAMPLING.paintWarmup;
  const keyDelayMs = opts.keyDelayMs ?? 55;
  const notes: string[] = [];

  let browser: Browser | undefined;
  // Full Chromium in new-headless mode, not chrome-headless-shell: the shell's compositing
  // path is not the shipping one and a 16 ms frame budget measured on it would be fiction.
  try {
    browser = await chromium.launch({
      headless: !opts.headed,
      channel: "chromium",
      args: ["--force-device-scale-factor=1", "--disable-backgrounding-occluded-windows"],
    });
  } catch (err) {
    notes.push(`full-chromium launch failed (${String(err)}); fell back to the default build`);
    browser = await chromium.launch({ headless: !opts.headed });
  }

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(PROBE);
    const page = await context.newPage();
    const client: CDPSession = await context.newCDPSession(page);

    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const found = await findEditor(page, selector, 45_000);
    if (!found) {
      throw new Error(
        `no editor matched ${selector} at ${opts.url} after 45s. ` +
        `Set SCRIV_PERF_SELECTOR if apps/web uses a different mount.`,
      );
    }
    // Give the initial render of a 2,000-block document time to settle before typing.
    await page.waitForTimeout(1500);

    // Caret into the middle of the document — typing at position 0 of a long document is
    // not the same work as typing in the middle of it.
    const placed = await page.evaluate(() => {
      const w = window as unknown as { __scrivPerf?: { placeCaret(f: number): void } };
      if (w.__scrivPerf?.placeCaret) { w.__scrivPerf.placeCaret(0.5); return "api"; }
      return "click";
    });
    if (placed === "click") {
      await page.click(selector, { position: { x: 200, y: 400 } });
      notes.push("caret placed by click (app exposes no __scrivPerf.placeCaret); position is approximate");
    }
    await page.waitForTimeout(400);

    const LETTERS = "the quick brown fox jumps over lazy dogs while editors commit state ".split("");
    let li = 0;
    const nextKey = () => LETTERS[li++ % LETTERS.length]!;

    // Warm-up: JIT, ProseMirror's DOM observer, style recalc caches, GPU tile allocation.
    for (let i = 0; i < warmup; i++) {
      await page.keyboard.type(nextKey());
      await page.waitForTimeout(keyDelayMs);
    }

    await client.send("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: {
        recordMode: "recordAsMuchAsPossible",
        includedCategories: [
          "devtools.timeline",
          "disabled-by-default-devtools.timeline",
          "disabled-by-default-devtools.timeline.frame",
          "benchmark",
          "latencyInfo",
          "rail",
          "toplevel",
        ],
      },
    });
    const events: TraceEvent[] = [];
    client.on("Tracing.dataCollected", (e: { value: TraceEvent[] }) => { events.push(...e.value); });
    const traceDone = new Promise<void>((resolve) => client.once("Tracing.tracingComplete", () => resolve()));

    await page.evaluate(() => {
      const w = window as unknown as { __scrivPaint: { samples: number[]; longTasks: number[]; armed: boolean } };
      w.__scrivPaint.samples = []; w.__scrivPaint.longTasks = []; w.__scrivPaint.armed = true;
    });

    for (let i = 0; i < samples; i++) {
      await page.keyboard.type(nextKey());
      await page.waitForTimeout(keyDelayMs);
    }
    await page.waitForTimeout(500);

    const probeData = await page.evaluate(() => {
      const w = window as unknown as { __scrivPaint: { samples: number[]; longTasks: number[]; armed: boolean } };
      w.__scrivPaint.armed = false;
      return { samples: w.__scrivPaint.samples.slice(), longTasks: w.__scrivPaint.longTasks.slice() };
    });

    await client.send("Tracing.end");
    await traceDone;

    const methods: { method: PaintMethod; stats: Stats }[] = [];

    const inputLatency = extractInputLatency(events);
    if (inputLatency.length >= 20) {
      methods.push({ method: "InputLatency::KeyDown", stats: summarize(inputLatency, warmup) });
    } else if (inputLatency.length > 0) {
      notes.push(`InputLatency::KeyDown produced only ${inputLatency.length} usable pairs; not used`);
    } else {
      notes.push("no InputLatency::KeyDown async events in the trace (category latencyInfo not emitted)");
    }

    const dispatchToDraw = extractDispatchToFrame(events);
    if (dispatchToDraw.samples.length >= 20) {
      methods.push({ method: "EventDispatch→DrawFrame", stats: summarize(dispatchToDraw.samples, warmup) });
      if (dispatchToDraw.note) notes.push(dispatchToDraw.note);
    } else {
      notes.push(`EventDispatch→frame correlation produced ${dispatchToDraw.samples.length} samples; not used`);
    }

    if (probeData.samples.length > 0) {
      methods.push({ method: "rAF+task probe", stats: summarize(probeData.samples, warmup) });
    }

    if (methods.length === 0) throw new Error("no keystroke→paint measurement produced any samples");

    const preference: PaintMethod[] = ["InputLatency::KeyDown", "EventDispatch→DrawFrame", "rAF+task probe"];
    const chosen = preference.map((m) => methods.find((x) => x.method === m)).find(Boolean)!;

    // Cross-check: the rAF probe excludes compositor draw so it should read at or below
    // the trace numbers. If it reads meaningfully HIGHER, the trace correlation is picking
    // the wrong frame and the gate would be certifying a number that is too good.
    const probe = methods.find((m) => m.method === "rAF+task probe");
    if (probe && chosen.method !== "rAF+task probe" && probe.stats.p99 > chosen.stats.p99 * 1.35) {
      notes.push(
        `CROSS-CHECK FAILED: the in-page probe (p99 ${probe.stats.p99.toFixed(2)} ms) exceeds ` +
        `${chosen.method} (p99 ${chosen.stats.p99.toFixed(2)} ms) by >35%. The trace correlation ` +
        `is probably attaching keystrokes to the wrong frame — treat the gated number as unproven.`,
      );
    }

    const version = browser.version();
    await context.close();

    const lt = probeData.longTasks;
    return {
      source: opts.source,
      url: opts.url,
      method: chosen.method,
      stats: chosen.stats,
      methods,
      browser: `Chromium ${version}${opts.headed ? " (headed)" : " (headless)"}`,
      notes,
      longTasks: {
        count: lt.length,
        totalMs: lt.reduce((a, b) => a + b, 0),
        maxMs: lt.length ? Math.max(...lt) : 0,
      },
    };
  } finally {
    await browser?.close();
  }
}

// ---------------------------------------------------------------------------------------
// Trace extraction

function asyncId(e: TraceEvent): string | undefined {
  return e.id ?? e.id2?.local ?? e.id2?.global;
}

/**
 * Chromium's own end-to-end input latency: async `InputLatency::KeyDown` events whose
 * begin is the browser-process receipt of the key and whose end is the frame swap that
 * carries the result.
 */
function extractInputLatency(events: TraceEvent[]): number[] {
  const begins = new Map<string, number>();
  const out: number[] = [];
  const sorted = events.filter((e) => e.name === "InputLatency::KeyDown").sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  for (const e of sorted) {
    const id = asyncId(e);
    if (id === undefined || e.ts === undefined) continue;
    if (e.ph === "b" || e.ph === "S") begins.set(id, e.ts);
    else if (e.ph === "e" || e.ph === "F") {
      const t0 = begins.get(id);
      if (t0 === undefined) continue;
      begins.delete(id);
      const ms = (e.ts - t0) / 1000;
      // Sanity window: a sub-microsecond or multi-second "latency" is a mis-paired id.
      if (ms > 0.05 && ms < 2000) out.push(ms);
    } else if (e.ph === "X" && e.dur !== undefined) {
      const ms = e.dur / 1000;
      if (ms > 0.05 && ms < 2000) out.push(ms);
    }
  }
  return out;
}

/**
 * Structural fallback: keydown dispatch on the renderer main thread → the frame that
 * carries its result. Prefers a compositor `DrawFrame`/`ActivateLayerTree` after the
 * renderer's `Commit`; falls back to the `Commit` itself and says so.
 */
function extractDispatchToFrame(events: TraceEvent[]): { samples: number[]; note?: string } {
  const byTs = (a: TraceEvent, b: TraceEvent) => (a.ts ?? 0) - (b.ts ?? 0);

  const keydowns = events
    .filter((e) => e.name === "EventDispatch" && (e.args?.data as { type?: string } | undefined)?.type === "keydown")
    .sort(byTs);
  const commits = events.filter((e) => e.name === "Commit").sort(byTs);
  const draws = events
    .filter((e) => e.name === "DrawFrame" || e.name === "ActivateLayerTree" || e.name === "Graphics.Pipeline.DrawAndSwap")
    .sort(byTs);

  if (keydowns.length === 0) return { samples: [] };

  const usedDraw = draws.length > 0;
  const samples: number[] = [];
  let ci = 0, di = 0;

  for (const kd of keydowns) {
    const t0 = kd.ts ?? 0;
    while (ci < commits.length && (commits[ci]!.ts ?? 0) < t0) ci++;
    let ci2 = ci;
    if (ci2 >= commits.length) continue;
    const commitTs = commits[ci2]!.ts ?? 0;

    let endTs = commitTs;
    if (usedDraw) {
      let di2 = di;
      while (di2 < draws.length && (draws[di2]!.ts ?? 0) < commitTs) di2++;
      if (di2 < draws.length) { endTs = draws[di2]!.ts ?? commitTs; di = di2; }
    }
    const ms = (endTs - t0) / 1000;
    if (ms > 0.05 && ms < 500) samples.push(ms);
  }

  return {
    samples,
    note: usedDraw
      ? undefined
      : "no DrawFrame/ActivateLayerTree events in the trace; EventDispatch→Commit used instead, " +
        "which stops at the renderer's frame commit and excludes compositor draw and swap",
  };
}
