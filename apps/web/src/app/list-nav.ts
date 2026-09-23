/**
 * The app's list dialect — one set of keys for every list in the product.
 *
 * Five panels contain a list of things to pick from (the palette, the file tree, comments,
 * search results, agent sites) and before this module each of them invented its own keys. The
 * palette moved with `Ctrl-n`/`Ctrl-p` as well as arrows, comments moved with `j`/`k` as well
 * as arrows, the tree took arrows only, the agent list and the search results took nothing at
 * all and had to be reached with Tab. Every one of them was keyboard-reachable; the vocabulary
 * you learned in one was wrong in the next, which is house rule 4 satisfied per feature and
 * broken as a system.
 *
 * WHAT THE DIALECT IS, and why these keys and not the others:
 *
 *   ArrowDown / ArrowUp    move            work in every list, including the two that sit
 *   Ctrl-n  / Ctrl-p       move            under a text field — a control chord cannot be
 *                                          confused with typing
 *   Enter                  activate        what the list is for
 *   Escape                 dismiss         the app's one universal key (see Panel.tsx)
 *
 * Home and End are deliberately absent for the same reason `j`/`k` is: in the palette and the
 * search pane the caret is in a query field while the list is being navigated, and Home and
 * End belong to the field there. A dialect that is right in three lists and wrong in two is
 * the thing this module exists to stop.
 *
 * `j`/`k` is NOT in the dialect, and dropping it from the comments pane is a deliberate
 * removal rather than an oversight. A dialect is only worth having if it is the same
 * everywhere, and `j`/`k` cannot be: the palette and the search pane navigate while the caret
 * sits in their query field, where `j` has to mean the letter `j`. A vim key that works in one
 * of five lists is a fourth dialect wearing the costume of a convention.
 *
 * The decision function is pure and takes a plain object rather than a `KeyboardEvent`, so the
 * dialect can be tested as a table — `apps/web/test/list-nav.test.ts` — instead of by pressing
 * keys in a browser. These handlers live outside the command registry (a "next item" command
 * would advertise a global binding for something that only means anything while one particular
 * list has focus), so a table test is the only thing that can see them at all.
 */

export interface ListKey {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export interface ListState {
  /** Index of the active item, or -1 when the list has no active item yet. */
  index: number;
  count: number;
}

export type ListAction =
  /** Make `to` the active item. Already clamped into range; never emitted for an empty list. */
  | { kind: "move"; to: number }
  | { kind: "activate" }
  | { kind: "dismiss" };

/**
 * What a key means to a list, or null when the list should not claim it.
 *
 * Returning null matters as much as the rest: a list that swallows every key it is handed is
 * how ⌘S stops saving while the file tree has focus.
 */
export function listAction(event: ListKey, state: ListState): ListAction | null {
  if (event.metaKey || event.altKey) return null;

  const move = (delta: number): ListAction | null => {
    if (state.count === 0) return null;
    const from = state.index < 0 ? (delta > 0 ? -1 : state.count) : state.index;
    return { kind: "move", to: clamp(from + delta, state.count) };
  };

  switch (event.key) {
    case "ArrowDown":
      return event.ctrlKey ? null : move(1);
    case "ArrowUp":
      return event.ctrlKey ? null : move(-1);
    case "n":
      return event.ctrlKey ? move(1) : null;
    case "p":
      return event.ctrlKey ? move(-1) : null;
    case "Enter":
      return event.ctrlKey || event.shiftKey ? null : { kind: "activate" };
    case "Escape":
      return { kind: "dismiss" };
    default:
      return null;
  }
}

export interface ListHandlers extends ListState {
  onMove(to: number): void;
  onActivate?(): void;
  /** Where Escape goes. Every list has one: the document, or the surface that opened it. */
  onDismiss(): void;
}

/**
 * Apply the dialect to a React key event, and report whether the list claimed the key.
 *
 * Claiming is `preventDefault` + `stopPropagation`: the first stops the browser scrolling the
 * pane out from under the selection on an arrow, the second keeps a list key from also being
 * read as an editor key by anything upstream. A key the dialect does not define is left alone,
 * so a panel can layer its own verbs (the tree's Left/Right, the comments pane's `r`) on top
 * without fighting this.
 */
export function handleListKey(
  event: ListKey & { preventDefault(): void; stopPropagation(): void },
  handlers: ListHandlers,
): boolean {
  const action = listAction(event, { index: handlers.index, count: handlers.count });
  if (!action) return false;
  if (action.kind === "activate" && !handlers.onActivate) return false;

  if (action.kind === "move") handlers.onMove(action.to);
  else if (action.kind === "activate") handlers.onActivate!();
  else handlers.onDismiss();

  event.preventDefault();
  event.stopPropagation();
  return true;
}

function clamp(index: number, count: number): number {
  return Math.max(0, Math.min(count - 1, index));
}
