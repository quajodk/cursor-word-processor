import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { unzipSync } from "fflate";
import { importDocx } from "../src/import";
import { exportDocx } from "../src/export";
import { readCommentThreading } from "../src/comments";

/**
 * Comments, replied to and resolved, against real Word documents.
 *
 * The corpus contains 675 comment threads across 11 documents and NOT ONE of them carries a
 * reply or a resolution — so there is nothing to read back that someone else wrote. The only
 * honest test is therefore a round trip through our own writer: take a real document, add a
 * reply and a resolution, write the .docx, re-open it with the ordinary importer, and require
 * that the thread comes back with the reply threaded under its parent and the resolution set.
 *
 * That is a stronger test than reading a fixture would be. It exercises the writer, the four
 * annotation parts, the document.xml range splice, and the reader, and it fails if any of
 * them disagrees about the join key.
 */

function repoRoot(): string {
  let d = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "bun.lock"))) return d;
    d = dirname(d);
  }
  return d;
}

const corpusDir = join(repoRoot(), "corpus", "docx");

/** Real documents that carry at least one comment thread with a paraId we can thread to. */
function commentedDocuments(limit: number): { name: string; bytes: Uint8Array }[] {
  if (!existsSync(corpusDir)) return [];
  const out: { name: string; bytes: Uint8Array }[] = [];
  for (const name of readdirSync(corpusDir).filter((f) => f.endsWith(".docx")).sort()) {
    const bytes = readFileSync(join(corpusDir, name));
    let entries: Record<string, Uint8Array>;
    try { entries = unzipSync(bytes); } catch { continue; }
    if (!entries["word/comments.xml"] || !entries["word/commentsExtended.xml"]) continue;
    const threading = readCommentThreading(entries);
    if (![...threading.values()].some((t) => t.paraId)) continue;
    out.push({ name, bytes });
    if (out.length >= limit) break;
  }
  return out;
}

