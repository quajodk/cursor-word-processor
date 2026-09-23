import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { registerDefaultCommands } from "../commands/defaults";
import { installKeyboard, setContextProvider, type CommandContext, type CommandUi } from "../commands/registry";
import { EditorController } from "../editor/controller";
import { baseName, dirName, host, relativeTo } from "../host";
import { EditorPane } from "./EditorPane";
import { InlineEditBar } from "./InlineEditBar";
import { DiffPane } from "./DiffPane";
import { FileTree, type TreeHandle } from "./FileTree";
import { Palette, type PaletteMode } from "./Palette";
import { CommentsPane } from "./CommentsPane";
import { FidelityPane } from "./FidelityPane";
import { AgentPane } from "./AgentPane";
import { getPrefs, setPrefs, subscribePrefs, watchSystemTheme } from "./prefs";
import { SearchPane } from "./SearchPane";
import { setStatus } from "./status";
import { StatusBar } from "./StatusBar";

/**
 * The shell.
 *
 * It owns exactly three things: which panes are visible, what overlay is open, and the wiring
 * that lets a command reach the host and the editor. It does not own the document — that lives
 * in `EditorController`, outside React, so that typing never reaches this component.
 */

interface Toast {
  id: number;
  message: string;
  tone: "info" | "error";
}

/**
 * Move keyboard focus into a panel that has just opened.
 *
 * Prefers the first control a writer would actually use — a text field if the panel has one,
 * else the first button — over the panel container, because focusing a `<section>` puts the
 * caret nowhere and the next Tab starts from the top of the document anyway.
 */
function focusIn(selector: string): void {
  const panel = document.querySelector<HTMLElement>(selector);
  if (!panel) return;
  const target = panel.querySelector<HTMLElement>("input, textarea, select")
    ?? panel.querySelector<HTMLElement>("button")
    ?? panel;
  target.focus();
}

