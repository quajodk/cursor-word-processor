# House-rules audit

Independent audit against the four house rules in `docs/ARCHITECTURE.md` §6. The auditor did
not build any of this. Every finding below is backed by a command that was run and its output.

Environment: darwin 25.5.0 arm64, Apple M1 Pro, bun 1.4.0, HEAD `bdcbec5`.
All probes were reverted; `git status` was clean at the end of the audit.

| Rule | Verdict |
|---|---|
| 1. TypeScript + React, bun | **PASS with a material gap** — the test suite is outside the typecheck graph |
| 2. No mocks, no hard-coded special cases | **VIOLATION** — no mocks or special-casing found, but the Markdown codec destroys content on real documents and the corpus tests are gated too loosely to notice |
| 3. Local-first, offline, pluggable AI | **PASS with a security defect** — nothing phones home; the local host server accepts cross-origin writes |
| 4. Keyboard-first, enforced latency gate | **VIOLATION** — 30 commands are absent from the palette, and the budget the rule names is never measured |

---

## Rule 1 — TypeScript + React, bun

**Confirmed good.** `bun.lock` is the only lockfile; no `package-lock.json`, `yarn.lock`,
`pnpm-lock.yaml` or `.npmrc` anywhere. `tsconfig.base.json` sets `strict: true` plus
`noUncheckedIndexedAccess`. Root `tsconfig.json` references all 12 workspace projects
(10 packages + 2 apps) — no package is outside the graph. `bun run typecheck` exits 0.

Escape hatches are low and concentrated: zero `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`
across all of `packages/*/src` and `apps/*/src`. `any`/`as any`/`as never`/`as unknown` totals
by package:

```
packages/md/src              34     apps/server/src               6
packages/perf/src             8     packages/ooxml/src            3
packages/lsp/src              2     everything else               0
```

`packages/md`'s 34 are at the mdast/remark boundary, which is genuinely weakly typed. Not
unsoundness hiding a bug — but see Rule 2: `packages/md` is both the least-typed package and
the one that owns the source-of-truth format.

### FINDING 1.1 — no test file in the repo is typechecked

Every project tsconfig is `"include": ["src"]`. All 15 test files live in `packages/*/test/`.
Proof — a deliberate type error inserted into a test file:

```
$ printf '\nconst __audit_probe: number = "definitely not a number";\n' >> packages/textops/test/ops.test.ts
$ bun run typecheck
$ tsc -b --pretty false
TYPECHECK EXIT=0
```

Exit 0. The same is true of `packages/textops/bench/`, `packages/ooxml/scripts/` and
`workbench/build.ts`. The brief's concern was a *package* escaping the references; that is
fixed. The *test tree* escaping is the same class of hole and is still open.

### FINDING 1.2 — nothing enforces the layering seam

`ARCHITECTURE.md` §1: *"The audit agent enforces this with a lint rule, not with good
intentions."* No such lint rule exists. There is no ESLint, Biome, or oxlint config in the
repo, and no test asserts on imports. The rule currently holds by good intentions only.

It is already bent: `packages/ooxml/src/bench/` and `packages/perf/src/` import `node:fs`,
call `Bun.spawnSync` (`bench/pandoc.ts`) and `fetch()` absolute URLs (`bench/discover-zenodo.ts`
→ `https://zenodo.org/api/records`). These are bench rigs and `packages/ooxml/src/index.ts`
does not re-export them, so nothing ships — but they sit inside `src/` alongside library code
where one stray import would bundle `node:fs` into the web app.

---

## Rule 2 — no mocks, no hard-coded special cases

**What is genuinely good, and verified:**

- The docx corpus is real. 288 files; provenance names `zenodo.org`, `www.archives.gov`,
  `*.uscourts.gov`, `cpo-general.illinois.gov`, `3gpp.org`, `irbo.nih.gov`. Nothing authored
  in-house.
- The tests run against all of it: `import: 288/288 files, 131862 blocks`,
  `xmlindex: 288/288 document.xml parsed`. `import.test.ts` asserts
  `expect(files.length).toBeGreaterThan(200)`, so an absent corpus fails rather than skips.
- `bun test` → **167 pass, 0 fail, 15 files, 282,334 expect() calls**. No test file failed to
  load; the file count matches the test tree exactly.
- No mocks, stubs, fakes or `if (someSpecificInput)` branches found anywhere in
  `packages/*/src` or `apps/*/src`. No hardcoded corpus filenames in library code.
