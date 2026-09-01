import type { Node as PMNode, Mark } from "prosemirror-model";
import type { PhrasingContent, RootContent } from "mdast";
import { MD_STYLE, MD_ALIGN, MD_RAW_INLINE } from "./types";
import type { DocMeta } from "./types";
import type { CriticInsertion, CriticDeletion, CriticSubstitution, CriticComment } from "./critic";

/**
 * doc-model → mdast. The inverse of `from-mdast.ts`.
 *
 * PM marks are a flat set per leaf; mdast phrasing content is nested wrappers. This walks
 * each block's inline children once, computes each leaf's *container* marks in a fixed
 * canonical order (deepest-nesting-last), and groups consecutive leaves that share the same
 * mark at the same depth into one wrapper node — the standard "run-length group by mark
 * prefix" technique. `comment` is not a container mark (CriticMarkup comments are not
 * containers, they are a marker inserted right after the annotated text) so it is peeled off
 * before grouping and re-inserted as a sibling once its leaf's nesting is fully built.
 */

const RAW_CODE_STYLES = new Set<string>([MD_STYLE.htmlBlock, MD_STYLE.definition, MD_STYLE.raw]);

const MARK_RANK: Record<string, number> = {
  insertion: 0,
  deletion: 0,
  link: 1,
  strong: 2,
  em: 3,
  strike: 4,
  underline: 5,
  superscript: 6,
  subscript: 6,
  code: 7,
  rPrRef: 8,
};
function rank(m: Mark): number {
  return MARK_RANK[m.type.name] ?? 9;
}

export interface SCtx {
  meta: DocMeta;
}

export function toMdastRoot(doc: PMNode, meta: DocMeta): { type: "root"; children: RootContent[] } {
  const ctx: SCtx = { meta };
  return { type: "root", children: convertBlocks(children(doc), ctx) };
}

function children(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach((c) => out.push(c));
  return out;
}

function convertBlocks(nodes: PMNode[], ctx: SCtx): RootContent[] {
  const out: RootContent[] = [];
  for (const node of nodes) out.push(...convertBlock(node, ctx));
  return out;
}

function convertBlock(node: PMNode, ctx: SCtx): RootContent[] {
  switch (node.type.name) {
    case "paragraph":
      return [{ type: "paragraph", children: convertInline(node, ctx) } as RootContent];
    case "heading":
      return [{ type: "heading", depth: clampDepth(node.attrs.level), children: convertInline(node, ctx) } as RootContent];
    case "blockquote":
      return [{ type: "blockquote", children: convertBlocks(children(node), ctx) } as RootContent];
    case "horizontal_rule":
      return [{ type: "thematicBreak" } as RootContent];
    case "code_block": {
      const text = node.textContent;
      if (RAW_CODE_STYLES.has(node.attrs.styleId)) {
        return [{ type: "html", value: text } as RootContent];
      }
      return [{ type: "code", lang: node.attrs.lang ?? null, meta: null, value: text } as RootContent];
    }
    case "bullet_list":
    case "ordered_list": {
      const ordered = node.type.name === "ordered_list";
      const items = children(node).map((li) => convertListItem(li, ctx));
      return [
        {
          type: "list",
          ordered,
          start: ordered ? (node.attrs.start ?? 1) : null,
          spread: node.attrs.styleId === MD_STYLE.listSpread,
          children: items,
        } as RootContent,
      ];
    }
    case "table":
      return [convertTable(node, ctx) as RootContent];
    case "figure": {
      const img = node.firstChild;
      if (!img) return [];
      return [
        {
          type: "paragraph",
          children: [{ type: "image", url: img.attrs.src, alt: img.attrs.alt ?? null, title: img.attrs.title ?? null }],
        } as RootContent,
      ];
    }
    default:
      return [];
  }
}

function clampDepth(level: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const n = Math.max(1, Math.min(6, Number(level) || 1));
  return n as 1 | 2 | 3 | 4 | 5 | 6;
}

function convertListItem(li: PMNode, _ctx: SCtx) {
  const checked = li.attrs.styleId === MD_STYLE.taskChecked ? true : li.attrs.styleId === MD_STYLE.taskUnchecked ? false : null;
  return { type: "listItem", checked, spread: undefined, children: convertBlocks(children(li), _ctx) } as any;
}

function convertTable(table: PMNode, ctx: SCtx) {
  const align: (string | null)[] = [];
  const rows: any[] = [];
  table.forEach((row) => {
    const cells: any[] = [];
    let ci = 0;
    row.forEach((cell) => {
      if (align[ci] === undefined) {
        const ref: string | null = cell.attrs.tcPrRef ?? null;
        align[ci] = ref && ref.startsWith(MD_ALIGN) ? ref.slice(MD_ALIGN.length) : null;
      }
      cells.push({ type: "tableCell", children: cellPhrasing(cell, ctx) });
      ci++;
    });
    rows.push({ type: "tableRow", children: cells });
  });
  return { type: "table", align, children: rows };
}

function cellPhrasing(cell: PMNode, ctx: SCtx): PhrasingContent[] {
  const first = cell.firstChild;
  if (first && first.type.name === "paragraph") return convertInline(first, ctx);
  return [];
}

