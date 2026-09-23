# High-fidelity .docx round-trip over a Markdown source of truth

The requirement is in genuine tension with itself:

- **Markdown is the source of truth.** Plain, portable, git-diffable, hand-editable.
- **A Word user must get their document back intact** — styles, numbering, tables,
  headers/footers, comments, tracked changes.

Markdown cannot express numbering definitions, style inheritance, section properties,
headers/footers, image wrap modes, fields, or revision ids. Any design that tries to make it
express them either corrupts the Markdown (invisible junk, non-portable extensions) or corrupts
the docx (regenerated approximations that drift).

This document resolves the tension. It is the core engineering of the project.

---

## 1. The wrong answers, and why

**(a) Encode OOXML in the Markdown.** HTML comments, custom directives, YAML blocks per
paragraph. Kills the thing that made Markdown worth choosing — it is no longer plain, no longer
hand-editable, no longer readable in any other tool. Rejected.

**(b) Regenerate the docx from the Markdown on export.** This is what pandoc does, and it is why
pandoc round-trips lose formatting. You cannot regenerate what you never modeled, and you cannot
model all of OOXML. Every export is a lossy re-render of the whole document — including the 95%
the writer never touched. Rejected.

**(c) Make the rich model primary and keep Markdown as an export** (the `docx-editor.dev`
shape). Coherent and arguably better for a pure Word tool — but it inverts the stated
requirement and gives up git-diffable plain text. Rejected *for this product*, though it informs
(d): its "preserve unmodeled XML" instinct is exactly right.

**(d) What we do: Markdown carries the text; the original zip carries the format; a sidecar maps
between them; export splices rather than regenerates.**

## 2. The three layers

```
report.md                    TEXT + STRUCTURE. Source of truth. Complete on its own.
.scriv/report.md.fidelity.json   THE MAP. Anchors → OOXML properties. Comments. Revisions.
.scriv/origin/report.docx    THE SUBSTRATE. The untouched original zip.
```

The load-bearing idea: **on export we do not build a docx, we edit one.**

Take the original zip. Copy every part byte-for-byte. Modify only the regions of
`word/document.xml` whose text actually changed. A `<w:p>` the writer never touched is emitted
as the exact original bytes — same run splits, same `rPr`, same `rsid`s, same proofing state.

This inverts the usual fidelity question. Instead of *"how much of OOXML can we model?"* it
becomes *"how little do we have to touch?"* We only need to understand the paragraphs that
changed. Everything else is preserved by not being understood at all.

Consequence: fidelity on an untouched document is **exact — byte-identical**, not "high". And
fidelity degrades only in proportion to how much was edited, which is the correct shape for the
guarantee.

## 3. Anchors: the actual research problem

A paragraph must keep its identity when the writer rewrites it. Two regimes, and conflating them
is the mistake:

### In-session: exact, zero fuzziness
While the document is open, every `aid` rides ProseMirror's transaction position mapping. A
block's identity is tracked *exactly* through every edit, split, merge, and move. There is no
guessing, because we observed every change. This covers ~99% of real use.

### Out-of-session: fuzzy recovery
The `.md` may be edited by another tool — vim, git merge, another person's PR. On load we must
re-attach anchors to blocks we did not watch change. This is a **sequence alignment problem**,
not a hashing problem.

Each anchor stores multiple independent signals:

| Signal | Survives | Fails on |
|---|---|---|
| `ordinal` | edits | insertions above |
| `contentHash` (exact) | moves | any edit |
| `simhash` (64-bit, token shingles) | small edits | rewrites |
| `shingles` (first/last 3-gram) | mid-block edits | edits at edges |
| `structPath` (§ → ordinal within section) | reordering elsewhere | section renames |
| `kind + level + listRef` | text edits | structural change |

Re-anchoring runs a **constrained Needleman–Wunsch alignment** over (stored anchors × current
blocks), scoring with a weighted combination of the above, with affine gaps so that a run of
inserted paragraphs costs less than the same number of scattered mismatches. Splits and merges
are first-class alignment operations, not failures:

- **split** (1 anchor → 2 blocks): both inherit `pPr`; the numbering entry is duplicated.
- **merge** (2 anchors → 1 block): the dominant anchor's `pPr` wins; the other is retired and
  its comments re-anchored to the surviving block with a confidence penalty.

### Confidence, and the refusal to guess
Every re-anchored block gets a confidence in [0,1]. Below the threshold, we **drop the OOXML
properties and record it in a fidelity ledger** rather than applying formatting to what might be
the wrong paragraph. Silent misapplication is worse than visible loss: a dropped style is a
formatting bug the user can see and fix; a misapplied one corrupts a document they trusted.

