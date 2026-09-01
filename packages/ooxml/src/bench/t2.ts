/**
 * T2 SEMANTIC SIMILARITY.
 *
 * DOCX-FIDELITY.md §6: "import → export → re-import both → compare normalized OOXML trees
 * (styles, numbering, tables, sectPr, headers/footers, comments, revisions), weighted
 * similarity in [0,1], target ≥ 0.98."
 *
 * The normalisation this builds on is in `normalize.ts`, which states rule by rule what it
 * erases and what a wrong call would conceal. This file adds the second half of the honesty
 * problem: **what gets compared, and what it is worth.** A scorer can flatter its author twice
 * over — once by normalising away real differences, and once by weighting the features it
 * happens to do well. So:
 *
 *   - Weights are declared as data, emitted into the report, and sum to 1 by assertion.
 *   - Text is 20%, not 100%. A tool that preserves every word and destroys every table scores
 *     around 0.2 here, which is what it deserves.
 *   - `structure` is a residual signal over EVERY element in every compared part, so a feature
 *     nobody wrote an extractor for still costs something when it disappears. This is what
 *     stops the score from being "similarity over the things we thought to measure".
 *   - A feature absent from BOTH documents is dropped and the remaining weights renormalised;
 *     a document with no tables is not rewarded for having no tables to lose.
 *   - The two rules that most flatter us — dropping volatile parts and comparing only the
 *     referenced style closure — are reported as separate UNWEIGHTED diagnostics
 *     (`docPropsRetained`, `latentStylesRetained`) so their cost is visible next to the number.
 */

import { strFromU8, type Unzipped } from "fflate";
import { normalizeTree, canon } from "./normalize.ts";
import { W, parseXml, child, children, descendants, attr, allText, type XNode } from "./xml.ts";

/* ------------------------------------------------------------------ weights */

export const FEATURE_WEIGHTS = {
  /** Body text, paragraph by paragraph. The thing a writer would notice first, and only 20%. */
  text: 0.20,
  /** Every element in every compared part, as a path bag. The catch-all that has no extractor. */
  structure: 0.14,
  /** The referenced style closure, each style's full pPr/rPr. */
  styles: 0.12,
  /** Resolved numbering level definitions, per numbered paragraph. */
  numbering: 0.12,
  /** Table geometry and cell/row/table properties. */
  tables: 0.12,
  /** Header and footer parts, compared whole. */
  headersFooters: 0.10,
  /** Section properties: page size, margins, columns, header/footer references. */
  sectPr: 0.08,
  /** Comment threads. */
  comments: 0.04,
  /** Tracked changes. */
  revisions: 0.04,
  /** Run splitting — deliberately its own low-weight feature; see normalize.ts REJECTED_RULES. */
  runs: 0.04,
} as const;

export type FeatureName = keyof typeof FEATURE_WEIGHTS;

{
  const sum = Object.values(FEATURE_WEIGHTS).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`T2 weights sum to ${sum}, not 1`);
}

/* ------------------------------------------------------------------ similarity primitives */

/** 2·|A∩B| / (|A|+|B|) over multisets. Order-blind; used where order is not meaningful. */
export function diceMultiset(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  let inter = 0;
  for (const x of b) {
    const n = counts.get(x) ?? 0;
    if (n > 0) { inter++; counts.set(x, n - 1); }
  }
  return (2 * inter) / (a.length + b.length);
}

const LCS_BUDGET = 6_000_000;

/**
 * 2·LCS / (m+n). Order-sensitive, which is the point: a tool that preserves every paragraph
 * but reorders them should not score 1.0 on text.
 *
 * Above `LCS_BUDGET` cells the quadratic DP is replaced by the order-blind Dice coefficient
 * and the caller is told, because a scorer that silently changes its metric on large inputs is
 * a scorer that reports two different numbers under one name.
 */
export function lcsSim(a: readonly string[], b: readonly string[]): { sim: number; exact: boolean } {
  if (a.length === 0 && b.length === 0) return { sim: 1, exact: true };
  if (a.length === 0 || b.length === 0) return { sim: 0, exact: true };
  if (a.length * b.length > LCS_BUDGET) return { sim: diceMultiset(a, b), exact: false };
  const { len, exact } = lcsLength(a, b);
  return { sim: (2 * len) / (a.length + b.length), exact };
}

