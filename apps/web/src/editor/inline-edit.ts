import type { HostApi } from "@scriv/host-api";
import { claimEditorKeys } from "../commands/registry";
import { acceptSuggestion, hasSuggestion, rejectSuggestion, suggestRewrite } from "@scriv/ai";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/**
 * Cmd-K: rewrite a selection, streamed in as an accept/reject diff over the live document.
 *
 * The state machine is small but the two hard parts are both in it.
 *
 * FIRST, the range must survive the writer continuing to type. The request is issued against
 * positions captured when Cmd-K was pressed, and the model takes seconds to answer. Anything
 * typed above the selection moves it. So `from`/`to` are re-mapped through every transaction
 * that lands while the request is in flight, which is what ProseMirror's mapping is for.
 *
 * SECOND, if the writer edits INSIDE the range while the model is working, the rewrite is
 * answering a question about text that no longer exists. That is a conflict, and it is
 * surfaced rather than resolved: silently applying a rewrite of a stale sentence is precisely
 * how an AI editor loses someone's work.
 */

export const inlineEditKey = new PluginKey<InlineEditState>("scriv-inline-edit");

export type Phase = "idle" | "prompting" | "streaming" | "reviewing" | "conflict" | "error";

export interface InlineEditState {
  phase: Phase;
  /** The range under edit, re-mapped as the document changes. */
  from: number;
  to: number;
  /** Text of the range as it stood when the request was made. */
  original: string;
  /** Accumulated model output. */
  buffer: string;
  /** Groups the suggestion's marks. */
  revId: string;
  message: string;
  /** Set when the writer edited inside the range while a request was in flight. */
  touchedWhileStreaming: boolean;
}

const IDLE: InlineEditState = {
  phase: "idle", from: 0, to: 0, original: "", buffer: "", revId: "", message: "", touchedWhileStreaming: false,
};

type Meta =
  | { kind: "prompt"; from: number; to: number; original: string; revId: string }
  | { kind: "streaming" }
  | { kind: "chunk"; text: string }
  | { kind: "done" }
  | { kind: "error"; message: string }
  | { kind: "cancel" };

/** Did this transaction change content inside [from, to)? */
function touchedRange(tr: Transaction, from: number, to: number): boolean {
  if (!tr.docChanged) return false;
  let touched = false;
  for (const step of tr.steps) {
    step.getMap().forEach((oldStart, oldEnd) => {
      if (oldEnd >= from && oldStart <= to) touched = true;
    });
  }
  return touched;
}

export function inlineEditPlugin(): Plugin<InlineEditState> {
  return new Plugin<InlineEditState>({
    key: inlineEditKey,
    state: {
      init: () => IDLE,
      apply(tr, value) {
        const meta = tr.getMeta(inlineEditKey) as Meta | undefined;
        if (meta?.kind === "cancel") return IDLE;
        if (meta?.kind === "prompt") {
          return { ...IDLE, phase: "prompting", from: meta.from, to: meta.to, original: meta.original, revId: meta.revId };
        }

        let next = value;
        if (value.phase !== "idle" && tr.docChanged) {
          // Re-map the range so it still points at the same text after edits elsewhere.
          const from = tr.mapping.map(value.from, 1);
          const to = tr.mapping.map(value.to, -1);
          const touched = value.phase === "streaming" && touchedRange(tr, value.from, value.to);
          next = { ...value, from, to, touchedWhileStreaming: value.touchedWhileStreaming || touched };
        }

        switch (meta?.kind) {
          case "streaming": return { ...next, phase: "streaming", buffer: "", message: "" };
          case "chunk": return { ...next, buffer: next.buffer + meta.text };
          case "done":
            return next.touchedWhileStreaming
              ? { ...next, phase: "conflict", message: "You edited this passage while the rewrite was running. Review it before applying." }
              : { ...next, phase: "reviewing" };
          case "error": return { ...next, phase: "error", message: meta.message };
          default: return next;
        }
      },
    },
    props: {
      handleKeyDown(view, event) {
        const st = inlineEditKey.getState(view.state);
        if (!st) return false;

        // ⌘K USED TO BE HANDLED HERE, with a comment claiming it "beats the command keymap
        // deterministically instead of racing it through event bubbling". It did not: the
        // command keymap is a capture-phase listener on `window`, so it wins every time, and
        // `defaults.ts` has carried an identical implementation the whole time. Two builders
        // solved the same problem twice, each believing theirs was the one that ran.
        //
        // The registry's copy is the one kept, because the palette is derived from the binding
        // table — a command that lives only in a plugin is a feature with no discoverable way
        // in, which house rule 4 forbids.
        if (st.phase === "reviewing" || st.phase === "conflict") {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) return accept(view);
          if (event.key === "Backspace" && (event.metaKey || event.ctrlKey)) return reject(view);
          if (event.key === "Escape") return reject(view);
        }
        return false;
      },
    },

    view: (editorView) => {
      // A suggestion under review owns the keys that decide it. Escape was going to
      // `cursor.clear` and collapsing the multi-cursor instead of rejecting the edit.
      const release = claimEditorKeys("inline-edit", (event) => {
        const st = inlineEditKey.getState(editorView.state);
        if (!st || (st.phase !== "reviewing" && st.phase !== "conflict")) return false;
        const mod = event.metaKey || event.ctrlKey;
        if (event.key === "Escape" && !mod) return true;
        return mod && (event.key === "Enter" || event.key === "Backspace");
      });
      return { destroy: release };
    },
  });
}