// -----------------------------------------------------------------------------------------
// Inline: PM leaves (text / hard_break, each with a flat marks array) → nested mdast phrasing.
// -----------------------------------------------------------------------------------------

interface Leaf {
  marks: Mark[];
  isBreak: boolean;
  text: string;
  commentAnchor?: string;
}

function convertInline(block: PMNode, ctx: SCtx): PhrasingContent[] {
  const leaves: Leaf[] = [];
  block.forEach((child) => {
    const commentMark = child.marks.find((m) => m.type.name === "comment");
    const containerMarks = child.marks.filter((m) => m.type.name !== "comment").sort((a, b) => rank(a) - rank(b));
    if (child.isText) {
      leaves.push({ marks: containerMarks, isBreak: false, text: child.text ?? "", commentAnchor: commentMark?.attrs.anchorId });
    } else if (child.type.name === "hard_break") {
      leaves.push({ marks: containerMarks, isBreak: true, text: "", commentAnchor: commentMark?.attrs.anchorId });
    }
  });
  return group(leaves, 0, ctx);
}

function group(leaves: Leaf[], depth: number, ctx: SCtx): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let i = 0;
  while (i < leaves.length) {
    const leaf = leaves[i]!;
    if (depth >= leaf.marks.length) {
      out.push(leafNode(leaf));
      if (leaf.commentAnchor) out.push(commentNode(leaf.commentAnchor, ctx));
      i++;
      continue;
    }
    const mark = leaf.marks[depth]!;
    if (mark.type.name === "code" || mark.type.name === "rPrRef") {
      out.push(terminalNode(mark, leaf));
      if (leaf.commentAnchor) out.push(commentNode(leaf.commentAnchor, ctx));
      i++;
      continue;
    }
    let j = i + 1;
    while (j < leaves.length && depth < leaves[j]!.marks.length && leaves[j]!.marks[depth]!.eq(mark)) j++;
    const inner = group(leaves.slice(i, j), depth + 1, ctx);
    out.push(...(wrapperFor(mark, inner) as PhrasingContent[]));
    i = j;
  }
  return mergeSubstitutions(out);
}

function leafNode(leaf: Leaf): PhrasingContent {
  return leaf.isBreak ? ({ type: "break" } as PhrasingContent) : ({ type: "text", value: leaf.text } as PhrasingContent);
}

function terminalNode(mark: Mark, leaf: Leaf): PhrasingContent {
  if (mark.type.name === "code") return { type: "inlineCode", value: leaf.text } as PhrasingContent;
  // rPrRef (md:raw): the leaf's text is the exact original source bytes. Emitted via the
  // `html` handler, which is the only core handler that prints a value with zero escaping —
  // exactly what "preserve verbatim" requires, whether or not it is actually HTML.
  return { type: "html", value: leaf.text } as PhrasingContent;
}

function commentNode(anchorId: string, ctx: SCtx): PhrasingContent {
  const found = ctx.meta.comments.find((c) => c.anchorId === anchorId);
  return { type: "criticComment", value: found?.body ?? "" } as unknown as PhrasingContent;
}

function wrapperFor(mark: Mark, children: PhrasingContent[]): unknown[] {
  switch (mark.type.name) {
    case "strong":
      return [{ type: "strong", children }];
    case "em":
      return [{ type: "emphasis", children }];
    case "strike":
      return [{ type: "delete", children }];
    case "link":
      return [{ type: "link", url: mark.attrs.href, title: mark.attrs.title ?? null, children }];
    case "underline":
      return [html("<u>"), ...children, html("</u>")];
    case "superscript":
      return [html("<sup>"), ...children, html("</sup>")];
    case "subscript":
      return [html("<sub>"), ...children, html("</sub>")];
    case "insertion":
      return [{ type: "criticInsertion", children, __revId: mark.attrs.revId } as CriticInsertion & { __revId: string }];
    case "deletion":
      return [{ type: "criticDeletion", children, __revId: mark.attrs.revId } as CriticDeletion & { __revId: string }];
    default:
      // Unknown mark this package does not have a Markdown representation for: drop the
      // wrapping rather than lose the text underneath it.
      return children;
  }
}

function html(value: string) {
  return { type: "html", value };
}

/** `{--old--}` immediately followed by `{++new++}` sharing a revId is one `{~~old~>new~~}`
 * substitution — reconstructing that is what keeps a substitution from round-tripping as two
 * separate markup spans it never was in the source. */
function mergeSubstitutions(nodes: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i] as any;
    const b = nodes[i + 1] as any;
    if (a?.type === "criticDeletion" && b?.type === "criticInsertion" && a.__revId && a.__revId === b.__revId) {
      out.push({ type: "criticSubstitution", deleted: a.children, inserted: b.children } as unknown as PhrasingContent);
      i++;
      continue;
    }
    out.push(nodes[i]!);
  }
  return out;
}

// Re-exported so serialize.ts can type its tree loosely without importing internals twice.
export type { CriticSubstitution, CriticComment };
