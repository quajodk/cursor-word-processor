# The bar: a three-way blind comparison

We are not trying to be "good for a prototype". The claim under test is that scriv beats each
incumbent *at the thing that incumbent is best at*:

| Comparator | Judged on | Because it is the best in the world at |
|---|---|---|
| **Cursor** | keystroke latency, completion quality, accept/reject diff, multi-file navigation | IDE mechanics |
| **Google Docs** | typography, tables, pagination, comments, what a .docx looks like coming back out | document polish |
| **Obsidian** | drafting for an hour without fighting the tool | writing flow |

Losing to Google Docs on typography while beating it on multi-cursor is not a win. The point of
splitting the rubric by comparator is to stop us from averaging away the losses.

## The task

One real editing task, run identically in all four tools. It must be real work, not a demo
script, and it must exercise all four v1 features without being *about* them.

**The task:** take a real 12–20 page Word document from the corpus (a standards draft or a
committee report — something with numbered headings, tables, footnotes and at least one
existing comment thread), and perform a realistic revision pass:

1. Restructure: move a section, split an overlong paragraph, merge two others.
2. Rewrite: tighten four paragraphs of bureaucratic prose.
3. Terminology: rename a defined term consistently across the document.
4. Cross-reference: add three references to numbered sections, and one citation.
5. Respond: reply to the existing comment thread and resolve it.
6. Deliver: save, and hand the .docx back to a Word user.

Every tool gets the same starting document, the same 45 minutes, and the same operator.

## Capture

- Full-session screen recording at 60fps, plus a keystroke log with timestamps.
- Input latency sampled independently of the recording (the recorder perturbs it) — see
  `packages/perf`. Latency is *measured*, never *judged from video*.
- Final artefacts: the exported `.docx` from each tool, opened and rendered, screenshotted.
- A written trace of every moment the operator had to stop and fight the tool.

## Blinding — the part that is easy to get wrong

The critic must not be able to identify us, and the obvious tells must be removed:

- **Chrome is cropped out.** Only the document region is shown. No title bars, no logos, no
  distinctive panel colours, no fonts unique to one app in the UI.
- **Tools are labelled A/B/C/D**, assigned by a seed the critic does not have, re-randomised
  per run.
- **The critic runs in a fresh context window** and is never told which tool is ours, that one
  of them is ours, or that the requester built one of them.
- **Order is shuffled** per criterion, so position does not leak identity.
- **Our own artefacts get the same treatment as the incumbents'** — no favourable cropping, no
  best-of-N takes, one recorded attempt each.

The failure mode to guard against is not the critic cheating; it is us leaking. A screenshot
with a recognisable accent colour, or a rubric worded in our vocabulary ("fidelity ledger"),
identifies us instantly. The rubric below is deliberately written in the incumbents' language.

## Rubric

Scored 1–5 per line, with a required one-sentence justification citing specific evidence from
the capture. Unjustified scores are discarded.

**Mechanics (vs Cursor)** — responsiveness under the hand · does completion offer the right
thing · is a suggested change reviewable before it lands · getting between files and back.

**Polish (vs Google Docs)** — does the page look like a document · tables · long-document
behaviour · comments · **and the decisive one: open the exported file in Word and compare it to
the original — what broke?**

**Flow (vs Obsidian)** — can you draft for an hour · does the tool interrupt · does the
keyboard do what your hands expect · did anything get lost.

## Verdicts

The critic picks a winner per axis and overall, names the single biggest weakness of each
tool, and answers one forcing question: **"which would you use for this task next week?"**
That last one catches tools that score well and are still unpleasant.

## Honesty rules

1. The critic is a **separate agent with a fresh context window** and never the builder.
2. A losing result is reported verbatim on the workbench page. We do not re-run until we like
   the answer; a re-run is only legitimate after a *fix*, and both results stay on the record.
3. If we win because the task suited us, say so. A rigged task is a lost year.
4. The measured bar (latency, round-trip score) is reported alongside and can contradict the
   blind verdict. When it does, that contradiction is the most interesting finding of the run
   and gets written up rather than resolved away.
