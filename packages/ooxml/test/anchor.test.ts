import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { importDocx } from "../src/import";
import { buildAnchors, prepareBlocks, reanchor, type Anchor, type BlockSignalInput } from "../src/anchor";
import {
  scenarioCombined, scenarioDelete, scenarioInsert, scenarioMerge, scenarioMove,
  scenarioReword, scenarioRewrite, scenarioSplit, type Scenario,
} from "./scenarios";

/**
 * The anchor engine, against real documents.
 *
 * DOCX-FIDELITY.md §3 calls out-of-session re-anchoring "the actual research problem" of this
 * project, and it is 925 lines of constrained Needleman-Wunsch with affine gaps. It had no
 * test at all — and `test/scenarios.ts`, a 239-line ground-truth harness built for exactly
 * this purpose, was imported by nothing. An untested subsystem with a purpose-built untested
 * harness beside it is the most expensive kind of gap: the work of making it checkable was
 * already done.
 *
 * WHAT IS BEING ASKED. The writer's `.md` was edited by something that is not this editor —
 * vim, a merge, a colleague's PR. Blocks have been reworded, split, merged, moved, inserted
 * and deleted, and the stored anchors have to be re-matched to them so a paragraph's Word
 * formatting, comments and revisions follow it. In-session edits never come here at all;
 * `doc-model/aid.ts` tracks those exactly.
 *
 * TWO KINDS OF FAILURE, AND THEY ARE NOT SYMMETRIC. Failing to match a block loses its
 * formatting, which is visible, ledgered and recoverable. Matching the WRONG block applies one
 * paragraph's Word properties to another, which is silent and is not. So the two are counted
 * separately and held to different standards — see the table of thresholds below.
 *
 * The first run of this file was also the first measurement of the subsystem, and it found a
 * traceback bug that had been costing about 40 points of recall on every position-changing
 * edit. Across ~5,600 blocks per scenario the engine now recovers 100% of content-preserving
 * edits, 100% of insertions and deletions, 96.2% of moves and 94.4% of a combined week of
 * editing, with 0-3 blocks silently misapplied.
 *
 * The scenarios are derived from each document's own vocabulary and sentence boundaries, so
 * none of them can be passed by pattern-matching a fixture, and the documents are whatever
 * the corpus happens to contain rather than ones picked to look good.
 */

function repoRoot(): string {
  let d = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "bun.lock"))) return d;
    d = dirname(d);
  }
  return d;
}

const CORPUS = join(repoRoot(), "corpus", "docx");

interface Case { name: string; blocks: BlockSignalInput[]; aids: string[]; anchors: Anchor[] }

/** Real documents, big enough that alignment has something to get wrong. */
function documents(limit: number, minBlocks = 60): Case[] {
  if (!existsSync(CORPUS)) return [];
  const out: Case[] = [];
  for (const name of readdirSync(CORPUS).filter((f) => f.endsWith(".docx")).sort()) {
    let imported;
    try { imported = importDocx(readFileSync(join(CORPUS, name))); } catch { continue; }

    // DOCUMENT ORDER COMES FROM `range`, NOT FROM THE KEY ORDER OF `blocks`.
    //
    // Aids are random per import, and roughly one in 1,500 of them comes out looking like an
    // integer ("66030358"). JavaScript hoists integer-like keys to the FRONT of an object's
    // key order, ascending, so `Object.entries(sidecar.blocks)` teleports those few blocks to
    // the top of the document — a different few on every run, because the aids are fresh each
    // import. Measured on this corpus: 4 blocks in 6,015.
    //
    // That was enough to make this file's own numbers drift between runs (the combined
    // scenario reported 5,645 blocks on two runs and 5,646 on a third) and it meant the
    // alignment was being scored against a document nobody has, in an order Word never wrote.
    // `export.ts` already sorts by `range` for exactly this reason; so does this.
    const ordered = Object.entries(imported.sidecar.blocks)
      .filter(([, rec]) => rec.range !== null)
      .sort((a, b) => a[1].range![0] - b[1].range![0]);

    const blocks: BlockSignalInput[] = [];
    const aids: string[] = [];
    for (const [aid, rec] of ordered) {
      if (rec.kind === "table") continue;
      if (rec.text.trim().length === 0) continue;
      blocks.push({
        kind: rec.kind, text: rec.text, level: rec.level,
        listRef: rec.numRef, listLevel: rec.listLevel, styleId: rec.styleId, aid,
      });
      aids.push(aid);
    }
    if (blocks.length < minBlocks) continue;
    out.push({ name, blocks, aids, anchors: buildAnchors(blocks, aids) });
    if (out.length >= limit) break;
  }
  return out;
}

