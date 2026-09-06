import type { CommentThread as DocxThread, NewReply } from "@scriv/ooxml";
import type { DocMeta } from "@scriv/md";
import { TextSelection, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { DocxMeta } from "../doc/docx";

/**
 * Comment threads, from whichever format the open document came in.
 *
 * Two sources, one shape. A `.docx` carries real threads — author, date, replies, resolved —
 * in four annotation parts. A `.md` carries CriticMarkup `{>>...<<}`, which is a note with a
 * body and nothing else: no author, no thread, no resolved state. Rather than invent a
 * container format for Markdown comments, this reports what each source can actually hold and
 * the panel says so. A "resolve" button that silently does nothing on a .md would be worse
 * than a disabled one that explains why.
 *
 * THE ANCHOR IS IN THE DOCUMENT; THE THREAD IS NOT. The `comment` mark carries only an
 * anchorId, so a thread survives its sentence being reworded, and replying to a comment never
 * becomes a ReplaceStep — it is not undoable, does not make the document dirty as prose, and
 * cannot leak into the Markdown.
 */

export interface CommentEntry {
  id: string;
  author: string;
  date: string | null;
  text: string;
  /** True for entries this session added and has not yet written to disk. */
  pending: boolean;
}

export interface Thread {
  anchorId: string;
  /** `w:id` of the root comment; the handle the exporter needs. */
  rootId: string;
  entries: CommentEntry[];
  resolved: boolean;
  /** Set when the resolved flag differs from what is on disk. */
  resolvedPending: boolean;
  /** The text the thread is attached to, for the panel. Empty when the anchor is gone. */
  quote: string;
  /** Document position of the anchor, or null when the marked text has been deleted. */
  pos: number | null;
  /** What this document's format can carry. */
  canReply: boolean;
  canResolve: boolean;
}

export type CommentSource = "docx" | "markdown" | "none";

export interface CommentsSnapshot {
  source: CommentSource;
  threads: Thread[];
  /** Why reply/resolve are unavailable, when they are. Shown rather than left to be guessed. */
  limitation: string | null;
}

/** Word's paraId is 8 hex digits and must not be zero. Minted once per reply, not per save. */
function paraId(): string {
  let v = 0;
  while (v === 0) v = Math.floor(Math.random() * 0xffffffff) >>> 0;
  return v.toString(16).toUpperCase().padStart(8, "0");
}

/**
 * Pending edits live in the codec's `meta`, alongside the origin they will be applied to.
 *
 * Deliberately NOT cleared after a save. Every save re-applies the whole list to the PRISTINE
 * origin, because the fidelity sidecar holds byte offsets into that origin — swapping in the
 * just-written package would invalidate every one of them. Re-applying is idempotent: the
 * reply ids are derived from the origin's own maximum, and each reply's paraId is minted once
 * here rather than at export time, so saving twice produces the same bytes rather than two
 * copies of the same reply.
 */
export interface PendingComments {
  replies: NewReply[];
  resolved: Map<string, boolean>;
}

export function pendingOf(meta: unknown): PendingComments | null {
  if (!isDocxMeta(meta)) return null;
  const m = meta as DocxMeta & { commentEdits?: PendingComments };
  if (!m.commentEdits) m.commentEdits = { replies: [], resolved: new Map() };
  return m.commentEdits;
}

function isDocxMeta(value: unknown): value is DocxMeta {
  return typeof value === "object" && value !== null && "sidecar" in value && "origin" in value;
}

function isMarkdownMeta(value: unknown): value is DocMeta {
  return typeof value === "object" && value !== null && "comments" in value && Array.isArray((value as DocMeta).comments);
}

/** Where each comment anchor sits in the live document, and what text it covers. */
function anchorPositions(state: EditorState): Map<string, { pos: number; quote: string }> {
  const out = new Map<string, { pos: number; quote: string }>();
  state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== "comment") continue;
      const id = mark.attrs.anchorId as string;
      const prev = out.get(id);
      // A thread can cover several adjacent text nodes; keep the first position and
      // accumulate the quoted text so the panel shows the whole marked range.
      if (prev) prev.quote += node.text ?? "";
      else out.set(id, { pos, quote: node.text ?? "" });
    }
    return true;
  });
  return out;
}