/** Longest common subsequence length, with the same quadratic budget as `lcsSim`. */
export function lcsLength(a: readonly string[], b: readonly string[]): { len: number; exact: boolean } {
  if (a.length === 0 || b.length === 0) return { len: 0, exact: true };
  if (a.length * b.length > LCS_BUDGET) {
    // Order-blind fallback: the size of the multiset intersection is an upper bound on LCS.
    const counts = new Map<string, number>();
    for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
    let inter = 0;
    for (const x of b) { const n = counts.get(x) ?? 0; if (n > 0) { inter++; counts.set(x, n - 1); } }
    return { len: inter, exact: false };
  }

  // Hash to integers first: string comparison dominates otherwise.
  const ids = new Map<string, number>();
  const idOf = (s: string): number => {
    let v = ids.get(s);
    if (v === undefined) { v = ids.size; ids.set(s, v); }
    return v;
  };
  const A = Int32Array.from(a, idOf);
  const B = Int32Array.from(b, idOf);

  let prev = new Int32Array(B.length + 1);
  let cur = new Int32Array(B.length + 1);
  for (let i = 1; i <= A.length; i++) {
    const ai = A[i - 1]!;
    for (let j = 1; j <= B.length; j++) {
      cur[j] = ai === B[j - 1]! ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    const t = prev; prev = cur; cur = t;
  }
  return { len: prev[B.length]!, exact: true };
}

/** 2·|matching entries| / (|A|+|B|) over keyed maps. A changed value is a miss on both sides. */
export function mapSim(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let match = 0;
  for (const [k, v] of a) if (b.get(k) === v) match++;
  return (2 * match) / (a.size + b.size);
}

/* ------------------------------------------------------------------ part loading */

export interface LoadedDoc {
  entries: Unzipped;
  /** Normalised trees, by logical part kind. `null` when the part is absent. */
  document: XNode | null;
  styles: XNode | null;
  numbering: XNode | null;
  comments: XNode | null;
  notes: XNode[];
  headers: XNode[];
  footers: XNode[];
}

const DOC_PART = "word/document.xml";

function loadPart(entries: Unzipped, name: string): XNode | null {
  const b = entries[name];
  if (!b) return null;
  try {
    return normalizeTree(parseXml(strFromU8(b)));
  } catch {
    return null;
  }
}

export function loadDoc(entries: Unzipped): LoadedDoc {
  const names = Object.keys(entries).sort();
  const pick = (re: RegExp): XNode[] =>
    names.filter((n) => re.test(n)).map((n) => loadPart(entries, n)).filter((x): x is XNode => x !== null);
  return {
    entries,
    document: loadPart(entries, DOC_PART),
    styles: loadPart(entries, "word/styles.xml"),
    numbering: loadPart(entries, "word/numbering.xml"),
    comments: loadPart(entries, "word/comments.xml"),
    notes: pick(/^word\/(footnotes|endnotes)\.xml$/),
    headers: pick(/^word\/header\d*\.xml$/),
    footers: pick(/^word\/footer\d*\.xml$/),
  };
}

/** Every part whose content is compared. docProps and settings are excluded — see normalize.ts. */
function comparedParts(d: LoadedDoc): Array<{ kind: string; root: XNode }> {
  const out: Array<{ kind: string; root: XNode }> = [];
  if (d.document) out.push({ kind: "document", root: d.document });
  if (d.styles) out.push({ kind: "styles", root: d.styles });
  if (d.numbering) out.push({ kind: "numbering", root: d.numbering });
  if (d.comments) out.push({ kind: "comments", root: d.comments });
  for (const n of d.notes) out.push({ kind: "notes", root: n });
  for (const h of d.headers) out.push({ kind: "header", root: h });
  for (const f of d.footers) out.push({ kind: "footer", root: f });
  return out;
}

/* ------------------------------------------------------------------ feature extractors */

const P = `${W}p`;
const R = `${W}r`;

/** Text of one paragraph, with tabs and breaks as the characters a reader would see. */
function paraText(p: XNode): string {
  let s = "";
  const walk = (n: XNode): void => {
    for (const c of n.children) {
      if (c.name === `${W}t`) s += c.text;
      else if (c.name === `${W}tab`) s += "\t";
      else if (c.name === `${W}br` || c.name === `${W}cr`) s += "\n";
      else if (c.name === `${W}noBreakHyphen`) s += "‑";
      else if (c.name === `${W}delText`) { /* deleted text is not shown; scored under revisions */ }
      else walk(c);
    }
  };
  walk(p);
  return s;
}

/**
 * Paragraphs with no text at all are excluded from the TEXT feature — an empty paragraph is
 * spacing, not text, and letting thousands of them match each other would inflate the number
 * that is supposed to answer "did the words survive". Their loss is still visible: they are
 * elements, so they are counted by `structure`.
 */
function textFeature(d: LoadedDoc): string[] {
  const out: string[] = [];
  for (const { root } of comparedParts(d)) {
    for (const p of descendants(root, P)) {
      const t = paraText(p).replace(/\s+/g, " ").trim();
      if (t.length > 0) out.push(t);
    }
  }
  return out;
}

/** Per-paragraph run structure: how many runs, and what each one's rPr is. */
function runsFeature(d: LoadedDoc): string[] {
  const out: string[] = [];
  for (const p of descendants(d.document ?? emptyNode(), P)) {
    const runs = descendants(p, R);
    if (runs.length === 0) continue;
    out.push(runs.map((r) => {
      const rPr = child(r, `${W}rPr`);
      return `${rPr ? canon(rPr) : "-"}:${paraText(r).length}`;
    }).join("|"));
  }
  return out;
}

function styleRefs(d: LoadedDoc): Set<string> {
  const refs = new Set<string>();
  for (const { root } of comparedParts(d)) {
    for (const name of [`${W}pStyle`, `${W}rStyle`, `${W}tblStyle`]) {
      for (const el of descendants(root, name)) {
        const v = attr(el, `${W}val`);
        if (v) refs.add(v);
      }
    }
  }
  return refs;
}

/**
 * The referenced style closure: every style the body actually uses, plus everything reachable
 * from it through `w:basedOn`, `w:link` and `w:next`.
 *
 * `docDefaults` is included as a pseudo-style because it is where half of a document's typography
 * lives, and dropping it would be invisible in a comparison of named styles alone.
 */
function stylesFeature(d: LoadedDoc): Map<string, string> {
  const out = new Map<string, string>();
  if (!d.styles) return out;
  const root = child(d.styles, `${W}styles`);
  if (!root) return out;

  const byId = new Map<string, XNode>();
  for (const s of children(root, `${W}style`)) {
    const id = attr(s, `${W}styleId`);
    if (id) byId.set(id, s);
  }

  const seed = styleRefs(d);
  // The default styles apply to every paragraph and run whether or not anything names them.
  for (const s of children(root, `${W}style`)) {
    const id = attr(s, `${W}styleId`);
    if (id && attr(s, `${W}default`) === "1") seed.add(id);
  }

  const queue = [...seed];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const s = byId.get(id);
    if (!s) { out.set(id, "MISSING"); continue; }
    out.set(id, canon(s));
    for (const rel of [`${W}basedOn`, `${W}link`, `${W}next`]) {
      const v = attr(child(s, rel), `${W}val`);
      if (v && !seen.has(v)) queue.push(v);
    }
  }

  const defaults = child(root, `${W}docDefaults`);
  if (defaults) out.set(" docDefaults", canon(defaults));
  return out;
}

