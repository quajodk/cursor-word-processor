import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { HostApi } from "@scriv/host-api";
import { siteKey, type ChangeSet, type Confidence, type Site } from "@scriv/ai";
import { applyWorkspaceRename, planWorkspaceRename, type ApplyReport } from "../editor/agent";

/**
 * Agent mode: an instruction that edits the workspace, reviewed before it lands.
 *
 * The shape of this panel is the argument. A chat box that returns a paragraph describing
 * what it would have done is not an agent, it is a colleague who does not have commit access.
 * What a writer needs is the *diff*, grouped by file, every site showing the line it sits on,
 * with accept and reject per site — and nothing written until they say so.
 *
 * IT IS USEFUL WITH THE NETWORK UNPLUGGED. The rename is decided in `@scriv/ai` with no model
 * involved: word boundaries, plurals, possessives, case, and a refusal to touch code are all
 * decidable, and deciding them exactly is more useful than asking a model to guess at them.
 * That is house rule 3 taken seriously rather than as a config flag.
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
  const termRef = useRef<HTMLInputElement>(null);

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

  const toggle = (key: string) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const setFile = (path: string, on: boolean) => {
    const file = changes?.files.find((f) => f.path === path);
    if (!file) return;
    setAccepted((prev) => {
      const next = new Set(prev);
      for (const s of file.sites) { if (on) next.add(siteKey(s)); else next.delete(siteKey(s)); }
      return next;
    });
  };

  const setAll = (on: boolean) => {
    if (!changes) return;
    setAccepted(on ? new Set(changes.files.flatMap((f) => f.sites.map(siteKey))) : new Set());
  };

  const onFieldKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); void plan(); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    e.stopPropagation();
  };

  return (
    <section className="agent" role="dialog" aria-label="Agent">
      <header className="agent-head">
        <h2>Agent</h2>
        <span className="agent-sub">Rename a term across the workspace</span>
        <button type="button" onClick={onClose} aria-label="Close">Close</button>
      </header>

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
          {phase === "planning" ? "Searching…" : "Find sites"}
        </button>
      </div>

      {error && <p className="agent-error">{error}</p>}

      {changes && summary && (
        <div className="agent-summary">
          <strong>
            {summary.sites === 0
              ? `No prose occurrences of “${term}” in ${scanned} files.`
              : `${summary.sites} site${summary.sites === 1 ? "" : "s"} in ${summary.files} of ${scanned} files`}
          </strong>
          {summary.sites > 0 && (
            <span className="agent-counts">
              {summary.byConfidence.exact} exact · {summary.byConfidence.variant} variant ·{" "}
              {summary.byConfidence.uncertain} to check
            </span>
          )}
          {summary.sites > 0 && (
            <span className="agent-bulk">
              <button type="button" onClick={() => setAll(true)}>All</button>
              <button type="button" onClick={() => setAll(false)}>None</button>
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
        <div className="agent-list">
          {changes.files.map((file) => {
            const on = file.sites.filter((s) => accepted.has(siteKey(s))).length;
            return (
              <div key={file.path} className="agent-file">
                <div className="agent-file-head">
                  <label>
                    <input
                      type="checkbox"
                      checked={on === file.sites.length}
                      ref={(el) => { if (el) el.indeterminate = on > 0 && on < file.sites.length; }}
                      onChange={(e) => setFile(file.path, e.target.checked)}
                    />
                    <code>{file.path}</code>
                  </label>
                  <span className="agent-file-count">{on} of {file.sites.length}</span>
                </div>
                {file.sites.map((site) => (
                  <SiteRow
                    key={siteKey(site)}
                    site={site}
                    checked={accepted.has(siteKey(site))}
                    onToggle={() => toggle(siteKey(site))}
                  />
                ))}
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
            {phase === "applying" ? "Writing…" : `Apply ${accepted.size} change${accepted.size === 1 ? "" : "s"}`}
          </button>
          <span className="agent-note">Writes the accepted sites and nothing else. Undo is git.</span>
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
    </section>
  );
}

function SiteRow({ site, checked, onToggle }: { site: Site; checked: boolean; onToggle: () => void }) {
  const head = site.line.slice(0, site.lineOffset);
  const tail = site.line.slice(site.lineOffset + site.before.length);
  return (
    <label className="agent-site" data-confidence={site.confidence} data-on={checked}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span className="agent-line">
        <span className="agent-lineno">{site.lineNumber}</span>
        <span className="agent-ctx">{clip(head, 44, "start")}</span>
        <del>{site.before}</del>
        <ins>{site.after}</ins>
        <span className="agent-ctx">{clip(tail, 44, "end")}</span>
      </span>
      <span className="agent-conf" title={site.note ?? ""}>{CONFIDENCE_LABEL[site.confidence]}</span>
    </label>
  );
}

/** Keep the site itself in view: trim the far end of the context, not the near one. */
function clip(s: string, max: number, keep: "start" | "end"): string {
  if (s.length <= max) return s;
  return keep === "start" ? `…${s.slice(-max)}` : `${s.slice(0, max)}…`;
}