/** How one scenario went on one document, split by KIND of failure rather than by count. */
interface Score {
  recall: number;
  expected: number;
  /** Matched nothing. The SAFE failure: formatting is lost, visibly, and ledgered. */
  lost: number;
  /** Matched the wrong anchor AND applied its properties. The failure that must not happen. */
  misapplied: number;
  /** Matched the wrong anchor but refused to apply its properties. Safe, and counted. */
  wrongButRefused: number;
}

function score(c: Case, s: Scenario): Score {
  const result = reanchor(c.anchors, s.blocks);
  let correct = 0, lost = 0, misapplied = 0, wrongButRefused = 0, expected = 0;
  const removed = new Set(s.removed);

  for (let i = 0; i < s.truth.length; i++) {
    const want = s.truth[i] ?? null;
    const alt = s.altTruth?.[i] ?? null;
    const a = result.assignments[i];
    const got = a?.aid ?? null;

    if (want !== null) {
      expected++;
      if (got === want || (alt !== null && got === alt)) correct++;
      else if (got === null) lost++;
      else if (a?.applyProps) misapplied++;
      else wrongButRefused++;
    } else if (got !== null && !removed.has(got)) {
      // A genuinely new block was matched to a surviving anchor. Reusing the aid of a block
      // that was deleted is reasonable; taking a LIVE block's identity is not.
      if (a?.applyProps) misapplied++;
      else wrongButRefused++;
    }
  }
  return { recall: expected === 0 ? 1 : correct / expected, expected, lost, misapplied, wrongButRefused };
}

const SEED = 0x5c817;

