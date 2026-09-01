/**
 * The fidelity ledger.
 *
 * DOCX-FIDELITY.md 3: "Silent misapplication is worse than visible loss." Every time this
 * subsystem drops something, approximates something, or is not sure enough to apply formatting,
 * it says so here. The ledger is surfaced in the UI's fidelity panel, aggregated by the
 * round-trip scorer, and is the primary quality metric for docx support.
 *
 * The rule this file exists to enforce: **there is no such thing as a silent loss.** If a code
 * path in this package decides not to model something, it records the decision. A ledger that
 * is empty on a document with SmartArt is a bug in the ledger, not a triumph of the importer.
 */

export type LedgerSeverity =
  /** Modeled differently but nothing is lost on export - the splice still copies origin bytes. */
  | "info"
  /** Representable but weakened: the editor shows less than Word does, export still faithful. */
  | "degraded"
  /** Something will not survive a round trip through an edited document. */
  | "dropped";

export type LedgerStage = "import" | "anchor" | "export";

export type LedgerCode =
  // ---- import
  | "unsupported-package"        // not a WordprocessingML package we can index
  | "missing-part"               // a part the document references is absent
  | "unmodeled-body-element"     // body-level element we carry verbatim but do not model
  | "unmodeled-run-child"        // run child (w:object, w:pict, w:sym) not represented inline
  | "inline-drawing-detached"    // drawing inside a mixed paragraph: kept in sidecar, not inline
  | "field-flattened"            // w:fldSimple / instrText kept as its cached result text
  | "nested-table"               // nested w:tbl: modeled, but geometry is approximated
  | "table-identity-unbacked"    // prosemirror-tables nodes cannot carry `aid` (see README)
  | "vmerge-approximated"        // w:vMerge continuation mapped to rowspan heuristically
  | "content-control-unwrapped"  // w:sdt: content kept, the control itself is not modeled
  | "alt-chunk"                  // w:altChunk: foreign content, copied but never edited
  | "footnote-reference"         // reference kept as an anchor; body lives in another part
  | "comment-orphan"             // commentRangeStart with no end, or an id with no thread
  | "revision-unmodeled"         // moveFrom/moveTo/pPrChange/rPrChange: kept, not editable
  | "encoding-nonstandard"       // document.xml is not UTF-8
  | "xml-foreign-nodes"          // comments / PIs inside document.xml
  // ---- anchor
  | "anchor-low-confidence"      // below threshold: OOXML properties DROPPED, deliberately
  | "anchor-lost"                // stored anchor matched nothing in the current document
  | "anchor-split"               // one anchor became two blocks
  | "anchor-merged"              // two anchors became one block; the loser was retired
  | "anchor-inserted"            // a current block has no stored anchor: no origin properties
  | "anchor-ambiguous"           // best match was not decisively better than the runner-up
  | "comment-reanchored"         // a comment moved to a surviving block, with a penalty
  // ---- export (reserved for the splice engine; defined here so both share one vocabulary)
  | "splice-regenerated"         // a paragraph had to be rebuilt rather than copied
  | "splice-synthesized"         // a brand-new paragraph was synthesized
  | "splice-props-dropped";      // properties were not reapplied because confidence was low

export interface LedgerEntry {
  code: LedgerCode;
  severity: LedgerSeverity;
  stage: LedgerStage;
  /** Human-readable, one line. Never contains document text beyond a short excerpt. */
  detail: string;
  /** Block identity this concerns, when there is one. */
  aid?: string;
  /** Index of the block in the current document, when there is one. */
  blockIndex?: number;
  /** Zip part this concerns, e.g. "word/document.xml". */
  part?: string;
  /** Byte range in that part, when known. */
  range?: [number, number];
  /** Element name that triggered it, e.g. "w:object". */
  element?: string;
  /** Anchor confidence, for the anchor codes. */
  confidence?: number;
  /** Number of occurrences folded into this entry. */
  count: number;
}

export interface LedgerSummary {
  total: number;
  bySeverity: Record<LedgerSeverity, number>;
  byCode: Record<string, number>;
  /** True when nothing at all was lost or degraded. The bar we are aiming at. */
  clean: boolean;
  /** True when nothing was dropped, though something may have been degraded. */
  lossless: boolean;
}

type Key = string;

/**
 * Entries are folded by (stage, code, aid, element, part) so a document with 4000 unmodeled
 * `w:sym` runs produces one entry with `count: 4000` rather than 4000 entries. A ledger that is
 * itself unreadable does not surface anything.
 */
export class Ledger {
  private readonly map = new Map<Key, LedgerEntry>();
  private readonly order: Key[] = [];

  add(e: Omit<LedgerEntry, "count"> & { count?: number }): void {
    const key = `${e.stage} ${e.code} ${e.aid ?? ""} ${e.element ?? ""} ${e.part ?? ""}`;
    const found = this.map.get(key);
    if (found) {
      found.count += e.count ?? 1;
      // Keep the worst confidence seen: the ledger should report the weakest link.
      if (e.confidence !== undefined && (found.confidence === undefined || e.confidence < found.confidence)) {
        found.confidence = e.confidence;
      }
      return;
    }
    const entry: LedgerEntry = { ...e, count: e.count ?? 1 };
    this.map.set(key, entry);
    this.order.push(key);
  }

  /** Merge another ledger's entries in, preserving folding. */
  absorb(other: Ledger | readonly LedgerEntry[]): void {
    const list = other instanceof Ledger ? other.entries() : other;
    for (const e of list) this.add(e);
  }

  entries(): LedgerEntry[] {
    return this.order.map((k) => this.map.get(k)!);
  }

  get size(): number {
    return this.map.size;
  }

  summary(): LedgerSummary {
    const bySeverity: Record<LedgerSeverity, number> = { info: 0, degraded: 0, dropped: 0 };
    const byCode: Record<string, number> = {};
    let total = 0;
    for (const e of this.map.values()) {
      bySeverity[e.severity] += e.count;
      byCode[e.code] = (byCode[e.code] ?? 0) + e.count;
      total += e.count;
    }
    return {
      total,
      bySeverity,
      byCode,
      clean: bySeverity.degraded === 0 && bySeverity.dropped === 0,
      lossless: bySeverity.dropped === 0,
    };
  }

  static from(entries: readonly LedgerEntry[]): Ledger {
    const l = new Ledger();
    l.absorb(entries);
    return l;
  }
}

export function summarize(entries: readonly LedgerEntry[]): LedgerSummary {
  return Ledger.from(entries).summary();
}
