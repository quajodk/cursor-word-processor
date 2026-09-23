import type { SearchHit } from "@scriv/host-api";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { currentContext } from "../commands/registry";
import { host, relativeTo } from "../host";
import { handleListKey } from "./list-nav";
import { revealSource } from "./reveal";

/**
 * Workspace text search, straight through the host (ripgrep when it is installed, a walk when
 * it is not — `apps/server/src/search.ts` decides, and nothing up here needs to know).
 *
 * The results are a list, so they move in the app's list dialect (`list-nav.ts`) like every
 * other list: before, they were `<button>`s reachable only by Tab, which made this the fifth
 * list panel and its fourth navigation dialect.
 *
 * And opening a hit goes to the hit. This pane prints a line number beside every row and then
 * used to throw it away — the shell's callback takes a path and nothing else — so clicking
 * line 15 opened the file at line 1 and the number on screen was decoration. Navigation now
 * goes through `reveal.ts`, which opens the file through the same shell door and then puts the
 * caret on the matched text.
 */

export interface SearchPaneProps {
  root: string;
  /**
   * The shell's opener. Unused: it takes a path only, so it cannot honour the line number this
   * pane displays, and `revealSource` calls the same `ui.openFile` underneath. Kept in the
   * signature so the shell keeps compiling until it drops the prop.
   */
  onOpen?: (path: string, line: number) => void;
}

export function SearchPane({ root }: SearchPaneProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [state, setState] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (query.trim().length < 2) {
      setHits([]);
      setState("idle");
      return;
    }
    let cancelled = false;
    setState("searching");
    const timer = setTimeout(async () => {
      try {
        const found = await host.search.text(root, query, { limit: 300 });
        if (cancelled) return;
        setHits(found);
        setState("done");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      }
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, root]);

  /**
   * Hits grouped by file for reading, each group carrying where it starts in the flat order.
   *
   * One numbering across the whole result set is what makes "next result" keep going at a file
   * boundary instead of stopping at it.
   */
  const groups = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const hit of hits) {
      const list = map.get(hit.path);
      if (list) list.push(hit);
      else map.set(hit.path, [hit]);
    }
    let start = 0;
    return [...map.entries()].map(([path, list]) => {
      const group = { path, list, start };
      start += list.length;
      return group;
    });
  }, [hits]);

  const flat = useMemo(() => groups.flatMap((g) => g.list), [groups]);

  useEffect(() => setActive(0), [hits]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  /**
   * Go to a hit.
   *
   * The needle is cut out of the hit's own line rather than taken from the query, because the
   * search is case-insensitive: searching `instrumentation` can match `Instrumentation`, and
   * the thing to select is the text that is actually there.
   */
  const go = (hit: SearchHit) => {
    const from = Math.max(0, hit.column - 1);
    const needle = hit.text.slice(from, from + query.trim().length);
    void revealSource({ path: hit.path, line: hit.line, column: hit.column, needle });
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    handleListKey(event, {
      index: active,
      count: flat.length,
      onMove: setActive,
      onActivate: () => {
        const hit = flat[active];
        if (hit) go(hit);
      },
      onDismiss: () => currentContext()?.ui.focusEditor(),
    });
  };

  return (
    <>
      <input
        ref={inputRef}
        className="search-field"
        placeholder="Search the workspace…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="sidebar-body" ref={listRef} onKeyDown={onKeyDown}>
        {state === "error" ? <div className="sidebar-note">{error}</div> : null}
        {state === "done" && hits.length === 0 ? <div className="sidebar-note">No matches.</div> : null}
        {state === "done" && hits.length > 0 ? (
          <div className="sidebar-note">
            {hits.length} match{hits.length === 1 ? "" : "es"} in {groups.length} file
            {groups.length === 1 ? "" : "s"}
          </div>
        ) : null}
        {groups.map(({ path, list, start }) => (
          <div key={path}>
            <div className="hit-file">{relativeTo(root, path)}</div>
            {list.map((hit, i) => {
              const at = start + i;
              return (
                <button
                  key={`${hit.line}:${hit.column}:${i}`}
                  type="button"
                  className="hit-row"
                  data-active={at === active}
                  onMouseMove={() => setActive(at)}
                  onClick={() => {
                    setActive(at);
                    go(hit);
                  }}
                >
                  <span className="hit-line">{hit.line}</span>
                  <span className="hit-text">{hit.text.trim().slice(0, 160)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