describe("comment threading", () => {
  const docs = commentedDocuments(6);

  test("the corpus has documents with comments, or nothing below is tested", () => {
    expect(docs.length).toBeGreaterThan(2);
  });

  test("reads the paraId join key, which is not the w:id", () => {
    for (const { name, bytes } of docs) {
      const { sidecar } = importDocx(bytes);
      const threads = Object.values(sidecar.comments);
      expect(threads.length).toBeGreaterThan(0);
      // Every thread in a document that ships commentsExtended should have found its paraId.
      const withParaId = threads.filter((t) => t.paraId !== null);
      expect(`${name}: ${withParaId.length}/${threads.length}`).toBe(`${name}: ${threads.length}/${threads.length}`);
      // And the paraId must not merely be the w:id under another name.
      for (const t of withParaId) expect(t.paraId).not.toBe(t.commentIds[0]);
    }
  });

  test("a reply survives a round trip through a real Word file, threaded to its parent", () => {
    let checked = 0;
    for (const { name, bytes } of docs) {
      const before = importDocx(bytes);
      const target = Object.values(before.sidecar.comments).find((t) => t.paraId && t.aid);
      if (!target) continue;
      const parentId = target.commentIds[0]!;

      const out = exportDocx(before.doc, before.sidecar, before.origin, {
        commentEdits: {
          replies: [{
            parentId,
            text: "Agreed — revised in this pass.",
            author: "Reviewer",
            initials: "R",
            date: "2026-09-06T10:00:00Z",
          }],
          resolved: new Map([[parentId, true]]),
        },
      });

      const after = importDocx(out.bytes);
      const threads = Object.values(after.sidecar.comments);

      const reply = threads.find((t) => t.text === "Agreed — revised in this pass.");
      expect(`${name}: reply ${reply ? "present" : "MISSING"}`).toBe(`${name}: reply present`);
      expect(reply!.author).toBe("Reviewer");
      expect(reply!.parentAnchorId).toBe(target.anchorId);

      // The parent thread is now resolved, and the reply is not.
      const parentAfter = threads.find((t) => t.anchorId === target.anchorId);
      expect(`${name}: parent resolved=${parentAfter?.resolved}`).toBe(`${name}: parent resolved=true`);
      checked++;
      expect(reply!.resolved).toBe(false);

      // The reply is anchored in the body, not floating: the importer only builds a thread
      // with an `aid` when it found a commentRangeStart for it in document.xml.
      expect(`${name}: reply anchored to ${reply!.aid ? "a block" : "NOTHING"}`)
        .toBe(`${name}: reply anchored to a block`);
      // Compared against the RE-IMPORTED parent, not the original one: aids are minted per
      // import, so `target.aid` belongs to a different id space than anything in `after`.
      expect(reply!.aid).toBe(parentAfter!.aid);
    }
    // A loop that silently `continue`d over every document would pass having asserted nothing.
    expect(checked).toBeGreaterThan(2);
  }, 120_000);

  test("only the annotation parts and the body are rewritten", () => {
    const { bytes } = docs[0]!;
    const before = importDocx(bytes);
    const target = Object.values(before.sidecar.comments).find((t) => t.paraId && t.aid)!;
    const out = exportDocx(before.doc, before.sidecar, before.origin, {
      commentEdits: {
        replies: [{ parentId: target.commentIds[0]!, text: "Noted.", author: "R", initials: "R", date: "2026-09-06T10:00:00Z" }],
        resolved: new Map([[target.commentIds[0]!, true]]),
      },
    });
    // Everything else in the package — styles, numbering, theme, media, headers — is copied.
    const rewritten = new Set(out.stats.partsRewritten);
    const allowed = new Set([
      before.sidecar.origin.documentPart,
      "word/comments.xml", "word/commentsExtended.xml", "word/commentsIds.xml",
    ]);
    expect([...rewritten].filter((p) => !allowed.has(p))).toEqual([]);
  }, 60_000);

  test("resolving alone does not touch comments.xml or the body", () => {
    const { bytes } = docs[0]!;
    const before = importDocx(bytes);
    const target = Object.values(before.sidecar.comments).find((t) => t.paraId)!;
    const out = exportDocx(before.doc, before.sidecar, before.origin, {
      commentEdits: { replies: [], resolved: new Map([[target.commentIds[0]!, true]]) },
    });
    expect(out.stats.partsRewritten).toEqual(["word/commentsExtended.xml"]);

    const after = importDocx(out.bytes);
    expect(after.sidecar.comments[target.anchorId]!.resolved).toBe(true);
  }, 60_000);

  test("un-resolving is the same one-attribute edit in reverse", () => {
    const { bytes } = docs[0]!;
    const before = importDocx(bytes);
    const target = Object.values(before.sidecar.comments).find((t) => t.paraId)!;
    const id = target.commentIds[0]!;

    const resolved = exportDocx(before.doc, before.sidecar, before.origin, {
      commentEdits: { replies: [], resolved: new Map([[id, true]]) },
    });
    const reopened = importDocx(resolved.bytes);
    expect(reopened.sidecar.comments[target.anchorId]!.resolved).toBe(true);

    const undone = exportDocx(reopened.doc, reopened.sidecar, reopened.origin, {
      commentEdits: { replies: [], resolved: new Map([[id, false]]) },
    });
    expect(importDocx(undone.bytes).sidecar.comments[target.anchorId]!.resolved).toBe(false);
  }, 60_000);

  test("a reply to a comment that is not in the document is refused, not half-written", () => {
    const { bytes } = docs[0]!;
    const before = importDocx(bytes);
    const out = exportDocx(before.doc, before.sidecar, before.origin, {
      commentEdits: {
        replies: [{ parentId: "999999", text: "orphan", author: "R", initials: "R", date: "2026-09-06T10:00:00Z" }],
        resolved: new Map(),
      },
    });
    // Nothing written, and the ledger says why rather than the file quietly not containing it.
    expect(out.stats.partsRewritten).toEqual([]);
    expect(out.ledger.some((e) => e.code === "comment-orphan" && /not a comment in this document/.test(e.detail ?? ""))).toBe(true);
    expect(importDocx(out.bytes).sidecar.comments["c:999999"]).toBeUndefined();
  }, 60_000);

  test("no comment edits means the file is untouched, byte for byte", () => {
    const { bytes } = docs[0]!;
    const before = importDocx(bytes);
    const out = exportDocx(before.doc, before.sidecar, before.origin, {});
    expect(out.stats.partsRewritten).toEqual([]);
    expect(out.stats.packageIdentical).toBe(true);
  }, 60_000);
});
