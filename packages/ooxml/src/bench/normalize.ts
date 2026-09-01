/**
 * T2 NORMALISATION — the honest core of the rig.
 *
 * An over-eager normaliser produces a flattering, useless score. This file is
 * therefore written as a ledger: every rule states what it erases, why that is
 * genuinely meaningless, and what it would hide if the reasoning is wrong.
 * `NORMALIZATION_RULES` below is emitted verbatim into the JSON report so the
 * score can never be read without the rules that produced it.
 *
 * The governing principle: **normalise representation, never content.**
 * If two byte sequences would render identically in Word AND behave identically
 * under further editing, the difference is representation. Anything else is
 * content and must survive to be scored.
 *
 * Two rules deliberately NOT applied, because they are the classic ways this
 * kind of scorer flatters its author — see REJECTED_RULES.
 */

import { W, XML_NS, type XNode } from "./xml.ts";

export interface Rule {
  id: string;
  what: string;
  why: string;
  /** What a wrong call here would conceal. Written pessimistically on purpose. */
  risk: string;
}

export const NORMALIZATION_RULES: Rule[] = [
  {
    id: "expanded-names",
    what: "Elements and attributes are matched by expanded name ({namespaceURI}local), never by prefix; xmlns declarations are dropped.",
    why: "XML Namespaces defines prefix as an arbitrary local binding. `w:p` and `foo:p` bound to the same URI ARE the same element. Producers legitimately emit different prefix sets and different declaration placement.",
    risk: "None known. This is an infoset identity, not a judgement call.",
  },
  {
    id: "attr-order",
    what: "Attributes are compared as a sorted key/value set, not as an ordered list.",
    why: "XML attributes are unordered by specification. No conforming consumer can observe the order.",
    risk: "None. Byte-order fidelity is what T0 measures; asking T2 to also measure it would make T2 a duplicate of T0.",
  },
  {
    id: "inter-element-whitespace",
    what: "Whitespace-only text nodes are dropped from elements that have element children, EXCEPT inside w:t, w:delText, w:instrText, w:noBreakHyphen and w:tab, where all character data is preserved byte-for-byte.",
    why: "OOXML body markup is element content; indentation between <w:p> and <w:pPr> is not data. Text-bearing elements are exempted absolutely.",
    risk: "If a producer put real text directly inside a container element we would drop it. Guarded: we only drop runs that are ENTIRELY whitespace, and only where sibling elements exist.",
  },
  {
    id: "drop-rsid",
    what: "All w:rsid* attributes (w:rsidR, w:rsidRDefault, w:rsidP, w:rsidTr, w:rsidDel, w:rsidRPr, w:rsidSect) and the w:rsids block in settings.xml are removed.",
    why: "Revision Save IDs record which Word editing session touched a region. They have no rendering effect, no semantic effect, and Word rewrites them on every save — two saves of an UNMODIFIED document differ in rsids.",
    risk: "Real but bounded: rsids are the single largest source of byte churn, so dropping them is also the single biggest lift to a T2 score. This is why T0 exists and is NOT normalised — the byte-identity claim in DOCX-FIDELITY.md §2 is checked there, at full strictness, with rsids intact.",
  },
  {
    id: "drop-proof-state",
    what: "w:proofErr elements and w:proofState in settings.xml are removed.",
    why: "Spell/grammar-check markers are a transient cache; Word regenerates them on load and they are absent from files never opened interactively.",
    risk: "Low. They are not rendered and carry no authored content.",
  },
  {
    id: "drop-layout-cache",
    what: "w:lastRenderedPageBreak elements are removed.",
    why: "A cache of where Word's layout engine last broke a page. Depends on installed fonts and printer driver, not on the document.",
    risk: "Low. Genuine page breaks are w:br w:type=\"page\" and are NOT touched.",
  },
  {
    id: "bookmark-ids",
    what: "w:bookmarkStart/@w:id and w:bookmarkEnd/@w:id are renumbered to their order of appearance; the Word-internal `_GoBack` bookmark is removed entirely.",
    why: "Bookmark ids are arbitrary handles whose only requirement is that start and end agree. The NAME is the referenceable identity and is fully compared. `_GoBack` records the user's last cursor position.",
    risk: "Low. Renumbering is order-preserving, so a reordered or dropped bookmark still shows up as a difference.",
  },
  {
    id: "boolean-toggles",
    what: "Toggle properties (w:b, w:i, w:strike, w:caps, ...) are canonicalised: absent w:val, w:val=\"1\"/\"true\"/\"on\" all become \"1\"; \"0\"/\"false\"/\"off\" become \"0\".",
    why: "ST_OnOff defines these as the same value. <w:b/> and <w:b w:val=\"true\"/> are indistinguishable to a consumer.",
    risk: "None. This is a spec-defined equivalence, applied only to the ST_OnOff element set.",
  },
  {
    id: "empty-property-containers",
    what: "Empty w:rPr, w:pPr, w:tblPrEx and w:sectPrChange containers with no children and no attributes are removed.",
    why: "An empty property bag applies no properties, exactly as its absence does.",
    risk: "None. Non-empty containers are untouched.",
  },
  {
    id: "drop-volatile-parts",
    what: "docProps/app.xml, docProps/core.xml, docProps/custom.xml, word/webSettings.xml, word/settings.xml/@w:rsids, and *.rels ordering are excluded from the scored tree.",
    why: "Editing time, revision counter, last-modified-by and template path change on every save regardless of content. Relationship IDs are internal handles resolved before comparison.",
    risk: "Moderate and acknowledged: an exporter could drop the author's name or the document title and we would not notice at T2. Mitigated by reporting docProps retention as a separate unweighted diagnostic (see t2.ts `diagnostics.docPropsRetained`).",
  },
  {
    id: "resolve-numbering-indirection",
    what: "w:numId values are resolved through numbering.xml (num -> abstractNum, honouring w:lvlOverride) to the RESOLVED level definition (numFmt, lvlText, start, indent, pStyle). The numeric numId itself is not compared.",
    why: "numId is a handle into a table. An exporter that renumbers 3->1 while preserving every level definition has changed nothing a reader can see.",
    risk: "Real. This is the most complex normalisation here and a bug in the resolver would silently pass broken numbering. Guarded two ways: an unresolvable numId scores as a MISS rather than being skipped, and the resolved level definition is compared in full, so losing lvlText or numFmt is still caught.",
  },
  {
    id: "resolve-style-indirection",
    what: "Style comparison uses the referenced-style closure: every styleId referenced by the body, plus everything reachable through w:basedOn / w:link / w:next, each serialised with its full w:pPr and w:rPr.",
    why: "Comparing raw styles.xml would penalise an exporter for dropping the 200 unused latent styles Word ships in every file, which have no effect on the document as it stands.",
    risk: "REAL AND THE MOST FLATTERING RULE HERE. Unused styles do matter to a Word user: they populate the style gallery and are what the next editor picks from. We therefore report unreferenced-style retention as a separate unweighted diagnostic (`diagnostics.latentStylesRetained`) so the number cannot hide, and the closure itself is compared in full so a dropped *referenced* style is a full miss.",
  },
  {
    id: "unicode-nfc",
    what: "Text content is compared after Unicode NFC normalisation.",
    why: "U+00E9 and U+0065 U+0301 are the same character. macOS producers emit NFD, Windows producers NFC; this is an encoding artefact of the authoring platform, not a text difference.",
    risk: "Low. NFC is content-preserving by definition; it does not fold case, width or compatibility characters (NFKC would, and is deliberately not used).",
  },
];