/**
 * Numbering, resolved through the indirection rather than compared by handle.
 *
 * `w:numId` is a key into a table; an exporter that renumbers 3→1 while preserving every level
 * definition has changed nothing a reader can see. What IS compared is the resolved level —
 * numFmt, lvlText, start, indentation, the paragraph style it applies — in full. An id that
 * cannot be resolved yields an `UNRESOLVED` token rather than being skipped, so a broken
 * numbering table is a miss and not a silence.
 */
function numberingFeature(d: LoadedDoc): string[] {
  const abstractById = new Map<string, XNode>();
  const numToAbstract = new Map<string, string>();
  const overrides = new Map<string, XNode>();
  if (d.numbering) {
    const root = child(d.numbering, `${W}numbering`);
    for (const an of children(root, `${W}abstractNum`)) {
      const id = attr(an, `${W}abstractNumId`);
      if (id) abstractById.set(id, an);
    }
    for (const n of children(root, `${W}num`)) {
      const numId = attr(n, `${W}numId`);
      if (!numId) continue;
      const abs = attr(child(n, `${W}abstractNumId`), `${W}val`);
      if (abs) numToAbstract.set(numId, abs);
      for (const ov of children(n, `${W}lvlOverride`)) {
        const ilvl = attr(ov, `${W}ilvl`) ?? "0";
        const lvl = child(ov, `${W}lvl`);
        if (lvl) overrides.set(`${numId}:${ilvl}`, lvl);
      }
    }
  }

  const resolve = (numId: string, ilvl: string): string => {
    const ov = overrides.get(`${numId}:${ilvl}`);
    if (ov) return canon(ov);
    const abs = numToAbstract.get(numId);
    const an = abs !== undefined ? abstractById.get(abs) : undefined;
    if (!an) return `UNRESOLVED:${numId}:${ilvl}`;
    const lvl = children(an, `${W}lvl`).find((l) => (attr(l, `${W}ilvl`) ?? "0") === ilvl);
    if (!lvl) return `UNRESOLVED-LVL:${numId}:${ilvl}`;
    return canon(lvl);
  };

  const out: string[] = [];
  for (const { root } of comparedParts(d)) {
    for (const p of descendants(root, P)) {
      const numPr = child(child(p, `${W}pPr`), `${W}numPr`);
      if (!numPr) continue;
      const numId = attr(child(numPr, `${W}numId`), `${W}val`);
      if (numId === undefined || numId === "0") continue;
      const ilvl = attr(child(numPr, `${W}ilvl`), `${W}val`) ?? "0";
      out.push(resolve(numId, ilvl));
    }
  }
  return out;
}

