# scriv — COHERENCE PASS (wave reconciliation)

Agent: fresh-context coherence reviewer. Started 2026-09-07.
Mandate: "does this feel like ONE tool, or four good features in a trench coat?"
NOT a correctness audit. Findings are coherence failures, ranked by damage to the "one tool" feeling.

Every finding is tagged:
- **[OBSERVED]** — seen in the running app
- **[CODE]** — read in source
- **[NOT CHECKED]** — flagged as a gap in my own coverage

STATUS: **COMPLETE.** 22 findings + narrative + ranked summary. The app ran throughout; most
findings are OBSERVED live, several with controlled A/B tests and computed-style measurements.

---

## 00. Run log (append-only)

- Created this file as first action.
- Servers started OK via Browser pane: `scriv-server` on 4300, `scriv-web` on 4310. **The app runs.** Findings below marked [OBSERVED] are from the live app.
- Read `workbench/status.json` (wave 18). Recorded the known `gap` per subsystem so I do not re-report them as new.

### Known gaps already ledgered in status.json (NOT my findings)
| piece | known gap (abbrev) |
|---|---|
| foundation | anchors not exercised against a real .docx-derived doc |
| shell | **only the Markdown path is wired; opening a .docx in the app is not possible** |
| md | no-op save rewrites 64% of lines (escaping) |
| docx-in | moves that are also reworded are lost & ledgered; text boxes/content controls dropped |
| score | T2 entailed by T0 |
| perf | "off main thread" asserted structurally, not observed |
| textops | IME not multiplexed across cursors; no column selection |
| intel | Harper `Node.js` sentence-end cascade; no user dictionary |
| ai | no API key here, so live provider round trip unverified |
| git | moved+reworded sentence not recognised as a move; blame not tested multi-author |
| docx-out | NEW comments (vs replies) not written |
| comments | creating a new comment not built; CriticMarkup carries no author/thread/resolved |
| fidelity-panel | no jump-to-block from a ledger entry |
| agent | only the rename instruction is built |

---

## 01. Keyboard vocabulary: four list panels, three different navigation dialects

**[CODE]** `apps/web/src/commands/registry.ts` is genuinely good and is the reason this project
is *close* to coherent: one registry, one dispatcher, the palette and the keymap are *views* of
it. The seam is not there. The seam is that **every panel that contains a LIST re-implements
list navigation locally, and no two of them agree.**

| panel | file | next item | prev item | activate | dismiss |
|---|---|---|---|---|---|
| Command palette | `app/Palette.tsx:105` | `ArrowDown`, **`Ctrl-n`** | `ArrowUp`, **`Ctrl-p`** | `Enter` | `Escape` → close overlay |
| File tree | `app/FileTree.tsx:161` | `ArrowDown` | `ArrowUp` | `Enter` | **none — no `Escape` case at all** |
| Comments | `app/CommentsPane.tsx:80` | `ArrowDown`, **`j`** | `ArrowUp`, **`k`** | `Enter` | `Escape` → focus editor |
| Agent review list | `app/AgentPane.tsx` | **none** | **none** | **none** (checkbox + Tab) | `Escape` *only from the two input fields* |
| Diff / blame | `app/DiffPane.tsx:74` | **none** | **none** | **none** | `Escape` (see 02 — probably unreachable) |

Three dialects for "move down a list" in one product: emacs (`Ctrl-n/p`) in the palette, vim
(`j/k`) in comments, arrows-only in the tree. A writer who learns `j/k` in the comments pane
and tries it in the palette types the letter `j` into the query box. A writer who learns
`Ctrl-n` in the palette and tries it in comments gets nothing.

`CommentsPane.tsx:17` even argues, in a comment, that these keys are *deliberately* local and
not commands — which is a defensible call for `j/k`, but it is an argument each builder made
separately and answered differently. Nothing in the repo defines what the app's list dialect
IS. `apps/web/test/bindings.test.ts` tests the registry's bindings for *collisions*; these
five handlers are outside the registry, so no test sees them and no test could.

**Why it breaks coherence:** this is house rule 4 ("keyboard-first") satisfied per feature and
violated as a system. Each panel is individually keyboard-reachable; the vocabulary you learn
in one is wrong in the next.

**Rank: 1 (highest damage).** It is the thing a keyboard-first writer hits within the first
five minutes and keeps hitting.

---

## 02. Two panels are missing the exit that the rest of the app taught you

**[CODE]**
- `FileTree.tsx:167` — the `switch (event.key)` has no `Escape` case. Every other focusable
  surface in the app treats `Escape` as "give the document back". The tree is a dead end: once
  focus is in it (via `focusTree()`), `Escape` does nothing and there is no keyboard route back
  to the prose except re-running a command.
- `DiffPane.tsx:80` — `onKeyDown` is attached to a `<section>` that has **no `tabIndex`**. A
  bare `<section>` is not focusable, so the handler only fires if focus is already on a
  descendant. The pane's own close button is labelled **`esc`** (`DiffPane.tsx:88`), which
  *promises* the key works. **[NOT CHECKED YET — verify live.]**

**Why it breaks coherence:** `Escape` is the one key the app is otherwise consistent about.
Two of the panels quietly opt out, and one of them advertises the key on a button.

**Rank: 2.**

---

## 03. "Review a proposed change" has two incompatible shapes

**[CODE]** The same user intent — *the tool proposed an edit; decide whether it lands* —
is modelled twice, differently, by two builders:

- **AI inline edit** (`editor/inline-edit.ts`, `app/InlineEditBar.tsx`): a diff **over the live
  document**, resolved with accept/reject.
- **Agent mode** (`app/AgentPane.tsx`): a **checkbox multi-select** in a side panel. Sites are
  `accepted.has(siteKey(site))` — a *selection set* — then committed in bulk with an
  "Apply N changes" button. There is no reject; there is only "not ticked".

These are not the same gesture, the same widget, or the same mental model, and there is no
path between them: you cannot review an agent site in the document, and you cannot bulk-apply
an inline edit. A writer who has learned "the tool proposes, I accept or reject in place"
learns it again as "the tool proposes, I tick boxes in a panel".

**Rank: 3.** (See also 07 — the *word* for a change differs too.)

---

## 04. The git pillar is not in the command system at all — ⌘⇧G is a hand-rolled window listener

**[OBSERVED]** With the palette open I typed `diff` → **"Nothing matches."** I then dumped the
entire palette from the live DOM. The complete command list is:

```
File: Open file… ⌘P            File: Save ⌘S             File: Save as… ⌘⇧S
File: New file… ⌘N             View: Show all commands ⌘⇧P
View: Toggle sidebar ⌘\        View: Focus file tree ⌘⇧1  View: Focus editor ⌘⇧2
View: Search the workspace ⌘⇧F View: Cycle theme ⌘⌥Y      View: Show comments ⌘⇧M
AI: Agent: rename a term across the workspace ⌘⇧R
View: Fidelity: what this document loses ⌘⌥F
View: Show style hints as well as errors ⌘⌥I
View: Toggle paragraph style ⌘⌥P   View: Toggle justification ⌘⌥J
Document: Open the typographic specimen   Document: Close document
Assist: Accept AI suggestion ⌘↩    Assist: Reject AI suggestion ⌘⌫
Host: Report AI provider status    Host: Report the workspace root
```

