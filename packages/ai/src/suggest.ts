import type { Node as PMNode } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import { OffsetMap } from "@scriv/doc-model";
import { diffProse, type Hunk } from "./diff";

/**
 * Projecting a rewrite into the live document as a reviewable suggestion.
 *
 * This deliberately uses the schema's EXISTING `insertion` and `deletion` marks rather than a
 * parallel mechanism of its own. Three things fall out of that choice, and none of them would
 * if AI suggestions had their own representation:
 *
 *   - Accepting an AI rewrite and accepting a colleague's tracked change are one code path.
 *   - An AI suggestion exports to Word as a real `<w:ins>` / `<w:del>` revision.
 *   - Undo, position mapping and collaborative editing already understand it.
 *
 * The document is never replaced. Moment's write-up on collaborative AI editing is right that
 * replacement is the failure mode: it discards the writer's own concurrent edits and gives
 * them nothing to review.
 */

export interface SuggestOptions {
  /** Shown on the change. Defaults to the provider name. */
  author?: string;
  /** Groups hunks that belong to one request, so accept-all can find them. */
  revId: string;
}

/**
 * Turn a rewrite into a suggestion over [from, to).
 *
 * Hunks are applied back to front so that earlier positions stay valid: mapping forward
 * through each insertion as it lands is possible but every off-by-one in it corrupts the
 * document, and reverse order removes the class of bug entirely.
 */
export function suggestRewrite(
  state: EditorState,
  from: number,
  to: number,
  revised: string,
  opts: SuggestOptions,
): Transaction | null {
  const original = state.doc.textBetween(from, to, "\n");
  const hunks = diffProse(original, revised);
  if (hunks.length === 0) return null;
  return applyHunks(state, from, to, hunks, opts);
}

export function applyHunks(
  state: EditorState,
  from: number,
  to: number,
  hunks: Hunk[],
  opts: SuggestOptions,
): Transaction | null {
  const insertion = state.schema.marks.insertion;
  const deletion = state.schema.marks.deletion;
  if (!insertion || !deletion) return null;

  const map = new OffsetMap(state.doc, from, to);
  const author = opts.author ?? "assistant";
  const date = new Date().toISOString();
  const insMark = insertion.create({ revId: opts.revId, author, date, origin: "ai" });
  const delMark = deletion.create({ revId: opts.revId, author, date, origin: "ai" });

  const tr = state.tr;
  for (let i = hunks.length - 1; i >= 0; i--) {
    const h = hunks[i]!;
    const start = map.pos(h.from);
    const end = map.pos(h.to);

    // The addition goes AFTER the text it replaces, so the document reads
    // "old new" while under review and the deletion is not orphaned from its replacement.
    if (h.added.length > 0) {
      tr.insert(end, state.schema.text(h.added, [insMark]));
    }
    if (end > start) {
      tr.addMark(start, end, delMark);
    }
  }
  return tr.docChanged || tr.steps.length > 0 ? tr : null;
}

/** Ranges carrying one of the tracked-change marks, innermost first. */
function markedRanges(doc: PMNode, markName: string, revId?: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const mark = node.marks.find((m) => m.type.name === markName && (!revId || m.attrs.revId === revId));
    if (!mark) return true;
    const last = out[out.length - 1];
    if (last && last.to === pos) last.to = pos + node.nodeSize;
    else out.push({ from: pos, to: pos + node.nodeSize });
    return true;
  });
  return out;
}

/**
 * Accept: the deletions go, the insertions become ordinary text.
 * Reject: the insertions go, the deletions become ordinary text.
 *
 * Both delete back to front for the same reason `applyHunks` does.
 */
function resolve(state: EditorState, keep: "insertion" | "deletion", revId?: string): Transaction | null {
  const drop = keep === "insertion" ? "deletion" : "insertion";
  const dropRanges = markedRanges(state.doc, drop, revId);
  const keepRanges = markedRanges(state.doc, keep, revId);
  if (dropRanges.length === 0 && keepRanges.length === 0) return null;

  const tr = state.tr;
  for (let i = dropRanges.length - 1; i >= 0; i--) {
    const r = dropRanges[i]!;
    tr.delete(r.from, r.to);
  }
  // Strip the surviving mark, using the transaction's own mapping since deletions moved
  // everything after them.
  for (const r of keepRanges) {
    const markType = state.schema.marks[keep];
    if (!markType) continue;
    const mappedFrom = tr.mapping.map(r.from, 1);
    const mappedTo = tr.mapping.map(r.to, -1);
    if (mappedTo > mappedFrom) tr.removeMark(mappedFrom, mappedTo, markType);
  }
  return tr.steps.length > 0 ? tr : null;
}

export const acceptSuggestion = (state: EditorState, revId?: string): Transaction | null =>
  resolve(state, "insertion", revId);

export const rejectSuggestion = (state: EditorState, revId?: string): Transaction | null =>
  resolve(state, "deletion", revId);

/** True when the document currently holds an unresolved suggestion. */
export function hasSuggestion(doc: PMNode, revId?: string): boolean {
  return markedRanges(doc, "insertion", revId).length > 0 || markedRanges(doc, "deletion", revId).length > 0;
}
