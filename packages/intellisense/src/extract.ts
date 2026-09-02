import type { Node as PMNode } from "prosemirror-model";
import type { ProseSymbol } from "./types";

/**
 * Pull symbols out of one document.
 *
 * Everything here is derived from structure or from statistics, never from a word list. The
 * corpus contains Hindi, Polish, French and German documents, and a rule that only fires on
 * English is the hard-coded special-casing the house rules forbid.
 */

/** `[@key]`, the pandoc/citeproc convention, and `@key` inside a citation bracket. */
const CITATION = /\[(-?@[\p{L}\d_][\p{L}\d_:.#$%&+?<>~/-]*(?:\s*;\s*-?@[\p{L}\d_][\p{L}\d_:.#$%&+?<>~/-]*)*)\]/gu;
const CITE_KEY = /-?@([\p{L}\d_][\p{L}\d_:.#$%&+?<>~/-]*)/gu;

/**
 * A capitalised token, by Unicode rather than by A–Z. Scripts without case (Devanagari, Han,
 * Arabic) have no uppercase, so entity detection simply finds nothing there rather than
 * producing garbage — an honest empty result, not a wrong one.
 */
function isCapitalised(token: string): boolean {
  const first = token[0];
  if (!first) return false;
  return first !== first.toLowerCase() && first === first.toUpperCase();
}

const STOP_AT = /[.!?;:,()[\]{}"“”'’]/u;

export interface ExtractOptions {
  path: string;
  /** Sentence starts as offsets into the block, used to discount sentence-initial capitals. */
  sentenceStarts?: (blockText: string) => number[];
}

/** Text of a textblock, with inline leaves flattened. */
function blockText(node: PMNode): string {
  return node.textBetween(0, node.content.size, "\n", " ");
}

export function extractSymbols(doc: PMNode, opts: ExtractOptions): ProseSymbol[] {
  const out: ProseSymbol[] = [];
  const entityCounts = new Map<string, { total: number; nonInitial: number }>();
  const citationCounts = new Map<string, number>();

  doc.descendants((node) => {
    if (node.type.name === "heading") {
      const text = blockText(node).trim();
      if (text) {
        out.push({
          kind: "heading",
          label: text,
          detail: `§ ${opts.path}`,
          path: opts.path,
          frequency: 1,
          level: node.attrs.level ?? 1,
        });
      }
      return true;
    }
    if (!node.isTextblock) return true;

    const text = blockText(node);

    // --- citations ---
    for (const m of text.matchAll(CITATION)) {
      for (const k of m[1]!.matchAll(CITE_KEY)) {
        const key = k[1]!;
        citationCounts.set(key, (citationCounts.get(key) ?? 0) + 1);
      }
    }

    // --- entities ---
    const starts = new Set(opts.sentenceStarts ? opts.sentenceStarts(text) : [0]);
    let i = 0;
    while (i < text.length) {
      if (/\s/.test(text[i]!)) { i++; continue; }
      const tokenStart = i;
      while (i < text.length && !/\s/.test(text[i]!)) i++;
      const token = text.slice(tokenStart, i);
      const clean = token.replace(STOP_AT, "");
      if (!isCapitalised(clean) || clean.length < 2) continue;

      // Extend across following capitalised tokens: "European Medicines Agency".
      let end = i;
      let phrase = clean;
      let j = i;
      while (j < text.length) {
        let k = j;
        while (k < text.length && /\s/.test(text[k]!)) k++;
        const ns = k;
        while (k < text.length && !/\s/.test(text[k]!)) k++;
        const next = text.slice(ns, k).replace(STOP_AT, "");
        if (!next || !isCapitalised(next) || next.length < 2) break;
        phrase += " " + next;
        end = k;
        j = k;
        // A terminator between the tokens ends the phrase.
        if (STOP_AT.test(text.slice(ns, k))) break;
      }
      i = end;

      // The discriminating signal: a word capitalised ONLY because it begins a sentence is
      // not a name. Requiring one occurrence away from a sentence start removes "The",
      // "However" and "Measurements" without needing a stop-word list for each language.
      const initial = starts.has(tokenStart);
      const record = (p: string, atStart: boolean) => {
        const rec = entityCounts.get(p) ?? { total: 0, nonInitial: 0 };
        rec.total++;
        if (!atStart) rec.nonInitial++;
        entityCounts.set(p, rec);
      };
      record(phrase, initial);

      // At a sentence start the first token is ambiguous: "The" in "The European Medicines
      // Agency" is capitalised by position, not because it is part of the name. Greedy
      // extension would swallow the real entity into a phrase that never appears again.
      // Both readings are recorded and the non-initial evidence decides between them.
      if (initial) {
        const space = phrase.indexOf(" ");
        if (space > 0) record(phrase.slice(space + 1), false);
      }
    }
    return true;
  });

  for (const [key, freq] of citationCounts) {
    out.push({ kind: "citation", label: `@${key}`, detail: `cited ${freq}×`, path: opts.path, frequency: freq });
  }

  for (const [phrase, rec] of entityCounts) {
    if (rec.total < 2) continue;
    // A MULTI-WORD capitalised phrase is almost certainly a name: ordinary prose does not
    // produce "European Medicines Agency" by accident. One mention away from a sentence
    // start is enough evidence.
    //
    // A SINGLE capitalised token is not: "Fix", "Add", "The", "This" open sentences, bullets
    // and changelog lines constantly, and a stray mid-sentence occurrence is easy to come by.
    // It has to be PREDOMINANTLY mid-sentence to count: at least half its occurrences away
    // from a positional boundary. That is what separates "CSS" (mid-sentence almost always)
    // from "The" (6 of 75), and it does so without an absolute floor, which would have
    // rejected a real name mentioned only twice.
    const multiWord = phrase.includes(" ");
    const enough = multiWord ? rec.nonInitial >= 1 : rec.nonInitial >= Math.max(1, rec.total * 0.5);
    if (!enough) continue;
    out.push({
      kind: "entity",
      label: phrase,
      detail: `${rec.total} mentions`,
      path: opts.path,
      frequency: rec.total,
    });
  }

  return out;
}

/** Bibliography keys from a BibTeX file, so citations complete before they are ever used. */
export function extractBibtex(source: string, path: string): ProseSymbol[] {
  const out: ProseSymbol[] = [];
  const entry = /@(\w+)\s*\{\s*([^,\s}]+)\s*,([\s\S]*?)\n\}/g;
  for (const m of source.matchAll(entry)) {
    const key = m[2]!;
    const body = m[3] ?? "";
    const title = /title\s*=\s*[{"]([^}"]*)/i.exec(body)?.[1]?.replace(/\s+/g, " ").trim();
    const author = /author\s*=\s*[{"]([^}"]*)/i.exec(body)?.[1]?.replace(/\s+/g, " ").trim();
    out.push({
      kind: "citation",
      label: `@${key}`,
      detail: m[1]!.toLowerCase(),
      documentation: [author, title].filter(Boolean).join(" — ") || undefined,
      path,
      frequency: 0,
    });
  }
  return out;
}
