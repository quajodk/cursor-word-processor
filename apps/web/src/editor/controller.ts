import type { HostApi } from "@scriv/host-api";
import type { Node as PMNode } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { latencyPercentiles, recordLatency, resetLatency, setStatus } from "../app/status";
import { codecFor, markdownCodec, type DocumentCodec } from "../doc/codec";
import { createEditorState, emptyDoc } from "./setup";
import { WorkspaceSymbols } from "./workspace-symbols";

/**
 * The editing surface, owned imperatively.
 *
 * This class exists to keep React off the keystroke path. The `EditorView` is constructed once,
 * into one div, and from then on ProseMirror owns that DOM outright: no component re-renders
 * when a character is typed, no props diff, no reconciliation. React is told about a document
 * being *opened*, which happens at human frequency, and nothing else.
 *
 * `dispatchTransaction` is therefore the hottest function in the app, and it does exactly three
 * things: apply, update, measure. Word counts and caret readouts are deferred to an idle
 * callback because they walk the document, and walking a 40,000-word document per keystroke is
 * precisely the bug docs/ARCHITECTURE.md §5 forbids.
 */

export type DocEvent = { type: "opened"; path: string | null } | { type: "dirty"; dirty: boolean };

const STATS_INTERVAL_MS = 400;

export class EditorController {
  view: EditorView | null = null;
  path: string | null = null;
  /** Round-trip state from the codec that parsed the open file. */
  meta: unknown = null;
  /** Chosen per document by extension, so a `.txt` is never rewritten as Markdown. */
  codec: DocumentCodec = markdownCodec;
  /** Exactly the bytes last read from or written to disk. */
  savedText = "";
  dirty = false;

  private readonly listeners = new Set<(ev: DocEvent) => void>();
  private statsPending = false;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  private unwatch: (() => void) | null = null;

  /** The workspace symbol table that feeds completion. Public so the shell can scan with it. */
  readonly symbols: WorkspaceSymbols;

  constructor(private readonly host: HostApi) {
    this.symbols = new WorkspaceSymbols(host);
  }

  /** Plugin options, rebuilt for every document so the completion plugin sees the live path. */
  private pluginOptions() {
    return { symbols: this.symbols, currentPath: () => this.path };
  }