/** Start a rewrite. Returns false when there is nothing selected or no provider configured. */
export async function startInlineEdit(
  view: EditorView,
  host: HostApi,
  instruction: string,
  signal?: AbortSignal,
): Promise<void> {
  // The range comes from plugin state, NOT from the live selection. By the time the writer
  // has typed an instruction, focus is in the prompt field and the editor's own selection may
  // have collapsed — reading it here made submit silently do nothing. Plugin state holds the
  // range captured when Cmd-K was pressed, re-mapped through every edit since.
  const captured = inlineEditKey.getState(view.state);
  if (!captured || captured.phase === "idle") return;
  const { from, to, revId } = captured;
  if (from === to) return;

  if (!(await host.ai.available())) {
    view.dispatch(view.state.tr.setMeta(inlineEditKey, {
      kind: "error",
      // Local-first: no key means no AI, and everything else keeps working. Say which
      // variable to set rather than failing silently.
      message: "No AI provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY and restart the server.",
    }));
    return;
  }

  const original = captured.original || view.state.doc.textBetween(from, to, "\n");
  view.dispatch(view.state.tr.setMeta(inlineEditKey, { kind: "streaming" }));

  const system =
    "You revise prose. Return ONLY the revised passage, with no preamble, no explanation and " +
    "no code fences. Preserve the author's voice, the Markdown formatting, and any citation " +
    "keys or cross-references exactly as they appear.";

  try {
    for await (const chunk of host.ai.stream({
      system,
      prompt: `Instruction: ${instruction}\n\nPassage:\n${original}`,
      signal,
    })) {
      if (chunk.type === "text") {
        view.dispatch(view.state.tr.setMeta(inlineEditKey, { kind: "chunk", text: chunk.text }));
      } else if (chunk.type === "error") {
        view.dispatch(view.state.tr.setMeta(inlineEditKey, { kind: "error", message: chunk.message }));
        return;
      }
    }
  } catch (e) {
    view.dispatch(view.state.tr.setMeta(inlineEditKey, { kind: "error", message: (e as Error).message }));
    return;
  }

  // The suggestion is projected once the stream completes rather than on every chunk: a
  // partial rewrite diffs as "everything after this point was deleted", which flashes the
  // whole passage red and makes the result unreadable while it arrives.
  const st = inlineEditKey.getState(view.state);
  if (!st || st.phase !== "streaming") return;
  const revised = st.buffer.trim();
  if (revised.length > 0) {
    const tr = suggestRewrite(view.state, st.from, st.to, revised, { revId: st.revId, author: "assistant" });
    if (tr) {
      tr.setMeta(inlineEditKey, { kind: "done" });
      view.dispatch(tr);
      return;
    }
  }
  view.dispatch(view.state.tr.setMeta(inlineEditKey, { kind: "error", message: "The rewrite came back identical." }));
}

export function accept(view: EditorView): boolean {
  const st = inlineEditKey.getState(view.state);
  if (!st || !hasSuggestion(view.state.doc, st.revId)) return false;
  const tr = acceptSuggestion(view.state, st.revId);
  if (!tr) return false;
  tr.setMeta(inlineEditKey, { kind: "cancel" });
  view.dispatch(tr);
  return true;
}

export function reject(view: EditorView): boolean {
  const st = inlineEditKey.getState(view.state);
  if (!st) return false;
  if (!hasSuggestion(view.state.doc, st.revId)) {
    view.dispatch(view.state.tr.setMeta(inlineEditKey, { kind: "cancel" }));
    return true;
  }
  const tr = rejectSuggestion(view.state, st.revId);
  if (!tr) return false;
  tr.setMeta(inlineEditKey, { kind: "cancel" });
  view.dispatch(tr);
  return true;
}

export function cancel(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(inlineEditKey, { kind: "cancel" }));
}
