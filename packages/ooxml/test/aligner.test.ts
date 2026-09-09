import { describe, test, expect } from "bun:test";
import { buildAnchors, reanchor, type BlockSignalInput } from "../src/anchor";

/**
 * The alignment itself, on synthetic documents, with move recovery TURNED OFF.
 *
 * Two reasons this exists beside `anchor.test.ts` rather than inside it.
 *
 * First, the corpus is gitignored. Every measurement in `anchor.test.ts` is worth more than
 * anything here — real documents, real vocabulary — and every one of them silently measures
 * nothing on a fresh clone. This file needs no corpus, so the aligner has a floor that is
 * always actually checked.
 *
 * Second, `recoverMoves: false` is the point. The exact-content recovery pass runs after the
 * DP and re-attaches anything the alignment missed, which means it can hide a totally broken
 * aligner behind a respectable-looking recall. It did: measured across 12 corpus documents,
 * the DP alone recovered 9.9% of blocks after a four-run insertion while the pass carried the
 * result to ~61%. Turning it off is what made the defect visible, so it stays off here.
 *
 * THE DEFECT THESE TESTS ENCODE. The traceback decided whether a gap cell had opened a gap or
 * extended one by testing the stored cell for float equality against the open candidate:
 *
 *     state = Math.abs(cur - fromM) < 1e-6 ? "M" : "Y";
 *
 * The matrix is Float32 and its values reach several hundred on a real document, where one ulp
 * is ~6e-5 — sixty times the tolerance. The test could not come out true, so a traceback that
 * entered a gap state never left it. One five-paragraph insertion 66 blocks from the end turned
 * the remaining walk into 5,382 consecutive inserts, ran `j` down to -4758 (the gap branches sat
 * above the boundary guards, so nothing stopped it), and reported every earlier anchor lost.
 *
 * It is a quiet failure in the worst way: recall drops, misapplication does not, so the engine
 * still looks like it is behaving correctly and merely underperforming.
 */

/** A document whose paragraphs are all distinct, so identity is never ambiguous. */
function synthetic(n: number): BlockSignalInput[] {
  const out: BlockSignalInput[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 12 === 0) {
      out.push({ kind: "heading", level: 2, text: `Section ${i / 12} concerning matter ${i}`, styleId: "Heading2" });
      continue;
    }
    out.push({
      kind: "paragraph", styleId: "BodyText",
      text: `Paragraph ${i} records that the ${i}th observation differed from the ${i + 1}th in ways the preceding section did not anticipate, and the tables below set out the measured consequence.`,
    });
  }
  return out;
}

const aidsFor = (n: number): string[] => Array.from({ length: n }, (_, i) => `b${i}`);
const novel = (k: number): BlockSignalInput => ({
  kind: "paragraph", styleId: "BodyText",
  text: `Newly written paragraph ${k}: nothing in the stored document resembles this sentence, which exists only to occupy a position that no anchor claims.`,
});

/** Every original block keeps its own aid; nothing is lost. */
function recall(anchors: ReturnType<typeof buildAnchors>, blocks: BlockSignalInput[], truth: Array<string | null>) {
  const r = reanchor(anchors, blocks, { recoverMoves: false });
  let correct = 0, expected = 0, misapplied = 0;
  for (let i = 0; i < truth.length; i++) {
    const want = truth[i] ?? null;
    const got = r.assignments[i]?.aid ?? null;
    if (want !== null) { expected++; if (got === want) correct++; }
    else if (got !== null && r.assignments[i]?.applyProps) misapplied++;
  }
  return { recall: correct / expected, expected, misapplied, lost: r.stats.lost, result: r };
}

