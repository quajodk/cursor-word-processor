import type { EditorView } from "prosemirror-view";
import type { HostApi } from "@scriv/host-api";
import { matchesEvent, parseBinding, type ParsedKey } from "./keys";

/**
 * The command registry.
 *
 * House rule: every feature is reachable from the keyboard and appears in the palette. That
 * only stays true if there is exactly one place a feature can announce itself, so this is it.
 * A feature registers a command; the palette, the keymap and the menus are all *views* of the
 * registry rather than parallel lists that drift.
 *
 * It lives in `apps/web` on purpose. `@scriv/host-api` is the I/O seam and knows nothing about
 * a UI; a registry of user-facing actions is app furniture, not part of the contract with the
 * host.
 */

/** What a command is allowed to touch. Anything not here is not a command's business. */
export interface CommandContext {
  readonly host: HostApi;
  /** The live ProseMirror view, or null before a document is open. */
  readonly view: EditorView | null;
  /** Absolute path of the open file, or null. */
  readonly filePath: string | null;
  readonly root: string;
  readonly ui: CommandUi;
}

export interface CommandUi {
  openPalette(initialQuery?: string): void;
  closePalette(): void;
  openQuickOpen(): void;
  focusEditor(): void;
  focusTree(): void;
  /** Put keyboard focus in the comments list, so threads are navigable without the mouse. */
  focusComments(): void;
  /** Show or hide the fidelity panel: what this document loses, and what a save would write. */
  toggleFidelity(): void;
  toggleSidebar(): void;
  setTheme(theme: "light" | "dark" | "system"): void;
  cycleTheme(): void;
  notify(message: string, tone?: "info" | "error"): void;
  openFile(path: string): Promise<void>;
  saveFile(): Promise<void>;
  newFile(): Promise<void>;
  reloadFromDisk(): Promise<void>;
  /**
   * Ask for one line of text, keyboard-only, in the same overlay as the palette. Resolves to
   * null when dismissed. A command that needs a filename or a URL uses this rather than
   * `window.prompt`, which steals focus from the document and cannot be styled or escaped
   * consistently across browsers.
   */
  prompt(label: string, initial?: string): Promise<string | null>;
  /** Expand the file tree to `path` and select it. */
  revealInTree(path: string): void;
}

export interface Command {
  /** Stable, namespaced: `editor.toggleBold`, `file.save`. */
  id: string;
  title: string;
  category?: string;
  /** `Mod-Shift-P` notation. Several bindings may map to the same command. */
  keybinding?: string | string[];
  /** Hidden from the palette when false. The binding is disabled too. */
  when?: (ctx: CommandContext) => boolean;
  /**
   * Fire even while the caret is in one of the app's own text fields.
   *
   * Off by default, and the default is the point. The dispatcher below runs in the CAPTURE
   * phase on `window`, so it sees every key before the field does — which meant ⌘⏎ in the
   * comment reply box ran "Exit code block" instead of posting the reply, and every ⌘B in
   * the search field toggled bold in the document behind it. A field's own handler is a
   * bubble-phase listener and never got a chance.
   *
   * Only commands that genuinely belong to the whole window opt in: the palette, save,
   * quick-open. An editing command has no business firing while someone types a filename.
   */
  whenTyping?: boolean;
  run: (ctx: CommandContext) => void | Promise<void>;
}

interface Registered extends Command {
  bindings: { source: string; parsed: ParsedKey }[];
}

const registry = new Map<string, Registered>();
const listeners = new Set<() => void>();
let contextProvider: (() => CommandContext) | null = null;

/**
 * Register a command. Returns an unregister function so features can be torn down cleanly.
 * Re-registering the same id replaces it — that is what makes hot module replacement survivable.
 */
export function registerCommand(command: Command): () => void {
  const bindings = toArray(command.keybinding).map((source) => ({ source, parsed: parseBinding(source) }));
  registry.set(command.id, { ...command, bindings });
  emit();
  return () => {
    if (registry.get(command.id)?.run === command.run) {
      registry.delete(command.id);
      emit();
    }
  };
}

export function registerCommands(commands: Command[]): () => void {
  const offs = commands.map(registerCommand);
  return () => offs.forEach((off) => off());
}

/** Every command, in registration order, filtered by its `when` guard. */
export function listCommands(ctx: CommandContext): Command[] {
  return [...registry.values()].filter((c) => !c.when || c.when(ctx));
}

export function getCommand(id: string): Command | undefined {
  return registry.get(id);
}

export function bindingsFor(id: string): string[] {
  return registry.get(id)?.bindings.map((b) => b.source) ?? [];
}

export async function runCommand(id: string, ctx?: CommandContext): Promise<void> {
  const command = registry.get(id);
  const context = ctx ?? currentContext();
  if (!command || !context) return;
  if (command.when && !command.when(context)) return;
  await command.run(context);
}

/** The app installs this once; commands then always see live state rather than a stale closure. */
export function setContextProvider(provider: (() => CommandContext) | null): void {
  contextProvider = provider;
}

export function currentContext(): CommandContext | null {
  return contextProvider ? contextProvider() : null;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const l of listeners) l();
}

function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * True when the event is being typed into one of the app's own fields.
 *
 * The ProseMirror editor is deliberately NOT one of them: editing commands are supposed to
 * fire there, that is the whole point of a single dispatcher. Everything else — the palette
 * input, the search field, a comment reply — belongs to its own component while it has focus.
 */
function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".ProseMirror")) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * The single global key handler.
 *
 * Every binding in the app resolves here, including the ones that fire while the caret is in
 * the editor — which is why ProseMirror's own keymap is left holding only the text-editing
 * primitives (Enter, Backspace, undo). One dispatcher means one place to reason about
 * precedence and no chance of a command that works in the tree but not in the editor.
 *
 * Later registrations win, so a feature can deliberately override a default binding.
 */
export function installKeyboard(target: Window = window): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const ctx = currentContext();
    if (!ctx) return;

    const typing = inTextField(event.target);
    const commands = [...registry.values()];
    for (let i = commands.length - 1; i >= 0; i--) {
      const command = commands[i]!;
      if (command.bindings.length === 0) continue;
      if (typing && !command.whenTyping) continue;
      if (command.when && !command.when(ctx)) continue;
      if (!command.bindings.some((b) => matchesEvent(b.parsed, event))) continue;
      event.preventDefault();
      event.stopPropagation();
      void Promise.resolve(command.run(ctx)).catch((err: unknown) => {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      });
      return;
    }
  };

  target.addEventListener("keydown", onKeyDown, { capture: true });
  return () => target.removeEventListener("keydown", onKeyDown, { capture: true } as EventListenerOptions);
}
