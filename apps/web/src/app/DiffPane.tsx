import { useEffect, useMemo, useState } from "react";
import type { HostApi } from "@scriv/host-api";
import { blameSentences, diffDocuments, type DocumentDiff, type SentenceBlame, type SentenceChange } from "@scriv/workspace";
import { codecFor } from "../doc/codec";
import { Panel } from "./Panel";

/**
 * The change view: what this document looks like against HEAD, in sentences.
 *
 * Everything a line diff gets wrong about prose is what this pane exists to show. A reflowed
 * paragraph is not a change. A moved sentence says "moved", once, rather than appearing as a
 * large deletion beside a large insertion. A reworded clause shows which words moved.
 *
 * It explains every dead end it can reach, because a change view showing nothing is
 * indistinguishable from a document with no changes, and the second is a much more comforting
 * thing to believe. There are four such ends: no repository, an untracked file, a tracked file
 * that genuinely matches HEAD, and a document this pane cannot read at all.
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
    // The fourth dead end, and the one nobody wrote a string for: the git feature meeting the
    // docx feature. `currentText()` returns null for a binary codec, so the diff and the blame
    // both stay null and every git branch below reports success — the file IS tracked, it DOES
    // differ from HEAD — leaving a pane that renders its chrome and nothing else. A writer
    // reads that as "no changes", which is the one conclusion it must not lead to.
    if (isBinary(path)) {
      setStatus(
        `This document opens through the ${extensionOf(path)} codec, which reads it as bytes rather ` +
        `than text. The sentence diff and the blame both need text, so neither can be computed ` +
        `here — which is this pane's limit, not a statement that the file has not changed.`,
      );
      setHead(null);
      setBlame(null);
      return;
    }
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

  if (!path) return null;

  const controls = (
    <>
      <div className="scriv-diff-tabs" role="tablist">
        <button role="tab" aria-selected={mode === "changes"} className={mode === "changes" ? "is-active" : ""}
          onClick={() => setMode("changes")}>Diff</button>
        <button role="tab" aria-selected={mode === "blame"} className={mode === "blame" ? "is-active" : ""}
          onClick={() => setMode("blame")}>Blame</button>
      </div>
      {diff && mode === "changes" && (
        <span className="scriv-diff-stats">
          {summarise(diff)}
        </span>
      )}
    </>
  );

  return (
    <Panel name="scriv-diff" title="Changes" subtitle="Against HEAD, in sentences" controls={controls} onClose={onClose}>
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
    </Panel>
  );
}

/**
 * The file's own extension, so the explanation above names the format the writer chose rather
 * than the codec's internal label. `codecFor` decides what actually opens it; this only has to
 * say which file we are talking about.
 */
function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "plain text" : path.slice(dot).toLowerCase();
}

function isBinary(path: string): boolean {
  return codecFor(path).binary === true;
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
