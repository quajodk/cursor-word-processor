import type { PhrasingContent } from "mdast";

/**
 * CriticMarkup (DOCX-FIDELITY.md §5): the plain-text representation of comments and tracked
 * changes, so they live in the `.md` itself rather than being sidecar-only.
 *
 *   {>>comment<<}       → a `comment` mark, anchored to adjacent prose
 *   {++insertion++}     → an `insertion` mark
 *   {--deletion--}      → a `deletion` mark
 *   {~~old~>new~~}      → `deletion` (old) immediately followed by `insertion` (new)
 *
 * Deliberately NOT a micromark tokenizer extension. The task allows either "a micromark
 * extension or a careful post-parse pass over text nodes", and a pass over mdast `text`
 * nodes gets the important safety property for free: mdast has already separated `text` from
 * `inlineCode` and fenced/indented `code` blocks by the time this runs, so this code
 * structurally cannot fire inside a code span or a code fence — it never sees their content
 * as a `text` node.
 *
 * Documented limitation (see package report): because this operates per `text` node rather
 * than per character stream, a CriticMarkup span that is *itself* split by nested inline
 * formatting — `{++hello *world*++}`, where mdast already breaks that into three siblings
 * (text, emphasis, text) — is not detected. Only spans wholly inside one plain-text run are
 * recognized. In practice the overwhelming majority of real CriticMarkup usage is plain text.
 */

export type CriticPiece =
  | { kind: "text"; value: string }
  | { kind: "ins"; value: string }
  | { kind: "del"; value: string }
  | { kind: "comment"; value: string }
  | { kind: "sub"; del: string; ins: string };

const CRITIC_RE = /\{(?:\+\+([\s\S]*?)\+\+|--([\s\S]*?)--|>>([\s\S]*?)<<|~~([\s\S]*?)~>([\s\S]*?)~~)\}/g;

/**
 * `{~~old~>new~~}` shares its `~~` delimiter with GFM strikethrough, and GFM's tokenizer runs
 * *before* this package ever sees a `text` node — so by the time mdast exists, a substitution
 * has already been carved into `text("...{") , delete([text("old~>new")]) , text("}...")`
 * rather than one flat `text` node containing the whole span. This stitches that specific
 * three-node shape back into one literal `text` node so the ordinary {@link splitCritic} pass
 * finds it, same as any other CriticMarkup span.
 *
 * Deliberately narrow: only a `delete` node whose single child is plain `text` containing
 * `~>` qualifies. A substitution whose old/new side has its own nested formatting —
 * `{~~*old*~>new~~}` — falls through and renders as literal strikethrough instead; this is
 * the same "spans split by nested inline formatting aren't detected" limitation documented
 * above, not a special case of it.
 */
export function mergeStrikethroughCollisions<T extends { type: string; value?: string; children?: unknown[] }>(nodes: T[]): T[] {
  const out: T[] = [];
  let i = 0;
  while (i < nodes.length) {
    const prev = nodes[i] as any;
    const mid = nodes[i + 1] as any;
    const next = nodes[i + 2] as any;
    if (
      prev?.type === "text" &&
      typeof prev.value === "string" &&
      prev.value.endsWith("{") &&
      mid?.type === "delete" &&
      Array.isArray(mid.children) &&
      mid.children.length === 1 &&
      mid.children[0]?.type === "text" &&
      typeof mid.children[0].value === "string" &&
      mid.children[0].value.includes("~>") &&
      next?.type === "text" &&
      typeof next.value === "string" &&
      next.value.startsWith("}")
    ) {
      const literal = `{~~${mid.children[0].value}~~}`;
      out.push({ type: "text", value: prev.value.slice(0, -1) + literal + next.value.slice(1) } as unknown as T);
      i += 3;
      continue;
    }
    out.push(nodes[i]!);
    i++;
  }
  return out;
}

/** Splits a plain-text run into literal text and CriticMarkup pieces, in source order. */
export function splitCritic(text: string): CriticPiece[] {
  if (!text.includes("{")) return [{ kind: "text", value: text }];
  const out: CriticPiece[] = [];
  let last = 0;
  CRITIC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CRITIC_RE.exec(text))) {
    if (m.index > last) out.push({ kind: "text", value: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "ins", value: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "del", value: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "comment", value: m[3] });
    else out.push({ kind: "sub", del: m[4] ?? "", ins: m[5] ?? "" });
    last = CRITIC_RE.lastIndex;
  }
  if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
  return out.length ? out : [{ kind: "text", value: text }];
}

// -----------------------------------------------------------------------------------------
// Serialize direction: synthetic mdast node types, constructed directly by to-mdast.ts (never
// produced by mdast-util-from-markdown — there is no `fromMarkdown` extension for them, only
// `toMarkdown` handlers), and rendered by `criticToMarkdown()` below.
// -----------------------------------------------------------------------------------------

export interface CriticInsertion {
  type: "criticInsertion";
  children: PhrasingContent[];
}
export interface CriticDeletion {
  type: "criticDeletion";
  children: PhrasingContent[];
}
export interface CriticSubstitution {
  type: "criticSubstitution";
  deleted: PhrasingContent[];
  inserted: PhrasingContent[];
}
export interface CriticComment {
  type: "criticComment";
  value: string;
}

/** `mdast-util-to-markdown` extension: handlers for the four synthetic node types above. */
export function criticToMarkdown() {
  return {
    handlers: {
      criticInsertion(node: CriticInsertion, _parent: unknown, state: any, info: any) {
        const exit = state.enter("criticInsertion");
        const tracker = state.createTracker(info);
        const before = tracker.move("{++");
        const value = tracker.move(
          state.containerPhrasing(node, { before, after: "++}", ...tracker.current() }),
        );
        const after = tracker.move("++}");
        exit();
        return before + value + after;
      },
      criticDeletion(node: CriticDeletion, _parent: unknown, state: any, info: any) {
        const exit = state.enter("criticDeletion");
        const tracker = state.createTracker(info);
        const before = tracker.move("{--");
        const value = tracker.move(
          state.containerPhrasing(node, { before, after: "--}", ...tracker.current() }),
        );
        const after = tracker.move("--}");
        exit();
        return before + value + after;
      },
      criticSubstitution(node: CriticSubstitution, _parent: unknown, state: any, info: any) {
        const exit = state.enter("criticSubstitution");
        const tracker = state.createTracker(info);
        const before = tracker.move("{~~");
        const del = tracker.move(
          state.containerPhrasing({ children: node.deleted }, { before, after: "~>", ...tracker.current() }),
        );
        const mid = tracker.move("~>");
        const ins = tracker.move(
          state.containerPhrasing({ children: node.inserted }, { before: mid, after: "~~}", ...tracker.current() }),
        );
        const after = tracker.move("~~}");
        exit();
        return before + del + mid + ins + after;
      },
      criticComment(node: CriticComment, _parent: unknown, state: any, info: any) {
        const exit = state.enter("criticComment");
        const tracker = state.createTracker(info);
        const before = tracker.move("{>>");
        const value = tracker.move(
          state.containerPhrasing(
            { children: [{ type: "text", value: node.value }] },
            { before, after: "<<}", ...tracker.current() },
          ),
        );
        const after = tracker.move("<<}");
        exit();
        return before + value + after;
      },
    },
  };
}
