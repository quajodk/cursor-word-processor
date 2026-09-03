import { useCallback, useEffect, useMemo, useState } from "react";
import type { HostApi } from "@scriv/host-api";
import { blameSentences, diffDocuments, type DocumentDiff, type SentenceBlame, type SentenceChange } from "@scriv/workspace";

/**
 * The change view: what this document looks like against HEAD, in sentences.
 *
 * Everything a line diff gets wrong about prose is what this pane exists to show. A reflowed
 * paragraph is not a change. A moved sentence says "moved", once, rather than appearing as a
 * large deletion beside a large insertion. A reworded clause shows which words moved.
 */

type Mode = "changes" | "blame";

export interface DiffPaneProps {
  host: HostApi;
  root: string;
  path: string | null;
  /** Current editor text, so the diff follows unsaved edits too. */
  currentText: () => string | null;
  onClose: () => void;
}

const KIND_LABEL: Record<SentenceChange["kind"], string> = {
  unchanged: "unchanged",
  reworded: "reworded",
  moved: "moved",
  "moved-and-reworded": "moved + reworded",
  split: "split",
  merged: "merged",
  inserted: "added",
  deleted: "removed",
};

export function DiffPane({ host, root, path, currentText, onClose }: DiffPaneProps) {
  const [mode, setMode] = useState<Mode>("changes");
  const [head, setHead] = useState<string | null>(null);
  const [blame, setBlame] = useState<SentenceBlame[] | null>(null);
  const [status, setStatus] = useState<string>("");

  const text = currentText();

  useEffect(() => {
    let cancelled = false;
    if (!path) return;
    setStatus("reading…");
    void (async () => {
      try {
        if (!(await host.git.isRepo(root))) {
          if (!cancelled) setStatus("This folder is not a git repository.");
          return;
        }
        const [committed, lines] = await Promise.all([
          host.git.show(root, path),
          host.git.blame(root, path).catch(() => []),
        ]);
        if (cancelled) return;
        setHead(committed);
        setBlame(text ? blameSentences(text, lines) : null);
        setStatus(committed === null ? "This file is not yet tracked by git." : "");
      } catch (e) {
        if (!cancelled) setStatus((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [host, root, path, text]);

  const diff: DocumentDiff | null = useMemo(
    () => (head !== null && text !== null ? diffDocuments(head, text) : null),
    [head, text],
  );

  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
  }, [onClose]);

  if (!path) return null;

  return (
    <section className="scriv-diff" aria-label="Changes" onKeyDown={onKey}>
      <header className="scriv-diff-head">
        <div className="scriv-diff-tabs" role="tablist">
          <button role="tab" aria-selected={mode === "changes"} className={mode === "changes" ? "is-active" : ""}
            onClick={() => setMode("changes")}>Changes</button>
          <button role="tab" aria-selected={mode === "blame"} className={mode === "blame" ? "is-active" : ""}
            onClick={() => setMode("blame")}>Blame</button>
        </div>
        {diff && mode === "changes" && (
          <span className="scriv-diff-stats">
            {summarise(diff)}
          </span>
        )}
        <button className="scriv-diff-close" onClick={onClose} aria-label="Close changes">esc</button>
      </header>

      {status && <p className="scriv-diff-status">{status}</p>}

      {mode === "changes" && diff && (
        diff.changes.length === 0
          ? <p className="scriv-diff-status">No changes against HEAD. Reflowing or rewrapping is not a change.</p>
          : <ol className="scriv-diff-list">
              {diff.changes.map((c, i) => <ChangeRow key={i} change={c} />)}
            </ol>
      )}

      {mode === "blame" && blame && (
        <ol className="scriv-diff-list">
          {blame.map((b) => (
            <li key={b.sentence} className="scriv-blame-row">
              <span className={`scriv-blame-who${b.mixed ? " is-mixed" : ""}`}>
                {b.mixed ? `${b.contributors.length} authors` : (b.author ?? "uncommitted")}
              </span>
              <span className="scriv-blame-text">{b.text}</span>
              {b.mixed && (
                <span className="scriv-blame-detail">{b.contributors.map((c) => c.author).join(", ")}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function summarise(diff: DocumentDiff): string {
  const s = diff.stats;
  const parts: string[] = [];
  if (s.reworded) parts.push(`${s.reworded} reworded`);
  if (s.moved) parts.push(`${s.moved} moved`);
  if (s.inserted) parts.push(`${s.inserted} added`);
  if (s.deleted) parts.push(`${s.deleted} removed`);
  if (s.split) parts.push(`${s.split} split`);
  if (s.merged) parts.push(`${s.merged} merged`);
  return parts.length > 0 ? parts.join(" · ") : "no changes";
}

function ChangeRow({ change }: { change: SentenceChange }) {
  return (
    <li className={`scriv-change scriv-change-${change.kind}`}>
      <div className="scriv-change-head">
        <span className="scriv-change-kind">{KIND_LABEL[change.kind]}</span>
        {change.section.length > 0 && <span className="scriv-change-section">{change.section.join(" › ")}</span>}
      </div>

      {/* A word diff when one exists: showing which words moved is the entire point, and a
          whole-sentence before/after would be the wall of colour this pane exists to avoid. */}
      {change.words ? (
        <p className="scriv-change-body">
          {change.words.runs.map((r, i) =>
            r.kind === "equal" ? <span key={i}>{r.text}</span>
            : r.kind === "delete" ? <del key={i}>{r.text}</del>
            : <ins key={i}>{r.text}</ins>,
          )}
        </p>
      ) : (
        <p className="scriv-change-body">
          {change.kind === "deleted" ? <del>{change.oldText}</del>
            : change.kind === "inserted" ? <ins>{change.newText}</ins>
            : <span>{change.newText || change.oldText}</span>}
        </p>
      )}
    </li>
  );
}
