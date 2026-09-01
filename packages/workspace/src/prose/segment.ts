/**
 * Sentence and block segmentation for prose.
 *
 * Two layers:
 *
 *  1. **Block layer** — splits Markdown into paragraphs, headings, list items, code fences,
 *     tables and block quotes, and records the heading path each block sits under. Sentence
 *     diffs are meaningless across a fence, and "line 412" is meaningless to a writer;
 *     "under *Chapter 3 › The Ballroom*" is not.
 *
 *  2. **Sentence layer** — `Intl.Segmenter` with `granularity: "sentence"`, i.e. the ICU
 *     implementation of UAX #29. That already gets decimals (`3.14`), closing quotes
 *     (`"…go." Then`), ellipses and lowercase continuations (`e.g. section 2.1`) right.
 *
 *     What UAX #29 deliberately does *not* do is resolve `ABBREV. Capitalised` — it has no
 *     lexicon, so `Dr. Smith` breaks. That case is genuinely lexical, so we repair it with
 *     an explicit, overridable abbreviation list plus two structural rules that need no
 *     lexicon at all (single-letter initials, and dotted acronyms). The list is *data* the
 *     caller can replace, not branching in the segmenter.
 */

import { normalizeSentence } from "./tokens";

/**
 * Abbreviations that are routinely followed by a capitalised word. Data, not policy:
 * pass your own via `SegmentOptions.abbreviations` for another language or house style.
 * Entries are compared lowercased and without the trailing period.
 */
export const DEFAULT_ABBREVIATIONS: readonly string[] = [
  // personal titles
  "mr", "mrs", "ms", "mx", "dr", "prof", "rev", "fr", "sr", "jr", "st", "sta", "ste",
  "hon", "gov", "pres", "sen", "rep", "gen", "col", "lt", "sgt", "capt", "cmdr", "adm",
  "maj", "supt", "insp", "msgr", "abp", "bp",
  // latin / editorial
  "etc", "vs", "viz", "cf", "al", "ibid", "op", "cit", "ca", "approx", "resp",
  // reference
  "fig", "figs", "eq", "eqs", "ch", "chap", "sec", "sect", "pp", "vol", "vols", "ed",
  "eds", "no", "nos", "art", "para", "ref", "refs", "app", "esp",
  // organisational
  "inc", "ltd", "co", "corp", "dept", "univ", "assn", "bros", "plc", "gmbh",
  // geographic
  "ave", "blvd", "rd", "mt", "ft", "pt", "is", "isl",
  // calendar
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sept", "sep", "oct", "nov", "dec",
  "mon", "tues", "tue", "wed", "thurs", "thur", "thu", "fri", "sat", "sun",
  // measurement
  "kg", "km", "cm", "mm", "lb", "lbs", "oz", "hr", "hrs", "min", "sec", "yr", "yrs",
];

export type BlockKind =
  | "paragraph"
  | "heading"
  | "list-item"
  | "code"
  | "blockquote"
  | "table"
  | "frontmatter"
  | "rule";

export interface Sentence {
  /** Index within `SegmentedDocument.sentences`. */
  index: number;
  /** Index of the owning block. */
  block: number;
  /** Sentence text, trimmed. */
  text: string;
  /** Character offset of `text` within the whole document. */
  start: number;
  /** Exclusive end offset of `text` within the whole document. */
  end: number;
  /** Case-folded, whitespace-collapsed form used for identity comparisons. */
  norm: string;
  /** 1-based line on which the sentence starts. */
  startLine: number;
  /** 1-based line on which the sentence ends. */
  endLine: number;
}

export interface Block {
  index: number;
  kind: BlockKind;
  /** Heading level, only for `kind === "heading"`. */
  level: number;
  /** Text of the block, verbatim (Markdown markers included). */
  text: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  /** Enclosing heading titles, outermost first. Empty at the top of the document. */
  headingPath: string[];
  /** Indices into `SegmentedDocument.sentences`. */
  sentences: number[];
}