**There is no diff, no blame, no git, no changes entry.** One of the four v1 pillars
("workspace/git with sentence-granularity diff and blame") has zero presence in the app's
discovery surface.

**[CODE]** `apps/web/src/app/App.tsx:126-134` is why:

```js
const onKey = (e: KeyboardEvent) => {
  if (e.key.toLowerCase() === "g" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    setShowDiff((v) => !v);
  }
};
window.addEventListener("keydown", onKey);
```

Every other feature in the app registers a `Command`. This one hand-rolls a listener in the
shell. That single deviation costs five separate coherence properties at once:

1. **Not in the palette** — `registry.ts` states the rule in its own header: *"there is exactly
   one place a feature can announce itself, so this is it… the palette, the keymap and the
   menus are all views of the registry rather than parallel lists that drift."* This is the
   drift, in the shell that owns the registry.
2. **Not in `apps/web/test/bindings.test.ts`** — that test reads `commands/defaults.ts` as
   source text with a regex. `⌘⇧G` is not in that file, so the collision check is structurally
   blind to it. The one binding outside the system is the one binding nothing can audit.
3. **Ignores `whenTyping`** — the registry deliberately refuses to fire editing commands while
   the caret is in a field (`inTextField`, and the long comment at `registry.ts` explaining
   that ⌘⏎ in the reply box used to run "Exit code block"). This listener has no such check, so
   ⌘⇧G toggles the diff pane while you are typing in the search box, the agent's term field, or
   a comment reply.
4. **Different phase** — the registry dispatches in the **capture** phase; this is a **bubble**
   phase listener on `window`. Two different precedence orders in one app.
5. **Different notation** — everything else is `"Mod-Shift-g"` parsed by `keys.ts`. This is a
   hand-written `metaKey || ctrlKey` test, so it fires on **both** ⌘⇧G and Ctrl⇧G on macOS,
   which no registry binding does.

**Why it breaks coherence:** the discovery surface is the app's promise that it is one tool.
A writer opens ⌘⇧P to ask "what can this thing do?" and is told, authoritatively and
completely, a list that omits a quarter of the product.

**Rank: 1 (tied highest).** Everything else is a dialect difference; this is a whole pillar
missing from the map.

---

## 05. The AI family has three names, and the palette shows them side by side

**[OBSERVED]** In the live palette, on adjacent lines:

```
AI:     Agent: rename a term across the workspace   ⌘⇧R
Assist: Accept AI suggestion                        ⌘↩
Assist: Reject AI suggestion                        ⌘⌫
```

Same feature family, rendered under **two different category headings** ("AI", "Assist"), with
a **third** word ("Agent") re-prefixed inside a title that already has a category prefix.
**[CODE]** the ids diverge the same way: `agent.rename` vs `ai.rewrite` / `ai.accept` /
`ai.reject`, and `defaults.ts:82 categoryFor()` only maps the textops prefixes, so everything
else's category is typed in by hand at each site.

Two more of the same shape, also observed on screen:
- `View: Fidelity: what this document loses` — category prefix plus an in-title prefix, so the
  row reads with two colons.
- `View:` is a junk drawer holding *Toggle sidebar*, *Focus file tree*, *Search the workspace*,
  *Cycle theme*, *Show comments*, *Fidelity*, *Show style hints*, *Toggle paragraph style*,
  *Toggle justification*. "Search the workspace" and "Toggle justification" are not the same
  kind of act; the comments panel and the fidelity panel are filed under View while the agent
  panel — the third panel, opened the same way — is filed under AI.

**Why it breaks coherence:** the palette is the one place the whole product is described in the
product's own words, and it is where the four builders' separate vocabularies are printed one
under the other.

**Rank: 4.**

---

## 06. `when` guards are applied inconsistently to the same feature's own commands

**[OBSERVED]** With **no document open at all**, the palette offers *"Assist: Accept AI
suggestion"* and *"Assist: Reject AI suggestion"*. It does not offer *"Rewrite selection with
AI…"*.

**[CODE]** `defaults.ts:401,409` guard accept/reject with `ctx.view !== null`; `ai.rewrite` and
`diagnostics.quickFix` use `inEditor` (`view !== null && view.hasFocus()`). Neither checks
whether a suggestion is actually pending — `inline-edit.ts` knows that, and nothing asks it.
So the command that *creates* a suggestion is correctly hidden, while the two commands that
act on a suggestion that cannot exist are offered by name.

The palette's list is the app telling the writer what is possible right now. Offering "Accept
AI suggestion" on a blank screen is the app being wrong about itself.

**Rank: 6.**

---

## 07. `workbench/status.json` is stale about the single biggest capability

**[OBSERVED]** `status.json` records, as the `shell` piece's known gap:

> *"Only the Markdown path is wired. **Opening a .docx in the app is not possible yet**, so the
> document-polish comparison against Google Docs cannot be run."*

I opened `sandbox/des-wa-gov__RFI-Template.docx` from the file tree and **it rendered fully** —
476 words, the status bar switched its format pill to `docx`, diagnostics ran over it
("14 suggestions · 5 muted · 1140 ms"), and the fidelity ledger is populated (see §11).

**Why it breaks coherence:** `status.json` is described to incoming agents as *"the last lists
every subsystem with its evidence and its known gap"* — it is the project's shared map. When
the map says a pillar is unbuilt and the pillar is built, every subsequent reader plans around
a constraint that no longer exists. It is the same failure mode as §04 in a different register:
a second source of truth that has drifted from the first.