const MAX_QUOTE = 140;

export function readThreads(state: EditorState | null, meta: unknown): CommentsSnapshot {
  const anchors = state ? anchorPositions(state) : new Map();

  if (isDocxMeta(meta)) {
    const pending = pendingOf(meta)!;
    const stored = Object.values((meta as DocxMeta).sidecar.comments) as DocxThread[];

    // Roots first, then each root's replies in the order they were written.
    const roots = stored.filter((t) => !t.parentAnchorId);
    const threads: Thread[] = [];

    for (const root of roots) {
      const rootId = root.commentIds[0] ?? "";
      const replies = stored.filter((t) => t.parentAnchorId === root.anchorId);
      const entries: CommentEntry[] = [root, ...replies].map((t) => ({
        id: t.commentIds[0] ?? t.anchorId,
        author: t.author || "Unknown",
        date: t.date,
        text: t.text,
        pending: false,
      }));
      for (const r of pending.replies) {
        if (r.parentId !== rootId) continue;
        entries.push({ id: `pending:${entries.length}`, author: r.author, date: r.date, text: r.text, pending: true });
      }

      const override = pending.resolved.get(rootId);
      const anchor = anchors.get(root.anchorId);
      threads.push({
        anchorId: root.anchorId,
        rootId,
        entries,
        resolved: override ?? root.resolved,
        resolvedPending: override !== undefined && override !== root.resolved,
        quote: clip(anchor?.quote ?? ""),
        pos: anchor?.pos ?? null,
        // A thread with no paraId has nowhere for a parent pointer or a done flag to live,
        // and the exporter refuses it. Saying so here is better than a button that fails.
        canReply: root.paraId !== null,
        canResolve: root.paraId !== null,
      });
    }

    const noParaId = roots.filter((r) => r.paraId === null).length;
    return {
      source: "docx",
      threads,
      limitation: noParaId > 0
        ? `${noParaId} of ${roots.length} threads were written without a w14:paraId, so Word has nowhere to record a reply or a resolution for them.`
        : null,
    };
  }

  if (isMarkdownMeta(meta)) {
    const threads: Thread[] = meta.comments.map((c) => {
      const anchor = anchors.get(c.anchorId);
      return {
        anchorId: c.anchorId,
        rootId: c.anchorId,
        entries: [{ id: c.anchorId, author: "", date: null, text: c.body, pending: false }],
        resolved: false,
        resolvedPending: false,
        quote: clip(anchor?.quote ?? ""),
        pos: anchor?.pos ?? null,
        canReply: false,
        canResolve: false,
      };
    });
    return {
      source: "markdown",
      threads,
      limitation: threads.length > 0
        ? "CriticMarkup carries a note and its text — no author, no thread, no resolved state. Replying and resolving need a format that can hold them; open the document as .docx for that."
        : null,
    };
  }

  return { source: "none", threads: [], limitation: null };
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_QUOTE ? `${t.slice(0, MAX_QUOTE - 1)}…` : t;
}

/* ------------------------------------------------------------------ mutation */

export interface ReplyAuthor {
  name: string;
  initials: string;
}

export function addReply(meta: unknown, rootId: string, text: string, author: ReplyAuthor): boolean {
  const pending = pendingOf(meta);
  if (!pending || text.trim().length === 0) return false;
  pending.replies.push({
    parentId: rootId,
    text: text.trim(),
    author: author.name,
    initials: author.initials,
    // Seconds resolution with a trailing Z, which is what Word writes and reads.
    date: `${new Date().toISOString().slice(0, 19)}Z`,
    paraId: paraId(),
  });
  return true;
}

export function setResolved(meta: unknown, rootId: string, resolved: boolean): boolean {
  const pending = pendingOf(meta);
  if (!pending) return false;
  pending.resolved.set(rootId, resolved);
  return true;
}

/** Scroll a thread's anchor into view and put the caret in it. Keyboard-first. */
export function revealThread(view: EditorView, thread: Thread): boolean {
  if (thread.pos === null) return false;
  const pos = Math.min(thread.pos, view.state.doc.content.size);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)).scrollIntoView());
  view.focus();
  return true;
}
