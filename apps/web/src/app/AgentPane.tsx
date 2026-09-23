import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { HostApi } from "@scriv/host-api";
import { siteKey, type ChangeSet, type Confidence, type Site } from "@scriv/ai";
import { applyWorkspaceRename, planWorkspaceRename, type ApplyReport } from "../editor/agent";
import { handleListKey } from "./list-nav";
import { Panel } from "./Panel";
import { revealSource } from "./reveal";

/**
 * Agent mode: an instruction that edits the workspace, reviewed before it lands.
 *
 * The shape of this panel is the argument. A chat box that returns a paragraph describing
 * what it would have done is not an agent, it is a colleague who does not have commit access.
 * What a writer needs is the *diff*, grouped by file, every change showing the line it sits on,
 * with accept and reject per change — and nothing written until they say so.
 *
 * IT IS USEFUL WITH THE NETWORK UNPLUGGED. The rename is decided in `@scriv/ai` with no model
 * involved: word boundaries, plurals, possessives, case, and a refusal to touch code are all
 * decidable, and deciding them exactly is more useful than asking a model to guess at them.
 * That is house rule 3 taken seriously rather than as a config flag.
 *
 * ONE GESTURE FOR "THE TOOL PROPOSED AN EDIT; DECIDE WHETHER IT LANDS". The panel's own header
 * comment claimed accept and reject per site while the panel actually rendered a checkbox
 * multi-select: a *selection set*, in which nothing is ever rejected, there is only unticked.
 * The document model already treats an AI rewrite and a colleague's tracked change as one code
 * path (`doc-model/src/schema.ts`), and the ⌘K bar reviews one with Accept and Reject. A
 * writer who has learned that gesture should not have to learn a second one here, so this is
 * the same two words with the same meaning, over the same underlying set.
 */

export interface AgentPaneProps {
  host: HostApi;
  root: string;
  onClose: () => void;
  /** So the shell can reload a document the agent rewrote under it. */
  onApplied: (paths: string[]) => void;
}

type Phase = "idle" | "planning" | "review" | "applying" | "done";

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  exact: "exact",
  variant: "variant",
  uncertain: "check",
};