Related and unverified: the `foundation` gap ("anchors not yet exercised against a real
.docx-derived document") may be stale for the same reason. **[NOT CHECKED]**

**Rank: 5.**

---

## 08. "Suggestion" means two unrelated things, in two places at once

**[OBSERVED]** With the .docx open, the status bar's left segment reads:

> `14 suggestions · 5 muted · 1140 ms`

Those are **Harper diagnostics**. Meanwhile the command palette offers:

> `Assist: Accept AI suggestion  ⌘↩`
> `Assist: Reject AI suggestion  ⌘⌫`

Those are an **AI inline edit**. And a third: `diagnostics.quickFix` is titled *"Apply
suggestion at cursor"* (⌘.) — a diagnostic again, but with the *verb* ("apply") that the AI
side spells "accept".

So in one product, on one screen:
- a diagnostic is a **suggestion** (status bar) and a **style hint** (palette: *"Show style
  hints as well as errors"*, ⌘⌥I) and something you **apply** (⌘.);
- an AI rewrite is also a **suggestion**, but one you **accept** or **reject** (⌘⏎ / ⌘⌫);
- an agent-mode site is neither — it is a **site** you **tick** and then **apply** in bulk (§03).

**[CODE]** confirms the split is in the source, not just the labels: `id: "diagnostics.quickFix",
title: "Apply suggestion at cursor"` and `id: "ai.accept", title: "Accept AI suggestion"` sit
eleven lines apart in `commands/defaults.ts` under the same category, `Assist`.

**Why it breaks coherence:** a writer reading "14 suggestions" in the status bar and then
pressing ⌘⏎ ("Accept AI suggestion") is pressing what looks like the obvious key for the thing
the status bar just counted. It is not. This is the clearest case of two builders naming the
same word differently and nobody reconciling it.

**Rank: 3 (tied with §03 — they are the same wound: "a proposed change" has no single name or
shape).**

---

## 09. Two competing tracked-changes stylesheets both landed; the document renders a hybrid of neither

**[OBSERVED, in the browser, by computing styles on live elements]** `apps/web/src/styles/document.css`
contains **two separate blocks** styling the same three classes, written by two different hands:

- **Block A**, `document.css:375-394`, selectors `.ProseMirror .scriv-ins` / `.scriv-del` / `.scriv-ins-ai`
  — coloured *text* plus underline/strikethrough, using `var(--ok)` and `var(--danger)`.
- **Block B**, `document.css:540-556`, selectors `ins.scriv-ins` / `del.scriv-del` / `ins.scriv-ins-ai`
  — coloured *backgrounds*, explicitly `text-decoration: none`, using `var(--good)`, `var(--accent)`
  and `var(--link)`.

Block B carries the design rationale in a comment:

> *"One appearance for an AI suggestion and a colleague's revision, because they are the same
> thing in the document. Origin only changes the hue, so a reader can tell at a glance who
> proposed a change without learning a second visual language for it."*

That is the right idea. It does not happen. I created `<ins>`/`<del>` elements inside the live
`.ProseMirror` and read `getComputedStyle`:

| element | computed result | what actually won |
|---|---|---|
| `<ins class="scriv-ins">` | colour `rgb(77,112,72)`, underline, **background transparent, box-shadow none** | Block A wins on colour; **Block B's background is silently dropped** |
| `<del class="scriv-del">` | colour `rgb(156,74,60)` (red, Block A) **on** `srgb 0.29/0.40/0.52 @ 0.12` (blue, Block B) | **both** — red text on a blue wash |
| `<ins class="scriv-ins scriv-ins-ai">` | background `oklab` **green** (Block A) + inset box-shadow `srgb 0.184/0.333/0.451` = **blue** `#2f5573` (Block B) | **a green highlight with a blue underline** |

Two independent causes:

1. **Specificity.** `.ProseMirror .scriv-ins-ai` is (0,2,0); `ins.scriv-ins-ai` is (0,1,1). Block A
   wins every head-to-head inside the editor, so Block B only shows through on the properties
   Block A does not set — which is why the AI insertion ends up green-with-blue-underline, the
   colour scheme of neither author.
2. **Undefined variables.** I read the custom properties off `:root` in the live page:
   `--ok`, `--danger`, `--accent`, `--link`, `--mark` all resolve. **`--good` and `--warn` are
   defined nowhere in `app.css`.** `ins.scriv-ins { background: color-mix(in srgb, var(--good) 16%, transparent) }`
   has no fallback, so `color-mix()` is invalid at computed-value time and the whole declaration
   is discarded. Block B's central claim — that a revision reads as a highlight — never renders
   at all.

**The same undefined variable is patched with two different fallbacks by two different files:**
`document.css:569` uses `var(--warn, #B8862C)` for the diagnostic squiggle; `app.css:761` and
`:774` use `var(--warn, #D3A03A)` for the inline-edit bar's conflict border. The app therefore
has two "warning" colours, and neither is a token — they are two guesses at a token that does
not exist.

**And origin does not change the hue after all.** `packages/doc-model/src/schema.ts:200,206`
emits `scriv-ins-${origin}` / `scriv-del-${origin}` where origin is `"user" | "ai"`. Only
`.scriv-ins-ai` has any CSS. `scriv-ins-user`, `scriv-del-user` and `scriv-del-ai` are styled
**nowhere**, so a Word tracked insertion is visually identical to an AI one, and an AI deletion
is visually identical to a colleague's.

**Worth crediting:** the *model* layer got this exactly right. `schema.ts:191` — *"Tracked
changes. Deliberately shared with AI suggestions: 'accept this AI rewrite' and 'accept this
colleague's tracked change' are one code path."* The unification exists in the data model and
is then broken twice above it: once in CSS (here) and once in agent mode (§03).

**Why it breaks coherence:** "a change" is the single most load-bearing concept in this
product — four features produce one — and its *appearance* is the arbitration of two
half-dead stylesheets. This is the most literal possible instance of "four good features in a
trench coat": both coats are on, and you can see both.

**Rank: 2 (tied with §02) — and it is the single most fixable high-value item here.**

---

## 10. Opening the comments pane scrolls the entire application chrome off screen

**[OBSERVED — reproducible]** Open `sandbox/des-wa-gov__RFI-Template.docx` (which carries real
Word comment threads), then press ⌘⇧M. The comments pane fills the sidebar and **the
FILES/SEARCH/COMMENTS tab strip and the whole status bar leave the window.** They are not
hidden — the window itself has scrolled, and the chrome is above and below the fold.

Measured in the live page while it was in that state:

```
window.innerHeight  486      window.scrollY      69
body   height 486px, overflow hidden   body.scrollHeight  1531
html   overflow: visible                     ← so the document element scrolls
.app        height 486px  min-height 0     overflow visible   scrollHeight 1531
aside.sidebar  height 1507px  min-height: auto ← the blowout
.comments      height 1469px  min-height 0
.comments-list height 1438px  overflow-y: auto  scrollHeight 1438  ← never scrolls
main           height 1507px
[role=tablist] rect.top  = -69      (above the viewport)
footer/status  rect.top  = +1437.5  (≈1000px below the fold)
```

The cause is exact and is a seam, not a bug in any one component. `.comments-list` **does**
declare `overflow-y: auto` — the comments builder wrote a proper scroll container. It never
scrolls because nothing above it constrains its height: `aside.sidebar` is a grid item left at
the default **`min-height: auto`**, so it refuses to shrink below its content and grows to
1507px inside a 486px shell. `.app` and `.comments` both carry `min-height: 0` — **somebody
already knew about this exact CSS-grid failure and fixed it in the shell and in the comments
component, and missed the one element in between, which belongs to neither**.

Recovery: ⌘⇧1 (focus file tree) switches the pane back to Files and everything snaps back —
`scrollY` returns to 0, sidebar to 462px, chrome visible. But the tab strip is off-screen while
you are stuck, so a mouse user's only route out is to scroll the window.

**Why it breaks coherence:** an IDE's chrome is its frame of reference. This is the most
visceral "these are separate apps" moment in the product: use the comments feature and the rest
of the tool physically leaves.

**Rank: 2 (tied) — worst *observed* single-interaction failure.**

---

## 02 — CONFIRMED LIVE (was [CODE], now [OBSERVED])

With focus in the file tree (`document.activeElement.className === "sidebar-body"`), I pressed
`Escape` and re-read `document.activeElement`: **still `sidebar-body`**, and
`.ProseMirror.contains(activeElement)` was `false`. The tree is a keyboard dead end exactly as
the source predicted. The comments pane, the palette, the agent pane and the inline-edit bar all
treat Escape as "give the document back"; the tree does not.

---

## 11. Four severity ladders, four different labelling strategies, and "info" means two things

**[OBSERVED + CODE]** Every one of the four features grades its output, and no two grade it the
same way or label it in the same register.

| feature | internal values | what the UI prints |
|---|---|---|
| Fidelity ledger | `dropped` / `degraded` / `info` | full sentences: *"Will not survive a round trip"*, *"Shown less faithfully than Word shows it"* (`FidelityPane.tsx:35`) |
| Sentence diff | `unchanged` `reworded` `moved` `moved-and-reworded` `split` `merged` `inserted` `deleted` | single lowercase words, **two renamed**: `inserted`→"added", `deleted`→"removed" (`DiffPane.tsx:24`) |
| Agent sites | `exact` / `variant` / `uncertain` | single lowercase words, **one renamed**: `uncertain`→"check" (`AgentPane.tsx:34`) |
| Diagnostics | `error` / `warning` / `info` / `hint` | plural nouns in the status bar: *"14 suggestions · 5 muted"* |

- **`info` appears in two ladders meaning different things** — a fidelity note you can ignore,
  and a Harper diagnostic severity.
- Fidelity speaks in sentences; diff and agent speak in single words; diagnostics speaks in
  counts. Reading all four in one session is reading four house styles.
- **[OBSERVED]** the fidelity pane prints the machine code to the user: I read its live text and
  it says `numbering-unlabelled  ×3`. The diff pane, by contrast, has a `KIND_LABEL` map
  precisely so its enum never reaches the screen. One panel humanises its vocabulary and the
  one next to it does not.
- The diff pane renames `inserted`/`deleted` to "added"/"removed" while the document model calls
  the same thing `insertion`/`deletion` (`doc-model/src/schema.ts:196,203`) and the CSS calls it
  `scriv-ins`/`scriv-del`. Three names for one concept between the model and the panel that
  displays it.

**Rank: 7.**

---

## 12. WHAT IS ALREADY RIGHT — and is the model the rest should copy

Coherence findings are worth more when it is clear the project can already do this, so:

- **`apps/web/src/commands/registry.ts`** is a genuinely single seam: one registry, one capture
  phase dispatcher, palette and keymap as *views*. Its header states the rule correctly and the
  `whenTyping` doc comment shows the collision reasoning was actually done. Everything in §01
  and §04 is a *deviation from this file*, not an absence of a design.
- **`apps/web/src/editor/comments.ts:10`** — *"Two sources, one shape. A `.docx` carries real
  threads… A `.md` carries CriticMarkup… this reports what each source can actually hold."*
  A `Thread` has `canReply` / `canResolve` / `limitation`, and the panel disables the buttons
  and **says why** rather than pretending. **[OBSERVED]** on the real .docx the pane shows
  author + date + Reply/Resolve per thread and reads as one feature. This is exactly the
  reconciliation the other seams need: one shape, capability flags, an honest limitation string.
- **`packages/doc-model/src/schema.ts:191`** — *"Tracked changes. Deliberately shared with AI
  suggestions: 'accept this AI rewrite' and 'accept this colleague's tracked change' are one
  code path."* The unification exists **in the model**. §03 and §09 are both cases of a layer
  above the model re-splitting what the model had already joined.
- The `defaults.ts` binding comments (`Mod-Alt-y` not `Mod-Alt-t`; `Mod-Shift-m` not
  `Mod-Shift-c`) show a real audit happened and its reasoning was written down where the next
  person will read it.

The conclusion this points to: **scriv is not four features in a trench coat at the model
layer. It is one tool whose presentation layer was built four times.** Every finding above
except §01 and §04 lives in `apps/web/src/app/*.tsx` or `styles/*.css`.

---

## 13. On a .docx — the format the product exists for — the git pane is a silent empty box

**[OBSERVED]** With `sandbox/des-wa-gov__RFI-Template.docx` open (a **git-tracked** file:
`git ls-files sandbox` lists it, `git check-ignore` says it is not ignored), I pressed ⌘⇧G and
read the pane's live text. In full, it is:

```
Changes
Blame
esc
```

No rows, no blame, **and no explanation**. The pane renders its chrome and nothing else.

**[CODE]** the cause: `DiffPane` receives `currentText={() => controller.currentText()}`
(`App.tsx:389`), and `EditorController.currentText()` (`controller.ts:96`) opens with

```ts
if (!this.view || this.codec.binary) return null;
```

So for any binary codec — i.e. every `.docx` — `text` is `null`, `diff` stays `null`, `blame`
stays `null`, and `status` stays `""` because the file *is* tracked so none of the three
status branches fire.

What makes this a coherence failure rather than a missing feature is that **`DiffPane` is
otherwise unusually good at explaining itself.** It has carefully written copy for every other
dead end:

- *"This folder is not a git repository."*
- *"This file is not yet tracked by git."*
- *"No changes against HEAD. Reflowing or rewrapping is not a change."*

Three hand-written explanations for three states the git builder anticipated — and silence for
the one state that arises the moment the git feature meets the docx feature. The two builders
never met, so neither wrote the fourth string.

Compare `editor/comments.ts`, which handles the exact same shape of problem correctly: when
the source cannot carry a capability it sets a `limitation` and the panel prints it (§12).
The pattern for this already exists in the codebase, one directory away.

**Why it breaks coherence:** two of the four v1 pillars produce nothing when combined, and the
tool does not admit it. A writer reasonably concludes their .docx has no changes against HEAD.

**Rank: 1 (tied highest with §04).** It is the clearest case of features that do not compose,
on the exact pairing the product's premise makes central.

---

## 14. Three panels open in the same slot with three focus policies and two words for "close"

**[OBSERVED]** With the fidelity pane already open I pressed ⌘⇧G. Both panels opened and
**stacked in the main column** — measured live:

```
main children: DIV.doc-scroll · SECTION.fidelity · SECTION.scriv-diff
.fidelity   rect top 187  height 219   position: static  tabIndex -1
.scriv-diff rect top 406  height  57   position: static  tabIndex -1
window.innerHeight 486
```

The document is compressed to a 187px sliver showing only its running head. Neither panel is a
dialog in layout terms (`position: static`) though both carry `role="dialog"`
(`FidelityPane.tsx:128`, `AgentPane.tsx:122`). Nothing arbitrates how many may be open at once.

**Three different focus policies for three panels in the same slot:**

| panel | takes focus on open? |
|---|---|
| Fidelity | **yes** — `App.tsx:210` `requestAnimationFrame(() => focusIn(".fidelity"))` |
| Agent | **yes** — `App.tsx:214`, same pattern |
| Diff | **no** — `App.tsx:130` is a bare `setShowDiff(v => !v)` (see §04) |

Confirmed live: after ⌘⇧G opened the diff pane, `document.activeElement` was still the
fidelity pane's Close button, and `.scriv-diff.contains(activeElement)` was `false`.

The comment at `App.tsx:205` states the policy and its reasoning — *"Both panels take keyboard
focus when they open… Flipping the boolean alone left focus in the document… which is
'reachable' in the sense that a filing cabinet in another building is reachable."* It says
**"both panels"**, because when it was written there were two. The third panel, added outside
the command system, is exactly the filing cabinet that comment warns about.

**Two words for "close", visible on screen simultaneously:**
- fidelity's header button reads **`Close`**
- diff's header button reads **`esc`**

I pressed `Escape`. **Nothing closed.** Both panels stayed open, focus stayed on the fidelity
Close button. So:

- The panel labelled **`esc`** has an `Escape` handler (`DiffPane.tsx:74`) on a `<section>` with
  `tabIndex: -1` (measured) — it can never receive focus, so the handler can never fire. It
  advertises the key that does not work.
- The panel labelled **`Close`** has **no keyboard handling at all** — `FidelityPane.tsx`
  contains no `key` handling of any kind.

**The full Escape ledger across the app:**

| surface | Escape |
|---|---|
| Command palette | closes ✓ |
| Comments pane | returns focus to the document ✓ |
| Inline edit bar | dismisses ✓ |
| Agent pane | closes — **but only while the caret is in one of its two input fields** |
| File tree | **nothing** (§02, confirmed live) |
| Fidelity pane | **nothing** — no handler exists |
| Diff pane | **nothing** — handler exists but is unreachable; button says `esc` |

Four surfaces honour the app's most universal key; three do not, and one of the three prints it
on a button.

**Rank: 2.**

---

## 15. Two keyboard systems race, the window always wins, and four in-editor handlers are dead code

**This is the deepest seam in the app and the root cause of several findings above.**

There are **two** keyboard systems:

- **A** — `commands/registry.ts installKeyboard()`: a `keydown` listener on `window` in the
  **capture** phase. On a match it calls `event.preventDefault(); event.stopPropagation();`
  **before** running the command, unconditionally, whether or not the command does anything.
- **B** — ProseMirror's plugin stack (`editor/setup.ts`), whose `handleKeyDown` props run on the
  contenteditable element during **bubbling** — i.e. always *after* A.

Capture-on-window beats every DOM handler in the document. So **any key that exists in both
systems is owned by A, and B's handler for it can never run.** `setup.ts` is nonetheless
written as if B's *internal ordering* decides these keys, and carries three comments saying so.

**[OBSERVED — the decisive test.]** In `sandbox/report.md` I typed `[[`, which opened the
completion popup (10 real workspace headings — `Method`, `Findings`, `Coastal Erosion
Monitoring`, …, height 272px, `display: block`). Then:

| key | `defaultPrevented` at a window capture listener | result |
|---|---|---|
| `ArrowDown` | **false** — not a registry binding | reached ProseMirror; selection moved to the next item ✓ |
| `Escape` | **true** — matched `cursor.clear` | **popup stayed open**: `display block / visibility visible / height 272` |
| `⌘Enter` | **true** — matched `ai.accept` | popup stayed open; `keymap({"Mod-Enter": exitCode})` never ran |

`completion.ts:107` contains `case "Escape": … {kind:"close"} … return true`. It is unreachable.
**The completion popup cannot be dismissed with Escape.**

Why Escape is in system A at all: `packages/textops/src/keymap.ts` exports
`{ key: "Escape", id: "cursor.clear", label: "Collapse to one cursor" }` in `BINDINGS`, and
`defaults.ts textOpCommands()` turns *every* entry in `BINDINGS` into a registered command with
`when: inEditor`. So Escape became a global binding as a side effect of the (good) decision to
derive the palette from the binding table. Nobody chose it.

**Four handlers inside the editor are dead as a result:**

| file | handler | shadowed by | consequence |
|---|---|---|---|
| `completion.ts:107` | `Escape` closes the popup | `cursor.clear` | popup un-dismissable by Escape — **observed** |
| `inline-edit.ts:120` | `Escape` rejects a pending AI edit | `cursor.clear` | Escape collapses cursors instead of rejecting the edit |
| `inline-edit.ts:117-119` | `⌘Enter` accept / `⌘Backspace` reject | `ai.accept` / `ai.reject` | harmless — the registry does the same thing |
| `inline-edit.ts:106` | `⌘K` opens the prompt | `ai.rewrite` (`defaults.ts:383`) | **two full implementations of ⌘K**; the plugin's is dead |

The `⌘K` case is the sharpest, because the plugin states the opposite in a comment:

> `inline-edit.ts:104` — *"Mod-K opens the prompt. Bound here rather than on the window **so it
> beats the command keymap deterministically instead of racing it through event bubbling**."*

It does not beat the command keymap. The command keymap is a capture-phase window listener, so
it wins every time; and `defaults.ts:379-394` re-implements the identical `setMeta(inlineEditKey,
{kind:"prompt", …})` dispatch. Two builders solved the same problem in two places, each believing
theirs was the one that ran.

And `setup.ts`'s three ordering comments — *"before the base keymap so **Escape collapses
cursors**"*, *"while a suggestion is under review, **Cmd-Enter and Escape belong to the
review**"*, *"while the popup is open, **Up/Down/Enter belong to the list**"* — assert three
different owners for Escape. Only the first is true, and it is true for a reason none of them
gives: the window listener, not the plugin order.

This is also the mirror image of the bug `registry.ts` already documents fixing — *"⌘⏎ in the
comment reply box ran 'Exit code block'… A field's own handler is a bubble-phase listener and
never got a chance."* The `whenTyping` flag fixed that for the app's `<input>`s. **The editor
itself was never given the same escape hatch**, so it has the identical problem, one layer in.

**Why it breaks coherence:** this is what makes the difference between "one tool" and "four
features" *mechanical* rather than aesthetic. Three of the four pillars put a modal surface
inside the editor (multi-cursor, the completion popup, the AI review), all three reach for
Escape, and the arbitration is an accident of which one also happened to be in a binding table.

**Rank: 1 (tied highest, and the root cause of §01's fragmentation).**

---

## 16. A search hit is the only "position in a document" the app cannot navigate to

**[OBSERVED]** ⌘⇧F, searched `Instrumentation`, got 4 hits rendered **with their line numbers**:

```
7  | * end-to-end input latency instrumentation: begins when the browse…
15 | ### Instrumentation
18 | ### Instrumentation
6  | ## Instrumentation
```

I clicked the hit labelled **line 15**. Measured immediately after:

```
doc-scroll scrollTop : 0
caret (status bar)   : ¶1:4          ← block 1, column 4
search decorations in the document : 0
```

The file opened **at the top**. The line number the panel just showed me was discarded.

**[CODE]** `SearchPane` is written to deliver it — its prop is
`onOpen: (path: string, line: number) => void` and it calls `onOpen(hit.path, hit.line)`
(`SearchPane.tsx:82`). The shell throws the argument away:

```tsx
// App.tsx:349-354
<SearchPane root={root} onOpen={(path) => { void ui.openFile(path); }} />
```

The search builder passed the line; the shell builder's callback takes one parameter.

Two further gaps in the same seam:

- **A search hit is not a decoration.** `pm.querySelectorAll('[class*=hit],[class*=search]')`
  returns 0, and there is no `Decoration` anywhere in `SearchPane.tsx` or the editor plugins for
  it. The brief asks whether a diagnostic, an AI suggestion and a search hit compose as
  decorations over the same text. They cannot: **two of the three are decorations and the third
  never enters the document at all.** The concept stops at the panel boundary.
- **The search results list is the fifth list panel and has a fourth navigation dialect: none.**
  Results are `<button>`s reachable only by Tab. No arrows, no `j/k`, no `Ctrl-n`, no Escape.
  Add it to the §01 table.

Also observed: after clicking a hit, `document.activeElement` stayed `search-field`. Opening a
document from search does not return you to the document.

**Rank: 4.**

---

## 17. The status bar has two unlabelled millisecond readouts and one free-text slot

**[OBSERVED]** the live status bar on `sandbox/report.md`, read as text:

```
● · sandbox/report.md · 1 suggestion · 15 ms · 145 words · ¶1:4 · 10.9 / 10.9 ms · markdown · host connected · ai: none
```

and on the .docx:

```
sandbox/des-wa-gov__RFI-Template.docx · 14 suggestions · 5 muted · 228 ms · 476 words · ¶1:1 · — ms · docx · host connected · ai: none
```

Two different `ms` figures in one bar, neither labelled on screen:
- `15 ms` / `228 ms` — how long the **diagnostics** pass took.
- `10.9 / 10.9 ms` / `— ms` — the **keystroke → state-commit** latency (p50/p99) against the
  8 ms budget from house rule 4.

The second has a `title` explaining itself (`StatusBar.tsx:42`) and a `data-tone` that turns
warn over budget. The first has neither: **[CODE]** it arrives as `status.message`, a generic
free-text chip (`StatusBar.tsx:25`) that any feature can write a sentence into. So every other
field in the bar is a structured, self-describing element, and the diagnostics subsystem writes
prose into a slot the shell provides for notifications.

Terminology note, same bar: "14 suggestions · **5 muted**" introduces a sixth word for a
diagnostic state ("muted"), alongside "suggestion", "style hint", "error", "info" and "hint"
(§08, §11).

**Rank: 8.**

---

## 18. Agent apply onto a dirty buffer: three toasts, three vocabularies, and the first advice destroys the work

**[CODE + partially OBSERVED]** I deliberately did **not** run Apply — it writes the user's
files and I was told not to modify anything. I verified the mechanism instead.

**[OBSERVED]** Agent mode planned correctly and offline: term `Coastal` → `Littoral` found
*"5 sites in 4 of 1452 files · 5 exact · 0 variant · 0 to check"*, each site showing its line
number, its context, the substitution inline, and an `EXACT` badge. The footer reads:

> **Apply 5 changes** — *"Writes the accepted sites and nothing else. Undo is git."*

One of the four target files was `sandbox/report.md`, which was **open in the editor and
dirty**. Nothing in the agent pane says so. **[CODE]** `grep dirty AgentPane.tsx editor/agent.ts`
returns nothing — the agent path has no concept of an unsaved buffer.

What happens on Apply, traced through the shell:

1. `applyWorkspaceRename` writes the files. Irreversible in-app: *"Undo is git."*
2. `App.tsx:373` toasts **"Rewrote 1 file."**
3. `App.tsx:377` — *"The open document may be one of them: reload it so the editor is not
   showing text that no longer exists on disk"* — calls `ui.openFile(open)`.
4. `ui.openFile` opens with `if (!guardDirty()) return;` (`App.tsx:241`). The buffer is dirty,
   so **the reload is refused** and it toasts:
   **"Unsaved changes. Save with ⌘S, or run “File: Revert to saved”."**
5. `controller.watchExternalChanges` (`App.tsx:153`) sees the file change under an unsaved
   buffer and toasts a third message:
   **"report.md changed on disk and you have unsaved edits — nothing was reloaded."**

**[OBSERVED — step 4 verified live]** With `report.md` dirty I ran `File: Open file…` and picked
another file. Two identical toasts appeared, verbatim:

```
Unsaved changes. Save with ⌘S, or run “File: Revert to saved”.
Unsaved changes. Save with ⌘S, or run “File: Revert to saved”.
```

(and, separately, a small bug: the guard fired twice for one attempt.)

Three things are wrong at the seam, none of them wrong inside any one feature:

- **Three subsystems narrate the same event in three different vocabularies** — "Rewrote 1
  file", "Unsaved changes", "changed on disk … nothing was reloaded" — and the writer must
  assemble the actual state from all three.
- **The first remedy offered is the destructive one.** After the agent has written the rename
  to disk, the toast says *"Save with ⌘S"* first. ⌘S at that moment writes the stale buffer over
  the rename the user just approved, silently undoing the applied change. The correct action,
  Revert, is the second half of the sentence.
- **`guardDirty` is a guard against the *user* opening a file, reused as the return path for a
  *machine-initiated* reload.** For a user it is right; for the reload it converts "the
  document you are looking at is now wrong" into "we did nothing, and here is a keystroke".

**Rank: 3.** It is the highest-consequence interaction collision in the app.

---

## 19. Three panels show you an address; none of them will take you there

**[OBSERVED]** A pattern across three separately-built panels:

| panel | address it displays | jump to it? |
|---|---|---|
| Search results | line number (`7`, `15`, `18`, `6`) | **no** — opens at the top of the file (§16) |
| Agent review sites | line number (`597`, `3`, `4`, `5`, `6`) | **no** — checkbox only, no activation at all |
| Fidelity ledger | block `aid` | **no** — already known, ledgered as the `fidelity-panel` gap |

`workbench/status.json` records this for exactly one of the three: *"No jump-to-block from a
ledger entry yet: an entry names an `aid` but clicking it does not move the caret there."* It is
filed as one panel's local gap. It is in fact the app's **third** independent instance of the
same missing verb — the tool repeatedly points at a place in a document and provides no way to
go there, and every builder stopped at the same edge without any of them noticing the other two.

Meanwhile `CommentsPane` **does** have the verb — `revealThread(view, thread)` moves the caret
to a comment's anchor. Four panels, one implementation, and it was never named as something the
others could use.

**Rank: 5.** Low individual severity, high "one tool" damage: it is a repeated shape, not an
oversight.

---

## 20. Multi-cursor silently switches the completion popup off

**[OBSERVED — controlled A/B in the same document, `sandbox/report.md`]**

**Test.** Typed ` zz zz ` into a paragraph, selected the first `zz`, pressed ⌘D
(`cursor.addNext`). A second cursor appeared — confirmed by a `scriv-cursor-range` decoration
in the DOM. Then typed `[[`.

```
multi-cursor active :  text becomes "… measureme [[ [[ nt along the east"   ← inserted at BOTH cursors ✓
                       completion popup: NOT OPEN
```

**Control.** Pressed Escape (cursors collapsed to one: 0 `.scriv-cursor`, 0
`.scriv-cursor-range`), typed `[[` again at a single cursor:

```
single cursor       :  completion popup OPEN, 10 items
```

So multi-cursor editing works, and completion works, and **the moment both are live the
completion feature silently ceases to exist.** Nothing is shown, nothing is logged.

**[CODE]** `completion.ts computeAt()` opens with `if (!sel.empty) return null;` and reads
`state.selection` — a single ProseMirror selection. It has no concept of the extra cursors that
`multiCursorPlugin` maintains, and `multiCursorPlugin` has no concept of the popup. Neither
file mentions the other. This is the brief's named collision, answered: **they do not compose;
one of them wins by silently disappearing.**

Worth recording the *positive* half of the same test: **decorations themselves compose
correctly.** I found a single span carrying `class="scriv-diag scriv-diag-warning
scriv-cursor-range"` — a Harper warning squiggle and a multi-cursor range on the same text,
merged by ProseMirror's decoration layer without fighting. The decoration *mechanism* is sound;
what does not compose is the *plugins' models of the selection* (this §) and the *stylesheets*
(§09).

**Rank: 6.**

---

## 21. Unreproduced observation — flagged for the correctness owner, not a coherence finding

**[OBSERVED once, NOT REPRODUCED.]** During the agent-mode pass, `sandbox/report.md` was open
and **dirty**. After this sequence the editor buffer became **empty** (`.ProseMirror` text = one
newline) while the status bar still read `● sandbox/report.md` — i.e. an empty buffer marked
unsaved, where ⌘S would have truncated the file on disk:

1. `report.md` open and dirty (` [[` typed at the top).
2. Clicked a search hit → `ui.openFile` refused by `guardDirty` (two toasts).
3. ⌘⇧R opened agent mode; ran the `Coastal`→`Littoral` plan (scanned 1452 files, 5 sites,
   `report.md` among them). **Apply was never pressed.**
4. ⌘⇧R closed agent mode. Clicks in the panel area, then ⌘D twice.
5. Buffer empty; `145 words` chip gone; dirty flag still set.

I then tried twice to reproduce it deliberately — a clean reload, reopening `report.md`, opening
the fidelity pane, clicking inside it, ⌘D twice — and the document stayed intact (652 chars)
both times. **I could not reproduce it and I am not claiming a cause.** Recording it because an
empty-but-dirty buffer is a data-loss shape, and because it happened while three subsystems
(dirty-guard, agent scan, file watcher) were interacting — which is the kind of state this pass
is meant to surface even when it cannot be pinned down. This belongs to whoever owns
correctness; it is out of scope for me to chase further.

---

## 22. Four panel headers, three implementations, one copy-paste with a drift

**[CODE + OBSERVED]** The four review surfaces each style their own header:

| panel | heading | close control |
|---|---|---|
| Agent (`app.css:821`) | `h2` 12px/600, `letter-spacing .09em`, uppercase, `--ink-soft` | `padding 2px 9px`, `color: var(--ink)`, `1px solid var(--rule)`, radius 3 |
| Fidelity (`app.css:942`) | `h2` 12px/600, `letter-spacing .09em`, uppercase, `--ink-soft` — **the identical rule, retyped** | same box, but `color: var(--ink-soft)` — **one property drifted** |
| Diff (`app.css:1107`) | **no heading at all** | `padding 2px 7px`, `color: var(--ink-faint)`, **`font-family: var(--mono-font)`, 11px** — a monospace `esc` chip |
| Comments (`app.css:301`) | 11px, `--panel-fg-dim`, `border-bottom: 1px solid var(--panel-rule)` | none (no close) |

Agent and Fidelity are the same design typed twice, already one property apart. Diff is a
third design that omits the heading and renders its close as monospace lowercase (§14: the
`esc` that does not work). Comments is a fourth, on a **different token family**: the app
defines two palettes — `--ink / --ink-soft / --ink-faint / --rule / --paper` and
`--panel-bg / --panel-fg / --panel-fg-dim / --panel-rule / --panel-hover / --panel-active`
(`app.css:13-18`) — and the comments pane is the only one of the four review surfaces on the
second, because it happens to live in the sidebar. So "a list of things to review" is themed
two different ways depending on which builder put it where.

Add the undefined-token drift from §09: `--good` and `--warn` are referenced but never defined,
and `--warn` is patched with **two different fallback hexes** in two files (`#B8862C` in
`document.css:569`, `#D3A03A` in `app.css:761,774`).

**Rank: 9.** Individually cosmetic; collectively it is why the panels read as four products.

---

# THE NARRATIVE — one realistic task, end to end

The brief asks whether a writer doing one real task feels one tool or seven. I ran it.
**[OBSERVED throughout.]**

1. **Open a .docx** — `sandbox/des-wa-gov__RFI-Template.docx`, from the keyboard, via the tree.
   *Works, and works well.* 476 words, real Word comment threads, real fidelity ledger,
   diagnostics over it in 228 ms. This is the strongest part of the product. (`status.json`
   claims this is impossible — §07.)
2. **Read the comments** — ⌘⇧M. The threads render with author, date, Reply and Resolve. Then
   **the tab strip and the entire status bar leave the window** (§10). You are now inside the
   comments feature with no visible frame.
3. **Get back** — Escape does nothing useful anywhere in the sidebar; ⌘⇧1 works but is "focus
   file tree", not "get out". The tree, once you are in it, has no Escape at all (§02).
4. **Run a rename** — ⌘⇧R. Agent mode is genuinely good and genuinely offline: 5 sites in 4 of
   1452 files, with confidence per site. But it is a **checkbox multi-select**, not the
   accept/reject you learned from the AI inline edit (§03), and its sites show line numbers it
   will not take you to (§19). Applying it onto the document you have open and unsaved produces
   **three toasts from three subsystems, the first of which tells you to press ⌘S** — which
   would destroy the rename you just approved (§18).
5. **Check what a save would lose** — ⌘⌥F. The fidelity pane is excellent and honest. It also
   prints `numbering-unlabelled` at you (§11), has no Escape (§14), and stacks with whatever
   else is open, squeezing the document to a 187px sliver (§14).
6. **Look at the diff** — ⌘⇧G, a binding that **is in no menu, no palette, and no test** (§04).
   On the .docx you have open it renders `Changes / Blame / esc` and **nothing else, with no
   explanation** (§13). Its close button says `esc`; Escape does not work (§14).
7. **Edit the prose** — multi-cursor works; the completion popup works; **the moment both are
   live, completion silently stops existing** (§20). The popup cannot be dismissed with Escape
   because a window-level binding eats the key before ProseMirror sees it (§15).
8. **Save** — the one step I did not run, because it writes the user's files.

**The verdict.** It does not feel like seven tools. It feels like **one very good tool whose
controls were installed by four people who never met.** The document model, the docx import,
the fidelity ledger, the sentence diff, the offline rename and the comment reconciliation are
all better than they need to be. What is missing is entirely in the last centimetre: what a key
means, what a thing is called, where focus goes, what colour a change is, and what happens when
two features are on at once.

That is a good problem to have, and it is worth saying plainly: **there is no finding in this
document that requires rethinking an algorithm.** Every one of them lives in
`apps/web/src/app/*.tsx`, `apps/web/src/commands/`, or `apps/web/src/styles/`.

---

# RANKED SUMMARY

Ranked by damage to the "one tool" feeling, not by severity as bugs.

| # | finding | evidence | where |
|---|---|---|---|
| **1** | **§15** Two keyboard systems race; capture-phase window listener always beats the ProseMirror plugin stack. Four in-editor handlers are dead, incl. two full ⌘K implementations. Completion popup cannot be dismissed with Escape. | OBSERVED | `commands/registry.ts`, `editor/setup.ts`, `editor/inline-edit.ts`, `editor/completion.ts` |
| **1** | **§04** The git pillar is outside the command system — ⌘⇧G is a hand-rolled `window` listener. Not in the palette, not in `bindings.test.ts`, ignores `whenTyping`, wrong phase, wrong notation. | OBSERVED | `app/App.tsx:126-134` |
| **1** | **§13** On a .docx the diff/blame pane is a silent empty box. Three hand-written explanations exist for other dead ends; none for this one. | OBSERVED | `app/DiffPane.tsx`, `editor/controller.ts:96`, `app/App.tsx:389` |
| **2** | **§10** Opening the comments pane scrolls the tab strip and status bar out of the window (`min-height:auto` on `aside.sidebar`; `min-height:0` was applied either side of it). | OBSERVED | `styles/app.css`, sidebar/comments seam |
| **2** | **§09** Two competing tracked-changes stylesheets both land; AI insertions render green-with-blue-underline, deletions red-on-blue; `--good`/`--warn` undefined; origin does not change the hue. | OBSERVED | `styles/document.css:375-394` vs `540-556` |
| **2** | **§14 / §02** Three panels in one slot, three focus policies, two words for "close" (`Close` / `esc`) — and Escape works in neither. File tree has no Escape. | OBSERVED | `App.tsx:130,205-217`, `FidelityPane.tsx`, `DiffPane.tsx:74`, `FileTree.tsx:167` |
| **3** | **§18** Agent apply onto a dirty buffer: three toasts, three vocabularies, first remedy (⌘S) destroys the applied rename. | CODE + partial OBSERVED | `App.tsx:153,181,372-378` |
| **3** | **§03 / §08** "A proposed change" has two shapes (accept/reject vs checkbox multi-select) and "suggestion" means both a Harper diagnostic and an AI rewrite — on screen simultaneously. | OBSERVED | `AgentPane.tsx`, `inline-edit.ts`, `defaults.ts:397-418`, status bar |
| **4** | **§01** Four list panels, three navigation dialects (`Ctrl-n/p` / `j/k` / arrows-only) plus a fifth panel with none. Outside the registry, so untestable by `bindings.test.ts`. | CODE | `Palette.tsx:105`, `FileTree.tsx:161`, `CommentsPane.tsx:80`, `AgentPane.tsx`, `SearchPane.tsx` |
| **4** | **§16** Search hits show line numbers the shell discards; a search hit is not a decoration at all. | OBSERVED | `SearchPane.tsx:82` vs `App.tsx:351` |
| **4** | **§05** The AI family has three names in the palette: category `AI`, category `Assist`, and a title prefixed `Agent:`. `View:` is a junk drawer. | OBSERVED | `defaults.ts` |
| **5** | **§19** Three panels display an address (line, line, `aid`); none navigates to it. `status.json` files it as one panel's local gap. `CommentsPane.revealThread` is the one implementation and was never shared. | OBSERVED | Search / Agent / Fidelity |
| **5** | **§07** `status.json` says opening a .docx is impossible. It is not. | OBSERVED | `workbench/status.json` |
| **6** | **§20** Multi-cursor silently switches the completion popup off. (Decorations themselves compose fine.) | OBSERVED | `completion.ts computeAt()` |
| **6** | **§06** `when` guards inconsistent within one feature: "Accept AI suggestion" is offered with no document open; "Rewrite selection" is not. | OBSERVED | `defaults.ts:401,409` |
| **7** | **§11** Four severity ladders, four labelling registers; `info` means two things; one panel prints its machine codes, the neighbouring one maps them. | OBSERVED | Fidelity / Diff / Agent / Diagnostics |
| **8** | **§17** Two unlabelled `ms` readouts in the status bar; diagnostics writes prose into the generic `message` slot. | OBSERVED | `StatusBar.tsx` |
| **9** | **§22** Four panel headers, three implementations, one verbatim copy-paste already one property apart, two token families. | CODE | `styles/app.css` |
| — | **§21** Unreproduced: empty-but-dirty buffer after an agent/dirty-guard/watcher interaction. Flagged for correctness, not claimed. | OBSERVED once | — |
| — | **§12** **What is already right**, and the patterns the fixes should copy. | — | `registry.ts`, `editor/comments.ts`, `doc-model/schema.ts` |

## The one-sentence version

Every seam in this list is the same seam: **a concept that the model layer had already unified —
a change, a key, a position in a document, a panel — got re-invented once per feature in the
presentation layer**, and the four re-inventions were never reconciled because nothing in the
repo names them as one thing.

## If only three things are fixed

1. **§15 + §04 + §01** — make the keyboard one system. Give the registry a way for an in-editor
   modal surface to claim a key (the editor-side equivalent of `whenTyping`), move ⌘⇧G into the
   registry, and define *one* list dialect that every panel imports.
2. **§13 + §10 + §14** — the panel contract: one close affordance with one word, Escape
   everywhere, one focus policy, and `min-height: 0` on `aside.sidebar`. Give DiffPane the
   fourth explanation string it is missing.
3. **§09 + §03 + §08** — pick one appearance and one word for "a change". Delete the losing
   stylesheet block; define `--good`/`--warn` or stop referencing them; make agent sites use the
   same accept/reject verb the inline edit uses.

*End of report.*

---

## APPENDIX — scope note and a concurrency warning

**Files I changed:** exactly one — `workbench/coherence.md`. I ran no `Apply` in agent mode and
never saved a document, so nothing under `sandbox/` was written (`sandbox/report.md` mtime is
unchanged from 2026-09-02).

**Not mine, and worth someone's attention:** during this pass `git status` showed
`packages/ooxml/src/anchor.ts` modified (36 insertions — a real feature change adding a
`moveMinTokens` option to `ReanchorOptions` and `DEFAULT_OPTIONS`), plus two untracked files
`packages/ooxml/scripts/_lost.ts` and `packages/ooxml/scripts/_sweep.ts`. Their mtimes
(01:32 and 01:16) fall **inside this session's window**, and I only ever read that package.
Either an earlier session left uncommitted work that something touched, or another agent is
editing this repo concurrently. Anyone acting on this report should check that before assuming
the working tree is quiet.

**Environment:** `bun run web` (4310) and `bun run server` (4300) were both left running.
Workspace root resolved to the repo root (`--root ../..`), `ai: none` (no provider key), so the
live AI round trip could not be exercised — that half of §03/§08/§15 is [CODE], as
`status.json` already notes for the `ai` piece.

**Tooling caveat, not an app bug:** the Browser pane's screenshots lagged the DOM by seconds
during this session. Everything marked [OBSERVED] was verified through `read_page`,
`get_page_text`, or `getComputedStyle`/DOM measurement in the live page — not from a screenshot
alone.