  subscribe(listener: (ev: DocEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: DocEvent): void {
    for (const l of this.listeners) l(ev);
  }

  // ---------------------------------------------------------------- lifecycle

  mount(el: HTMLElement): void {
    if (this.view) return;
    this.view = new EditorView(el, {
      state: createEditorState(emptyDoc(), this.pluginOptions()),
      dispatchTransaction: (tr) => this.dispatch(tr),
      attributes: { spellcheck: "true", role: "textbox", "aria-multiline": "true" },
    });
    this.scheduleStats(true);
  }

  destroy(): void {
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = null;
    this.unwatch?.();
    this.unwatch = null;
    this.view?.destroy();
    this.view = null;
  }

  focus(): void {
    this.view?.focus();
  }

  // ---------------------------------------------------------------- the hot path

  private dispatch(tr: Transaction): void {
    const view = this.view;
    if (!view) return;

    const t0 = performance.now();
    const next = view.state.apply(tr);
    view.updateState(next);
    const elapsed = performance.now() - t0;

    if (tr.docChanged) {
      // Only real edits are measured. Selection-only transactions do no work worth budgeting,
      // and folding them in would flatter the percentile.
      recordLatency(elapsed);
      if (!this.dirty) {
        this.dirty = true;
        setStatus({ dirty: true }, true);
        this.emit({ type: "dirty", dirty: true });
      }
    }
    this.scheduleStats();
  }

  /** Coalesced, then run when the browser is idle: this walks the whole document. */
  private scheduleStats(immediate = false): void {
    if (this.statsPending && !immediate) return;
    this.statsPending = true;
    const run = () => {
      this.statsTimer = null;
      this.statsPending = false;
      const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => number }).requestIdleCallback;
      if (idle) idle(() => this.computeStats(), { timeout: 500 });
      else this.computeStats();
    };
    if (immediate) {
      if (this.statsTimer) clearTimeout(this.statsTimer);
      run();
      return;
    }
    this.statsTimer ??= setTimeout(run, STATS_INTERVAL_MS);
  }

  private computeStats(): void {
    const view = this.view;
    if (!view) return;
    const { doc, selection } = view.state;

    let words = 0;
    let chars = 0;
    doc.descendants((node) => {
      if (!node.isText) return true;
      const value = node.text ?? "";
      chars += value.length;
      // Counting transitions rather than splitting avoids allocating an array per text node.
      let inWord = false;
      for (let i = 0; i < value.length; i++) {
        const space = /\s/.test(value[i]!);
        if (!space && !inWord) words++;
        inWord = !space;
      }
      return true;
    });

    const $from = selection.$from;
    const { p50, p99, samples } = latencyPercentiles();
    const codec = this.codec;
    setStatus({
      words,
      chars,
      blocks: doc.childCount,
      line: $from.depth > 0 ? $from.index(0) + 1 : 1,
      col: $from.parentOffset + 1,
      p50,
      p99,
      samples,
      codecId: codec.id,
      codecStructural: codec.structural,
    });
  }

  // ---------------------------------------------------------------- documents

  /** Replace the document without tearing the view down: the DOM node is never remounted. */
  setDocument(path: string | null, doc: PMNode, meta: unknown, savedText: string, codec?: DocumentCodec): void {
    if (!this.view) return;
    this.path = path;
    this.meta = meta;
    this.codec = codec ?? codecFor(path);
    this.savedText = savedText;
    this.dirty = false;
    resetLatency();
    // Index the document being opened before its state is installed, so the first keystroke
    // in it can already complete its own names.
    if (path) this.symbols.setOpenDocument(path, doc);
    this.view.updateState(createEditorState(doc, this.pluginOptions()));
    setStatus({ path, dirty: false, p50: -1, p99: -1, samples: 0 }, true);
    this.emit({ type: "opened", path });
    this.scheduleStats(true);
    this.view.focus();
  }

  async open(path: string): Promise<void> {
    const codec = codecFor(path);
    if (codec.binary && codec.parseBinary) {
      // A .docx is a zip. Decoding it as UTF-8 to fit a text-shaped interface would corrupt
      // it, and the original bytes are not incidental here — export splices them rather than
      // regenerating, so they are carried in `meta` for as long as the document is open.
      const bytes = await this.host.fs.readBinary(path);
      const { doc, meta } = codec.parseBinary(bytes);
      this.setDocument(path, doc, meta, "", codec);
      return;
    }
    const text = await this.host.fs.read(path);
    const { doc, meta } = codec.parse(text);
    this.setDocument(path, doc, meta, text, codec);
  }

  async save(): Promise<string> {
    if (!this.view) throw new Error("no editor");
    if (!this.path) throw new Error("this document has no path yet — use “File: Save As”");
    if (this.codec.binary && this.codec.serializeBinary) {
      const bytes = this.codec.serializeBinary(this.view.state.doc, this.meta);
      await this.host.fs.writeBinary(this.path, bytes);
      this.dirty = false;
      setStatus({ dirty: false }, true);
      this.emit({ type: "dirty", dirty: false });
      return this.path;
    }
    const text = this.codec.serialize(this.view.state.doc, this.meta);
    await this.host.fs.write(this.path, text);
    this.savedText = text;
    this.dirty = false;
    setStatus({ dirty: false }, true);
    this.emit({ type: "dirty", dirty: false });
    return this.path;
  }

  async saveAs(path: string): Promise<string> {
    if (!this.view) throw new Error("no editor");
    // Save-as to a different kind of file changes which codec owns the document.
    const codec = codecFor(path);
    const text = codec.serialize(this.view.state.doc, this.meta);
    await this.host.fs.write(path, text);
    this.path = path;
    this.codec = codec;
    this.savedText = text;
    this.dirty = false;
    setStatus({ path, dirty: false }, true);
    this.emit({ type: "opened", path });
    return path;
  }

  async reload(): Promise<void> {
    if (!this.path) return;
    await this.open(this.path);
  }

  /**
   * Follow the file on disk. Another tool rewriting the open file while the writer has unsaved
   * changes is the one case where doing nothing is right: silently reloading would destroy work,
   * so the conflict is reported and left to a person.
   */
  watchExternalChanges(root: string, onConflict: (path: string) => void): void {
    this.unwatch?.();
    this.unwatch = this.host.fs.watch(root, (ev) => {
      if (ev.type !== "change" || ev.path !== this.path) return;
      if (this.dirty) {
        onConflict(ev.path);
        return;
      }
      void this.host.fs.read(ev.path).then((text) => {
        if (text === this.savedText || this.dirty || ev.path !== this.path) return;
        const codec = codecFor(ev.path);
        const { doc, meta } = codec.parse(text);
        this.setDocument(ev.path, doc, meta, text, codec);
      });
    });
  }
}
