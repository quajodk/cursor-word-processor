import type { FileStat, GitFileStatus } from "@scriv/host-api";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from "react";
import { currentContext } from "../commands/registry";
import { host } from "../host";
import { handleListKey } from "./list-nav";

/**
 * The file tree.
 *
 * Lazy by directory: a workspace can be a book with a thousand chapters or a repository with
 * fifty thousand files, and the difference must not be visible in the first paint. Children are
 * fetched when a folder is expanded and cached until the host reports a change under it.
 *
 * Fully keyboard-driven — it speaks the app's list dialect (`list-nav.ts`) like every other
 * list, plus Right/Left to expand and collapse — because "every feature reachable without the
 * mouse" has to include the one you use most, and has to include the way back out.
 */

export interface TreeHandle {
  focus(): void;
  reveal(path: string): void;
  refresh(): void;
}

interface Row {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
}

export interface FileTreeProps {
  root: string;
  openPath: string | null;
  onOpen: (path: string) => void;
  handleRef: Ref<TreeHandle>;
}

export function FileTree({ root, openPath, onOpen, handleRef }: FileTreeProps) {
  const [children, setChildren] = useState<Map<string, FileStat[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [git, setGit] = useState<Map<string, GitFileStatus["status"]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (dir: string) => {
    try {
      const entries = await host.fs.list(dir);
      setChildren((prev) => new Map(prev).set(dir, entries));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshGit = useCallback(async () => {
    if (!root) return;
    try {
      if (!(await host.git.isRepo(root))) return;
      const status = await host.git.status(root);
      setGit(new Map(status.map((s) => [s.path, s.status])));
    } catch {
      /* not a repository, or git is not installed: the tree works either way */
    }
  }, [root]);

  useEffect(() => {
    if (!root) return;
    void load(root);
    void refreshGit();
  }, [root, load, refreshGit]);

  // Follow the disk. A directory whose contents changed is re-listed only if it is expanded.
  // `expanded` is read through a ref so that expanding a folder does not tear down and rebuild
  // the host subscription — the socket would churn on every click.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  useEffect(() => {
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = host.fs.watch(root, (ev) => {
      const dir = ev.path.slice(0, ev.path.lastIndexOf("/")) || root;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (dir === root || expandedRef.current.has(dir)) void load(dir);
        void refreshGit();
      }, 120);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [root, load, refreshGit]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      for (const entry of children.get(dir) ?? []) {
        out.push({ path: entry.path, name: entry.name, isDir: entry.isDir, depth });
        if (entry.isDir && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }, [children, expanded, root]);

  const toggle = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else {
          next.add(path);
          if (!children.has(path)) void load(path);
        }
        return next;
      });
    },
    [children, load],
  );

  useImperativeHandle(handleRef, () => ({
    focus() {
      listRef.current?.focus();
      setSelected((current) => current ?? rows[0]?.path ?? null);
    },
    refresh() {
      void load(root);
      for (const dir of expanded) void load(dir);
      void refreshGit();
    },
    reveal(path: string) {
      // Expand every ancestor between the root and the file.
      const parts: string[] = [];
      let cursor = path;
      while (cursor.length > root.length) {
        cursor = cursor.slice(0, cursor.lastIndexOf("/"));
        if (cursor.length <= root.length) break;
        parts.push(cursor);
      }
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const dir of parts) {
          next.add(dir);
          if (!children.has(dir)) void load(dir);
        }
        return next;
      });
      setSelected(path);
    },
  }));

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const index = rows.findIndex((r) => r.path === selected);
    const move = (delta: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))];
      if (next) setSelected(next.path);
    };

    // Expand and collapse are the tree's own verbs, layered on top of the shared dialect
    // rather than folded into it: this is the only list in the app with a hierarchy, and a
    // "go in / come out" pair would mean nothing in the other four.
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const row = rows[index];
      const forward = event.key === "ArrowRight";
      if (row?.isDir && expanded.has(row.path) !== forward) toggle(row.path);
      else move(forward ? 1 : -1);
      event.preventDefault();
      return;
    }

    handleListKey(event, {
      index,
      count: rows.length,
      onMove: (to) => {
        const next = rows[to];
        if (next) setSelected(next.path);
      },
      onActivate: () => {
        const row = rows[index];
        if (!row) return;
        if (row.isDir) toggle(row.path);
        else onOpen(row.path);
      },
      // The tree was the app's one keyboard dead end: every other focusable surface treats
      // Escape as "give the document back", and once focus was in here the only route out was
      // to run a command. It goes through the shell's own `focusEditor` rather than reaching
      // for a view, because that is the same door ⌘⇧2 opens.
      onDismiss: () => currentContext()?.ui.focusEditor(),
    });
  };

  if (error) {
    return (
      <div className="sidebar-note">
        {error}
        <br />
        Start the host with <code>bun run --cwd apps/server dev</code>.
      </div>
    );
  }

  return (
    <div className="sidebar-body" ref={listRef} tabIndex={0} onKeyDown={onKeyDown} role="tree">
      {rows.map((row) => (
        <button
          key={row.path}
          type="button"
          className="tree-row"
          role="treeitem"
          aria-expanded={row.isDir ? expanded.has(row.path) : undefined}
          data-selected={row.path === selected}
          data-open={row.path === openPath}
          data-git={git.get(row.path) ?? undefined}
          style={{ paddingLeft: 8 + row.depth * 13 }}
          onClick={() => {
            setSelected(row.path);
            if (row.isDir) toggle(row.path);
            else onOpen(row.path);
          }}
        >
          <span className="tree-twisty" data-expanded={row.isDir ? expanded.has(row.path) : undefined}>
            {row.isDir ? "▶" : ""}
          </span>
          <span className="tree-name">{row.name}</span>
          {git.has(row.path) ? <span className="tree-dot" /> : null}
        </button>
      ))}
      {rows.length === 0 ? <div className="sidebar-note">This folder is empty.</div> : null}
    </div>
  );
}
