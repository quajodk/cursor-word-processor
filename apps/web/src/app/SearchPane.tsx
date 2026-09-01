import type { SearchHit } from "@scriv/host-api";
import { useEffect, useMemo, useRef, useState } from "react";
import { host, relativeTo } from "../host";

/**
 * Workspace text search, straight through the host (ripgrep when it is installed, a walk when
 * it is not — `apps/server/src/search.ts` decides, and nothing up here needs to know).
 */
export function SearchPane({ root, onOpen }: { root: string; onOpen: (path: string, line: number) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [state, setState] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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

  const grouped = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const hit of hits) {
      const list = map.get(hit.path);
      if (list) list.push(hit);
      else map.set(hit.path, [hit]);
    }
    return [...map.entries()];
  }, [hits]);

  return (
    <>
      <input
        ref={inputRef}
        className="search-field"
        placeholder="Search the workspace…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="sidebar-body">
        {state === "error" ? <div className="sidebar-note">{error}</div> : null}
        {state === "done" && hits.length === 0 ? <div className="sidebar-note">No matches.</div> : null}
        {state === "done" && hits.length > 0 ? (
          <div className="sidebar-note">
            {hits.length} match{hits.length === 1 ? "" : "es"} in {grouped.length} file
            {grouped.length === 1 ? "" : "s"}
          </div>
        ) : null}
        {grouped.map(([path, list]) => (
          <div key={path}>
            <div className="hit-file">{relativeTo(root, path)}</div>
            {list.map((hit, i) => (
              <button
                key={`${hit.line}:${hit.column}:${i}`}
                type="button"
                className="hit-row"
                onClick={() => onOpen(hit.path, hit.line)}
              >
                <span className="hit-line">{hit.line}</span>
                <span className="hit-text">{hit.text.trim().slice(0, 160)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