- `packages/textops/src/data/locale-data.ts` is legitimate **data**: 16 lines, generated,
  CLDR 46.1 + pragmatic_segmenter, provenance and licences cited, and `segment.ts` never names
  a word. Correct call.
- `packages/perf` explicitly refuses to fake missing subsystems (`bench/slots.ts`).

### FINDING 2.1 (MOST SERIOUS) — the Markdown codec destroys content on real documents

Open a real `.md` and press ⌘S with **zero edits**. Reproduced end to end in the running app on
`corpus/md/repos/prettier__prettier__docs_index.md`:

```
before md5: 0a0e95f7023d9864cc8dbfdb5be0ebe4  2753 bytes
after  md5: 7148a20de7278f64af88c0620c6f8156  2684 bytes

< [![A Prettier Printer by James Long...](/images/....png)](https://www.youtube.com/watch?v=hkfBvpEfWdA)
> ![A Prettier Printer by James Long...](/images/....png)
```

The hyperlink is silently deleted. Isolated to the codec (`parseMarkdown` → `serializeMarkdown`,
no editor involved):

```
LOSS  linked image (badge / video thumbnail)
        in : "[![Build](https://img.shields.io/badge/x.svg)](https://ci.example.com/job/42)\n"
        out: "![Build](https://img.shields.io/badge/x.svg)\n"
LOSS  linked image inside a sentence
        in : "See [![logo](a.png)](https://example.com) for details.\n"
        out: "See&#x20;\n\n![logo](a.png)\n\n&#x20;for details.\n"
LOSS  emphasis spanning a link
        in : "_see [empty lines](x.md#a) and [objects](y.md#b)._\n"
        out: "_see&#x20;_[_empty lines_](x.md#a)_&#x20;and&#x20;_[_objects_](y.md#b)_._\n"
```

A linked image mid-sentence does not merely lose its link — it **splits one paragraph into
three**. Quantified over the project's own corpus:

```
corpus markdown files              : 1437
rewritten by a no-op open+save     : 902  (62.8%)
files that LOSE link targets       : 46   (3.2%)
total link targets destroyed       : 59
files gaining &#x20; entity soup   : 35
```

Casualties include `gohugoio/hugo` README, `helm/helm` CONTRIBUTING, `axios/axios` examples,
`kubernetes/kubernetes` CHANGELOG. `[![badge]](url)` is the single most common construct in
real-world Markdown.

**Why the suite is green:** `md/test/roundtrip.test.ts` gates on *idempotence*
(`serialize(parse(y)) === y`) with `expect(rate).toBeGreaterThan(50)`. The mangled output is
perfectly idempotent — pass two is stable — so the destruction is invisible to the assertion.
The measured rate is 96.19%; the bar is 50%. A collapse to 51% is still a green build.

This is a Rule 2 violation on its own terms: the feature does not work on arbitrary real
documents, and the test cannot see it.

### FINDING 2.2 — the docx fidelity headline is printed, not asserted

`splice-fidelity.test.ts` computes `formattingKept` — *"a one-word edit loses no run
formatting"*, the central claim of `DOCX-FIDELITY.md` — and only ever `console.log`s it. The
only assertion is `expect(unreported).toEqual([])`: a loss fails the test **only if the ledger
did not name it**.

Proof — one line changed in `packages/ooxml/src/export.ts` so the exporter silently discards
the stored `rPr` blob on every regenerated run:

```
-    return mergeRPr(blob ? blob.xml : null, wanted, wp);
+    return mergeRPr(null, wanted, wp);

$ bun test packages/ooxml/test/splice-fidelity.test.ts
[splice] T0 byte-identical: 60/60
[splice] T1 surgical: 59/59; run formatting fully preserved: 36/59
 3 pass  0 fail
BUNTEST_EXIT=0
```

39% of real Word documents now lose their bold, italic and font runs on a one-word edit, and
the build is green. (Reverted; `git diff` clean.)

T0 byte-identity *is* properly asserted (`expect(identical).toBe(n)`). It is the T1 formatting
half that is ungated.

Two smaller siblings of the same pattern in that file:
- Every failure path is `catch { continue; }` / `if (...) continue;` — a file that throws on
  import silently leaves the denominator instead of failing.
- With `corpus/docx` absent (it is gitignored) every test in the file returns early and passes
  vacuously. `import.test.ts` guards this; `splice-fidelity.test.ts` does not.

### FINDING 2.3 — T1 deliberately excludes the hard case

