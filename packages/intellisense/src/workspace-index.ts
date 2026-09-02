import type { Node as PMNode } from "prosemirror-model";
import { sentences } from "@scriv/textops";
import { extractBibtex, extractSymbols } from "./extract";

/**
 * Offsets at which a capital letter is explained by POSITION rather than by being a name.
 *
 * Sentence starts are the obvious ones, but not the only ones: `Intl.Segmenter` does not end
 * a sentence at a bare line break, so in a block like "Fix the parser\nFix the lexer" the
 * second "Fix" reads as mid-sentence and earns credit as a proper name. Changelogs and bullet
 * lists are made almost entirely of such lines, which is how "Fix", "Add", "The" and "This"
 * ended up as the most frequent "entities" in a 40-document sample.
 */
const CLAUSE_END = /[)\]}>:|\u2014\u2013\u2022]/u;

function positionalStarts(text: string): number[] {
  const out = sentences(text).map((s) => s.start);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    // A line break, or a structural clause end. Reference documentation is full of the
    // latter -- "{DTLSSession} The new session." puts a capital after a type annotation,
    // which no sentence segmenter treats as a boundary but which explains the capital just
    // as completely as a full stop would. This is punctuation shape, not a word list, so it
    // holds in every language the corpus contains.
    if (ch !== "\n" && !CLAUSE_END.test(ch)) continue;
    let j = i + 1;
    while (j < text.length && /[ \t]/.test(text[j]!)) j++;
    if (j > i + 1 || ch === "\n") out.push(j);
  }
  return out;
}
import type { ProseSymbol } from "./types";

/**
 * The workspace symbol table.
 *
 * Held per document so a single edit re-indexes one file rather than the workspace, then
 * merged on read. Merging is where frequency becomes meaningful: a name used once in each of
 * nine chapters is a far better completion than one used nine times in a single paragraph,
 * and only a workspace-level view can tell those apart.
 */
export class WorkspaceIndex {
  private readonly byPath = new Map<string, ProseSymbol[]>();
  private merged: ProseSymbol[] | null = null;

  /** Index one document. Replaces anything previously held for that path. */
  setDocument(path: string, doc: PMNode): void {
    this.byPath.set(path, extractSymbols(doc, { path, sentenceStarts: positionalStarts }));
    this.merged = null;
  }

  /** Index a bibliography file, so citations complete before they are ever used. */
  setBibliography(path: string, source: string): void {
    this.byPath.set(path, extractBibtex(source, path));
    this.merged = null;
  }

  remove(path: string): void {
    if (this.byPath.delete(path)) this.merged = null;
  }

  get documentCount(): number {
    return this.byPath.size;
  }

  /**
   * Every symbol, with duplicates collapsed across files.
   *
   * The number of FILES a symbol appears in is tracked separately from how often it occurs,
   * because they mean different things: a name used once in each of nine chapters is a better
   * completion than one used nine times in a single paragraph.
   */
  symbols(): ProseSymbol[] {
    if (this.merged) return this.merged;
    const acc = new Map<string, ProseSymbol & { documents: number }>();
    for (const list of this.byPath.values()) {
      const seenHere = new Set<string>();
      for (const sym of list) {
        const key = `${sym.kind} ${sym.label}`;
        const prev = acc.get(key);
        if (!prev) {
          acc.set(key, { ...sym, documents: 1 });
          seenHere.add(key);
          continue;
        }
        prev.frequency += sym.frequency;
        if (!seenHere.has(key)) {
          prev.documents++;
          seenHere.add(key);
        }
        if (!prev.documentation && sym.documentation) prev.documentation = sym.documentation;
      }
    }
    const out = [...acc.values()].map((s) => {
      const { documents, ...rest } = s;
      return documents > 1 ? { ...rest, detail: `${rest.detail}, ${documents} files` } : rest;
    });
    this.merged = out;
    return out;
  }
}
