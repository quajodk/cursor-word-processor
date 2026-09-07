/**
 * Word's numbering, computed into the labels a reader actually sees.
 *
 * WHY THIS EXISTS. 37 of the 288 corpus documents have headings that Word numbers
 * automatically — `1.`, `1.1`, `2.` — and none of that reached the editor. The numbering was
 * never LOST: it lives in the interned `w:pPr` and export reapplies it, so a round trip
 * preserves it (verified: `<w:numPr>` count 234 before an edit, 234 after). But the writer saw
 * `État des choses` where Word shows `2.1 État des choses`, and nothing said so.
 *
 * That is worse than it sounds for this project specifically. The blind-comparison task's
 * step 4 is *"add three references to numbered sections"* — you cannot reference a numbered
 * section whose number your editor does not show. Against Google Docs, on a standards draft,
 * that is the whole comparison.
 *
 * WHAT THIS DOES AND DOES NOT DO. It computes labels from `numbering.xml` and the document
 * order: counters per level, restarts, `lvlText` templates, and the number formats Word
 * actually emits. It does NOT attempt Word's full model — `w:numberingChange`, per-instance
 * `startOverride` interacting with revision marks, and legacy `w:ilfo` lists are not handled,
 * and each one is REPORTED rather than approximated, because a wrong section number is worse
 * than a missing one: a reader will act on it.
 */

export type NumFmt =
  | "decimal" | "decimalZero" | "upperRoman" | "lowerRoman" | "upperLetter" | "lowerLetter"
  | "ordinal" | "bullet" | "none" | "chicago";

/** One level of one abstract numbering definition. */
export interface LevelDef {
  ilvl: number;
  numFmt: string | null;
  /** e.g. `%1.%2` — the template, with `%n` standing for level n-1's counter. */
  lvlText: string | null;
  /** First value this level takes. Word's default is 1. */
  start: number;
  /**
   * `w:lvlRestart`. Absent means "restart whenever any higher level advances"; 0 means
   * never restart; n means restart when level n-1 advances.
   */
  lvlRestart: number | null;
  /** `w:isLgl`: render every level of the template as decimal regardless of its own format. */
  isLgl: boolean;
  /** Text between the number and the paragraph: tab, space or nothing. Not rendered here. */
  suff: string | null;
}

export interface NumDef {
  numId: string;
  abstractNumId: string | null;
  levels: Map<number, LevelDef>;
  /** `w:startOverride` per level, which resets the counter for this instance. */
  startOverride: Map<number, number>;
}

export interface NumberingTable {
  byNumId: Map<string, NumDef>;
  /** Anything present in numbering.xml that this does not model. Fed to the ledger. */
  unmodeled: string[];
}

/** A paragraph that participates in numbering, in document order. */
export interface NumberedParagraph {
  numId: string;
  ilvl: number;
}

const DEFAULT_LEVEL: Omit<LevelDef, "ilvl"> = {
  numFmt: "decimal", lvlText: null, start: 1, lvlRestart: null, isLgl: false, suff: null,
};

/**
 * Label every numbered paragraph, in document order.
 *
 * Returns one entry per input, `null` where the level is a bullet or explicitly unnumbered —
 * a bullet has no label a cross-reference could name, and inventing "1." for it would be a
 * fabrication.
 *
 * COUNTERS ARE KEYED BY ABSTRACT DEFINITION, not by `numId`. Two `w:num` entries pointing at
 * the same `w:abstractNum` continue one sequence in Word; keying by `numId` would restart the
 * numbering at every style change and produce a document full of "1."
 */
