import { OffsetMap, proseText } from "@scriv/doc-model";
import { DiagnosticsClient, type Diagnostic, type Severity } from "@scriv/lsp";
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

/**
 * Live prose diagnostics, drawn as decorations.
 *
 * Decorations rather than document nodes: a squiggle is a view concern, and putting it in the
 * document would make it part of the text — savable, undoable, and exportable to Word, none of
 * which is wanted. This is the property that decided the editor engine (ARCHITECTURE.md §0).
 */

export const diagnosticsKey = new PluginKey<DiagnosticsState>("scriv-diagnostics");

export interface DiagnosticsState {
  /**
   * Positions are document positions, already mapped from the checker's text offsets.
   *
   * EVERY diagnostic is here, including the ones below the severity floor and therefore not
   * underlined. Filtering at this level would mean the quick-fix key could not reach a hint
   * the writer deliberately put the caret on, and a future panel would have nothing to list.
   * The floor decides what is DRAWN, not what is known.
   */
  items: { from: number; to: number; diagnostic: Diagnostic }[];
  decorations: DecorationSet;
  /** Round-trip time of the last check, for the status bar. */
  elapsedMs: number;
  /** Drawn in the text: at or above the severity floor. */
  shown: number;
  /** Known but not drawn. Reported, so quiet is never indistinguishable from clean. */
  muted: number;
  /** True while the document is still being scanned for the first time. */
  scanning: boolean;
}

const EMPTY: DiagnosticsState = {
  items: [], decorations: DecorationSet.empty, elapsedMs: 0, shown: 0, muted: 0, scanning: false,
};

/** Severity order, quietest first. A diagnostic is drawn when its rank is at or above the floor. */
const RANK: Record<Severity, number> = { hint: 0, info: 1, warning: 2, error: 3 };

const CLASS: Record<string, string> = {
  error: "scriv-diag scriv-diag-error",
  warning: "scriv-diag scriv-diag-warning",
  info: "scriv-diag scriv-diag-info",
  hint: "scriv-diag scriv-diag-hint",
};

function build(state: EditorState, diagnostics: Diagnostic[], floor: Severity): DiagnosticsState {
  const from = 0;
  const to = state.doc.content.size;
  const map = new OffsetMap(state.doc, from, to);
  const items: DiagnosticsState["items"] = [];
  const decos: Decoration[] = [];
  const min = RANK[floor];
  let muted = 0;

  for (const d of diagnostics) {
    const a = map.pos(d.from);
    const b = map.pos(d.to);
    if (b <= a) continue;
    items.push({ from: a, to: b, diagnostic: d });
    if ((RANK[d.severity] ?? 1) < min) { muted++; continue; }
    decos.push(Decoration.inline(a, b, {
      class: CLASS[d.severity] ?? CLASS.info!,
      title: `${d.message} (${d.source}: ${d.code})`,
    }));
  }
  return {
    items, decorations: DecorationSet.create(state.doc, decos), elapsedMs: 0,
    shown: decos.length, muted, scanning: false,
  };
}

export interface DiagnosticsOptions {
  /** Document language. Harper declines anything that is not English. */
  language: () => string;
  /**
   * Quietest severity to underline. Read on every result rather than captured once, so
   * changing it takes effect on the next refresh without rebuilding the editor.
   */
  floor?: () => Severity;
  onTiming?: (info: { elapsedMs: number; shown: number; muted: number; scanning: boolean }) => void;
}

export function diagnosticsPlugin(opts: DiagnosticsOptions): Plugin<DiagnosticsState> {
  let client: DiagnosticsClient | null = null;

  return new Plugin<DiagnosticsState>({
    key: diagnosticsKey,
    state: {
      init: () => EMPTY,
      apply(tr, value, _old, newState) {
        const incoming = tr.getMeta(diagnosticsKey) as
          { diagnostics: Diagnostic[]; elapsedMs: number; scanning: boolean } | undefined;
        if (incoming) {
          const floor = opts.floor?.() ?? "warning";
          return { ...build(newState, incoming.diagnostics, floor), elapsedMs: incoming.elapsedMs, scanning: incoming.scanning };
        }
        if (!tr.docChanged) return value;
        // Map the existing decorations forward so squiggles track the text while the next
        // check is in flight, instead of vanishing on every keystroke and flashing back.
        return { ...value, decorations: value.decorations.map(tr.mapping, tr.doc) };
      },
    },
    props: {
      decorations: (state) => diagnosticsKey.getState(state)?.decorations ?? DecorationSet.empty,
    },
    view(view) {
      const worker = new Worker(new URL("./diagnostics.worker.ts", import.meta.url), { type: "module" });
      client = new DiagnosticsClient(worker, {
        onDiagnostics: (diagnostics, meta) => {
          const tr = view.state.tr.setMeta(diagnosticsKey, {
            diagnostics, elapsedMs: meta.elapsedMs, scanning: meta.partial,
          });
          view.dispatch(tr);
          const st = diagnosticsKey.getState(view.state);
          opts.onTiming?.({
            elapsedMs: meta.elapsedMs,
            shown: st?.shown ?? 0,
            muted: st?.muted ?? 0,
            scanning: meta.partial,
          });
        },
      });
      // `proseText`, not `textBetween`: code is masked to spaces so the checker never sees
      // it. Same length, so the offsets it returns still map through OffsetMap unchanged.
      const send = (v: EditorView) => client?.request(proseText(v.state.doc), opts.language());
      send(view);
      return {
        update(v, prev) {
          if (!v.state.doc.eq(prev.doc)) send(v);
        },
        destroy() {
          client?.destroy();
          client = null;
        },
      };
    },
  });
}

/** The diagnostic under a position, if any. */
export function diagnosticAt(state: EditorState, pos: number) {
  const st = diagnosticsKey.getState(state);
  return st?.items.find((i) => pos >= i.from && pos <= i.to) ?? null;
}

/** Apply a diagnostic's first fix at the caret. Bound to a key so it never needs the mouse. */
export function applyFirstFix(view: EditorView): boolean {
  const hit = diagnosticAt(view.state, view.state.selection.from);
  const fix = hit?.diagnostic.fixes[0];
  if (!hit || !fix) return false;
  const tr = view.state.tr.insertText(fix.replacement, hit.from, hit.to);
  view.dispatch(tr.scrollIntoView());
  return true;
}
