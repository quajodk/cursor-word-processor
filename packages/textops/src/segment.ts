import { SENTENCE_SUPPRESSIONS } from "./data/locale-data";

/**
 * Word and sentence segmentation.
 *
 * `Intl.Segmenter` does the Unicode work — it is the only thing in the platform that gets
 * word and sentence boundaries right for Hindi, Japanese, Arabic and Polish as well as
 * English, and the corpus contains all of those. What it does NOT do is suppress the
 * sentence break after an abbreviation: it ends a sentence at "Dr." and at "U.S." because
 * UAX #29 has no opinion about which full stops are abbreviations. That gap is closed here
 * by merging across a break whose preceding text ends in a known suppression.
 *
 * The suppression list is DATA (CLDR + pragmatic_segmenter, see ./data/locale-data.ts). The
 * algorithm below never names a word. Swap the table and the behaviour follows — which is
 * what keeps this from being the hard-coded special-casing the house rules forbid.
 */

export interface Range {
  /** Offset of the first character, in UTF-16 units within the block text. */
  start: number;
  /** Offset just past the last character. */
  end: number;
}

const segmenters = new Map<string, Intl.Segmenter>();
function segmenter(locale: string, granularity: "word" | "sentence" | "grapheme"): Intl.Segmenter | null {
  const key = `${locale}:${granularity}`;
  let s = segmenters.get(key);
  if (s) return s;
  try {
    s = new Intl.Segmenter(locale, { granularity });
  } catch {
    try { s = new Intl.Segmenter("en", { granularity }); } catch { return null; }
  }
  segmenters.set(key, s);
  return s;
}

function suppressionsFor(locale: string): ReadonlySet<string> {
  const lang = locale.toLowerCase().split(/[-_]/)[0] ?? "en";
  const list = SENTENCE_SUPPRESSIONS[lang] ?? SENTENCE_SUPPRESSIONS["en"] ?? [];
  let set = suppressionCache.get(lang);
  if (!set) { set = new Set(list); suppressionCache.set(lang, set); }
  return set;
}
const suppressionCache = new Map<string, Set<string>>();

/** Word ranges, excluding whitespace and punctuation runs. */
export function words(text: string, locale = "en"): Range[] {
  const seg = segmenter(locale, "word");
  const out: Range[] = [];
  if (!seg) {
    const re = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*/gu;
    for (let m = re.exec(text); m; m = re.exec(text)) out.push({ start: m.index, end: m.index + m[0].length });
    return out;
  }
  for (const s of seg.segment(text)) {
    if (!s.isWordLike) continue;
    out.push({ start: s.index, end: s.index + s.segment.length });
  }
  return out;
}

/** The word containing or immediately touching `offset`, or null. */
export function wordAt(text: string, offset: number, locale = "en"): Range | null {
  for (const w of words(text, locale)) {
    if (offset >= w.start && offset <= w.end) return w;
    if (w.start > offset) break;
  }
  return null;
}

/**
 * The last whitespace-delimited token ending at `end`, lowercased. This is what a suppression
 * is matched against, so "Washington, D.C." tests "d.c." rather than the whole clause.
 */
function trailingToken(text: string, end: number): string {
  let i = end;
  while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
  return text.slice(i, end).toLowerCase();
}

/**
 * Sentence ranges, with abbreviation breaks suppressed.
 *
 * Trailing whitespace stays OUT of the range: "select the sentence" should not swallow the
 * space before the next one, or repeatedly expanding selection creeps forward.
 */
export function sentences(text: string, locale = "en"): Range[] {
  const seg = segmenter(locale, "sentence");
  const supp = suppressionsFor(locale);
  const raw: Range[] = [];

  if (!seg) {
    let start = 0;
    const re = /[.!?][)"'”’\]]*(\s|$)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      raw.push({ start, end: m.index + m[0].length });
      start = m.index + m[0].length;
    }
    if (start < text.length) raw.push({ start, end: text.length });
  } else {
    for (const s of seg.segment(text)) raw.push({ start: s.index, end: s.index + s.segment.length });
  }

  // Merge across a break that only happened because of an abbreviation, a decimal point, or
  // an initial ("J. R. R. Tolkien" is one sentence, and each of those is a suppression of
  // length two that no word list will ever enumerate).
  const merged: Range[] = [];
  for (const r of raw) {
    const prev = merged[merged.length - 1];
    if (prev && shouldMerge(text, prev.end, supp)) { prev.end = r.end; continue; }
    merged.push({ ...r });
  }

  // Trim trailing whitespace out of each range.
  for (const r of merged) {
    while (r.end > r.start && /\s/.test(text[r.end - 1]!)) r.end--;
  }
  return merged.filter((r) => r.end > r.start);
}

/**
 * Should the break at `breakAt` be suppressed?
 *
 * Membership of the suppression list is necessary but NOT sufficient, because the published
 * lists contain entries that are also ordinary words: pragmatic_segmenter's German list has
 * "test.", so trusting the list alone merged "... ein Test. Noch einer." into one sentence
 * that Intl.Segmenter had already split correctly. False merges are the worse failure — they
 * join sentences, and every sentence-level feature in the product (selection, diff, blame) is
 * then wrong for the rest of the paragraph.
 *
 * So the list is gated on abbreviation SHAPE, which is a structural property rather than a
 * named word, and holds across languages:
 *   - two or more dots  — "z.B.", "e.g.", "D.C.", "U.S."
 *   - a single letter   — "J.", an initial
 *   - three letters or fewer before the dot, and in the list — "Dr.", "Mr.", "etc.", "bzw."
 *
 * The cost is recall on longer abbreviations ("Prof.", "Abb."), which fall back to whatever
 * the platform segmenter decides. That is the right side to err on, and it is a real limit
 * rather than a hidden one.
 */
function shouldMerge(text: string, breakAt: number, supp: ReadonlySet<string>): boolean {
  let i = breakAt;
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  if (i === 0 || text[i - 1] !== ".") return false;
  const token = trailingToken(text, i);

  // An initial: a single letter and a dot.
  if (/^\p{L}\.$/u.test(token)) return true;
  // A decimal point with digits either side.
  if (/\d\.$/.test(token) && /^\d/.test(text.slice(breakAt).trimStart())) return true;
  // Multi-dot abbreviations cannot be ordinary words.
  if ((token.match(/\./g)?.length ?? 0) >= 2) return supp.has(token) || /^(\p{L}\.){2,}$/u.test(token);
  // Otherwise the list decides, but only for tokens short enough not to be plain words.
  const letters = token.slice(0, token.indexOf("."));
  return letters.length <= 3 && supp.has(token);
}

/** The sentence containing `offset`, or null. */
export function sentenceAt(text: string, offset: number, locale = "en"): Range | null {
  const all = sentences(text, locale);
  for (const s of all) if (offset >= s.start && offset <= s.end) return s;
  return all.length > 0 && offset > all[all.length - 1]!.end ? all[all.length - 1]! : null;
}
