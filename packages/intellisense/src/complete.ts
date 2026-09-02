import type { CompletionContext, CompletionItem, ProseSymbol, SymbolKind, Trigger } from "./types";

/**
 * When to offer a completion, and in what order.
 *
 * The hard part of prose completion is not matching, it is RESTRAINT. Code completion can pop
 * on every identifier character because a programmer is always naming something. A writer is
 * usually just writing, and a popup that appears mid-sentence is an interruption, not a
 * feature — which is the single fastest way to lose the "drafting for an hour" comparison.
 *
 * So the popup opens on an explicit request, or on a sigil that means "I am about to name
 * something I have named before":
 *
 *   `@`  citations      — the pandoc convention, already muscle memory for academic writers
 *   `[[` cross-refs     — headings, the wiki-link convention
 *   `:`  snippets
 *
 * Entities and defined terms are offered only on explicit request or after enough characters
 * to be unambiguous, because those have no sigil and would otherwise fire constantly.
 */

/**
 * Bare words never open the popup on their own.
 *
 * Any threshold low enough to be useful ("nor", "that", "with" are three and four letters)
 * is also low enough to interrupt ordinary sentences, and an editor that interrupts is one
 * you cannot draft in for an hour. Entities and terms are reachable by explicit request,
 * which is the only time the writer has actually asked to be shown a list.
 */

const SIGILS: { sigil: string; kinds: SymbolKind[]; prefix: string; suffix: string }[] = [
  // A heading label carries no brackets, so accepting supplies both and the link comes out
  // closed. A citation label already carries its `@`, so re-adding one produced `@@key`.
  { sigil: "[[", kinds: ["heading"], prefix: "[[", suffix: "]]" },
  { sigil: "@", kinds: ["citation"], prefix: "", suffix: "" },
  { sigil: ":", kinds: ["snippet"], prefix: "", suffix: "" },
];

/**
 * What, if anything, should be completed at the caret.
 *
 * Scoped to the block text, never the document: this runs on the keystroke path and the
 * latency budget has no room for a whole-document scan per character.
 */
export function triggerAt(ctx: CompletionContext, explicit = false): Trigger | null {
  const { blockText, offset } = ctx;
  const before = blockText.slice(0, offset);

  for (const { sigil, kinds, prefix, suffix } of SIGILS) {
    const at = before.lastIndexOf(sigil);
    if (at < 0) continue;
    const query = before.slice(at + sigil.length);
    // A sigil only counts while the query after it is still a single word. Whitespace ends
    // it, otherwise an `@` early in a paragraph keeps the popup alive for the whole line.
    if (/\s/.test(query)) continue;
    // `:` is far too common in prose to trigger on its own; require it to start a word.
    if (sigil === ":" && at > 0 && !/\s/.test(before[at - 1] ?? " ")) continue;
    // `from` is the sigil itself: accepting replaces what was typed instead of appending.
    return { query, from: at, kinds, explicit, prefix, suffix };
  }

  // A bare word: the current word under the caret.
  let start = offset;
  while (start > 0 && !/[\s"'“”‘’([{]/u.test(blockText[start - 1] ?? "")) start--;
  if (!explicit) return null;
  const query = blockText.slice(start, offset);
  return { query, from: start, kinds: [], explicit, prefix: "", suffix: "" };
}

/** Case-insensitive subsequence match with the ranges that matched, or null. */
function fuzzy(label: string, query: string): { score: number; matches: [number, number][] } | null {
  if (query.length === 0) return { score: 0.5, matches: [] };
  const l = label.toLowerCase();
  const q = query.toLowerCase();

  const exactAt = l.indexOf(q);
  if (exactAt === 0) return { score: 1, matches: [[0, q.length]] };
  if (exactAt > 0) {
    // A match at a word boundary is worth much more than one buried mid-word.
    const boundary = exactAt === 0 || /[\s\-_/([]/u.test(label[exactAt - 1] ?? "");
    return { score: boundary ? 0.85 : 0.6, matches: [[exactAt, exactAt + q.length]] };
  }

  // Subsequence, rewarding consecutive runs and word-boundary starts.
  const matches: [number, number][] = [];
  let li = 0, runStart = -1, consecutive = 0, boundaryHits = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    let found = -1;
    for (let k = li; k < l.length; k++) if (l[k] === ch) { found = k; break; }
    if (found < 0) return null;
    if (runStart >= 0 && found === li) consecutive++;
    else {
      if (runStart >= 0) matches.push([runStart, li]);
      runStart = found;
      if (found === 0 || /[\s\-_/([]/u.test(label[found - 1] ?? "")) boundaryHits++;
    }
    li = found + 1;
  }
  if (runStart >= 0) matches.push([runStart, li]);

  const density = q.length / Math.max(1, li);
  const score = 0.25 + 0.25 * density + 0.1 * (consecutive / q.length) + 0.1 * Math.min(1, boundaryHits / 2);
  return { score: Math.min(score, 0.55), matches };
}

const KIND_WEIGHT: Record<SymbolKind, number> = {
  citation: 1.0,
  heading: 0.95,
  term: 0.95,
  snippet: 0.9,
  entity: 0.8,
};

export function complete(symbols: ProseSymbol[], ctx: CompletionContext, explicit = false): CompletionItem[] {
  const trigger = triggerAt(ctx, explicit);
  if (!trigger) return [];

  const wanted = new Set(trigger.kinds);
  const out: CompletionItem[] = [];

  for (const sym of symbols) {
    if (wanted.size > 0 && !wanted.has(sym.kind)) continue;
    // A citation's label carries the sigil; the query after `@` should not have to repeat it.
    const label = trigger.kinds.includes("citation") && sym.label.startsWith("@")
      ? sym.label.slice(1)
      : sym.label;
    const m = fuzzy(label, trigger.query);
    if (!m) continue;

    // Frequency is a tiebreak, never a driver: a badly-matching common word must not outrank
    // a well-matching rare one, or the list stops answering what was typed.
    const freq = Math.min(1, Math.log1p(sym.frequency) / Math.log(40));
    const local = ctx.path && sym.path === ctx.path ? 0.06 : 0;
    const score = m.score * KIND_WEIGHT[sym.kind] + 0.12 * freq + local;

    out.push({ ...sym, score, matches: m.matches });
  }

  out.sort((a, b) => b.score - a.score || a.label.length - b.label.length || a.label.localeCompare(b.label));
  return out.slice(0, ctx.limit ?? 12);
}
