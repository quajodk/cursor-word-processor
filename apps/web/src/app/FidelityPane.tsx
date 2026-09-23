import { useEffect, useMemo, useState } from "react";
import { exportDocx, summarize, type LedgerEntry, type LedgerSeverity } from "@scriv/ooxml";
import type { EditorController } from "../editor/controller";
import type { DocxMeta } from "../doc/docx";
import { markdownCodec } from "../doc/markdown";
import { Panel } from "./Panel";
import { revealBlock } from "./reveal";

/**
 * What this document will lose, stated before it is handed over.
 *
 * DOCX-FIDELITY.md §3 calls the ledger "the primary quality metric for docx support" and says
 * it is "surfaced in the UI's fidelity panel". There was no fidelity panel. A quality metric
 * nobody can see is a quality metric nobody is defending — the same failure as the round-trip
 * number that was logged but never asserted.
 *
 * TWO QUESTIONS, AND THEY ARE NOT THE SAME ONE:
 *
 *   What did the editor fail to show me?   — the IMPORT ledger, known the moment a file opens.
 *   What will a Word user see missing?     — the EXPORT ledger, which does not exist until an
 *                                            export has actually been attempted.
 *
 * So the second is a real export, run on demand and thrown away. That is the question the
 * blind comparison ends on — "open the exported file in Word and compare it to the original,
 * what broke?" — and the interesting answer is not that we score well on it. It is that the
 * tool can tell you the answer BEFORE you send the file.
 */

export interface FidelityPaneProps {
  controller: EditorController;
  /** Bumped when the open document changes, so the check does not describe the last one. */
  revision: number;
  onClose: () => void;
}

const SEVERITY_ORDER: LedgerSeverity[] = ["dropped", "degraded", "info"];
const SEVERITY_LABEL: Record<LedgerSeverity, string> = {
  dropped: "Will not survive a round trip",
  degraded: "Shown less faithfully than Word shows it",
  info: "Modelled differently; nothing is lost",
};

interface ExportCheck {
  entries: LedgerEntry[];
  partsRewritten: string[];
  totalParts: number;
  blocks: number;
  copied: number;
  runSpliced: number;
  rebuilt: number;
  synthesized: number;
  bytesCopied: number;
  bytesGenerated: number;
  packageIdentical: boolean;
  ms: number;
}