describe("the constrained Needleman-Wunsch alignment, without the move-recovery safety net", () => {
  // 300 blocks so the DP's accumulated scores land in the range where Float32 rounding is
  // coarser than the tolerance the old exit test used. At 20 blocks the bug does not reproduce.
  const N = 300;
  const base = synthetic(N);
  const aids = aidsFor(N);
  const anchors = buildAnchors(base, aids);

  test("an untouched document aligns to itself", () => {
    const r = recall(anchors, base, aids);
    expect(`${(r.recall * 100).toFixed(1)}% of ${r.expected}`).toBe(`100.0% of ${N}`);
    expect(r.lost).toBe(0);
  }, 30_000);

  test("a run of inserted paragraphs costs only those paragraphs", () => {
    // The regression. Before the traceback fix this recovered the blocks BEFORE the insertion
    // and lost every one after it, because the walk entered the gap state and never returned.
    for (const at of [5, 150, N - 12]) {
      const blocks: BlockSignalInput[] = [];
      const truth: Array<string | null> = [];
      for (let i = 0; i < N; i++) {
        if (i === at) for (let k = 0; k < 5; k++) { blocks.push(novel(k)); truth.push(null); }
        blocks.push(base[i]!);
        truth.push(aids[i]!);
      }
      const r = recall(anchors, blocks, truth);
      expect(`insert@${at}: ${(r.recall * 100).toFixed(1)}%, ${r.lost} lost`).toBe(`insert@${at}: 100.0%, 0 lost`);
    }
  }, 30_000);

  test("several insertion runs are absorbed independently", () => {
    const blocks: BlockSignalInput[] = [];
    const truth: Array<string | null> = [];
    const runs = new Set([17, 88, 141, 205, 266]);
    for (let i = 0; i < N; i++) {
      if (runs.has(i)) for (let k = 0; k < 6; k++) { blocks.push(novel(i * 10 + k)); truth.push(null); }
      blocks.push(base[i]!);
      truth.push(aids[i]!);
    }
    const r = recall(anchors, blocks, truth);
    expect(`${(r.recall * 100).toFixed(1)}%, ${r.lost} lost`).toBe(`100.0%, 0 lost`);
  }, 30_000);

  test("a deleted run loses exactly its own anchors and nothing downstream", () => {
    // The mirror image: the X state had the same trapped exit. A deletion must cost the
    // deleted anchors, not every anchor after them.
    const drop = new Set<number>();
    for (let i = 120; i < 128; i++) drop.add(i);
    const blocks: BlockSignalInput[] = [];
    const truth: Array<string | null> = [];
    for (let i = 0; i < N; i++) { if (drop.has(i)) continue; blocks.push(base[i]!); truth.push(aids[i]!); }
    const r = recall(anchors, blocks, truth);
    expect(`${(r.recall * 100).toFixed(1)}%, ${r.lost} lost`).toBe(`100.0%, ${drop.size} lost`);
  }, 30_000);

  test("insertions and deletions together", () => {
    const drop = new Set([40, 41, 42, 200, 201]);
    const blocks: BlockSignalInput[] = [];
    const truth: Array<string | null> = [];
    for (let i = 0; i < N; i++) {
      if (i === 70 || i === 240) for (let k = 0; k < 4; k++) { blocks.push(novel(i + k)); truth.push(null); }
      if (drop.has(i)) continue;
      blocks.push(base[i]!);
      truth.push(aids[i]!);
    }
    const r = recall(anchors, blocks, truth);
    expect(`${(r.recall * 100).toFixed(1)}%, ${r.lost} lost`).toBe(`100.0%, ${drop.size} lost`);
  }, 30_000);

  test("the traceback terminates on its own rather than on its guard", () => {
    // The runaway walked j to -4758 and only stopped because `guard` ran out; the ops it
    // pushed carried negative indices and assigned nothing. A traceback that reaches (0,0)
    // accounts for every anchor exactly once, so this is the invariant that catches it.
    const blocks = [...base.slice(0, 100), novel(1), novel(2), novel(3), ...base.slice(100)];
    const r = reanchor(anchors, blocks, { recoverMoves: false });
    const seen = new Set<string>();
    for (const a of r.assignments) if (a.aid) seen.add(a.aid);
    for (const l of r.lost) seen.add(l.aid);
    for (const x of r.retired) seen.add(x.aid);
    expect(`${seen.size} of ${N} anchors accounted for`).toBe(`${N} of ${N} anchors accounted for`);
    expect(r.assignments.length).toBe(blocks.length);
  }, 30_000);

  test("a wholly different document is refused rather than aligned", () => {
    // The floor in the other direction: a traceback that now follows the diagonal happily must
    // not have become one that matches anything positionally.
    //
    // This is a harsher input than any real document. Every foreign block carries the same
    // `styleId`, the same kind, the same null list state and a perfect ordinal, so 45% of the
    // signal weight votes yes by construction and only the text can say no. Measured: 24 of
    // 300 blocks clear the 0.55 threshold (median confidence 0.507), so the refusal rule
    // catches 92% of the worst case the signal set admits. The bar is set at 10% to record
    // that with a little headroom; `anchor.test.ts` runs the same property against real
    // foreign documents, where it is a much easier question.
    const foreign = Array.from({ length: N }, (_, i) => novel(i + 9000));
    const r = reanchor(anchors, foreign, { recoverMoves: false });
    const applied = r.assignments.filter((a) => a.aid !== null && a.applyProps).length;
    expect(`${applied} of ${N} foreign blocks took stored properties — ${applied <= N * 0.1 ? "few" : "MANY"}`)
      .toBe(`${applied} of ${N} foreign blocks took stored properties — few`);
  }, 30_000);
});