export interface SegmentedDocument {
  text: string;
  blocks: Block[];
  sentences: Sentence[];
  /** Offset of the first character of each 1-based line; `lineStarts[0]` is unused. */
  lineStarts: number[];
}

export interface SegmentOptions {
  locale?: string;
  /** Overrides `DEFAULT_ABBREVIATIONS` entirely when provided. */
  abbreviations?: Iterable<string>;
  /** Treat the input as plain prose: no Markdown block rules. Default false. */
  plainText?: boolean;
}

const sentenceSegmenters = new Map<string, Intl.Segmenter>();

function sentenceSegmenter(locale: string): Intl.Segmenter {
  let s = sentenceSegmenters.get(locale);
  if (!s) {
    s = new Intl.Segmenter(locale, { granularity: "sentence" });
    sentenceSegmenters.set(locale, s);
  }
  return s;
}

/** `true` when a chunk ending here is a false sentence boundary that must be re-joined. */
function endsWithAbbreviation(chunk: string, abbrevs: Set<string>): boolean {
  const t = chunk.replace(/[\s ]+$/u, "");
  if (!t.endsWith(".")) return false;

  // Dotted acronym: "U.S.", "e.g.", "i.e.", "a.m." — structural, needs no lexicon.
  if (/(?:^|[^\p{L}\p{N}])(?:\p{L}\.){2,}$/u.test(t)) return true;

  // Single-letter initial: "J. R. R. Tolkien", "A. Turing" — structural.
  if (/(?:^|[\s([{"'“‘])\p{L}\.$/u.test(t)) return true;

  const m = /(\p{L}+)\.$/u.exec(t);
  if (!m) return false;
  return abbrevs.has(m[1]!.toLowerCase());
}

/**
 * Segment `text` into sentences, returning offsets relative to `text`.
 * Blank input yields no sentences.
 */
export function segmentSentences(
  text: string,
  opts: SegmentOptions = {},
): { text: string; start: number; end: number }[] {
  const locale = opts.locale ?? "en";
  const abbrevs = new Set(
    [...(opts.abbreviations ?? DEFAULT_ABBREVIATIONS)].map((a) => a.replace(/\.$/, "").toLowerCase()),
  );

  const raw: { start: number; end: number }[] = [];
  for (const seg of sentenceSegmenter(locale).segment(text)) {
    raw.push({ start: seg.index, end: seg.index + seg.segment.length });
  }

  // Re-join boundaries ICU could not resolve without a lexicon.
  const joined: { start: number; end: number }[] = [];
  for (const r of raw) {
    const prev = joined[joined.length - 1];
    if (prev !== undefined) {
      const prevText = text.slice(prev.start, prev.end);
      const isBlank = text.slice(r.start, r.end).trim() === "";
      if (isBlank || endsWithAbbreviation(prevText, abbrevs)) {
        prev.end = r.end;
        continue;
      }
    }
    joined.push({ ...r });
  }

  const out: { text: string; start: number; end: number }[] = [];
  for (const r of joined) {
    const slice = text.slice(r.start, r.end);
    const lead = slice.length - slice.trimStart().length;
    const trimmed = slice.trim();
    if (trimmed === "") continue;
    out.push({ text: trimmed, start: r.start + lead, end: r.start + lead + trimmed.length });
  }
  return out;
}

function computeLineStarts(text: string): number[] {
  // Index 0 is a placeholder so that lineStarts[n] is the start of 1-based line n.
  const starts = [0, 0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line number containing `offset`. */
export function lineAt(lineStarts: number[], offset: number): number {
  let lo = 1;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

interface RawBlock {
  kind: BlockKind;
  level: number;
  start: number;
  end: number;
}

const ATX = /^ {0,3}(#{1,6})(\s+|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(\s+|$)/;
const RULE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;

/** Split Markdown into blocks. Fences, tables and front matter are never sentence-split. */
function splitBlocks(text: string): RawBlock[] {
  const lines: { start: number; end: number; text: string }[] = [];
  let pos = 0;
  while (pos <= text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl === -1 ? text.length : nl;
    lines.push({ start: pos, end, text: text.slice(pos, end) });
    if (nl === -1) break;
    pos = nl + 1;
  }

  const blocks: RawBlock[] = [];
  let i = 0;

  // YAML front matter, only when it opens the file.
  if (lines.length > 0 && /^---\s*$/.test(lines[0]!.text)) {
    let j = 1;
    while (j < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[j]!.text)) j++;
    if (j < lines.length) {
      blocks.push({ kind: "frontmatter", level: 0, start: lines[0]!.start, end: lines[j]!.end });
      i = j + 1;
    }
  }

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.text.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line.text);
    if (fence) {
      const marker = fence[1]![0]!;
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^ {0,3}${marker === "`" ? "`" : "~"}{3,}\\s*$`).test(lines[j]!.text)) j++;
      const endLine = Math.min(j, lines.length - 1);
      blocks.push({ kind: "code", level: 0, start: line.start, end: lines[endLine]!.end });
      i = endLine + 1;
      continue;
    }

    const atx = ATX.exec(line.text);
    if (atx) {
      blocks.push({ kind: "heading", level: atx[1]!.length, start: line.start, end: line.end });
      i++;
      continue;
    }

    if (RULE.test(line.text)) {
      blocks.push({ kind: "rule", level: 0, start: line.start, end: line.end });
      i++;
      continue;
    }

    // Indented code block (four spaces), only when it does not continue a list item.
    if (/^ {4,}\S/.test(line.text) && (blocks.length === 0 || blocks[blocks.length - 1]!.kind !== "list-item")) {
      let j = i;
      while (j + 1 < lines.length && (/^ {4,}/.test(lines[j + 1]!.text) || lines[j + 1]!.text.trim() === "")) j++;
      while (j > i && lines[j]!.text.trim() === "") j--;
      blocks.push({ kind: "code", level: 0, start: line.start, end: lines[j]!.end });
      i = j + 1;
      continue;
    }

    const isQuote = /^ {0,3}>/.test(line.text);
    const isList = LIST_ITEM.test(line.text);
    const isTable = line.text.includes("|") && i + 1 < lines.length && /^[\s|:-]+$/.test(lines[i + 1]!.text) && lines[i + 1]!.text.includes("-");

    if (isTable) {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1]!.text.includes("|")) j++;
      blocks.push({ kind: "table", level: 0, start: line.start, end: lines[j]!.end });
      i = j + 1;
      continue;
    }

    // Run of continuation lines: stop at a blank line, a new list item, a fence,
    // a heading, a rule, or a change of quote-ness.
    let j = i;
    while (j + 1 < lines.length) {
      const next = lines[j + 1]!;
      if (next.text.trim() === "") break;
      if (LIST_ITEM.test(next.text)) break;
      if (FENCE.test(next.text) || ATX.test(next.text) || RULE.test(next.text)) break;
      if (/^ {0,3}>/.test(next.text) !== isQuote) break;
      if (!isQuote && !isList && SETEXT.test(next.text)) break;
      j++;
    }

    // Setext heading: paragraph text underlined by === or ---.
    if (!isQuote && !isList && j + 1 < lines.length && SETEXT.test(lines[j + 1]!.text) && lines[j + 1]!.text.trim() !== "") {
      const level = lines[j + 1]!.text.trim().startsWith("=") ? 1 : 2;
      blocks.push({ kind: "heading", level, start: line.start, end: lines[j]!.end });
      i = j + 2;
      continue;
    }

    blocks.push({
      kind: isQuote ? "blockquote" : isList ? "list-item" : "paragraph",
      level: 0,
      start: line.start,
      end: lines[j]!.end,
    });
    i = j + 1;
  }

  return blocks;
}

const PROSE_BLOCKS: ReadonlySet<BlockKind> = new Set<BlockKind>(["paragraph", "list-item", "blockquote"]);

/** Strip Markdown inline markers from heading text so heading paths read like prose. */
function headingTitle(raw: string): string {
  return raw
    .replace(/^ {0,3}#{1,6}\s*/, "")
    .replace(/\s*#+\s*$/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

/**
 * Segment a document into blocks and sentences.
 *
 * `opts.plainText` skips the Markdown block rules and treats the input as one prose body
 * split on blank lines — the right mode for a `.txt` file or for content extracted from
 * somewhere else.
 */
export function segmentDocument(text: string, opts: SegmentOptions = {}): SegmentedDocument {
  const lineStarts = computeLineStarts(text);
  const rawBlocks = opts.plainText ? splitPlainBlocks(text) : splitBlocks(text);

  const blocks: Block[] = [];
  const sentences: Sentence[] = [];
  const headingStack: { level: number; title: string }[] = [];

  for (const rb of rawBlocks) {
    const blockText = text.slice(rb.start, rb.end);
    const headingPath = headingStack.map((h) => h.title);
    const block: Block = {
      index: blocks.length,
      kind: rb.kind,
      level: rb.level,
      text: blockText,
      start: rb.start,
      end: rb.end,
      startLine: lineAt(lineStarts, rb.start),
      endLine: lineAt(lineStarts, Math.max(rb.start, rb.end - 1)),
      headingPath,
      sentences: [],
    };

    if (rb.kind === "heading") {
      const title = headingTitle(blockText);
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= rb.level) headingStack.pop();
      headingStack.push({ level: rb.level, title });
    }

    // Prose blocks get sentence-split; headings become a single sentence; code, tables,
    // rules and front matter stay whole (splitting them would be nonsense).
    let pieces: { text: string; start: number; end: number }[];
    if (PROSE_BLOCKS.has(rb.kind)) {
      pieces = segmentSentences(blockText, opts).map((p) => ({ ...p, start: p.start + rb.start, end: p.end + rb.start }));
    } else if (rb.kind === "heading") {
      const trimmed = blockText.trim();
      const lead = blockText.length - blockText.trimStart().length;
      pieces = trimmed === "" ? [] : [{ text: trimmed, start: rb.start + lead, end: rb.start + lead + trimmed.length }];
    } else {
      const trimmed = blockText.replace(/\s+$/u, "");
      pieces = trimmed === "" ? [] : [{ text: trimmed, start: rb.start, end: rb.start + trimmed.length }];
    }

    for (const p of pieces) {
      const s: Sentence = {
        index: sentences.length,
        block: block.index,
        text: p.text,
        start: p.start,
        end: p.end,
        norm: normalizeSentence(p.text),
        startLine: lineAt(lineStarts, p.start),
        endLine: lineAt(lineStarts, Math.max(p.start, p.end - 1)),
      };
      sentences.push(s);
      block.sentences.push(s.index);
    }

    blocks.push(block);
  }

  return { text, blocks, sentences, lineStarts };
}

function splitPlainBlocks(text: string): RawBlock[] {
  const out: RawBlock[] = [];
  const re = /\n[ \t]*\n/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > start) out.push({ kind: "paragraph", level: 0, start, end: m.index });
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push({ kind: "paragraph", level: 0, start, end: text.length });
  return out.filter((b) => text.slice(b.start, b.end).trim() !== "");
}

/** Human-readable location for a sentence: heading path plus block kind. */
export function sentenceLocation(doc: SegmentedDocument, sentenceIndex: number): string {
  const s = doc.sentences[sentenceIndex];
  if (!s) return "";
  const b = doc.blocks[s.block]!;
  const path = b.headingPath.filter((p) => p !== "");
  return path.length > 0 ? path.join(" › ") : "(document root)";
}
