# Research brief (provided by the user, verified where noted)

Verified 2026-09-01 against the npm registry:

| Claim | Status |
|---|---|
| `harper.js` ships a browser build, Apache-2.0 | CONFIRMED — v2.7.0, Apache-2.0 |
| ProseMirror has pure decorations; Lexical/Quill do not | CONFIRMED by API surface; decisive for AI diff + diagnostics |
| `prosemirror-suggestion-mode` exists | CONFIRMED — v1.0.79, MIT |
| `prosemirror-tables` | CONFIRMED — v1.8.5, MIT |
| `saxes` (offset-recording SAX parse) | CONFIRMED — v6.0.0, ISC |
| pandoc available locally as a fidelity oracle | CONFIRMED — /usr/local/bin/pandoc |

Leads still to verify by reading the source: `ant981228/cardmirror` ARCHITECTURE.md (closest
prior art to the sidecar problem), `mhurhangee/docx-editor` word-fidelity docs (rich-model-primary
alternative), Moment's "Collaborative editing with AI is really, really hard" (three-way merge).

Divergence from the brief, and why: the brief proposes a sidecar holding "verbatim unmodeled XML
keyed to stable anchors". We go further — we keep **the entire original zip** and *splice* it on
export rather than regenerating from a model plus sidecar. See docs/DOCX-FIDELITY.md §2. This
turns the question from "how much OOXML can we model?" into "how little must we touch?", and
makes an unedited round-trip byte-identical rather than merely faithful.