export function computeLabels(
  table: NumberingTable,
  paragraphs: readonly NumberedParagraph[],
): (string | null)[] {
  /** sequence key -> level -> current value */
  const counters = new Map<string, Map<number, number>>();
  const out: (string | null)[] = [];

  for (const p of paragraphs) {
    const def = table.byNumId.get(p.numId);
    if (!def) { out.push(null); continue; }

    const key = def.abstractNumId ?? `num:${def.numId}`;
    let seq = counters.get(key);
    if (!seq) { seq = new Map(); counters.set(key, seq); }

    const level = levelOf(def, p.ilvl);
    const fmt = normaliseFmt(level.numFmt);
    if (fmt === "bullet" || fmt === "none") {
      // A bullet still advances nothing and resets nothing: it is not part of a sequence.
      out.push(null);
      continue;
    }

    const startFor = (l: number) => def.startOverride.get(l) ?? levelOf(def, l).start;

    // Advance this level.
    const current = seq.get(p.ilvl);
    seq.set(p.ilvl, current === undefined ? startFor(p.ilvl) : current + 1);

    // Reset every deeper level whose restart rule says this advance resets it.
    for (let deeper = p.ilvl + 1; deeper < 9; deeper++) {
      const d = levelOf(def, deeper);
      // `lvlRestart = 0` means never restart. `lvlRestart = n` means restart only when level
      // n-1 advances. Absent means restart whenever any shallower level advances.
      if (d.lvlRestart === 0) continue;
      if (d.lvlRestart !== null && d.lvlRestart - 1 !== p.ilvl) continue;
      seq.delete(deeper);
    }

    out.push(render(level, def, seq, startFor));
  }
  return out;
}

function levelOf(def: NumDef, ilvl: number): LevelDef {
  return def.levels.get(ilvl) ?? { ilvl, ...DEFAULT_LEVEL };
}

/**
 * Fill the level's `lvlText` template.
 *
 * `%1` is level 0, `%2` is level 1, and so on — a one-based token naming a zero-based level,
 * which is the single easiest thing to get wrong here. A level with no template falls back to
 * its own number, because a heading with no label at all cannot be cross-referenced.
 */
function render(
  level: LevelDef,
  def: NumDef,
  seq: Map<number, number>,
  startFor: (l: number) => number,
): string {
  const value = (l: number) => seq.get(l) ?? startFor(l);
  const template = level.lvlText ?? `%${level.ilvl + 1}`;

  return template.replace(/%([1-9])/g, (_, digit: string) => {
    const l = Number(digit) - 1;
    // `isLgl` renders every component as decimal even when its own level is roman or alpha.
    const fmt = level.isLgl ? "decimal" : normaliseFmt(levelOf(def, l).numFmt);
    return format(value(l), fmt);
  });
}

function normaliseFmt(raw: string | null): NumFmt {
  switch (raw) {
    case "decimal": case "decimalZero": case "upperRoman": case "lowerRoman":
    case "upperLetter": case "lowerLetter": case "ordinal": case "bullet": case "none":
    case "chicago":
      return raw;
    case null: case undefined:
      return "decimal";
    default:
      // Word has a long tail of formats (ideographDigital, taiwaneseCounting, aiueoFullWidth,
      // …). Rendering one of those as a decimal is a visible approximation, so the caller is
      // told about it through `NumberingTable.unmodeled` rather than it passing silently.
      return "decimal";
  }
}

const ROMAN: [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

export function format(n: number, fmt: NumFmt): string {
  if (!Number.isFinite(n)) return "";
  switch (fmt) {
    case "decimalZero": return n < 10 ? `0${n}` : String(n);
    case "upperRoman": return roman(n).toUpperCase();
    case "lowerRoman": return roman(n);
    case "upperLetter": return letters(n).toUpperCase();
    case "lowerLetter": return letters(n);
    case "ordinal": return ordinal(n);
    case "chicago": return chicago(n);
    default: return String(n);
  }
}

function roman(n: number): string {
  if (n <= 0 || n > 3999) return String(n);
  let out = "", rest = n;
  for (const [value, sym] of ROMAN) {
    while (rest >= value) { out += sym; rest -= value; }
  }
  return out;
}

/** Word's alphabetic sequence: a…z, then aa, bb, cc — repeats, not base-26. */
function letters(n: number): string {
  if (n <= 0) return String(n);
  const i = (n - 1) % 26;
  const repeat = Math.floor((n - 1) / 26) + 1;
  return String.fromCharCode(97 + i).repeat(repeat);
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** Word's "chicago" is the footnote sequence: * † ‡ § then doubled. */
function chicago(n: number): string {
  const marks = ["*", "†", "‡", "§"];
  if (n <= 0) return String(n);
  const i = (n - 1) % marks.length;
  const repeat = Math.floor((n - 1) / marks.length) + 1;
  return marks[i]!.repeat(repeat);
}
