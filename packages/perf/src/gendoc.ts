/**
 * Builds the 40k-word benchmark document out of the real corpus.
 *
 * Requirements this is trying to satisfy:
 *  - ~40,000 words and ~2,000 top-level blocks (ARCHITECTURE §5 / task brief).
 *  - A realistic block mix. A document that is 2,000 identical paragraphs is a much easier
 *    document than a real one: no nested list_items, no table cells, no defining nodes for
 *    position mapping to walk through.
 *  - Inline marks at a realistic density. Marks cost on every step map and every slice.
 *  - Deterministic. The gate compares runs; the input must be byte-identical run to run,
 *    or the "regression" it reports is just a different document.
 *
 * The `aid` values are seeded rather than produced by newAid(), because newAid() is
 * time- and Math.random()-based by design. Nothing on the measured path reads an aid's
 * value — only its presence and uniqueness — so this changes nothing we measure and buys
 * a reproducible input.
 */

import type { Node as PMNode, Mark } from "prosemirror-model";
import { schema } from "@scriv/doc-model";
import { CORPUS } from "./budgets";
import { loadCorpus, countWords, type CorpusText } from "./corpus";

/** mulberry32 — small, fast, good enough, and reproducible across engines. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rand {
  next(): number;
  int(maxExclusive: number): number;
  range(lo: number, hiInclusive: number): number;
  pick<T>(xs: readonly T[]): T;
  chance(p: number): boolean;
}

function makeRand(seed: number): Rand {
  const r = rng(seed);
  const int = (n: number) => Math.floor(r() * n);
  return {
    next: r,
    int,
    range: (lo, hi) => lo + int(hi - lo + 1),
    pick: (xs) => xs[int(xs.length)]!,
    chance: (p) => r() < p,
  };
}

/** Sentence-level view of the corpus, so generated blocks are made of whole sentences. */
export interface Sentences {
  /** Every sentence in the corpus, in order, per book. */
  byBook: string[][];
  all: string[];
  /** Short ones, for headings, list items and table cells. */
  short: string[];
}

const WS = /\s+/g;

export function splitSentences(text: string): string[] {
  // Paragraph-aware, then sentence-terminator aware. Deliberately simple: the goal is
  // realistic token/length distributions, not linguistic correctness.
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const flat = para.replace(WS, " ").trim();
    if (flat.length < 20) continue;
    const parts = flat.split(/(?<=[.!?][")”’]?)\s+(?=[A-Z"“(])/);
    for (const p of parts) {
      const s = p.trim();
      if (s.length >= 15 && s.length <= 600) out.push(s);
    }
  }
  return out;
}

export async function loadSentences(): Promise<{ sentences: Sentences; corpus: CorpusText[] }> {
  const corpus = await loadCorpus();
  const byBook = corpus.map((c) => splitSentences(c.text));
  const all: string[] = [];
  // Interleave books so the document changes register the way a real long document does,
  // rather than being four homogeneous halves.
  const maxLen = Math.max(...byBook.map((b) => b.length));
  for (let i = 0; i < maxLen; i++) for (const b of byBook) if (i < b.length) all.push(b[i]!);
  const short = all.filter((s) => s.length >= 20 && s.length <= 90);
  if (all.length < 5000) throw new Error(`corpus too small: only ${all.length} sentences`);
  return { sentences: { byBook, all, short }, corpus };
}

// ---------------------------------------------------------------------------------------

const MARKED_WORD_RATE = 0.045; // fraction of words carrying an inline mark
const LINK_HOSTS = ["example.org", "docs.internal", "archive.org", "standards.example"];

function seededAid(rand: Rand): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += "0123456789abcdef"[rand.int(16)];
  return s;
}

/**
 * Turns a plain string into inline content with realistic mark density. Marks are applied
 * to word runs, not characters, and never split a word — which is what a real import
 * produces and what makes mark boundaries land where a typist's caret lands.
 */
