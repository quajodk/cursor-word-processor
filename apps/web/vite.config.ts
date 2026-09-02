import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Workspace packages are consumed as TypeScript source (`main: src/index.ts`), and bun installs
 * an isolated `node_modules` per package. Both `apps/web` and `@scriv/doc-model` therefore have
 * their own entry for prosemirror-model — and two copies of prosemirror-model means two `Schema`
 * classes, at which point every `instanceof` inside prosemirror-view fails in ways that look
 * like data corruption. `dedupe` collapses them onto one module instance.
 */
const PROSEMIRROR = [
  "prosemirror-model",
  "prosemirror-state",
  "prosemirror-view",
  "prosemirror-transform",
  "prosemirror-keymap",
  "prosemirror-commands",
  "prosemirror-history",
  "prosemirror-inputrules",
  "prosemirror-schema-list",
  "prosemirror-tables",
  "prosemirror-gapcursor",
  "prosemirror-dropcursor",
];

export default defineConfig({
  plugins: [react()],
  server: { port: 4310, strictPort: true },
  resolve: { dedupe: ["react", "react-dom", ...PROSEMIRROR] },
  build: { target: "es2022", sourcemap: true },
  worker: {
    /**
     * ES modules, not the IIFE default.
     *
     * The diagnostics worker loads Harper's WebAssembly through a dynamic import, which makes
     * it a code-splitting build, and Rollup cannot emit those as IIFE. Setting it here also
     * keeps the dev server and the production build on the same format.
     */
    format: "es",
  },
});
