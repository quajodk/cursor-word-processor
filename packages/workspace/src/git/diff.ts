import { alignSentences, type AlignOptions } from "../prose/align";
import { segmentDocument, type SegmentOptions, type SegmentedDocument } from "../prose/segment";
import { diffWords, type WordDiff } from "../prose/word-diff";

/**
 * A document diff a writer can actually read.
 *
 * Line diffs are why writers never adopted git. Reflow one paragraph and every line in it is
 * marked changed; fix a typo in a hand-wrapped file and the diff is the whole paragraph. The
 * unit a writer thinks in is the sentence, so that is the unit here — with a word-level diff
 * *inside* each changed sentence, so a reworded clause shows which words moved rather than
 * two walls of colour.
 *
 * Moves are first class. In prose, relocating a section is the single most common structural
 * edit, and a line diff represents it as a large deletion beside a large insertion — the one
 * shape that guarantees the reader learns nothing.
 */

export type ChangeKind =
  /** Present on both sides, identical. */
  | "unchanged"
  /** Present on both sides, reworded. Carries a word diff. */
  | "reworded"
  /** Same text, different place. */
  | "moved"
  /** Same text, different place, AND reworded. */
  | "moved-and-reworded"
  /** One sentence became several. */
  | "split"
  /** Several sentences became one. */
  | "merged"
  | "inserted"
  | "deleted";

export interface SentenceChange {
  kind: ChangeKind;
  /** Old-side sentence indices. Empty for an insertion. */
  old: number[];
  /** New-side sentence indices. Empty for a deletion. */
  new: number[];
  oldText: string;
  newText: string;
  /** Word-level detail, only for kinds that changed text within a pair. */
  words?: WordDiff;
  /** Heading path on whichever side exists, so a hunk can say where it lives. */
  section: string[];
  /** 1-based line on the side that exists, for interoperability with ordinary git. */
  oldLine?: number;
  newLine?: number;
}

export interface DocumentDiff {
  changes: SentenceChange[];
  old: SegmentedDocument;
  new: SegmentedDocument;
  stats: {
    unchanged: number;
    reworded: number;
    moved: number;
    split: number;
    merged: number;
    inserted: number;
    deleted: number;
    /** Fraction of old sentences that survived in any form, 0..1. */
    retained: number;
  };
}

export interface DiffOptions extends AlignOptions, SegmentOptions {
  /** Include unchanged sentences in `changes`. Default false — a diff shows changes. */
  includeUnchanged?: boolean;
}

export function diffDocuments(oldText: string, newText: string, opts: DiffOptions = {}): DocumentDiff {
  const a = segmentDocument(oldText, opts);
  const b = segmentDocument(newText, opts);
  const alignment = alignSentences(a.sentences, b.sentences, opts);

  const changes: SentenceChange[] = [];
  const stats = { unchanged: 0, reworded: 0, moved: 0, split: 0, merged: 0, inserted: 0, deleted: 0, retained: 0 };

  const sectionOf = (doc: SegmentedDocument, idx: number | undefined): string[] =>
    idx === undefined ? [] : doc.blocks[doc.sentences[idx]?.block ?? -1]?.headingPath ?? [];

  for (const pair of alignment.pairs) {
    const oldText_ = pair.old.map((i) => a.sentences[i]!.text).join(" ");
    const newText_ = pair.new.map((i) => b.sentences[i]!.text).join(" ");
    const identical = a.sentences[pair.old[0]!]?.norm === b.sentences[pair.new[0]!]?.norm
      && pair.old.length === 1 && pair.new.length === 1;

    let kind: ChangeKind;
    if (pair.old.length > 1) kind = "merged";
    else if (pair.new.length > 1) kind = "split";
    else if (identical) kind = pair.moved ? "moved" : "unchanged";
    else kind = pair.moved ? "moved-and-reworded" : "reworded";

    if (kind === "unchanged") {
      stats.unchanged++;
      if (!opts.includeUnchanged) continue;
    } else if (kind === "moved") stats.moved++;
    else if (kind === "split") stats.split++;
    else if (kind === "merged") stats.merged++;
    else if (kind === "moved-and-reworded") { stats.moved++; stats.reworded++; }
    else stats.reworded++;

    changes.push({
      kind,
      old: pair.old,
      new: pair.new,
      oldText: oldText_,
      newText: newText_,
      // A word diff only means something when text actually changed within a pair.
      words: kind === "unchanged" || kind === "moved" ? undefined : diffWords(oldText_, newText_, opts.locale),
      section: sectionOf(b, pair.new[0]) .length > 0 ? sectionOf(b, pair.new[0]) : sectionOf(a, pair.old[0]),
      oldLine: a.sentences[pair.old[0]!]?.startLine,
      newLine: b.sentences[pair.new[0]!]?.startLine,
    });
  }

  for (const i of alignment.deleted) {
    stats.deleted++;
    changes.push({
      kind: "deleted", old: [i], new: [], oldText: a.sentences[i]!.text, newText: "",
      section: sectionOf(a, i), oldLine: a.sentences[i]!.startLine,
    });
  }
  for (const i of alignment.inserted) {
    stats.inserted++;
    changes.push({
      kind: "inserted", old: [], new: [i], oldText: "", newText: b.sentences[i]!.text,
      section: sectionOf(b, i), newLine: b.sentences[i]!.startLine,
    });
  }

  // Reading order: by where the change lands in the NEW document, since that is the text the
  // reader is looking at. A deletion sorts by where it used to be relative to its neighbours.
  changes.sort((x, y) => (x.new[0] ?? x.old[0] ?? 0) - (y.new[0] ?? y.old[0] ?? 0));

  const survived = a.sentences.length - stats.deleted;
  stats.retained = a.sentences.length === 0 ? 1 : survived / a.sentences.length;

  return { changes, old: a, new: b, stats };
}

/**
 * A `.gitattributes` recipe so ordinary `git diff` stays useful outside this editor.
 *
 * The repository must remain interoperable: a colleague on the command line, a code-review
 * tool, or CI should all still produce something readable. `textconv` reflows prose to one
 * sentence per line before git diffs it, which gives plain git a sentence-granular diff for
 * free without changing a byte of what is stored.
 */
export const GITATTRIBUTES_RECIPE = `# One sentence per line for diffing only; the stored file is untouched.
*.md diff=prose
*.markdown diff=prose
`;

export const GITCONFIG_RECIPE = `[diff "prose"]
\ttextconv = scriv sentences
\tcachetextconv = true
`;