function inlineFrom(text: string, rand: Rand, opts: { allowLinks?: boolean } = {}): PMNode[] {
  const words = text.split(" ");
  const out: PMNode[] = [];
  let buf: string[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    out.push(schema.text(buf.join(" ")));
    buf = [];
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.length === 0) continue;
    if (!rand.chance(MARKED_WORD_RATE) || w.length < 3) { buf.push(w); continue; }

    const span = Math.min(words.length - i, rand.range(1, 4));
    const chunk = words.slice(i, i + span).join(" ");
    i += span - 1;

    let mark: Mark;
    const roll = rand.next();
    if (roll < 0.32) mark = schema.marks.strong!.create();
    else if (roll < 0.66) mark = schema.marks.em!.create();
    else if (roll < 0.74) mark = schema.marks.code!.create();
    else if (roll < 0.8) mark = schema.marks.underline!.create();
    else if (roll < 0.86) mark = schema.marks.strike!.create();
    else if (roll < 0.93 && (opts.allowLinks ?? true)) {
      mark = schema.marks.link!.create({ href: `https://${rand.pick(LINK_HOSTS)}/r/${seededAid(rand)}` });
    } else {
      // rPrRef: unmodeled Word run formatting carried by reference. Real imported
      // documents are full of these and they are marks like any other on the hot path.
      mark = schema.marks.rPrRef!.create({ ref: seededAid(rand) });
    }

    // Text preceding the marked run has to be flushed with a trailing space preserved.
    if (buf.length > 0) { out.push(schema.text(buf.join(" ") + " ")); buf = []; }
    else if (out.length > 0) out.push(schema.text(" "));
    out.push(schema.text(chunk, [mark]));
    if (i < words.length - 1) buf.push("");
  }
  flush();

  // Guard: ProseMirror rejects empty text nodes.
  const clean = out.filter((n) => n.text === undefined || n.text.length > 0);
  return clean.length > 0 ? clean : [schema.text(text || "…")];
}