export function AgentPane({ host, root, onClose, onApplied }: AgentPaneProps) {
  const [term, setTerm] = useState("");
  const [replacement, setReplacement] = useState("");
  const [frontmatter, setFrontmatter] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [changes, setChanges] = useState<ChangeSet | null>(null);
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  const [report, setReport] = useState<ApplyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanned, setScanned] = useState(0);
  const [active, setActive] = useState(0);
  const termRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /** Every change, in the order they are rendered, so the list dialect has one thing to move through. */
  const sites = useMemo(() => (changes ? changes.files.flatMap((f) => f.sites) : []), [changes]);

  /** Where each file's changes begin in that flat order, so a row knows its own index. */
  const fileStart = useMemo(() => {
    const map = new Map<string, number>();
    let at = 0;
    for (const file of changes?.files ?? []) {
      map.set(file.path, at);
      at += file.sites.length;
    }
    return map;
  }, [changes]);

  const summary = useMemo(() => {
    if (!changes) return null;
    const byConfidence: Record<Confidence, number> = { exact: 0, variant: 0, uncertain: 0 };
    let sites = 0;
    for (const f of changes.files) for (const s of f.sites) { byConfidence[s.confidence]++; sites++; }
    return { files: changes.files.length, sites, byConfidence };
  }, [changes]);

  const plan = async () => {
    if (term.trim().length === 0 || replacement.trim().length === 0) return;
    setPhase("planning");
    setError(null);
    setReport(null);
    try {
      const result = await planWorkspaceRename(host, root, term, replacement, { frontmatter });
      setChanges(result.changes);
      setScanned(result.changes.scanned);
      // Exact and variant sites start accepted; anything flagged `uncertain` starts REJECTED.
      // A default of "all on" turns review into a formality, which is the failure mode of
      // every bulk-edit tool: the writer clicks apply and finds out later.
      setAccepted(new Set(
        result.changes.files.flatMap((f) =>
          f.sites.filter((s) => s.confidence !== "uncertain").map(siteKey)),
      ));
      setPhase("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  };

  const apply = async () => {
    if (!changes) return;
    setPhase("applying");
    try {
      const r = await applyWorkspaceRename(host, root, changes, accepted);
      setReport(r);
      setPhase("done");
      if (r.written.length > 0) onApplied(r.written);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("review");
    }
  };

  /** Accept or reject one change. Two verbs over one set, so "not decided" cannot exist. */
  const decide = (site: Site, accept: boolean) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (accept) next.add(siteKey(site)); else next.delete(siteKey(site));
      return next;
    });
  };

  const decideFile = (path: string, accept: boolean) => {
    const file = changes?.files.find((f) => f.path === path);
    if (!file) return;
    setAccepted((prev) => {
      const next = new Set(prev);
      for (const s of file.sites) { if (accept) next.add(siteKey(s)); else next.delete(siteKey(s)); }
      return next;
    });
  };

  const decideAll = (accept: boolean) => {
    if (!changes) return;
    setAccepted(accept ? new Set(sites.map(siteKey)) : new Set());
  };

  /** Open the file the change is in and put the caret on the term. The panel stays open. */
  const go = (site: Site) => {
    void revealSource({
      path: site.path,
      line: site.lineNumber,
      column: site.lineOffset + 1,
      needle: site.before,
    });
  };

  const onFieldKey = (e: ReactKeyboardEvent) => {
    // Enter is this field's own verb. Escape is deliberately left to bubble to the panel,
    // which is the one place in the app that decides what Escape means for a panel.
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    void plan();
  };

  const onListKey = (e: ReactKeyboardEvent) => {
    const site = sites[active];

    // Accept and reject are this list's own verbs, on the first letter of each word.
    if (site && (e.key === "a" || e.key === "A" || e.key === "r" || e.key === "R")) {
      decide(site, e.key === "a" || e.key === "A");
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    handleListKey(e, {
      index: active,
      count: sites.length,
      onMove: setActive,
      onActivate: () => { if (site) go(site); },
      onDismiss: onClose,
    });
  };

  // A review list you have to Tab into is a review list nobody reviews. When a plan lands, the
  // thing to look at is the changes, so that is where the keyboard goes.
  useEffect(() => {
    if (phase === "review" && sites.length > 0) {
      setActive(0);
      listRef.current?.focus();
    }
  }, [phase, sites.length]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <Panel name="agent" title="Agent" subtitle="Rename a term across the workspace" onClose={onClose}>
      <div className="agent-form">
        <label>
          <span>Term</span>
          <input
            ref={termRef}
            value={term}
            placeholder="the defined term"
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={onFieldKey}
          />
        </label>
        <label>
          <span>Becomes</span>
          <input
            value={replacement}
            placeholder="its new name"
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={onFieldKey}
          />
        </label>
        <label className="agent-check">
          <input type="checkbox" checked={frontmatter} onChange={(e) => setFrontmatter(e.target.checked)} />
          <span>Include frontmatter</span>
        </label>
        <button
          type="button"
          className="agent-run"
          onClick={() => void plan()}
          disabled={phase === "planning" || term.trim().length === 0 || replacement.trim().length === 0}
        >
          {phase === "planning" ? "Searching…" : "Find changes"}
        </button>
      </div>

      {error && <p className="agent-error">{error}</p>}

      {changes && summary && (
        <div className="agent-summary">
          <strong>
            {summary.sites === 0
              ? `No prose occurrences of “${term}” in ${scanned} files.`
              : `${summary.sites} change${summary.sites === 1 ? "" : "s"} in ${summary.files} of ${scanned} files`}
          </strong>
          {summary.sites > 0 && (
            <span className="agent-counts">
              {summary.byConfidence.exact} exact · {summary.byConfidence.variant} variant ·{" "}
              {summary.byConfidence.uncertain} to check
            </span>
          )}
          {summary.sites > 0 && (
            <span className="agent-bulk">
              <button type="button" onClick={() => decideAll(true)}>Accept all</button>
              <button type="button" onClick={() => decideAll(false)}>Reject all</button>
            </span>
          )}
        </div>
      )}

      {changes && changes.skipped.length > 0 && (
        <details className="agent-skipped">
          <summary>{changes.skipped.length} file(s) not searched</summary>
          <ul>
            {changes.skipped.slice(0, 40).map((s) => (
              <li key={s.path}><code>{s.path}</code> — {s.reason}</li>
            ))}
          </ul>
        </details>
      )}

      {changes && changes.files.length > 0 && (
        <div
          className="agent-list"
          ref={listRef}
          tabIndex={0}
          onKeyDown={onListKey}
          aria-label="Proposed changes"
        >
          {changes.files.map((file) => {
            const on = file.sites.filter((s) => accepted.has(siteKey(s))).length;
            return (
              <div key={file.path} className="agent-file">
                <div className="agent-file-head">
                  <code>{file.path}</code>
                  <span className="agent-file-count">{on} of {file.sites.length} accepted</span>
                  <span className="agent-verdict">
                    <button type="button" onClick={() => decideFile(file.path, true)}>Accept all</button>
                    <button type="button" onClick={() => decideFile(file.path, false)}>Reject all</button>
                  </span>
                </div>
                {file.sites.map((site, i) => {
                  const at = (fileStart.get(file.path) ?? 0) + i;
                  return (
                    <SiteRow
                      key={siteKey(site)}
                      site={site}
                      accepted={accepted.has(siteKey(site))}
                      isActive={at === active}
                      onDecide={(accept) => decide(site, accept)}
                      onGo={() => go(site)}
                      onFocusRow={() => setActive(at)}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {changes && changes.files.length > 0 && (
        <footer className="agent-foot">
          <button
            type="button"
            className="agent-apply"
            onClick={() => void apply()}
            disabled={phase === "applying" || accepted.size === 0}
          >
            {phase === "applying"
              ? "Writing…"
              : `Apply ${accepted.size} accepted change${accepted.size === 1 ? "" : "s"}`}
          </button>
          <span className="agent-note">
            Writes the accepted changes and nothing else; rejected ones are left exactly as they
            are. Undo is git.
          </span>
        </footer>
      )}

      {report && (
        <div className="agent-report">
          <p><strong>{report.written.length} file(s) written.</strong></p>
          {report.stale.length > 0 && (
            <p className="agent-error">
              {report.stale.length} site(s) were skipped: their file changed while you were
              reviewing. Search again to see them.
            </p>
          )}
          {report.failed.length > 0 && (
            <ul className="agent-error">
              {report.failed.map((f) => <li key={f.path}><code>{f.path}</code> — {f.reason}</li>)}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

interface SiteRowProps {
  site: Site;
  accepted: boolean;
  isActive: boolean;
  onDecide: (accept: boolean) => void;
  onGo: () => void;
  onFocusRow: () => void;
}

function SiteRow({ site, accepted, isActive, onDecide, onGo, onFocusRow }: SiteRowProps) {
  const head = site.line.slice(0, site.lineOffset);
  const tail = site.line.slice(site.lineOffset + site.before.length);
  return (
    <div
      className="agent-site"
      data-confidence={site.confidence}
      data-on={accepted}
      data-active={isActive}
      onMouseMove={onFocusRow}
    >
      {/* The line number was an address the panel would not take you to — one of three panels
          with that shape. It is the control now, not a label. */}
      <button type="button" className="agent-lineno" onClick={() => { onFocusRow(); onGo(); }}
        title="Go to this line">
        {site.lineNumber}
      </button>
      <span className="agent-line">
        <span className="agent-ctx">{clip(head, 44, "start")}</span>
        <del>{site.before}</del>
        <ins>{site.after}</ins>
        <span className="agent-ctx">{clip(tail, 44, "end")}</span>
      </span>
      <span className="agent-conf" title={site.note ?? ""}>{CONFIDENCE_LABEL[site.confidence]}</span>
      <span className="agent-verdict">
        <button type="button" aria-pressed={accepted} onClick={() => { onFocusRow(); onDecide(true); }}>
          Accept
        </button>
        <button type="button" aria-pressed={!accepted} onClick={() => { onFocusRow(); onDecide(false); }}>
          Reject
        </button>
      </span>
    </div>
  );
}

/** Keep the site itself in view: trim the far end of the context, not the near one. */
function clip(s: string, max: number, keep: "start" | "end"): string {
  if (s.length <= max) return s;
  return keep === "start" ? `…${s.slice(-max)}` : `${s.slice(0, max)}…`;
}
