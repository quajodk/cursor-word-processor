import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { EditorController } from "../editor/controller";
import { addReply, readThreads, revealThread, setResolved, type Thread } from "../editor/comments";
import { handleListKey } from "./list-nav";

/**
 * The comments panel.
 *
 * Threads live beside the document rather than in margin bubbles. Bubbles look like Word and
 * fail the moment two comments land on the same line or the window narrows, and the point of
 * this panel is to be *read* — a reviewer's pass is a list of things to answer, not a set of
 * objects floating over the prose.
 *
 * KEYBOARD FIRST, like everything else: it moves in the app's list dialect (`list-nav.ts`),
 * Enter opens the reply box, ⌘Enter posts, R resolves, Escape returns to the document. Nothing
 * here needs the mouse.
 *
 * It used to move on `j`/`k` as well, which this file argued for as a local decision. The
 * argument was right about the decision being local and wrong about that being enough: the
 * palette moves on `Ctrl-n`/`Ctrl-p` and the tree on arrows alone, so a writer who learned
 * `j`/`k` here typed the letter `j` into the palette's query box. `j`/`k` cannot be the app's
 * dialect because two of the five lists are navigated while the caret is in a text field, so
 * it is gone from the one list that had it rather than half-adopted by the rest.
 *
 * These keys are LOCAL to the panel and are deliberately not commands: the palette is a view
 * of the command registry, and putting "next comment thread" in it would advertise a global
 * binding for something that only means anything while this list has focus. ⌘⇧M reaches the
 * panel from anywhere, and that is the command. (This comment used to claim "the same actions
 * are in the palette with their bindings", which was never true.)
 */

export interface CommentsPaneProps {
  controller: EditorController;
  /** Bumped by the shell whenever the document or its selection changes. */
  revision: number;
  author: { name: string; initials: string };
}

export function CommentsPane({ controller, revision, author }: CommentsPaneProps) {
  const [active, setActive] = useState(0);
  const [replying, setReplying] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const [tick, setTick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  const snapshot = useMemo(
    () => readThreads(controller.editorView?.state ?? null, controller.meta),
    // `revision` and `tick` are the inputs that matter: the controller's meta is mutated in
    // place rather than replaced, so identity comparison would never see a new reply.
    [controller, revision, tick],
  );

  const visible = snapshot.threads.filter((t) => showResolved || !t.resolved);
  const resolvedCount = snapshot.threads.filter((t) => t.resolved).length;

  useEffect(() => {
    if (active >= visible.length) setActive(Math.max(0, visible.length - 1));
  }, [visible.length, active]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const reveal = (thread: Thread) => {
    const view = controller.editorView;
    if (view) revealThread(view, thread);
  };

  const post = (thread: Thread) => {
    if (addReply(controller.meta, thread.rootId, draft, author)) {
      setDraft("");
      setReplying(null);
      setTick((n) => n + 1);
      controller.markDirty();
    }
  };

  const toggleResolved = (thread: Thread) => {
    if (!thread.canResolve) return;
    if (setResolved(controller.meta, thread.rootId, !thread.resolved)) {
      setTick((n) => n + 1);
      controller.markDirty();
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const thread = visible[active];

    // Resolve is this list's own verb, so it is handled here rather than in the dialect.
    if (event.key === "r" || event.key === "R") {
      if (thread) toggleResolved(thread);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    handleListKey(event, {
      index: active,
      count: visible.length,
      onMove: setActive,
      onActivate: () => {
        if (!thread) return;
        if (thread.canReply) { setReplying(thread.anchorId); queueMicrotask(() => replyRef.current?.focus()); }
        else reveal(thread);
      },
      onDismiss: () => controller.focus(),
    });
  };

  if (snapshot.source === "none") {
    return <div className="pane-empty">Open a document to see its comments.</div>;
  }

  return (
    <div className="comments" role="region" aria-label="Comments">
      <div className="comments-head">
        <span>
          {snapshot.threads.length === 0
            ? "No comments"
            : `${visible.length} open${resolvedCount > 0 ? ` · ${resolvedCount} resolved` : ""}`}
        </span>
        {resolvedCount > 0 && (
          <button type="button" className="comments-toggle" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? "Hide resolved" : "Show resolved"}
          </button>
        )}
      </div>

      {snapshot.limitation && <p className="comments-note">{snapshot.limitation}</p>}

      <div className="comments-list" ref={listRef} tabIndex={0} onKeyDown={onKeyDown}>
        {visible.length === 0 && snapshot.threads.length > 0 && (
          <div className="pane-empty">Every thread is resolved.</div>
        )}
        {visible.map((thread, index) => (
          <article
            key={thread.anchorId}
            className="comment-thread"
            data-active={index === active}
            data-resolved={thread.resolved}
            data-orphan={thread.pos === null}
            onMouseDown={() => { setActive(index); reveal(thread); }}
          >
            {thread.quote ? (
              <blockquote className="comment-quote">{thread.quote}</blockquote>
            ) : (
              // Not hidden: a thread whose text was deleted still has to be answerable, and
              // pretending it is anchored would be worse than saying it is not.
              <p className="comment-quote is-orphan">The text this thread was on has been deleted.</p>
            )}

            {thread.entries.map((entry) => (
              <div key={entry.id} className="comment-entry" data-pending={entry.pending}>
                <div className="comment-meta">
                  <span className="comment-author">{entry.author || "Note"}</span>
                  {entry.date && <time>{formatDate(entry.date)}</time>}
                  {entry.pending && <span className="comment-pending">unsaved</span>}
                </div>
                <p className="comment-body">{entry.text}</p>
              </div>
            ))}

            {replying === thread.anchorId ? (
              <div className="comment-reply">
                <textarea
                  ref={replyRef}
                  className="comment-input"
                  value={draft}
                  placeholder="Reply…  ⌘⏎ to post"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(thread); }
                    else if (e.key === "Escape") { e.preventDefault(); setReplying(null); setDraft(""); }
                    e.stopPropagation();
                  }}
                />
                <div className="comment-actions">
                  <button type="button" onClick={() => post(thread)} disabled={draft.trim().length === 0}>Post</button>
                  <button type="button" onClick={() => { setReplying(null); setDraft(""); }}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="comment-actions">
                <button
                  type="button"
                  disabled={!thread.canReply}
                  title={thread.canReply ? "Reply to this thread" : "This document's format cannot carry a reply"}
                  onClick={() => { setActive(index); setReplying(thread.anchorId); queueMicrotask(() => replyRef.current?.focus()); }}
                >
                  Reply
                </button>
                <button
                  type="button"
                  disabled={!thread.canResolve}
                  title={thread.canResolve ? "Mark this thread resolved" : "This document's format cannot carry a resolved state"}
                  onClick={() => toggleResolved(thread)}
                >
                  {thread.resolved ? "Reopen" : "Resolve"}
                  {thread.resolvedPending ? " •" : ""}
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

/** Word writes ISO-8601; show the date a reviewer would recognise, not the timestamp. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