/** Table geometry and properties. Cell TEXT is excluded — it is already 20% of the score. */
function tablesFeature(d: LoadedDoc): string[] {
  const out: string[] = [];
  for (const { root } of comparedParts(d)) {
    for (const tbl of descendants(root, `${W}tbl`)) {
      const tblPr = child(tbl, `${W}tblPr`);
      const grid = children(child(tbl, `${W}tblGrid`), `${W}gridCol`).map((g) => attr(g, `${W}w`) ?? "?").join(",");
      const rows = children(tbl, `${W}tr`).map((tr) => {
        const trPr = child(tr, `${W}trPr`);
        const cells = children(tr, `${W}tc`).map((tc) => {
          const tcPr = child(tc, `${W}tcPr`);
          return tcPr ? canon(tcPr) : "-";
        });
        return `${trPr ? canon(trPr) : "-"}[${cells.join(";")}]`;
      });
      out.push(`${tblPr ? canon(tblPr) : "-"}|grid=${grid}|${rows.join("/")}`);
    }
  }
  return out;
}

function sectPrFeature(d: LoadedDoc): string[] {
  const out: string[] = [];
  for (const el of descendants(d.document ?? emptyNode(), `${W}sectPr`)) out.push(canon(el));
  return out;
}

/**
 * Header and footer parts, compared whole.
 *
 * Compared as an unordered bag of complete part trees, not by filename: `header2.xml` in one
 * package and `header1.xml` in another are the same header if their content is the same, and
 * which sectPr points at which is scored under `sectPr`.
 */
function headerFooterFeature(d: LoadedDoc): string[] {
  return [...d.headers.map((h) => `H${canon(h)}`), ...d.footers.map((f) => `F${canon(f)}`)];
}

function commentsFeature(d: LoadedDoc): string[] {
  const out: string[] = [];
  const root = child(d.comments ?? emptyNode(), `${W}comments`);
  for (const c of children(root, `${W}comment`)) {
    out.push([
      attr(c, `${W}author`) ?? "",
      attr(c, `${W}initials`) ?? "",
      allText(c).replace(/\s+/g, " ").trim(),
    ].join(""));
  }
  return out;
}

const REVISION_ELEMENTS = ["ins", "del", "moveFrom", "moveTo", "pPrChange", "rPrChange", "sectPrChange", "tblPrChange"];

function revisionsFeature(d: LoadedDoc): string[] {
  const out: string[] = [];
  for (const { root } of comparedParts(d)) {
    for (const name of REVISION_ELEMENTS) {
      for (const el of descendants(root, `${W}${name}`)) {
        out.push(`${name}${attr(el, `${W}author`) ?? ""}${allText(el).replace(/\s+/g, " ").trim()}`);
      }
    }
  }
  return out;
}

/**
 * The residual. Every element in every compared part, as a root-to-node path.
 *
 * This is what makes "we did not write an extractor for it" cost something. `normalize.ts`
 * rejects the rule "skip elements the scorer does not understand" precisely because it is
 * invisible; this is the positive form of that rejection.
 */
function structureFeature(d: LoadedDoc): string[] {
  const out: string[] = [];
  for (const { kind, root } of comparedParts(d)) {
    const walk = (n: XNode, path: string): void => {
      for (const c of n.children) {
        const p = `${path}/${c.local}`;
        out.push(p);
        walk(c, p);
      }
    };
    walk(root, kind);
  }
  return out;
}

function emptyNode(): XNode {
  return { name: "#empty", local: "#empty", attrs: new Map(), children: [], text: "", parent: null };
}

/* ------------------------------------------------------------------ scoring */

export interface FeatureScore {
  similarity: number;
  weight: number;
  /** Item counts on each side — the honest denominator behind the ratio. */
  origin: number;
  output: number;
  applicable: boolean;
  /** False when an LCS fell back to the order-blind coefficient because the input was huge. */
  exact: boolean;
}