export function App() {
  const prefs = useSyncExternalStore(subscribePrefs, getPrefs);
  const [root, setRoot] = useState("");
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showDiff, setShowDiff] = useState(false);
  const [showFidelity, setShowFidelity] = useState(false);
  const [showAgent, setShowAgent] = useState(false);
  /**
   * Bumped whenever the open document changes identity or content.
   *
   * The comments panel reads threads out of the controller's `meta`, which is mutated in
   * place rather than replaced — a reply appends to an array — so React has nothing to
   * compare. This is the signal that says "look again".
   */
  const [docRevision, setDocRevision] = useState(0);

  const controller = useMemo(() => new EditorController(host), []);
  const treeRef = useRef<TreeHandle>(null);
  const rootRef = useRef("");
  rootRef.current = root;

  /**
   * Who a reply is from.
   *
   * There is no account system and nothing here phones home, so the name comes from the
   * workspace's own git config via the host, falling back to a plain label. Writing
   * "Anonymous" into a colleague's Word document would be worse than writing nothing
   * identifying at all, so the fallback says what it is.
   */
  const [commentAuthor, setCommentAuthor] = useState({ name: "scriv", initials: "S" });
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    void (async () => {
      try {
        const name = (await host.git.authorName(root)).trim();
        if (cancelled || name.length === 0) return;
        const initials = name.split(/\s+/).map((w) => w[0]!).join("").slice(0, 3).toUpperCase();
        setCommentAuthor({ name, initials });
      } catch { /* not a git workspace, or no user.name: the fallback stands */ }
    })();
    return () => { cancelled = true; };
  }, [root]);

  const notify = useCallback((message: string, tone: "info" | "error" = "info") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), tone === "error" ? 7000 : 3200);
  }, []);

  // ------------------------------------------------------------------ host

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const value = await host.root();
        if (cancelled) return;
        setRoot(value);
        setStatus({ root: value, host: "connected" }, true);
        const provider = await host.ai.providerName();
        if (!cancelled) setStatus({ ai: provider }, true);
      } catch (err) {
        if (cancelled) return;
        setStatus({ host: "unreachable" }, true);
        notify(err instanceof Error ? err.message : String(err), "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notify]);

  useEffect(() => watchSystemTheme(), []);



  // Index the workspace for completion. Deliberately fire-and-forget and unawaited: the
  // editor is usable from the first frame, and completions simply get better as it lands.
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    void controller.symbols.scan(root, (p) => {
      if (cancelled) return;
      setStatus({ message: p.done ? "" : `indexing ${p.indexed}/${p.total}` }, false);
    });
    return () => { cancelled = true; };
  }, [root, controller]);

  useEffect(() => {
    if (!root) return;
    controller.watchExternalChanges(root, (path) => {
      notify(`${baseName(path)} changed on disk and you have unsaved edits — nothing was reloaded.`, "error");
    });
  }, [root, controller, notify]);

  // Follow the controller's own notion of which file is open (it changes on save-as too).
  useEffect(
    () =>
      controller.subscribe((ev) => {
        if (ev.type === "opened") setOpenPath(ev.path);
        setDocRevision((n) => n + 1);
      }),
    [controller],
  );

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!controller.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [controller]);

  // ------------------------------------------------------------------ ui seam

  const ui = useMemo<CommandUi>(() => {
    const guardDirty = (): boolean => {
      if (!controller.dirty) return true;
      notify("Unsaved changes. Save with ⌘S, or run “File: Revert to saved”.", "error");
      return false;
    };

    const ask = (label: string, initial = "") =>
      new Promise<string | null>((resolve) => {
        setPalette({ kind: "input", label, initial, resolve });
      });

    return {
      openPalette: (initialQuery = "") => setPalette({ kind: "commands", query: initialQuery }),
      closePalette: () => setPalette(null),

      async openQuickOpen() {
        try {
          const files = await host.search.files(rootRef.current, { limit: 5000 });
          setPalette({ kind: "files", files, root: rootRef.current });
        } catch (err) {
          notify(err instanceof Error ? err.message : String(err), "error");
        }
      },

      focusEditor: () => controller.focus(),
      // Both panels take keyboard focus when they open, after the frame that renders them.
      // Flipping the boolean alone left focus in the document: the panel appeared, and a
      // keyboard-only user had to Tab an unknown number of times to reach it — which is
      // "reachable" in the sense that a filing cabinet in another building is reachable.
      toggleFidelity: () => setShowFidelity((v) => {
        const next = !v;
        if (next) requestAnimationFrame(() => focusIn(".fidelity"));
        return next;
      }),
      toggleAgent: () => setShowAgent((v) => {
        const next = !v;
        if (next) requestAnimationFrame(() => focusIn(".agent"));
        return next;
      }),
      // Same shape as its two neighbours. It used to be a `window` keydown of its own, which is
      // why the changes pane was the one panel that did not take focus when it opened.
      toggleDiff: () => setShowDiff((v) => {
        const next = !v;
        if (next) requestAnimationFrame(() => focusIn(".diff"));
        return next;
      }),
      focusComments: () => {
        setPrefs({ sidebar: true, pane: "comments" });
        // After the pane has actually rendered: the tab switch is a state change, and
        // focusing a list that does not exist yet silently does nothing.
        requestAnimationFrame(() => document.querySelector<HTMLElement>(".comments-list")?.focus());
      },
      focusTree: () => {
        setPrefs({ sidebar: true, pane: "files" });
        requestAnimationFrame(() => treeRef.current?.focus());
      },
      toggleSidebar: () => setPrefs({ sidebar: !getPrefs().sidebar }),
      setTheme: (theme) => setPrefs({ theme }),
      cycleTheme: () => {
        const order = ["light", "dark", "system"] as const;
        const next = order[(order.indexOf(getPrefs().theme) + 1) % order.length]!;
        setPrefs({ theme: next });
        notify(`Theme: ${next}`);
      },
      notify,

      async openFile(path: string) {
        if (!guardDirty()) return;
        try {
          await controller.open(path);
          treeRef.current?.reveal(path);
        } catch (err) {
          notify(err instanceof Error ? err.message : String(err), "error");
        }
      },

      async saveFile() {
        const saved = await controller.save();
        notify(`Saved ${relativeTo(rootRef.current, saved)}`);
        treeRef.current?.refresh();
      },

      async newFile() {
        const name = await ask("New file, relative to the workspace root", "untitled.md");
        if (!name) return;
        const path = name.startsWith("/") ? name : `${rootRef.current}/${name}`;
        await host.fs.write(path, "");
        await controller.open(path);
        treeRef.current?.refresh();
        treeRef.current?.reveal(path);
        notify(`Created ${relativeTo(rootRef.current, path)}`);
      },

      async reloadFromDisk() {
        await controller.reload();
        notify("Reloaded from disk");
      },

      prompt: ask,

      revealInTree(path: string) {
        setPrefs({ sidebar: true, pane: "files" });
        treeRef.current?.reveal(path);
      },
    };
  }, [controller, notify]);

  // ------------------------------------------------------------------ commands

  useEffect(() => {
    const provide = (): CommandContext => ({
      host,
      view: controller.view,
      filePath: controller.path,
      root: rootRef.current,
      ui,
    });
    setContextProvider(provide);
    const offCommands = registerDefaultCommands(controller);
    const offKeys = installKeyboard(window);
    return () => {
      offKeys();
      offCommands();
      setContextProvider(null);
    };
  }, [controller, ui]);

  // ------------------------------------------------------------------ render

  const headLeft = openPath ? relativeTo(root, dirName(openPath)) || baseName(root) : baseName(root) || "scriv";
  const headRight = openPath ? baseName(openPath) : "untitled";

  return (
    <div className="app" data-sidebar={prefs.sidebar ? "shown" : "hidden"}>
      <aside className="sidebar">
        <div className="sidebar-tabs" role="tablist">
          <button
            type="button"
            className="sidebar-tab"
            role="tab"
            aria-selected={prefs.pane === "files"}
            onClick={() => setPrefs({ pane: "files" })}
          >
            Files
          </button>
          <button
            type="button"
            className="sidebar-tab"
            role="tab"
            aria-selected={prefs.pane === "search"}
            onClick={() => setPrefs({ pane: "search" })}
          >
            Search
          </button>
          <button
            type="button"
            className="sidebar-tab"
            role="tab"
            aria-selected={prefs.pane === "comments"}
            onClick={() => setPrefs({ pane: "comments" })}
          >
            Comments
          </button>
        </div>

        {prefs.pane === "files" ? (
          <FileTree
            root={root}
            openPath={openPath}
            onOpen={(path) => void ui.openFile(path)}
            handleRef={treeRef}
          />
        ) : prefs.pane === "comments" ? (
          <CommentsPane controller={controller} revision={docRevision} author={commentAuthor} />
        ) : (
          <SearchPane
            root={root}
            onOpen={(path) => {
              void ui.openFile(path);
            }}
          />
        )}
      </aside>

      <main className="main">
        <InlineEditBar view={controller.editorView ?? null} host={host} />
        <EditorPane
          controller={controller}
          headLeft={headLeft}
          headRight={headRight}
          paragraph={prefs.paragraph}
          alignment={prefs.alignment}
        />
        {showAgent && (
          <AgentPane
            host={host}
            root={root}
            onClose={() => setShowAgent(false)}
            onApplied={(paths) => {
              notify(`Rewrote ${paths.length} file${paths.length === 1 ? "" : "s"}.`);
              // The open document may be one of them: reload it so the editor is not showing
              // text that no longer exists on disk.
              const open = controller.path;
              if (open && paths.some((p) => open.endsWith(p))) void ui.openFile(open);
            }}
          />
        )}
        {showFidelity && (
          <FidelityPane controller={controller} revision={docRevision} onClose={() => setShowFidelity(false)} />
        )}
        {showDiff && (
          <DiffPane
            host={host}
            root={root}
            path={openPath}
            currentText={() => controller.currentText()}
            onClose={() => setShowDiff(false)}
          />
        )}
      </main>

      <StatusBar />

      {palette ? <Palette mode={palette} onClose={() => setPalette(null)} /> : null}

      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast" data-tone={toast.tone}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
