/**
 * Unicode-aware tokenisation, shared by the sentence segmenter, the word-level differ and
 * the similarity metrics. Everything here is pure: it takes strings and returns data.
 *
 * We use `Intl.Segmenter` rather than a regex so that apostrophes, hyphenation, CJK and
 * combining marks behave the way ICU says they should, not the way a `\w+` pattern guesses.
 */

export interface Token {
  /** Token text exactly as it appears in the source. */
  text: string;
  /** Character offset of the token within the string it was taken from. */
  start: number;
  /** Exclusive end offset. */
  end: number;
  /** True for word-like tokens (letters/numbers), false for whitespace and punctuation. */
  wordLike: boolean;
}

const wordSegmenters = new Map<string, Intl.Segmenter>();

function wordSegmenter(locale: string): Intl.Segmenter {
  let s = wordSegmenters.get(locale);
  if (!s) {
    s = new Intl.Segmenter(locale, { granularity: "word" });
    wordSegmenters.set(locale, s);
  }
  return s;
}

/** Split `text` into word / non-word tokens with offsets. */
export function tokenize(text: string, locale = "en"): Token[] {
  const out: Token[] = [];
  for (const seg of wordSegmenter(locale).segment(text)) {
    out.push({ text: seg.segment, start: seg.index, end: seg.index + seg.segment.length, wordLike: seg.isWordLike === true });
  }
  return out;
}

/** Word-like tokens only, lowercased — the unit of comparison for similarity. */
export function words(text: string, locale = "en"): string[] {
  const out: string[] = [];
  for (const seg of wordSegmenter(locale).segment(text)) {
    if (seg.isWordLike) out.push(seg.segment.toLowerCase());
  }
  return out;
}

/**
 * Normalised form used for sentence identity. Case-folded, whitespace-collapsed, NFC.
 * Two sentences with the same normal form are treated as "the same sentence" for the
 * purposes of alignment and move detection.
 */
export function normalizeSentence(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * Dice coefficient over the multiset of word tokens. 1 = identical bag of words, 0 = disjoint.
 * Multiset (not set) so that repeated words are not silently collapsed.
 */
export function wordSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const w of a) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of b) {
    const n = counts.get(w);
    if (n !== undefined && n > 0) {
      counts.set(w, n - 1);
      common++;
    }
  }
  return (2 * common) / (a.length + b.length);
}

/**
 * Similarity of two sentences: word-bag Dice blended with a character-bigram Dice so that
 * short sentences ("Yes." vs "No.") and heavy rewordings still get a sensible number.
 */
export function sentenceSimilarity(a: string, b: string, locale = "en"): number {
  const wa = words(a, locale);
  const wb = words(b, locale);
  const dice = wordSimilarity(wa, wb);
  // Very short sentences carry too few words for the bag to mean anything.
  if (wa.length <= 3 || wb.length <= 3) {
    return Math.max(dice, bigramSimilarity(normalizeSentence(a), normalizeSentence(b)));
  }
  return dice;
}

/** Dice coefficient over character bigrams. */
export function bigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let common = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = counts.get(g);
    if (n !== undefined && n > 0) {
      counts.set(g, n - 1);
      common++;
    }
  }
  return (2 * common) / (a.length - 1 + (b.length - 1));
}