export interface T2Diagnostics {
  /** Fraction of docProps/* parts carried through. Excluded from the score; see normalize.ts. */
  docPropsRetained: number;
  /** Fraction of styles.xml style definitions retained, INCLUDING the unreferenced ones. */
  latentStylesRetained: number;
  /** Fraction of origin zip entry names present in the output. */
  partsRetained: number;
  /** Fraction of word/media/* entries that are byte-identical. */
  mediaIdentical: number;
  /** Output size / origin size. */
  bytesRatio: number;
}

export interface T2Result {
  weighted: number;
  features: Record<string, FeatureScore>;
  diagnostics: T2Diagnostics;
}

export function scoreT2(originEntries: Unzipped, outputEntries: Unzipped): T2Result {
  const a = loadDoc(originEntries);
  const b = loadDoc(outputEntries);

  const seq = (name: FeatureName, x: string[], y: string[]): [FeatureName, FeatureScore] => {
    const applicable = x.length > 0 || y.length > 0;
    const { sim, exact } = lcsSim(x, y);
    return [name, { similarity: applicable ? sim : 1, weight: FEATURE_WEIGHTS[name], origin: x.length, output: y.length, applicable, exact }];
  };
  const bag = (name: FeatureName, x: string[], y: string[]): [FeatureName, FeatureScore] => {
    const applicable = x.length > 0 || y.length > 0;
    return [name, { similarity: applicable ? diceMultiset(x, y) : 1, weight: FEATURE_WEIGHTS[name], origin: x.length, output: y.length, applicable, exact: true }];
  };

  const stylesA = stylesFeature(a);
  const stylesB = stylesFeature(b);

  const entries: Array<[FeatureName, FeatureScore]> = [
    seq("text", textFeature(a), textFeature(b)),
    bag("structure", structureFeature(a), structureFeature(b)),
    ["styles", {
      similarity: stylesA.size === 0 && stylesB.size === 0 ? 1 : mapSim(stylesA, stylesB),
      weight: FEATURE_WEIGHTS.styles, origin: stylesA.size, output: stylesB.size,
      applicable: stylesA.size > 0 || stylesB.size > 0, exact: true,
    }],
    seq("numbering", numberingFeature(a), numberingFeature(b)),
    seq("tables", tablesFeature(a), tablesFeature(b)),
    bag("headersFooters", headerFooterFeature(a), headerFooterFeature(b)),
    seq("sectPr", sectPrFeature(a), sectPrFeature(b)),
    bag("comments", commentsFeature(a), commentsFeature(b)),
    bag("revisions", revisionsFeature(a), revisionsFeature(b)),
    seq("runs", runsFeature(a), runsFeature(b)),
  ];

  let num = 0;
  let den = 0;
  const features: Record<string, FeatureScore> = {};
  for (const [name, score] of entries) {
    features[name] = score;
    if (!score.applicable) continue;   // renormalise: nothing to lose is not a win
    num += score.similarity * score.weight;
    den += score.weight;
  }

  return {
    weighted: den === 0 ? 1 : num / den,
    features,
    diagnostics: diagnose(originEntries, outputEntries, a, b),
  };
}

function diagnose(origin: Unzipped, output: Unzipped, a: LoadedDoc, b: LoadedDoc): T2Diagnostics {
  const originNames = Object.keys(origin);
  const outputNames = new Set(Object.keys(output));

  const docProps = originNames.filter((n) => n.startsWith("docProps/"));
  const docPropsRetained = docProps.length === 0 ? 1 : docProps.filter((n) => outputNames.has(n)).length / docProps.length;

  const countStyles = (d: LoadedDoc): number => children(child(d.styles ?? emptyNode(), `${W}styles`), `${W}style`).length;
  const sa = countStyles(a);
  const latentStylesRetained = sa === 0 ? 1 : Math.min(1, countStyles(b) / sa);

  const partsRetained = originNames.length === 0 ? 1 : originNames.filter((n) => outputNames.has(n)).length / originNames.length;

  const media = originNames.filter((n) => n.startsWith("word/media/"));
  const mediaIdentical = media.length === 0 ? 1
    : media.filter((n) => {
      const x = origin[n]!;
      const y = output[n];
      if (!y || y.length !== x.length) return false;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
      return true;
    }).length / media.length;

  const size = (u: Unzipped): number => Object.values(u).reduce((n, v) => n + v.length, 0);
  const originSize = size(origin);

  return {
    docPropsRetained,
    latentStylesRetained,
    partsRetained,
    mediaIdentical,
    bytesRatio: originSize === 0 ? 1 : size(output) / originSize,
  };
}