export const REJECTED_RULES: Rule[] = [
  {
    id: "REJECTED: merge-adjacent-runs",
    what: "NOT APPLIED: merging adjacent w:r siblings that share identical w:rPr into one run before comparison.",
    why: "It is superficially defensible — the rendered result is identical. It is rejected because run splitting is exactly what a regenerating exporter destroys, and DOCX-FIDELITY.md §4 stakes the whole design on preserving original run boundaries. Normalising it away would erase the difference this project exists to demonstrate.",
    risk: "Cost of rejecting: we penalise a harmless re-split. Accepted, and made visible — run structure is scored as its own low-weight `runs` feature rather than being folded into `text`, so a re-split costs 4% of the score, not 20%.",
  },
  {
    id: "REJECTED: drop-unknown-elements",
    what: "NOT APPLIED: skipping elements the scorer does not have a specific extractor for.",
    why: "This is the single most flattering thing such a scorer can do, and it is invisible in the output. Every element that survives normalisation is compared; the per-feature extractors are additive views over the same normalised tree, and a residual `structure` signal covers elements no named feature claims.",
    risk: "Cost of rejecting: the score is harder to move. That is the point.",
  },
  {
    id: "REJECTED: text-only-comparison",
    what: "NOT APPLIED: reducing documents to their plain text and calling the ratio a fidelity score.",
    why: "It is what makes naive round-trip benchmarks report 0.99 for tools that destroy every table and every style. Text is 20% of the weighted score here, not 100%.",
    risk: "None.",
  },
];

/* ------------------------------------------------------------------ */
/* Implementation                                                      */
/* ------------------------------------------------------------------ */

/** Elements whose character data is document content and must never be touched. */
const TEXT_BEARING = new Set([
  `${W}t`,
  `${W}delText`,
  `${W}instrText`,
  `${W}delInstrText`,
  `${W}noBreakHyphen`,
  `${W}softHyphen`,
  `${W}tab`,
]);