The ledger is surfaced in the UI (a "fidelity" panel), reported by the round-trip scorer, and is
the primary quality metric for this subsystem.

### What it actually scores
Measured by `packages/ooxml/test/anchor.test.ts` across 12 corpus documents, ~5,600 blocks per
scenario, against ground truth from `test/scenarios.ts`. The figures are reproducible run to
run; if they ever stop being, suspect document order before suspecting the aligner:

| out-of-session edit | identity recovered | anchors safely lost | **silently misapplied** |
|---|---|---|---|
| reword 20%@15% · rewrite 50%@50% · split · merge | 100% | 0 | 0 |
| insert 4×5 · delete 3×4 | 100% | 0 | 0 |
| move 66 blocks | 96.2% | 214 | 3 |
| all of the above at once | 94.4% | 307 | 3 |

The two failure columns are not the same kind of number and are held to different standards.
The last column is the one this section is about; the middle one is a formatting loss the writer
can see and the ledger reports.

Moves are the remaining limit. A move is not expressible in an order-preserving alignment, so it
is recovered afterwards by exact content match — and the blocks that pass through that net are
mostly not the ones you would expect. Of 242 blocks missed after a moved section, 238 were SHORT
(under three tokens) and none were reworded; move recovery had inherited a three-token floor from
the waypoint skeleton, which needs it for a reason move recovery does not. Reworded moved blocks
are a real limit too, but a smaller one: 66 of the combined scenario's 348 misses. Either way the
blocks are lost and ledgered, never guessed at.

## 4. Export: the splice engine

1. Read `word/document.xml` from the origin zip as **raw bytes**.
2. Parse with `saxes`, recording **byte offsets** for every element open/close. This yields an
   offset-indexed tree without ever re-serializing — the parser is used as an *index*, not as a
   transform. This is what guarantees byte-fidelity: we never round-trip XML through a DOM that
   might normalize attribute order, self-closing tags, namespace prefixes or whitespace.
3. Diff current doc-model blocks against the imported snapshot, keyed by `aid`.
4. For each block:
   - **unchanged** → `copy(originBytes[start..end])`
   - **text changed, structure same** → regenerate only the `<w:r>` runs, reusing stored `rPr`
     per run and re-splitting text along the original run boundaries where they still apply
   - **new block** → synthesize a `<w:p>`, inheriting `pPr` from the neighbour it was split from
     or from the paragraph style it maps to
   - **deleted** → omit (or, in tracked-changes mode, wrap in `<w:del>`)
5. Splice the pieces, rewrite only the parts that changed (`document.xml`, plus `comments.xml`
   and `people.xml` if comments changed), copy all other zip entries **verbatim, uncompressed
   bytes and all**.

Numbering, styles, headers, footers, footnotes, themes, fonts, settings, embedded media: never
parsed, never touched, therefore never broken.

## 5. Comments and tracked changes

Both are anchored ranges, not content, in the doc model:

- A `comment` mark carries only `{ anchorId }`. Thread content, author, timestamp, resolution and
  `w:commentRangeStart/End` ids live in the sidecar.
- Tracked changes use `insertion` / `deletion` marks carrying `{ revId, author, date }`,
  round-tripping to `<w:ins>` / `<w:del>`. Our own AI edits and Cmd-K accept/reject use the *same
  mark types*, which means "accept this AI rewrite" and "accept this colleague's tracked change"
  are one code path — and an AI suggestion can be exported as a real Word tracked change.

In the Markdown, comments and tracked changes are represented in **CriticMarkup**
(`{>>comment<<}`, `{++ins++}`, `{--del--}`) — an existing convention, degrades to readable text,
and keeps the `.md` self-sufficient rather than sidecar-dependent for its most important
annotations.

## 6. Scoring: how we know it works

`bun run roundtrip` over a corpus of **real-world .docx files collected from the wild** (public
government forms, university templates, standards drafts, published reports) — never fixtures we
authored to pass our own parser.

Three tiers, reported per file and aggregated:

| Tier | Test | Target |
|---|---|---|
| **T0 identity** | import → export with zero edits → byte compare | 100% byte-identical |
| **T1 surgical** | import → edit one word → export → compare all *other* paragraphs | 100% byte-identical outside the edited `<w:p>` |
| **T2 semantic** | import → export → re-import both → compare normalized OOXML trees (styles, numbering, tables, sectPr, headers/footers, comments, revisions) | ≥ 0.98 weighted similarity |

Plus a **pandoc baseline** on the same corpus. Pandoc is the fidelity oracle and the number to
beat; if we are not decisively ahead of it on T1 and T2, this design has failed and we should
know that early rather than late.