`packages/ooxml/src/bench/edit.ts`: *"The word must live inside a single text node: an edit
that spans a run boundary is a different (and harder) test."* Words spanning `<w:r>` boundaries
are extremely common in Word (rsid splits, proofing runs). The 59/59 headline is measured on
the subset that avoids the interesting problem. Disclosed in a comment rather than hidden, but
the headline number does not carry the caveat.

### FINDING 2.4 — T2 and the pandoc baseline are not gated at all

`DOCX-FIDELITY.md` §6 sets **T2 ≥ 0.98 weighted similarity** and a pandoc baseline as the
number to beat. Neither appears in any test — `grep "scoreT2\|0.98" --include="*.test.ts"`
returns nothing. They exist only in `bun run roundtrip`, which no gate runs.

### FINDING 2.5 — two thirds of the corpus provenance is gitignored

`.gitignore` says *"provenance manifests stay tracked"* but whitelists only
`corpus/docx/MANIFEST.json`, which covers 95 of 288 files. The other 183 are in
`PROVENANCE.bench.jsonl`, and `SEEDS.txt` holds the seed URLs — both gitignored. On a fresh
clone, 193 of 288 files have no committed provenance, which is exactly the evidence Rule 2
asks the project to keep.

---

## Rule 3 — local-first, offline, pluggable AI

**Confirmed good, empirically.** Started with keys explicitly unset and drove the real app:

```
$ bun run --cwd apps/server start -- --port 4399 --root /tmp/audit/root
scriv host  http://127.0.0.1:4399
  ai provider    : none  (no key set — offline; nothing will be sent anywhere)
```

Opened a 288-file-corpus `.docx` (8,222 words) and a `.md` in the browser. **Every network
request in the session was to `localhost:4311` or `127.0.0.1:4399`. Zero external hosts.**
Harper's WASM is inlined (`import { binaryInlined } from "harper.js/binaryInlined"`), not
downloaded. `index.html` loads no fonts, no CDN, no analytics. Diagnostics, completion, docx
import/export, search, git diff, multi-cursor all worked with no key set.

`apps/server/src/ai.ts` is a clean seam: provider selected by whichever of
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` is present, base URL overridable, `available()` is a
pure env lookup. Invoking ⌘K rewrite with no key produced **no `/api/ai/stream` request at
all** — silent on the wire, as documented.

Path containment holds:

```
fs.read /etc/passwd                                  -> refusing path outside workspace root
fs.read /tmp/audit/root/../../../etc/passwd          -> refusing path outside workspace root
/api/fs/read-binary {"path":"/etc/passwd"}           -> refusing path outside workspace root
```

### FINDING 3.1 (SECURITY) — any website can write to the workspace

`corsHeaders()` correctly withholds CORS headers from a non-localhost origin, so a hostile page
cannot *read* a response. But the handler still **executes** before that check, and a POST with
`Content-Type: text/plain` is a CORS-*simple* request — no preflight, so the browser sends it.
A write does not need the response.

```
$ curl -X POST http://127.0.0.1:4399/api/rpc \
    -H 'Origin: https://evil.example.com' \
    -H 'content-type: text/plain;charset=UTF-8' \
    -d '{"method":"fs.write","args":["/tmp/audit/root/PWNED.md","# written cross-origin\n"]}'
HTTP/1.1 200 OK
{"ok":true}

$ cat /tmp/audit/root/PWNED.md
# written cross-origin
```

`fs.write`, `fs.remove` and `fs.rename` are all reachable this way. Any tab the user has open
can overwrite or delete their entire workspace while scriv is running. No Origin check on the
request path, no CSRF token, no content-type requirement. (File removed after the probe.)

### FINDING 3.2 — the RPC boundary casts network input with `as never`

`apps/server/src/index.ts` guards strings with `str()` but passes options objects through
unvalidated:

```ts
"fs.list":     async ([dir, opts])          => await fs.list(str(dir), opts as never),
"search.text": async ([root, query, opts])  => await search.text(str(root), str(query), opts as never),
"search.files":async ([root, opts])         => await search.files(str(root), opts as never),
```

`opts.glob` reaches a ripgrep argv (argv-only, no shell — not injectable) and `opts.regex`
reaches `new RegExp(query)` in the walk fallback (ReDoS-able). Low severity on its own; it
becomes real in combination with 3.1.

---

## Rule 4 — keyboard-first, latency gate that fails the build

**The gate does fail.** Verified by regressing the keystroke path (a 12 ms busy-wait in
`aidPlugin`'s `apply`):

```
  FAIL     Keystroke → DOM commit (8 ms p99)
           ! p99 24.773 ms exceeds the 8 ms budget
  GATE: FAIL
