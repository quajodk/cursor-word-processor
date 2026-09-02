/**
 * Vite worker entry.
 *
 * A file of its own because Vite discovers workers by the `new Worker(new URL(...))` form and
 * needs a module it can name. The logic lives in `@scriv/lsp` so that the Tauri build can
 * reuse it without going through Vite at all.
 */
import "@scriv/lsp/src/worker";
