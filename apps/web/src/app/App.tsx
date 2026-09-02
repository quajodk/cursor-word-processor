import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { registerDefaultCommands } from "../commands/defaults";
import { installKeyboard, setContextProvider, type CommandContext, type CommandUi } from "../commands/registry";
import { EditorController } from "../editor/controller";
import { baseName, dirName, host, relativeTo } from "../host";
import { EditorPane } from "./EditorPane";
import { FileTree, type TreeHandle } from "./FileTree";
import { Palette, type PaletteMode } from "./Palette";
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

export function App() {
  const prefs = useSyncExternalStore(subscribePrefs, getPrefs);
  const [root, setRoot] = useState("");
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const controller = useMemo(() => new EditorController(host), []);
  const treeRef = useRef<TreeHandle>(null);
  const rootRef = useRef("");
  rootRef.current = root;

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
        </div>

        {prefs.pane === "files" ? (
          <FileTree
            root={root}
            openPath={openPath}
            onOpen={(path) => void ui.openFile(path)}
            handleRef={treeRef}
          />
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
        <EditorPane
          controller={controller}
          headLeft={headLeft}
          headRight={headRight}
          paragraph={prefs.paragraph}
          alignment={prefs.alignment}
        />
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
