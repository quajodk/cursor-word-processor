/**
 * Keybinding parsing and matching.
 *
 * One notation for the whole app: `Mod-Shift-P`, `Mod-s`, `Alt-ArrowUp`. `Mod` is Cmd on
 * macOS and Ctrl elsewhere, which is the same convention prosemirror-keymap uses, so a
 * binding string can be handed to either side without translation.
 */

export interface ParsedKey {
  key: string; // normalised: lowercase for single characters, exact for named keys
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function parseBinding(binding: string): ParsedKey {
  const parts = binding.split("-");
  const key = parts.pop() ?? "";
  const parsed: ParsedKey = { key: normaliseKey(key), meta: false, ctrl: false, shift: false, alt: false };
  for (const raw of parts) {
    const part = raw.toLowerCase();
    if (part === "mod") {
      if (IS_MAC) parsed.meta = true;
      else parsed.ctrl = true;
    } else if (part === "cmd" || part === "meta") parsed.meta = true;
    else if (part === "ctrl" || part === "control") parsed.ctrl = true;
    else if (part === "shift") parsed.shift = true;
    else if (part === "alt" || part === "option") parsed.alt = true;
  }
  return parsed;
}

function normaliseKey(key: string): string {
  if (key.length === 1) return key.toLowerCase();
  return key;
}

export function matchesEvent(parsed: ParsedKey, event: KeyboardEvent): boolean {
  if (parsed.meta !== event.metaKey) return false;
  if (parsed.ctrl !== event.ctrlKey) return false;
  if (parsed.alt !== event.altKey) return false;
  if (parsed.shift !== event.shiftKey) return false;

  const eventKey = normaliseKey(event.key);
  if (eventKey === parsed.key) return true;

  // With Alt held, macOS rewrites `event.key` to the composed character (Alt-p → "π").
  // `event.code` still carries the physical key, so fall back to it for single characters.
  if (parsed.key.length === 1 && event.code === `Key${parsed.key.toUpperCase()}`) return true;
  if (parsed.key.length === 1 && /[0-9]/.test(parsed.key) && event.code === `Digit${parsed.key}`) return true;
  return false;
}

const SYMBOLS: Record<string, string> = {
  Mod: IS_MAC ? "⌘" : "Ctrl",
  Shift: "⇧",
  Alt: IS_MAC ? "⌥" : "Alt",
  Ctrl: IS_MAC ? "⌃" : "Ctrl",
  Enter: "↩",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backspace: "⌫",
  Escape: "Esc",
};

/** Human-readable form for the palette and tooltips. */
export function formatBinding(binding: string): string {
  const parts = binding.split("-");
  const key = parts.pop() ?? "";
  const mods = parts.map((p) => SYMBOLS[capitalise(p)] ?? capitalise(p));
  const label = SYMBOLS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return IS_MAC ? mods.join("") + label : [...mods, label].join("+");
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