describe("the anchor engine against real documents", () => {
  const docs = documents(12);

  test("the corpus is present and the documents are big enough to be a test", () => {
    // Without this, every loop below iterates an empty array and reports green.
    expect(docs.length).toBeGreaterThan(5);
    expect(Math.min(...docs.map((d) => d.blocks.length))).toBeGreaterThan(59);
  });

  test("an untouched document re-anchors to itself, exactly", () => {
    // The floor. If this fails nothing else means anything.
    for (const c of docs) {
      const result = reanchor(c.anchors, c.blocks);
      const got = result.assignments.map((a) => a.aid);
      expect(`${c.name}: ${got.filter((a, i) => a === c.aids[i]).length}/${c.aids.length}`)
        .toBe(`${c.name}: ${c.aids.length}/${c.aids.length}`);
      expect(result.stats.lost).toBe(0);
      // And every block keeps its Word properties: nothing is refused on a no-op.
      expect(result.assignments.every((a) => a.applyProps)).toBe(true);
    }
  }, 120_000);

  /**
   * Each entry: the scenario, a recall floor, and a cap on SILENT MISAPPLICATION.
   *
   * The two numbers are not the same kind of number, and that is the point.
   *
   * `maxMisapplied` is the one the design cares about. DOCX-FIDELITY.md §3: "silent
   * misapplication is worse than visible loss." Giving block B the Word formatting that
   * belonged to block A is invisible and unrecoverable; failing to match B at all loses its
   * formatting, says so in the ledger, and the writer can see it. The caps below are the
   * measured counts across ~5,600 blocks per scenario — 2 or 3 — and they are caps, not
   * targets: they exist so the number cannot grow unnoticed.
   *
   * `minRecall` is set a few points BELOW what the engine currently achieves, so the next
   * document added to the corpus does not turn the suite red.
   *
   *   CONTENT changes  — reword, rewrite, split, merge — recover 100%.
   *   POSITION changes — insert and delete recover 100%, move 96.2%, combined 94.4%.
   *
   * These floors were 0.50 and 0.42 when this file was written, because the DP traceback was
   * broken and the exact-content move-recovery pass was carrying the whole feature. The
   * diagnosis was made by running the aligner with `recoverMoves: false`, which dropped recall
   * to ~10% on any document past 200 blocks; the cause was a gap-state exit test that compared
   * a Float32 cell for equality within 1e-6, sixty times finer than the ulp at those magnitudes.
   * A traceback that entered a gap never left it. See `aligner.test.ts`, which pins the
   * behaviour without needing this corpus.
   *
   * Insert and delete now misapply NOTHING, where they each misapplied 2 blocks before — the
   * lost anchors were not merely lost, some of them were landing on the wrong block on the way
   * out. `move` and `combined` are the two that still lose blocks (214 and 307).
   *
   * That explanation used to read "because a reworded moved block defeats exact content match".
   * Classifying every miss showed it was wrong: of 242 blocks missed after a moved section, 238
   * were SHORT — under three tokens — and NOT ONE was reworded. Move recovery was excluding
   * them by a token floor of 3 inherited from the waypoint skeleton, which needs it for a
   * reason move recovery does not share. Lowering that floor to 2 is free; see
   * `moveMinTokens` in `src/anchor.ts` for the sweep and for the guard that was tried at 1
   * and measured to make things worse. Reworded moved blocks are a real limit, but they are
   * the minority case: 66 of the combined scenario's 348 misses.
   */
  const SCENARIOS: { make: (c: Case) => Scenario; minRecall: number; maxMisapplied: number }[] = [
    { make: (c) => scenarioReword(c.blocks, c.aids, SEED, 0.2, 0.15), minRecall: 0.95, maxMisapplied: 0 },
    { make: (c) => scenarioRewrite(c.blocks, c.aids, SEED), minRecall: 0.95, maxMisapplied: 0 },
    { make: (c) => scenarioSplit(c.blocks, c.aids, SEED, 0.15), minRecall: 0.95, maxMisapplied: 0 },
    { make: (c) => scenarioMerge(c.blocks, c.aids, SEED, 0.15), minRecall: 0.95, maxMisapplied: 0 },
    { make: (c) => scenarioMove(c.blocks, c.aids, SEED), minRecall: 0.92, maxMisapplied: 3 },
    { make: (c) => scenarioInsert(c.blocks, c.aids, SEED, 4, 5), minRecall: 0.97, maxMisapplied: 1 },
    { make: (c) => scenarioDelete(c.blocks, c.aids, SEED, 3, 4), minRecall: 0.97, maxMisapplied: 1 },
    { make: (c) => scenarioCombined(c.blocks, c.aids, SEED), minRecall: 0.90, maxMisapplied: 4 },
  ];

  for (const spec of SCENARIOS) {
    const name = spec.make(docs[0] ?? { name: "", blocks: [], aids: [], anchors: [] }).name;
    test(`recovers identity after: ${name}`, () => {
      let expected = 0, correct = 0, lost = 0, misapplied = 0, wrongButRefused = 0;

      for (const c of docs) {
        const r = score(c, spec.make(c));
        expected += r.expected;
        correct += r.recall * r.expected;
        lost += r.lost;
        misapplied += r.misapplied;
        wrongButRefused += r.wrongButRefused;
      }

      const recall = expected === 0 ? 0 : correct / expected;
      console.log(
        `[anchor] ${name.padEnd(16)} recall ${(recall * 100).toFixed(1)}%  ` +
        `lost ${String(lost).padStart(4)}  MISAPPLIED ${misapplied}  wrong-but-refused ${wrongButRefused}  ` +
        `(${docs.length} docs, ${expected} blocks)`,
      );

      // Guards the whole test against a corpus that shrank to nothing.
      expect(expected).toBeGreaterThan(300);
      // Aggregate rather than per-document: one unusual file should move the number, not
      // decide the verdict.
      expect(`${name}: recall ${(recall * 100).toFixed(1)}%`)
        .toBe(recall >= spec.minRecall ? `${name}: recall ${(recall * 100).toFixed(1)}%` : `${name}: recall >= ${(spec.minRecall * 100).toFixed(0)}%`);
      expect(`${name}: ${misapplied} silently misapplied`)
        .toBe(misapplied <= spec.maxMisapplied ? `${name}: ${misapplied} silently misapplied` : `${name}: at most ${spec.maxMisapplied} silently misapplied`);
    }, 180_000);
  }

  test("a block it is not sure about does not get another block's properties", () => {
    // `applyProps === false` is the engine's refusal, and the splice engine treats it as
    // "synthesize a plain paragraph". A low-confidence match that still said applyProps
    // would be the silent misapplication DOCX-FIDELITY.md §3 forbids.
    let lowConfidence = 0, appliedAnyway = 0;
    for (const c of docs) {
      const s = scenarioCombined(c.blocks, c.aids, SEED);
      const result = reanchor(c.anchors, s.blocks);
      for (const a of result.assignments) {
        if (a.aid === null) continue;
        if (a.confidence >= 0.5) continue;
        lowConfidence++;
        if (a.applyProps) appliedAnyway++;
      }
    }
    console.log(`[anchor] low-confidence matches: ${lowConfidence}, of which applied properties anyway: ${appliedAnyway}`);
    expect(appliedAnyway).toBe(0);
  }, 180_000);

  test("everything it could not place is reported, not dropped", () => {
    // The ledger is the contract: every anchor is either assigned, retired into a merge, or
    // listed as lost. An anchor that simply vanishes is a comment or a revision that vanished
    // with it, and nothing would say so.
    for (const c of docs.slice(0, 6)) {
      const s = scenarioCombined(c.blocks, c.aids, SEED);
      const result = reanchor(c.anchors, s.blocks);

      const accounted = new Set<string>();
      for (const a of result.assignments) {
        if (a.aid) accounted.add(a.aid);
        for (const absorbed of a.absorbed ?? []) accounted.add(absorbed);
      }
      for (const l of result.lost) accounted.add(l.aid);
      for (const r of result.retired) accounted.add(r.aid);

      const unaccounted = c.aids.filter((aid) => !accounted.has(aid));
      expect(`${c.name}: ${unaccounted.length} unaccounted`).toBe(`${c.name}: 0 unaccounted`);
    }
  }, 180_000);

  test("it is deterministic — the same input twice gives the same answer", () => {
    // Alignment with tie-breaking is easy to make order-dependent, and a re-anchor that
    // differed run to run would make every number above meaningless.
    for (const c of docs.slice(0, 6)) {
      const s = scenarioCombined(c.blocks, c.aids, SEED);
      const a = reanchor(c.anchors, s.blocks).assignments.map((x) => `${x.aid}:${x.op}:${x.applyProps}`);
      const b = reanchor(c.anchors, s.blocks).assignments.map((x) => `${x.aid}:${x.op}:${x.applyProps}`);
      expect(a).toEqual(b);
    }
  }, 180_000);

  test("a document replaced wholesale matches nothing rather than matching anything", () => {
    // The adversarial case: entirely different prose, same block structure. An aligner that
    // leans on structure over content would happily map every block one-to-one and hand each
    // new paragraph the formatting of whatever used to be in that slot.
    for (const c of docs.slice(0, 6)) {
      const other = docs.find((d) => d.name !== c.name && d.blocks.length >= c.blocks.length);
      if (!other) continue;
      const foreign = other.blocks.slice(0, c.blocks.length);
      const result = reanchor(c.anchors, foreign);
      const applied = result.assignments.filter((a) => a.aid !== null && a.applyProps).length;
      // Some structural coincidence is expected on boilerplate ("Introduction", "Purpose").
      // What must not happen is wholesale adoption.
      expect(`${c.name}: ${applied < c.blocks.length * 0.25 ? "few" : "MANY"} foreign blocks took stored properties`)
        .toBe(`${c.name}: few foreign blocks took stored properties`);
    }
  }, 180_000);
});
