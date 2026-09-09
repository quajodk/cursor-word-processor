/**
 * Renders workbench/status.json (plus any measured results in bench/out/) into a single
 * self-contained page. Regenerated after every wave: `bun run workbench/build.ts`.
 */
import { existsSync } from "node:fs";

type State = "done" | "running" | "queued" | "blocked" | "pending";
interface Piece { id: string; name: string; scope: string; builder: State; critic: State; evidence: string | null; gap: string | null }
interface Metric { label: string; value: string | number | null; unit: string; budget: string; state: string; lowerIsBetter?: boolean }
interface Status {
  wave: number; waveTitle: string; pieces: Piece[]; metrics: Metric[];
  decisions: { t: string; d: string; why: string }[]; notes: string[];
}

const status: Status = await Bun.file("workbench/status.json").json();

// Fold in real measurements when the benches have run. Absence stays absence — an
// unmeasured number is rendered as unmeasured, never as zero and never as a guess.
for (const [file, apply] of [
  ["bench/out/perf.json", (j: any) => {
    const set = (label: string, v: unknown) => { const m = status.metrics.find((m) => m.label === label); if (m && v != null) { m.value = typeof v === "number" ? Number(v.toFixed(2)) : String(v); m.state = "measured"; } };
    set("Keystroke → state commit", j?.keystroke?.p99);
    set("Keystroke → paint", j?.paint?.p99);
  }],
  ["bench/out/roundtrip.json", (j: any) => {
    const set = (label: string, v: unknown) => { const m = status.metrics.find((m) => m.label === label); if (m && v != null) { m.value = typeof v === "number" ? Number(v.toFixed(3)) : String(v); m.state = "measured"; } };
    set("docx round-trip T0 identity", j?.t0?.percentIdentical);
    set("docx round-trip T2 semantic", j?.t2?.weighted);
    set("Real .docx corpus", j?.corpus?.count);
  }],
  ["bench/out/md.json", (j: any) => {
    const m = status.metrics.find((m) => m.label === "Markdown round-trip");
    if (m && j?.passRate != null) { m.value = Number((j.passRate * 100).toFixed(1)); m.state = "measured"; }
  }],
] as const) {
  if (existsSync(file)) { try { apply(await Bun.file(file).json()); } catch { /* a malformed bench file must not fake a number */ } }
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const chip = (s: State | string) => `<span class="chip chip-${esc(s)}">${esc(s)}</span>`;

/**
 * Budget direction. A millisecond figure must come in UNDER its budget; a percentage or a
 * count must REACH it. A tile that is over budget reads red — a progress page that shows
 * green while the gate is failing is worse than no page.
 *
 * That inference was wrong for any count where fewer is better, and it was showing one such
 * tile green: "Link targets lost, 1437 files" read 4 against a budget of 0, and 4 < 0 is
 * false, so it rendered as passing. `lowerIsBetter` states the direction explicitly for those;
 * the unit-based guess stays as the default for everything else.
 */
const overBudget = (m: Metric): boolean | null => {
  if (m.value === null || m.state !== "measured") return null;
  const v = Number(m.value), b = Number(m.budget);
  if (!Number.isFinite(v) || !Number.isFinite(b)) return null;
  if (m.lowerIsBetter ?? m.unit.includes("ms")) return v > b;
  return v < b;
};

const metricTile = (m: Metric) => {
  const has = m.value !== null && m.state === "measured";
  const over = overBudget(m);
  const cls = !has ? " tile-empty" : over === true ? " tile-over" : over === false ? " tile-ok" : "";
  return `<div class="tile${cls}">
    <div class="tile-label">${esc(m.label)}</div>
    <div class="tile-value">${has ? `${esc(m.value)}<span class="tile-unit">${esc(m.unit)}</span>` : `<span class="tile-pending">not yet measured</span>`}</div>
    <div class="tile-budget">${over === true ? "over budget · " : "budget · "}${esc(m.budget)} ${esc(m.unit)}</div>
  </div>`;
};

const pieceRow = (p: Piece) => `<article class="piece piece-${esc(p.builder)}">
  <header class="piece-head">
    <h3>${esc(p.name)}</h3>
    <div class="piece-chips">${chip(p.builder)}${p.critic !== "pending" ? chip(p.critic) : ""}</div>
  </header>
  <p class="piece-scope">${esc(p.scope)}</p>
  ${p.evidence ? `<p class="piece-evidence"><span class="tag">verified</span>${esc(p.evidence)}</p>` : ""}
  ${p.gap ? `<p class="piece-gap"><span class="tag tag-gap">biggest gap</span>${esc(p.gap)}</p>` : ""}
</article>`;

const html = `<title>scriv workbench</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,400;0,600;1,400&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{
  --paper:#F6F7F9; --surface:#FFFFFF; --ink:#14171C; --ink-soft:#5C6470; --ink-faint:#8A93A0;
  --rule:#DFE3E9; --accent:#B8352B; --accent-soft:#F5E4E2; --good:#2E7D5A; --good-soft:#E2F0EA;
  --warn:#9A6A0C; --warn-soft:#F6ECD8; --idle:#7A828E; --idle-soft:#ECEEF2;
  --shadow:0 1px 2px rgba(20,23,28,.05), 0 8px 24px -16px rgba(20,23,28,.18);
}
:root:not([data-theme="light"]){ @media (prefers-color-scheme: dark){
  --paper:#0E1014; --surface:#161920; --ink:#E9ECF1; --ink-soft:#98A1AE; --ink-faint:#6B7482;
  --rule:#242932; --accent:#EC6C61; --accent-soft:#2E1B1A; --good:#4FB587; --good-soft:#132620;
  --warn:#D3A03A; --warn-soft:#241D0F; --idle:#7C8593; --idle-soft:#1C2028;
  --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 24px -16px rgba(0,0,0,.8);
}}
:root[data-theme="dark"]{
  --paper:#0E1014; --surface:#161920; --ink:#E9ECF1; --ink-soft:#98A1AE; --ink-faint:#6B7482;
  --rule:#242932; --accent:#EC6C61; --accent-soft:#2E1B1A; --good:#4FB587; --good-soft:#132620;
  --warn:#D3A03A; --warn-soft:#241D0F; --idle:#7C8593; --idle-soft:#1C2028;
  --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 24px -16px rgba(0,0,0,.8);
}
*{box-sizing:border-box}
body{background:var(--paper);color:var(--ink);
  font-family:"IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;
  font-size:15px;line-height:1.55;margin:0;padding:clamp(20px,4vw,56px) clamp(16px,4vw,40px) 72px;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:900px;margin:0 auto;display:flex;flex-direction:column;gap:clamp(32px,5vw,52px)}

header.masthead{display:flex;flex-direction:column;gap:10px;padding-bottom:20px;border-bottom:2px solid var(--ink)}
.eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:600}
h1{font-family:Spectral,Georgia,serif;font-weight:600;font-size:clamp(30px,6vw,44px);line-height:1.08;
  margin:0;letter-spacing:-.015em;text-wrap:balance}
.dek{font-family:Spectral,Georgia,serif;font-style:italic;color:var(--ink-soft);font-size:clamp(15px,2.4vw,18px);margin:0;max-width:62ch}
.stamp{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:11.5px;color:var(--ink-faint);
  display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:4px}

section{display:flex;flex-direction:column;gap:16px}
h2{font-family:Spectral,Georgia,serif;font-size:13px;font-weight:600;letter-spacing:.13em;
  text-transform:uppercase;color:var(--ink-soft);margin:0;padding-bottom:8px;border-bottom:1px solid var(--rule)}

.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:12px}
.tile{background:var(--surface);border:1px solid var(--rule);border-radius:3px;padding:14px 16px;
  display:flex;flex-direction:column;gap:5px;border-left:3px solid var(--good);box-shadow:var(--shadow)}
.tile-empty{border-left-color:var(--idle)}
.tile-ok{border-left-color:var(--good)}
.tile-over{border-left-color:var(--accent)}
.tile-over .tile-value{color:var(--accent)}
.tile-over .tile-budget{color:var(--accent);font-weight:500}
.tile-label{font-size:11.5px;letter-spacing:.05em;color:var(--ink-soft);text-transform:uppercase;font-weight:500}
.tile-value{font-family:"IBM Plex Mono",monospace;font-size:26px;font-weight:500;line-height:1.1;
  font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.tile-unit{font-size:12px;color:var(--ink-soft);margin-left:6px;font-weight:400}
.tile-pending{font-family:"IBM Plex Sans",sans-serif;font-size:14px;color:var(--ink-faint);font-style:italic;letter-spacing:0}
.tile-budget{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--ink-faint);font-variant-numeric:tabular-nums}

.pieces{display:flex;flex-direction:column;gap:10px}
.piece{background:var(--surface);border:1px solid var(--rule);border-left:3px solid var(--idle);
  border-radius:3px;padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.piece-done{border-left-color:var(--good)}
.piece-running{border-left-color:var(--accent)}
.piece-blocked{border-left-color:var(--warn)}
.piece-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.piece h3{font-family:Spectral,Georgia,serif;font-size:18px;font-weight:600;margin:0;letter-spacing:-.01em}
.piece-chips{display:flex;gap:6px}
.chip{font-family:"IBM Plex Mono",monospace;font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;
  padding:2px 7px;border-radius:2px;background:var(--idle-soft);color:var(--idle);white-space:nowrap}
.chip-done{background:var(--good-soft);color:var(--good)}
.chip-running{background:var(--accent-soft);color:var(--accent)}
.chip-blocked{background:var(--warn-soft);color:var(--warn)}
.piece-scope{margin:0;color:var(--ink-soft);font-size:14px;max-width:70ch}
.piece-evidence,.piece-gap{margin:0;font-size:13.5px;color:var(--ink);max-width:74ch}
.tag{font-family:"IBM Plex Mono",monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;
  color:var(--good);margin-right:8px}
.tag-gap{color:var(--warn)}

.decisions{display:flex;flex-direction:column;gap:0}
.decision{display:grid;grid-template-columns:1fr;gap:4px;padding:14px 0;border-bottom:1px solid var(--rule)}
.decision:last-child{border-bottom:none}
@media(min-width:720px){.decision{grid-template-columns:150px 1fr;gap:6px 24px}}
.decision dt{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint);font-weight:500;padding-top:2px}
.decision-body{display:flex;flex-direction:column;gap:4px}
.decision-what{font-family:Spectral,Georgia,serif;font-size:17px;font-weight:600;margin:0;letter-spacing:-.01em}
.decision-why{margin:0;color:var(--ink-soft);font-size:14px;max-width:68ch}

ul.notes{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:8px;color:var(--ink-soft);font-size:14px;max-width:74ch}
ul.notes li::marker{color:var(--accent)}
footer{border-top:1px solid var(--rule);padding-top:16px;font-family:"IBM Plex Mono",monospace;
  font-size:11.5px;color:var(--ink-faint)}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
<div class="wrap">
<header class="masthead">
  <div class="eyebrow">Wave ${status.wave} · ${esc(status.waveTitle)}</div>
  <h1>scriv workbench</h1>
  <p class="dek">An IDE for writing. Markdown on disk is the source of truth; the editing surface is a real word processor.</p>
  <div class="stamp"><span>updated ${new Date().toISOString().replace("T", " ").slice(0, 16)}Z</span><span>bun · TypeScript · ProseMirror</span></div>
</header>

<section>
  <h2>Measured bar</h2>
  <div class="tiles">${status.metrics.map(metricTile).join("")}</div>
</section>

<section>
  <h2>Subsystems</h2>
  <div class="pieces">${status.pieces.map(pieceRow).join("")}</div>
</section>

<section>
  <h2>Decisions on the record</h2>
  <dl class="decisions">${status.decisions.map((d) => `<div class="decision">
    <dt>${esc(d.t)}</dt>
    <div class="decision-body">
      <p class="decision-what">${esc(d.d)}</p>
      <p class="decision-why">${esc(d.why)}</p>
    </div></div>`).join("")}</dl>
</section>

<section>
  <h2>Notes</h2>
  <ul class="notes">${status.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
</section>

<footer>Every number on this page is measured or absent. Nothing here is estimated.</footer>
</div>`;

await Bun.write("workbench/index.html", html);
console.log(`workbench/index.html — ${(html.length / 1024).toFixed(1)} kB`);
