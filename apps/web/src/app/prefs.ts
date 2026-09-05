/**
 * View preferences: theme, paragraph setting, justification, sidebar.
 *
 * Kept outside React for the same reason as the status store — commands mutate them from the
 * keyboard, and a command should not need a component reference to do its job. Persisted, so
 * that the tool a writer configured yesterday is the one they open today.
 */

export type Theme = "light" | "dark" | "system";
export type ParagraphStyle = "book" | "spaced";
export type Alignment = "ragged" | "justify";
export type SidebarPane = "files" | "search";
/**
 * The quietest diagnostic drawn in the text.
 *
 * "warning" by default, and the default is the whole point. Harper stands 1,741 diagnostics
 * on a 40k-word document, 660 of them style hints — "consider a shorter sentence", "this
 * word is a regionalism". Underlining all of them turns the page into a rash and trains the
 * writer to ignore every mark on it, including the misspellings. Word and Google Docs both
 * put style suggestions behind a separate mode for the same reason.
 *
 * Nothing is discarded: hints are still computed, still counted in the status bar, and
 * ⌥⌘I draws them. They just do not interrupt drafting by default.
 */
export type DiagnosticFloor = "hint" | "info" | "warning" | "error";

export interface Prefs {
  theme: Theme;
  paragraph: ParagraphStyle;
  alignment: Alignment;
  sidebar: boolean;
  pane: SidebarPane;
  diagnosticFloor: DiagnosticFloor;
}

const KEY = "scriv.prefs";
const THEME_KEY = "scriv.theme"; // read by the pre-paint script in index.html

const fallback: Prefs = {
  theme: "system",
  paragraph: "book",
  alignment: "ragged",
  sidebar: true,
  pane: "files",
  diagnosticFloor: "warning",
};

let state: Prefs = load();
const listeners = new Set<() => void>();

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    return fallback;
  }
}

export function getPrefs(): Prefs {
  return state;
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setPrefs(patch: Partial<Prefs>): void {
  const next = { ...state, ...patch };
  if ((Object.keys(next) as (keyof Prefs)[]).every((k) => next[k] === state[k])) return;
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    localStorage.setItem(THEME_KEY, state.theme);
  } catch {
    /* private browsing: preferences are a convenience, not a requirement */
  }
  applyTheme();
  for (const l of listeners) l();
}

/** Resolve `system` against the OS and stamp the result on <html> for the CSS to read. */
export function applyTheme(): void {
  const dark =
    state.theme === "dark" ||
    (state.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePref = state.theme;
}

export function watchSystemTheme(): () => void {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (state.theme === "system") {
      applyTheme();
      for (const l of listeners) l();
    }
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
