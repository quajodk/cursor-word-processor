# scriv — architecture

An IDE for writing. Markdown on disk is the source of truth; the editing surface is a real
word processor. Web app for v1, Tauri desktop for v2.

This document is the shared contract. Every package builds against it. If you need to break
something here, change this file first and say so.

---

## 0. Decisions already made (do not relitigate without evidence)

| Decision | Choice | Why |
|---|---|---|
| Editor engine | **ProseMirror**, used directly (no Tiptap) | Schema-based tree model matches OOXML's block/run shape. **Pure decorations** — style without mutating the doc — are load-bearing for AI diffs, diagnostic squiggles, blame gutters and comment highlights. Lexical and Quill lack them. Tiptap's auto-schema and extension indirection fight the custom keymaps and the docx mapping. |
| Runtime / PM | **bun** | House rule. |
| Language | **TypeScript + React** | House rule. React only for chrome (panels, trees, popups); the editing surface is ProseMirror's own DOM, never React-reconciled per keystroke. |
| Diagnostics | **harper.js** (Apache-2.0, WASM, offline) behind an LSP-shaped interface | Runs in a web worker in v1 and in-process in v2. No server, no network. |
| Markdown | **remark/mdast** (CommonMark + GFM) | Round-trips through a real AST, not regexes. |
| docx | **Splice-over-origin** (see `DOCX-FIDELITY.md`) | Never regenerate what we did not change. |
| Host access | **`@scriv/host-api` interface** | The only way any package touches disk, git or processes. Web impl = local bun server over HTTP/WS. Tauri impl = `invoke`. This is what keeps v2 from being a rewrite. |

## 1. The layering rule that keeps Tauri possible

```
┌──────────────────────────────────────────────────────────┐
│ apps/web  — React shell, ProseMirror view, keymaps        │  no fs, no git, no child_process
├──────────────────────────────────────────────────────────┤
│ packages/* — pure logic. Deterministic. Unit-testable.    │  no I/O at all
├──────────────────────────────────────────────────────────┤
│ @scriv/host-api — interface: fs, git, search, proc, ai    │  ← the seam
├──────────────────────────────────────────────────────────┤
│ apps/server (bun, v1)          │  src-tauri (rust, v2)    │
└──────────────────────────────────────────────────────────┘
```

**Hard rule:** nothing above the seam may import `node:fs`, `node:child_process`, or call
`fetch` at an absolute URL. If a package needs the disk, it takes a `HostApi` as a parameter.
The audit agent enforces this with a lint rule, not with good intentions.

## 2. Packages

| Package | Owns | Depends on |
|---|---|---|
| `@scriv/doc-model` | ProseMirror schema, node/mark definitions, block identity, the `DocHandle` | — |
| `@scriv/md` | mdast ⇄ doc-model. Markdown is the on-disk truth. | doc-model |
| `@scriv/ooxml` | docx import, fidelity sidecar, anchor engine, splice export, round-trip scoring | doc-model, md |
| `@scriv/textops` | Smart text ops: surrounds, multi-cursor, motions, transpose, join, kill-line | doc-model |
| `@scriv/intellisense` | Workspace symbol index + completion sources | doc-model, md |
| `@scriv/lsp` | Prose language server (worker) + JSON-RPC client. Harper + Vale-style + our own. | intellisense |
| `@scriv/ai` | Provider interface, streaming, Cmd-K inline edit, three-way merge, agent mode | doc-model, md |
| `@scriv/workspace` | File tree, fuzzy open, search, git status/diff/blame at sentence granularity | host-api |
| `@scriv/host-api` | The seam. Types only + web/tauri implementations. | — |
| `@scriv/perf` | Latency harness. Fails the build on regression. | — |

## 3. The document model

ProseMirror schema, deliberately close to OOXML's shape so the docx mapping is structural
rather than heuristic:

```
doc      = block+
block    = heading | paragraph | list | table | blockquote | code_block | figure | hr
paragraph= inline*   attrs: { aid, styleId?, pPrRef?, listRef? }
heading  = inline*   attrs: { aid, level, styleId?, pPrRef? }
table    = row+      attrs: { aid, tblPrRef? }         (prosemirror-tables)
marks    = strong | em | strike | code | link | underline | super | sub
           | rPrRef   ← carries unmodeled run formatting by reference
           | comment  ← anchor id, not content
           | insertion / deletion  ← tracked changes
```

Two attributes carry the whole fidelity story:

- **`aid`** — a stable block identity (8 hex chars). Assigned on import or first edit.
  Maintained *exactly* while the document is open by riding ProseMirror transaction position
  mapping. Never written into the Markdown.
- **`*Ref`** — an opaque key into the fidelity sidecar. The editor never interprets OOXML;
  it only carries the reference forward.

`marks` for comments and tracked changes hold **anchor ids only**. Content lives in the
sidecar. This is what lets a comment survive the writer rewording the sentence it points at.

## 4. Where truth lives

```
project/
  report.md                     ← SOURCE OF TRUTH. Plain. Hand-editable. Git-diffable.
  .scriv/
    report.md.fidelity.json     ← anchors, style refs, sectPr, comments, revisions
    origin/report.docx          ← the untouched original zip (content-addressed)
    index.db                    ← workspace symbol index (derived, disposable)
```

`report.md` alone is a complete, valid document. Delete `.scriv/` and you lose Word fidelity,
never text. That asymmetry is deliberate: the irreplaceable thing is plain and portable, the
recoverable thing is the cache.

## 5. Latency budget (enforced, not aspirational)

| Path | Budget (p99) | Test |
|---|---|---|
| Keystroke → DOM commit | **8 ms** | `perf/keystroke.bench` on a 40k-word doc |
| Keystroke → paint (end to end) | **16 ms** (one frame) | Playwright + CDP tracing |
| Completion popup open | **40 ms** | `perf/completion.bench` |
| Diagnostics refresh (debounced) | **150 ms**, off main thread | worker round-trip |
| Open 40k-word doc | **400 ms** | cold-load bench |
| docx import (50-page) | **1200 ms** | corpus bench |

Anything on the keystroke path that allocates per character, re-parses the document, or
touches React is a bug. Diagnostics, indexing and AI never run on the main thread.

## 6. House rules (audited before anything ships)

1. TypeScript + React. bun as runtime and package manager.
2. **No mocks, no hard-coded special cases.** Every feature works on arbitrary real documents.
   docx tests run against a corpus of real-world files collected from the wild — never fixtures
   we authored to make our own parser pass.
3. **Local-first.** Works fully offline. AI is pluggable behind one interface, keyed by env var.
   Nothing phones home by default; with no key set, every non-AI feature still works.
4. **Keyboard-first.** Every feature reachable without the mouse. Every command is in the command
   palette with a binding. A perf test fails the build when per-keystroke latency regresses.