export function FidelityPane({ controller, revision, onClose }: FidelityPaneProps) {
  const [check, setCheck] = useState<ExportCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mdCheck, setMdCheck] = useState<{ identical: boolean; at: number; before: string; after: string } | null>(null);

  const meta = controller.meta;
  const isDocx = isDocxMeta(meta);

  // A check describes the document it was run on. Keeping it across an open would be a lie.
  useEffect(() => { setCheck(null); setMdCheck(null); setError(null); }, [revision]);

  const importEntries = useMemo(() => (isDocx ? (meta as DocxMeta).ledger : []), [meta, isDocx]);
  const importSummary = useMemo(() => summarize(importEntries), [importEntries]);

  const runCheck = () => {
    if (!isDocx) return;
    const doc = controller.editorView?.state.doc;
    if (!doc) return;
    setChecking(true);
    setError(null);
    // Deferred a frame so the button's disabled state paints before the export blocks the
    // thread. The export is synchronous and can take a few hundred milliseconds on a long
    // document; a button that appears to do nothing for that long reads as broken.
    requestAnimationFrame(() => {
      try {
        const m = meta as DocxMeta;
        const t0 = performance.now();
        const result = exportDocx(doc, m.sidecar, m.origin, { commentEdits: m.commentEdits ?? null });
        setCheck({
          entries: result.ledger,
          partsRewritten: result.stats.partsRewritten,
          totalParts: m.origin.entries.length,
          blocks: result.stats.blocks,
          copied: result.stats.copied,
          runSpliced: result.stats.runSpliced,
          rebuilt: result.stats.rebuilt,
          synthesized: result.stats.synthesized,
          bytesCopied: result.stats.bytesCopied,
          bytesGenerated: result.stats.bytesGenerated,
          packageIdentical: result.stats.packageIdentical,
          ms: performance.now() - t0,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setChecking(false);
      }
    });
  };

  const runMarkdownCheck = () => {
    const doc = controller.editorView?.state.doc;
    if (!doc) return;
    try {
      const written = markdownCodec.serialize(doc, controller.meta);
      const original = controller.savedText;
      if (written === original) { setMdCheck({ identical: true, at: -1, before: "", after: "" }); return; }
      let at = 0;
      while (at < written.length && at < original.length && written[at] === original[at]) at++;
      setMdCheck({
        identical: false,
        at,
        before: original.slice(Math.max(0, at - 40), at + 40),
        after: written.slice(Math.max(0, at - 40), at + 40),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Panel name="fidelity" title="Fidelity" subtitle="What this document loses" onClose={onClose}>
      {!isDocx && controller.codec.id === "markdown" && (
        <div className="fidelity-body">
          <p className="fidelity-lede">
            Markdown is this document's own format, so there is nothing to translate away. The
            question worth asking is whether saving it unchanged would rewrite it.
          </p>
          <button type="button" className="fidelity-run" onClick={runMarkdownCheck}>
            Check round trip
          </button>
          {mdCheck?.identical && <p className="fidelity-verdict is-clean">Saving now reproduces the file byte for byte.</p>}
          {mdCheck && !mdCheck.identical && (
            <>
              <p className="fidelity-verdict is-warn">
                Saving would rewrite the file, first at byte {mdCheck.at.toLocaleString()}.
              </p>
              <pre className="fidelity-diff">{`on disk : ${JSON.stringify(mdCheck.before)}\nwould be: ${JSON.stringify(mdCheck.after)}`}</pre>
            </>
          )}
        </div>
      )}

      {!isDocx && controller.codec.id !== "markdown" && (
        <div className="fidelity-body">
          <p className="fidelity-lede">
            This file is open through the plain-text codec, which has no syntax knowledge and
            round-trips byte for byte. There is nothing it could lose.
          </p>
        </div>
      )}

      {isDocx && (
        <div className="fidelity-body">
          <p className="fidelity-lede">
            Export does not rebuild this file, it edits the one that arrived: paragraphs you did
            not touch are written back as their original bytes.
          </p>

          <h3>
            On opening
            <span className={verdictClass(importSummary.bySeverity.dropped, importSummary.bySeverity.degraded)}>
              {verdictText(importSummary.bySeverity.dropped, importSummary.bySeverity.degraded, importEntries.length)}
            </span>
          </h3>
          <EntryList entries={importEntries} empty="Everything in this document is modelled." />

          <h3>
            On saving
            <button type="button" className="fidelity-run" onClick={runCheck} disabled={checking}>
              {checking ? "Checking…" : check ? "Check again" : "Check what will be written"}
            </button>
          </h3>

          {error && <p className="fidelity-verdict is-warn">{error}</p>}

          {!check && !error && (
            <p className="fidelity-lede">
              Runs a real export and throws it away, so the answer is what would actually be
              written rather than an estimate.
            </p>
          )}

          {check && (
            <>
              <dl className="fidelity-stats">
                <div><dt>Parts rewritten</dt><dd>{check.partsRewritten.length} of {check.totalParts}</dd></div>
                <div><dt>Blocks copied verbatim</dt><dd>{check.copied} of {check.blocks}</dd></div>
                <div><dt>Run-spliced</dt><dd>{check.runSpliced}</dd></div>
                <div><dt>Rebuilt</dt><dd>{check.rebuilt}</dd></div>
                <div><dt>New</dt><dd>{check.synthesized}</dd></div>
                <div>
                  <dt>Bytes from the original</dt>
                  <dd>{percent(check.bytesCopied, check.bytesCopied + check.bytesGenerated)}</dd>
                </div>
              </dl>
              {check.partsRewritten.length > 0 && (
                <p className="fidelity-parts">
                  {check.partsRewritten.join(", ")} — every other part is copied byte for byte.
                </p>
              )}
              {check.packageIdentical && (
                <p className="fidelity-verdict is-clean">
                  The written file would be byte-identical to the one you opened.
                </p>
              )}
              <EntryList
                entries={check.entries}
                empty="Nothing is lost or approximated on the way out."
              />
              <p className="fidelity-foot">Checked in {check.ms.toFixed(0)} ms.</p>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

function EntryList({ entries, empty }: { entries: LedgerEntry[]; empty: string }) {
  if (entries.length === 0) return <p className="fidelity-verdict is-clean">{empty}</p>;
  const bySeverity = new Map<LedgerSeverity, LedgerEntry[]>();
  for (const e of entries) {
    const list = bySeverity.get(e.severity) ?? [];
    list.push(e);
    bySeverity.set(e.severity, list);
  }
  return (
    <>
      {SEVERITY_ORDER.filter((s) => bySeverity.has(s)).map((severity) => (
        <div key={severity} className="fidelity-group" data-severity={severity}>
          <h4>{SEVERITY_LABEL[severity]}</h4>
          <ul>
            {bySeverity.get(severity)!
              .slice()
              .sort((a, b) => b.count - a.count)
              .map((e, i) => (
                <li key={`${e.code}:${e.element ?? ""}:${e.part ?? ""}:${i}`}>
                  <code>{e.code}</code>
                  {e.count > 1 && <span className="fidelity-count">×{e.count.toLocaleString()}</span>}
                  <span className="fidelity-detail">{e.detail}</span>
                  {e.confidence !== undefined && (
                    <span className="fidelity-count">confidence {e.confidence.toFixed(2)}</span>
                  )}
                  {/* An entry that names a block is an address, and an address the tool will
                      not take you to is a worse answer than no address. `aid` is the model's
                      own stable block identity, so unlike a line number it cannot go stale
                      while the panel is open. */}
                  {e.aid && (
                    <button type="button" className="fidelity-goto" onClick={() => revealBlock(e.aid!)}>
                      Go to it
                    </button>
                  )}
                </li>
              ))}
          </ul>
        </div>
      ))}
    </>
  );
}

function verdictClass(dropped: number, degraded: number): string {
  return `fidelity-badge ${dropped > 0 ? "is-warn" : degraded > 0 ? "is-soft" : "is-clean"}`;
}

function verdictText(dropped: number, degraded: number, total: number): string {
  if (dropped > 0) return `${dropped.toLocaleString()} will not survive a round trip`;
  if (degraded > 0) return `${degraded.toLocaleString()} shown less faithfully`;
  return total > 0 ? "nothing lost" : "clean";
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function isDocxMeta(value: unknown): value is DocxMeta {
  return typeof value === "object" && value !== null && "sidecar" in value && "origin" in value;
}
