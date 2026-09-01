import { useSyncExternalStore } from "react";
import { relativeTo } from "../host";
import { getStatus, subscribeStatus } from "./status";

/**
 * The status bar reports what the tool actually measured, not what it hopes.
 *
 * `p99` is the keystroke → state-commit latency from `EditorController.dispatch`, over the
 * current document. The budget it is being held against is 8 ms (docs/ARCHITECTURE.md §5), so
 * the number is shown in the shell rather than in a benchmark nobody runs, and it turns red the
 * moment it is missed.
 */
export function StatusBar() {
  const status = useSyncExternalStore(subscribeStatus, getStatus);
  const relative = status.path ? relativeTo(status.root, status.path) : null;
  const overBudget = status.p99 >= 0 && status.p99 > 8;

  return (
    <footer className="status">
      {status.dirty ? <span className="status-dirty" title="unsaved changes">●</span> : null}
      <span className="status-path" title={status.path ?? ""}>
        {relative ?? "no document"}
      </span>

      {status.message ? <span className="status-chip">{status.message}</span> : null}

      <span className="status-spacer" />

      {status.words > 0 ? (
        <span title={`${status.chars.toLocaleString()} characters in ${status.blocks} blocks`}>
          {status.words.toLocaleString()} words
        </span>
      ) : null}

      <span title="block and column of the caret">
        ¶{status.line}:{status.col}
      </span>

      <span
        className="status-chip"
        data-tone={overBudget ? "warn" : status.p99 >= 0 ? "ok" : undefined}
        title={`keystroke → state commit, over ${status.samples} samples. Budget: 8 ms p99.`}
      >
        {status.p99 >= 0 ? `${status.p50.toFixed(1)} / ${status.p99.toFixed(1)} ms` : "— ms"}
      </span>

      <span
        className="status-chip"
        data-tone={status.codecStructural ? "ok" : "warn"}
        title={
          status.codecStructural
            ? "Markdown codec active"
            : "@scriv/md is not exporting parseMarkdown yet — files open as plain text and round-trip byte for byte, but structured documents cannot be saved"
        }
      >
        {status.codecId}
      </span>

      <span className="status-chip" data-tone={status.host === "connected" ? "ok" : "warn"}>
        host {status.host}
      </span>

      <span title="AI provider, selected by environment variable on the host">ai: {status.ai}</span>
    </footer>
  );
}