PERF EXIT CODE = 1
```

Clean run: `GATE: pass`, exit 0. That half is real. (Reverted.)

### FINDING 4.1 — the budget the house rule names is never measured

`ARCHITECTURE.md` §5 row 2 is *"Keystroke → paint (end to end), 16 ms"*. `bun run perf` reports:

```
  n/a      Keystroke → paint, end to end (16 ms p99, one frame)
           ! no samples were collected
```

`n/a` is not a failure — `failed = checks.some(c => c.verdict === "fail")`. And the bench does
not merely fail to collect: `packages/perf/src/browser/e2e.ts` (the Playwright + CDP tracing
harness) is **imported by nothing**. `grep -rn "e2e\|benchPaint" packages/perf/src apps`
returns only comments. `run.ts` never sets `measurements["keystroke.to-paint"]`. The end-to-end
per-keystroke budget cannot pass or fail; it is dead code with a row in the report.

`probeSlots()` is likewise called in `run.ts` and its result assigned to an unused variable.

### FINDING 4.2 — the keystroke number is measured against a stack that is not the app

```
NOTE  apps/web/src/perf-plugins.ts does not exist. Measured against the baseline stack
      (aidPlugin + history) only. Every number below is a LOWER BOUND on the real editor.
```

The 8 ms budget is enforced against 2 of the app's ~15 plugins. Nothing in the real editor's
plugin stack — decorations, diagnostics, completion, multi-cursor, tables — is on the measured
path. The harness is honest about this in print; the gate is still blind to a regression in any
of it.

### FINDING 4.3 — two §5 budgets are marked "not implemented" for subsystems that ship

```
  n/a      Completion popup open (40 ms p99)      subsystem not built yet — reported, not gated
  n/a      Diagnostics refresh, debounced (150 ms p99)  subsystem not built yet — reported, not gated
