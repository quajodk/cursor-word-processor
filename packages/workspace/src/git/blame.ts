import type { BlameLine } from "@scriv/host-api";
import { segmentDocument, type SegmentOptions, type SegmentedDocument } from "../prose/segment";

/**
 * Blame at sentence granularity.
 *
 * `git blame` answers "who last touched this LINE", which in a hand-wrapped document is a
 * question nobody asked: one sentence spans three lines with three different authors, and
 * three sentences share one line. Rolling it up to sentences answers the question a writer
 * actually has — who wrote this thought.
 *
 * The interesting case is a sentence whose lines have different authors. Picking the most
 * recent, or the majority, would be a guess presented as a fact. It is reported as MIXED,
 * with the contributors listed, because "two people wrote this sentence together" is true and
 * useful, and choosing one of them silently is neither.
 */

export interface SentenceBlame {
  /** Index into `SegmentedDocument.sentences`. */
  sentence: number;
  text: string;
  /** Sole author when the sentence's lines agree, else null. */
  commit: string | null;
  author: string | null;
  timestamp: number | null;
  summary: string | null;
  /** True when the sentence's lines have more than one author. */
  mixed: boolean;
  /** Every contributor, most lines first. Length 1 unless `mixed`. */
  contributors: { commit: string; author: string; timestamp: number; summary: string; lines: number }[];
}

export interface BlameOptions extends SegmentOptions {
  /** Pre-segmented document, when the caller already has one. */
  document?: SegmentedDocument;
}

export function blameSentences(text: string, lines: BlameLine[], opts: BlameOptions = {}): SentenceBlame[] {
  const doc = opts.document ?? segmentDocument(text, opts);
  const byLine = new Map<number, BlameLine>();
  for (const l of lines) byLine.set(l.line, l);

  return doc.sentences.map((s) => {
    const counts = new Map<string, { commit: string; author: string; timestamp: number; summary: string; lines: number }>();
    for (let line = s.startLine; line <= s.endLine; line++) {
      const b = byLine.get(line);
      if (!b) continue;
      const prev = counts.get(b.commit);
      if (prev) prev.lines++;
      else counts.set(b.commit, { commit: b.commit, author: b.author, timestamp: b.timestamp, summary: b.summary, lines: 1 });
    }

    const contributors = [...counts.values()].sort((x, y) => y.lines - x.lines || y.timestamp - x.timestamp);
    const only = contributors.length === 1 ? contributors[0]! : null;
    return {
      sentence: s.index,
      text: s.text,
      commit: only?.commit ?? null,
      author: only?.author ?? null,
      timestamp: only?.timestamp ?? null,
      summary: only?.summary ?? null,
      mixed: contributors.length > 1,
      contributors,
    };
  });
}

/** Blame rolled up to paragraphs, for a gutter that would otherwise be unreadably dense. */
export function blameBlocks(text: string, lines: BlameLine[], opts: BlameOptions = {}): SentenceBlame[] {
  const doc = opts.document ?? segmentDocument(text, opts);
  const perSentence = blameSentences(text, lines, { ...opts, document: doc });
  return doc.blocks.map((block) => {
    const counts = new Map<string, { commit: string; author: string; timestamp: number; summary: string; lines: number }>();
    for (const si of block.sentences) {
      for (const c of perSentence[si]?.contributors ?? []) {
        const prev = counts.get(c.commit);
        if (prev) prev.lines += c.lines;
        else counts.set(c.commit, { ...c });
      }
    }
    const contributors = [...counts.values()].sort((x, y) => y.lines - x.lines || y.timestamp - x.timestamp);
    const only = contributors.length === 1 ? contributors[0]! : null;
    return {
      sentence: block.index,
      text: block.text,
      commit: only?.commit ?? null,
      author: only?.author ?? null,
      timestamp: only?.timestamp ?? null,
      summary: only?.summary ?? null,
      mixed: contributors.length > 1,
      contributors,
    };
  });
}