/** ST_OnOff toggle properties per ECMA-376 §17.3.2. */
const TOGGLES = new Set(
  [
    "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline",
    "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden",
    "rtl", "cs", "specVanish", "oMath", "keepNext", "keepLines", "pageBreakBefore",
    "widowControl", "suppressLineNumbers", "suppressAutoHyphens", "kinsoku",
    "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE", "autoSpaceDN",
    "bidi", "adjustRightInd", "snapToGrid", "contextualSpacing", "mirrorIndents",
    "suppressOverlap", "titlePg", "cantSplit", "tblHeader",
  ].map((n) => `${W}${n}`),
);

const DROP_ELEMENTS = new Set([
  `${W}proofErr`,
  `${W}lastRenderedPageBreak`,
  `${W}rsid`,
  `${W}rsids`,
]);

const EMPTY_CONTAINERS = new Set([`${W}rPr`, `${W}pPr`, `${W}tblPrEx`, `${W}sectPrChange`]);

function isRsidAttr(name: string): boolean {
  return name.startsWith(`${W}rsid`);
}

function canonToggle(v: string | undefined): string {
  if (v === undefined) return "1";
  const s = v.trim().toLowerCase();
  if (s === "0" || s === "false" || s === "off") return "0";
  return "1";
}

/**
 * Normalises IN PLACE and returns the same node. Idempotent.
 * Bookmark renumbering is done in a second pass because it needs document order.
 */
export function normalizeTree(root: XNode): XNode {
  walk(root);
  renumberBookmarks(root);
  return root;
}

function walk(n: XNode): void {
  /* rule: drop-rsid */
  for (const k of [...n.attrs.keys()]) if (isRsidAttr(k)) n.attrs.delete(k);

  /* rule: boolean-toggles */
  if (TOGGLES.has(n.name)) {
    const v = n.attrs.get(`${W}val`);
    /* Only canonicalise when the attribute is absent or a recognised ST_OnOff
       literal — never coerce an unexpected value, which would hide a bug. */
    if (v === undefined || /^(0|1|true|false|on|off)$/i.test(v.trim())) {
      n.attrs.set(`${W}val`, canonToggle(v));
    }
  }

  const kept: XNode[] = [];
  for (const c of n.children) {
    /* rule: drop-proof-state, drop-layout-cache */
    if (DROP_ELEMENTS.has(c.name)) continue;
    walk(c);
    /* rule: empty-property-containers (post-order: children already pruned) */
    if (EMPTY_CONTAINERS.has(c.name) && c.children.length === 0 && c.attrs.size === 0) continue;
    kept.push(c);
  }
  n.children = kept;

  /* rule: inter-element-whitespace. Only when this element has element
     children (so it is a container, not a text leaf) and is not text-bearing. */
  if (!TEXT_BEARING.has(n.name)) {
    if (n.children.length > 0 && n.text.trim() === "") n.text = "";
  } else {
    /* Text-bearing: preserve exactly, but NFC-normalise (rule: unicode-nfc). */
    n.text = n.text.normalize("NFC");
  }
}

function renumberBookmarks(root: XNode): void {
  /* rule: bookmark-ids */
  const idMap = new Map<string, string>();
  let next = 0;
  const goBackIds = new Set<string>();

  const collect = (n: XNode): void => {
    for (const c of n.children) {
      if (c.name === `${W}bookmarkStart`) {
        const id = c.attrs.get(`${W}id`);
        const name = c.attrs.get(`${W}name`);
        if (id !== undefined) {
          if (name === "_GoBack") goBackIds.add(id);
          else if (!idMap.has(id)) idMap.set(id, String(next++));
        }
      }
      collect(c);
    }
  };
  collect(root);

  const apply = (n: XNode): void => {
    const kept: XNode[] = [];
    for (const c of n.children) {
      if (c.name === `${W}bookmarkStart` || c.name === `${W}bookmarkEnd`) {
        const id = c.attrs.get(`${W}id`);
        if (id !== undefined && goBackIds.has(id)) continue; // drop _GoBack pair
        if (id !== undefined) c.attrs.set(`${W}id`, idMap.get(id) ?? `orphan:${id}`);
      }
      apply(c);
      kept.push(c);
    }
    n.children = kept;
  };
  apply(root);
}

/**
 * Canonical serialisation of a normalised node — the token used by every
 * comparator. Deterministic, order-preserving over children, order-free over
 * attributes.
 *
 * `depth` bounds recursion so a token stays a fingerprint rather than a full
 * subtree dump; Infinity gives the exact subtree.
 */
export function canon(n: XNode, depth = Infinity): string {
  const attrs = [...n.attrs.entries()]
    .filter(([k]) => k !== `${XML_NS}space`) // xml:space is a serialisation directive
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  const head = attrs ? `${n.name}[${attrs}]` : n.name;
  if (depth <= 0) return `${head}{…}`;
  const kids = n.children.map((c) => canon(c, depth - 1)).join("");
  const text = n.text ? JSON.stringify(n.text) : "";
  return `<${head}>${text}${kids}</>`;
}