function headingText(s: string, rand: Rand): string {
  const words = s.replace(/[.,;:!?"'“”]/g, "").split(" ").filter(Boolean);
  const n = Math.min(words.length, rand.range(2, 7));
  const start = words.length > n ? rand.int(words.length - n) : 0;
  const phrase = words.slice(start, start + n).join(" ");
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

// ---------------------------------------------------------------------------------------

export interface GeneratedDoc {
  doc: PMNode;
  json: unknown;
  stats: {
    words: number;
    topLevelBlocks: number;
    totalNodes: number;
    textNodes: number;
    markedTextNodes: number;
    docSize: number;
    blockMix: Record<string, number>;
    corpus: { title: string; words: number }[];
  };
}

export async function generateDoc(
  opts: { targetWords?: number; targetBlocks?: number; seed?: number } = {},
): Promise<GeneratedDoc> {
  const targetWords = opts.targetWords ?? CORPUS.targetWords;
  const targetBlocks = opts.targetBlocks ?? CORPUS.targetBlocks;
  const rand = makeRand(opts.seed ?? CORPUS.seed);
  const { sentences, corpus } = await loadSentences();

  const S = sentences.all;
  const SHORT = sentences.short;
  let cursor = rand.int(S.length);
  const nextSentence = () => S[cursor++ % S.length]!;
  let shortCursor = rand.int(SHORT.length);
  const nextShort = () => SHORT[shortCursor++ % SHORT.length]!;

  const blocks: PMNode[] = [];
  const mix: Record<string, number> = {};
  let words = 0;
  const bump = (k: string) => { mix[k] = (mix[k] ?? 0) + 1; };
  const attrs = () => ({ aid: seededAid(rand), styleId: null, pPrRef: null });

  const para = (sentenceCount: number, styleId: string | null = null) => {
    const parts: string[] = [];
    for (let i = 0; i < sentenceCount; i++) parts.push(nextSentence());
    const text = parts.join(" ");
    words += countWords(text);
    return schema.nodes.paragraph!.create({ ...attrs(), styleId }, inlineFrom(text, rand));
  };

  // Block mix, chosen to look like a long report rather than a novel: mostly paragraphs,
  // a real heading skeleton, meaningful list and table presence, occasional quote/code/hr.
  while (blocks.length < targetBlocks && words < targetWords) {
    const remainingBlocks = targetBlocks - blocks.length;
    const roll = rand.next();

    if (roll < 0.075) {
      // heading
      const level = rand.chance(0.12) ? 1 : rand.chance(0.45) ? 2 : rand.chance(0.7) ? 3 : 4;
      const t = headingText(nextShort(), rand);
      words += countWords(t);
      blocks.push(schema.nodes.heading!.create({ ...attrs(), level, styleId: `Heading${level}` }, inlineFrom(t, rand, { allowLinks: false })));
      bump(`heading${level}`);
    } else if (roll < 0.185 && remainingBlocks > 1) {
      // list — bullet or ordered, 3-9 items, some items multi-paragraph
      const ordered = rand.chance(0.4);
      const itemCount = rand.range(3, 9);
      const items: PMNode[] = [];
      for (let i = 0; i < itemCount; i++) {
        const content: PMNode[] = [para(rand.chance(0.25) ? 2 : 1)];
        if (rand.chance(0.12)) content.push(para(1));
        items.push(schema.nodes.list_item!.create(attrs(), content));
      }
      const type = ordered ? schema.nodes.ordered_list! : schema.nodes.bullet_list!;
      const listAttrs = ordered
        ? { ...attrs(), numRef: seededAid(rand), start: 1 }
        : { ...attrs(), numRef: seededAid(rand) };
      blocks.push(type.create(listAttrs, items));
      bump(ordered ? "ordered_list" : "bullet_list");
    } else if (roll < 0.215 && remainingBlocks > 1) {
      // table — prosemirror-tables nodes, header row + body, cells hold paragraphs
      const cols = rand.range(2, 5);
      const rows = rand.range(3, 9);
      const cell = (header: boolean) => {
        const t = nextShort().slice(0, rand.range(12, 48));
        words += countWords(t);
        const p = schema.nodes.paragraph!.create({ ...attrs(), styleId: null }, inlineFrom(t, rand, { allowLinks: false }));
        const type = header ? schema.nodes.table_header! : schema.nodes.table_cell!;
        return type.create({ colspan: 1, rowspan: 1, colwidth: null, tcPrRef: rand.chance(0.3) ? seededAid(rand) : null }, [p]);
      };
      const rowNodes: PMNode[] = [];
      rowNodes.push(schema.nodes.table_row!.create(null, Array.from({ length: cols }, () => cell(true))));
      for (let r = 0; r < rows; r++) {
        rowNodes.push(schema.nodes.table_row!.create(null, Array.from({ length: cols }, () => cell(false))));
      }
      blocks.push(schema.nodes.table!.create(attrs(), rowNodes));
      bump("table");
    } else if (roll < 0.235) {
      const inner = [para(rand.range(1, 3))];
      blocks.push(schema.nodes.blockquote!.create(attrs(), inner));
      bump("blockquote");
    } else if (roll < 0.25) {
      const lines: string[] = [];
      for (let i = 0; i < rand.range(3, 10); i++) lines.push(nextShort().slice(0, rand.range(20, 70)));
      const t = lines.join("\n");
      words += countWords(t);
      blocks.push(schema.nodes.code_block!.create({ ...attrs(), lang: rand.pick(["ts", "py", "sh", null]) }, [schema.text(t)]));
      bump("code_block");
    } else if (roll < 0.258) {
      blocks.push(schema.nodes.horizontal_rule!.create(attrs()));
      bump("horizontal_rule");
    } else {
      blocks.push(para(rand.range(2, 9)));
      bump("paragraph");
    }
  }

  // Top up words with paragraphs if the mix came in light, so the doc really is 40k words.
  while (words < targetWords) { blocks.push(para(rand.range(3, 8))); bump("paragraph"); }

  const doc = schema.nodes.doc!.create(null, blocks);

  let totalNodes = 0, textNodes = 0, markedTextNodes = 0;
  doc.descendants((n) => {
    totalNodes++;
    if (n.isText) { textNodes++; if (n.marks.length > 0) markedTextNodes++; }
    return true;
  });

  return {
    doc,
    json: doc.toJSON(),
    stats: {
      words: countWords(doc.textBetween(0, doc.content.size, " ", " ")),
      topLevelBlocks: doc.childCount,
      totalNodes,
      textNodes,
      markedTextNodes,
      docSize: doc.content.size,
      blockMix: mix,
      corpus: corpus.map((c) => ({ title: c.title, words: c.words })),
    },
  };
}
