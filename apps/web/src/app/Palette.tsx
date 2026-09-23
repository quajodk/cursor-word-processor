import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { formatBinding } from "../commands/keys";
import { bindingsFor, currentContext, listCommands, type Command } from "../commands/registry";
import { relativeTo } from "../host";
import { fuzzyMatch, highlight } from "./fuzzy";
import { handleListKey } from "./list-nav";

/**
 * One overlay, three jobs: run a command, open a file, answer a question.
 *
 * The house rule is that every feature is in the palette with its binding. The palette is
 * therefore a *view* of the registry rather than a menu that has to be kept in step with it —
 * a command that exists is a command you can find, and one that has a binding shows it.
 *
 * It navigates in the app's list dialect (`list-nav.ts`) like every other list. The keys it
 * used to own privately — arrows plus `Ctrl-n`/`Ctrl-p` — are in fact the dialect, because
 * they are the only movement keys that can work in a list you navigate while typing into its
 * query field.
 */

export type PaletteMode =
  | { kind: "commands"; query: string }
  | { kind: "files"; files: string[]; root: string }
  | { kind: "input"; label: string; initial: string; resolve: (value: string | null) => void };

export interface PaletteProps {
  mode: PaletteMode;
  onClose: () => void;
}

interface Choice {
  key: string;
  title: string;
  detail?: string;
  binding?: string;
  positions: number[];
  score: number;
  run: () => void;
}

export function Palette({ mode, onClose }: PaletteProps) {
  const [query, setQuery] = useState(mode.kind === "commands" ? mode.query : mode.kind === "input" ? mode.initial : "");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const choices = useMemo<Choice[]>(() => {
    if (mode.kind === "input") return [];
    const trimmed = query.trim();

    if (mode.kind === "commands") {
      const ctx = currentContext();
      if (!ctx) return [];
      const out: Choice[] = [];
      for (const command of listCommands(ctx)) {
        const label = `${command.category ? command.category + ": " : ""}${command.title}`;
        const match = fuzzyMatch(label, trimmed);
        if (!match) continue;
        out.push({
          key: command.id,
          title: label,
          binding: bindingsFor(command.id)[0],
          positions: match.positions,
          score: match.score,
          run: () => void runCommandSafely(command),
        });
      }
      return out.sort((a, b) => b.score - a.score).slice(0, 200);
    }

    const out: Choice[] = [];
    for (const path of mode.files) {
      const label = relativeTo(mode.root, path);
      const match = fuzzyMatch(label, trimmed);
      if (!match) continue;
      out.push({
        key: path,
        title: label,
        positions: match.positions,
        score: match.score,
        run: () => void currentContext()?.ui.openFile(path),
      });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 200);
  }, [mode, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, choices]);

  const commit = () => {
    if (mode.kind === "input") {
      mode.resolve(query);
      onClose();
      return;
    }
    const choice = choices[active];
    onClose();
    choice?.run();
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    // The one-line input mode has no list to move through, but Enter and Escape still have to
    // mean confirm and cancel — so it declares a list of length zero and keeps the same keys.
    handleListKey(event, {
      index: active,
      count: mode.kind === "input" ? 0 : choices.length,
      onMove: setActive,
      onActivate: commit,
      onDismiss: () => {
        if (mode.kind === "input") mode.resolve(null);
        onClose();
      },
    });
  };

  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          if (mode.kind === "input") mode.resolve(null);
          onClose();
        }
      }}
    >
      <div className="palette" role="dialog" aria-modal="true">
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder={
            mode.kind === "commands"
              ? "Run a command…"
              : mode.kind === "files"
                ? "Open a file…"
                : mode.label
          }
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {mode.kind === "input" ? (
          <div className="palette-empty">Enter to confirm · Escape to cancel</div>
        ) : (
          <div className="palette-list" ref={listRef}>
            {choices.length === 0 ? <div className="palette-empty">Nothing matches.</div> : null}
            {choices.map((choice, index) => (
              <button
                key={choice.key}
                type="button"
                className="palette-item"
                data-active={index === active}
                onMouseMove={() => setActive(index)}
                onClick={() => {
                  onClose();
                  choice.run();
                }}
              >
                <span className="palette-title">
                  {highlight(choice.title, choice.positions).map((part, i) =>
                    part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
                  )}
                </span>
                {choice.binding ? <span className="palette-key">{formatBinding(choice.binding)}</span> : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function runCommandSafely(command: Command): void {
  const ctx = currentContext();
  if (!ctx) return;
  void Promise.resolve(command.run(ctx)).catch((err: unknown) => {
    ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
  });
}
