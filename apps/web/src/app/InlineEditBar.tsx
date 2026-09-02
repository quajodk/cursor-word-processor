import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorView } from "prosemirror-view";
import type { HostApi } from "@scriv/host-api";
import { accept, cancel, inlineEditKey, reject, startInlineEdit, type Phase } from "../editor/inline-edit";

/**
 * The Cmd-K bar.
 *
 * React is fine here — this appears on a deliberate keystroke and disappears again, and it
 * never renders while the writer is typing into the document. The suggestion itself is drawn
 * by ProseMirror decorations, not by this component; all this owns is the instruction field
 * and the accept/reject affordances.
 */
export function InlineEditBar({ view, host }: { view: EditorView | null; host: HostApi }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [instruction, setInstruction] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);

  // Poll the plugin rather than subscribing: the plugin is the source of truth and this is a
  // once-per-interaction surface, so a 90 ms tick costs nothing and avoids threading a
  // listener through the editor for one component.
  useEffect(() => {
    if (!view) return;
    const id = setInterval(() => {
      const st = inlineEditKey.getState(view.state);
      if (!st) return;
      setPhase(st.phase);
      setMessage(st.message);
    }, 90);
    return () => clearInterval(id);
  }, [view]);

  useEffect(() => {
    if (phase === "prompting") input.current?.focus();
  }, [phase]);

  const run = useCallback(() => {
    if (!view || instruction.trim().length === 0) return;
    abort.current?.abort();
    abort.current = new AbortController();
    void startInlineEdit(view, host, instruction.trim(), abort.current.signal);
  }, [view, host, instruction]);

  const dismiss = useCallback(() => {
    abort.current?.abort();
    if (view) { reject(view); cancel(view); view.focus(); }
    setInstruction("");
  }, [view]);

  if (phase === "idle" || !view) return null;

  const reviewing = phase === "reviewing" || phase === "conflict";

  return (
    <div className={`scriv-inline-edit is-${phase}`} role="dialog" aria-label="Rewrite selection">
      {phase === "prompting" && (
        <input
          ref={input}
          className="scriv-inline-edit-input"
          placeholder="Rewrite this passage to…"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); run(); }
            if (e.key === "Escape") { e.preventDefault(); dismiss(); }
          }}
        />
      )}

      {phase === "streaming" && <span className="scriv-inline-edit-status">Rewriting…</span>}

      {reviewing && (
        <>
          {phase === "conflict" && <span className="scriv-inline-edit-warn">{message}</span>}
          <span className="scriv-inline-edit-status">
            {phase === "conflict" ? "Review carefully" : "Review the change"}
          </span>
          <button className="scriv-inline-edit-btn" onClick={() => { accept(view); view.focus(); }}>
            Accept <kbd>⌘⏎</kbd>
          </button>
          <button className="scriv-inline-edit-btn is-quiet" onClick={dismiss}>
            Reject <kbd>⌘⌫</kbd>
          </button>
        </>
      )}

      {phase === "error" && (
        <>
          <span className="scriv-inline-edit-warn">{message}</span>
          <button className="scriv-inline-edit-btn is-quiet" onClick={dismiss}>Dismiss</button>
        </>
      )}
    </div>
  );
}