```

Both are wired into the app: `apps/web/src/editor/workspace-symbols.ts` imports
`@scriv/intellisense`; `apps/web/src/editor/diagnostics.ts` imports `@scriv/lsp`. And the
diagnostics budget is being **missed by ~23×** — the running app's own status bar read
`830 suggestions · 3474 ms` on an 8k-word document against a 150 ms budget. Off the main
thread, so the editor stays responsive, but the number is not being watched by anything.

### FINDING 4.4 — the throughput budget flips verdict between identical runs

Two consecutive runs of unmodified code:

```
run 1:  docx import throughput  p99 1.559 ms vs budget 1.5 ms — OVER   (NOT GATED, 3 tail samples)
run 2:  docx import throughput  p99 1.470 ms vs budget 1.5 ms — under  PASS
```

`gate.ts` downgrades an under-supported breach to `partial` rather than failing — statistically
the right call, and reasoned in a comment. The consequence is that the throughput budget is
effectively ungated at n=227, and the code sits right on the line.

### FINDING 4.5 — 30 commands have no palette entry, contradicting the registry's own contract

`apps/web/src/commands/registry.ts`: *"there is exactly one place a feature can announce
itself, so this is it. The palette, the keymap and the menus are all views of the registry
rather than parallel lists that drift."*

`packages/textops/src/keymap.ts` exports `BINDINGS` as data specifically *"so the command
palette can render it."* Nothing consumes it:

```
$ grep -rn "BINDINGS" apps packages --exclude-dir=node_modules --exclude-dir=dist
packages/textops/src/index.ts:14:export { textopsKeymap, BINDINGS, ... } from "./keymap";
```

Re-exported and never imported. Confirmed in the running app — ⌘⇧P, type "cursor":
**"Nothing matches."** The 30 missing commands are every selection op, all five multi-cursor
commands, every sentence and paragraph motion, kill-line, kill-sentence, yank, yank-pop,
transpose, join, duplicate, move-paragraph and delete-word.

Also outside the registry and therefore outside the palette:

| Feature | Binding | Registered in |
|---|---|---|
| AI inline rewrite (the flagship) | ⌘K | `editor/inline-edit.ts` raw `handleKeyDown` |
| Accept / reject an AI edit | ⌘↩ / ⌘⌫ | same |
| Quick-fix at the caret | ⌘. | `editor/setup.ts` keymap |
| Changes pane (prose git) | ⌘⇧G | raw `window.addEventListener` in `App.tsx` |
| Hard break, table cell nav | ⇧↩, Tab | `editor/setup.ts` keymap |

⌘⇧G is a bare global `window` listener that `preventDefault()`s regardless of focus.

### FINDING 4.6 — two live macOS collisions the collision table missed

`keymap.ts` lists `Ctrl-ArrowLeft` and `Ctrl-ArrowRight` as `UNUSABLE_ON_MACOS` (move-a-space)
but binds the vertical pair from the same System Settings group:

| Key | Bound to | macOS default, ON out of the box |
|---|---|---|
| `Ctrl-ArrowUp` | `motion.paragraphBack` | **Mission Control** |
| `Ctrl-ArrowDown` | `motion.paragraphForward` | **Application windows** |
| `Mod-Alt-d` | `view.cycleTheme` | **⌘⌥D toggles the Dock**, system-wide |

Next/previous paragraph are dead on a stock Mac, and neither has a palette entry (4.5), so both
are unreachable. `Mod-.` (was superscript) and `Mod-Shift-k` (was ⌘K link) are correctly
resolved — those three earlier collisions are fixed.

Benign duplicates: `Mod-z` / `Mod-y` / `Mod-Shift-z` are registered twice, once in
`setup.ts`'s keymap and once in `defaults.ts`. Same commands, so harmless, but it is the drift
the registry doc warns about.

---

## Outside the four rules — blind-comparison risk

Ranked by how much damage each does in the rubric in `docs/BLIND-COMPARISON.md`.

1. **Every image in an imported .docx is broken.** `packages/ooxml/src/import.ts:608` sets
   `src` to the in-zip path. In the running app:
   ```
   {"src":"word/media/image2.png","resolved":"http://localhost:4311/word/media/image2.png","naturalW":0,"naturalH":0}
   ```
   `naturalWidth: 0`. The dev server's SPA fallback returns 200 so nothing errors; in a build it
   is a 404. Against Google Docs on "does the page look like a document", a broken image icon
   ends the comparison. Images need extracting from the zip to blob URLs.

2. **No comments UI at all.** `apps/web/src/app/` has no comments panel. The schema has the
   `comment` mark, the importer captures threads into the sidecar, and `import.test.ts` asserts
   >5 corpus files have them — but there is no way to read, reply to or resolve one. Blind-
   comparison task **step 5 is "reply to the existing comment thread and resolve it"**, which
   is currently impossible.

3. **No fidelity panel.** `DOCX-FIDELITY.md` §3: *"The ledger is surfaced in the UI (a
   'fidelity' panel)."* `grep -rn "ledger\|fidelity" --include="*.tsx" apps/web/src` returns
   nothing. The ledger is the subsystem's stated primary quality metric and the user cannot see
   it.

4. **⌘K produces no feedback with no key set.** Typing a rewrite and pressing ↩ did nothing
   visible — no error, no toast, no "no provider configured". The status bar says `ai: none`
   and `AiService.stream` yields a proper error chunk, so the message exists; it never reaches
   the user. Against Cursor on "is a suggested change reviewable", silence reads as broken.

5. **Harper flags 830 "suggestions" on an 8k-word document** (proper nouns like FAIR4RS,
   acronyms). Against Obsidian on "does the tool interrupt", a page of squiggles is worse than
   no diagnostics.

6. **`⌘A` in the command palette input does not select-all** — it appends to the query
   (observed: "cursor" + "rewrite" → "cursorrewrite"). Small, but it is a keyboard-first app
   and the palette is the front door.

7. **`ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5"`** in `apps/server/src/ai.ts` is not a model
   id the Anthropic API serves. First AI request with an Anthropic key and no `SCRIV_AI_MODEL`
   override will 404. Worth checking against current docs before any demo.

8. **`packages/perf/bench/out/perf.json` is tracked in git** and rewritten by every
   `bun run perf`, so running the gate dirties the working tree with machine-specific numbers.
   `.gitignore` has `bench/out/` but the file was committed before it applied.

---

## Reproduction

```bash
bun run typecheck                                    # exit 0
bun test                                             # 167 pass, 0 fail, 15 files
bun run perf                                         # GATE: pass, exit 0
bun run --cwd apps/server start -- --port 4399 --root <dir>
bun run --cwd apps/web vite --port 4311              # VITE_SCRIV_HOST=http://127.0.0.1:4399
```
