import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Root, RootContent, PhrasingContent, ListItem, Table, List } from "mdast";
import type { Node as PMNode, Mark } from "prosemirror-model";
import { schema, newAid } from "@scriv/doc-model";
import { splitFrontmatter } from "./frontmatter";
import { splitCritic, mergeStrikethroughCollisions } from "./critic";
import { detectStyle } from "./style";
import { MD_STYLE, MD_RAW_INLINE, MD_ALIGN } from "./types";
import type { DocMeta, ParseResult, CriticComment, CriticRevision } from "./types";

/**
 * Options for {@link parseMarkdown}.
 *
 * `anchors` is the documented seam for re-attaching known `aid`s when re-parsing a file we
 * already had open (DOCX-FIDELITY.md §3, "in-session: exact"). It is deliberately dumb:
 * `anchors[i]` becomes the aid of the i-th identified block encountered in document order
 * (the same order {@link nextAid} assigns fresh ones), nothing more. There is no fuzzy
 * matching, no diffing, no attempt to cope with blocks having moved or split — if the
 * document changed shape since `anchors` was captured, positions past the change point will
 * be wrong. That is deliberate: fuzzy realignment across out-of-session edits is
 * `packages/ooxml/anchor`'s job, not this package's. Callers doing that alignment should
 * compute the corrected per-position aid list themselves and pass it in here.
 */
export interface ParseOptions {
  anchors?: readonly (string | null | undefined)[];
}

interface Ctx {
  /** The document body with frontmatter already stripped — the same string mdast positions
   * are offsets into. */
  src: string;
  anchors?: readonly (string | null | undefined)[];
  ordinal: number;
  comments: CriticComment[];
  revisions: CriticRevision[];
}

function nextAid(ctx: Ctx): string {
  const given = ctx.anchors ? ctx.anchors[ctx.ordinal] : undefined;
  ctx.ordinal++;
  return given ?? newAid();
}

function sliceNode(ctx: Ctx, node: { position?: { start: { offset: number }; end: { offset: number } } }): string {
  if (!node.position) return "";
  return ctx.src.slice(node.position.start.offset, node.position.end.offset);
}

export function parseMarkdown(src: string, opts: ParseOptions = {}): ParseResult {
  const { frontmatter, body } = splitFrontmatter(src);
  const tree = fromMarkdown(body, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as Root;

  const ctx: Ctx = { src: body, anchors: opts.anchors, ordinal: 0, comments: [], revisions: [] };
  const blocks = convertBlocks(tree.children, ctx);
  const content = blocks.length > 0 ? blocks : [schema.nodes.paragraph!.create({ aid: nextAid(ctx) })];
  const doc = schema.node("doc", null, content);

  const meta: DocMeta = {
    frontmatter,
    style: detectStyle(body, tree),
    comments: ctx.comments,
    revisions: ctx.revisions,
  };
  return { doc, meta };
}

// -----------------------------------------------------------------------------------------
// Block conversion
// -----------------------------------------------------------------------------------------

function convertBlocks(nodes: RootContent[], ctx: Ctx): PMNode[] {
  const out: PMNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
        out.push(...blocksFromInline(node.children, ctx, "paragraph", {}));
        break;
      case "heading":
        out.push(...blocksFromInline(node.children, ctx, "heading", { level: node.depth }));
        break;
      case "thematicBreak":
        out.push(schema.nodes.horizontal_rule!.create({ aid: nextAid(ctx) }));
        break;
      case "blockquote": {
        const inner = convertBlocks(node.children, ctx);
        out.push(
          schema.nodes.blockquote!.create(
            { aid: nextAid(ctx) },
            inner.length ? inner : [schema.nodes.paragraph!.create({ aid: nextAid(ctx) })],
          ),
        );
        break;
      }
      case "code": {
        const lang = node.lang ?? null;
        const text = node.value ?? "";
        out.push(
          schema.nodes.code_block!.create({ aid: nextAid(ctx), lang }, text ? schema.text(text) : undefined),
        );
        break;
      }
      case "list":
        out.push(convertList(node, ctx));
        break;
      case "table":
        out.push(convertTable(node, ctx));
        break;
      case "html":
        out.push(rawBlock(ctx, node, MD_STYLE.htmlBlock));
        break;
      case "definition":
        out.push(rawBlock(ctx, node, MD_STYLE.definition));
        break;
      default:
        // footnoteDefinition, or any future block type this package does not yet model:
        // preserved byte-for-byte rather than guessed at or dropped.
        out.push(rawBlock(ctx, node, MD_STYLE.raw));
        break;
    }
  }
  return out;
}

function rawBlock(ctx: Ctx, node: RootContent, styleId: string): PMNode {
  const text = sliceNode(ctx, node as any);
  return schema.nodes.code_block!.create(
    { aid: nextAid(ctx), styleId },
    text ? schema.text(text) : undefined,
  );
}

function convertList(node: List, ctx: Ctx): PMNode {
  const items = node.children.map((item) => convertListItem(item, ctx));
  const styleId = node.spread ? MD_STYLE.listSpread : null;
  if (node.ordered) {
    return schema.nodes.ordered_list!.create(
      { aid: nextAid(ctx), start: node.start ?? 1, styleId },
      items.length ? items : [emptyListItem(ctx)],
    );
  }
  return schema.nodes.bullet_list!.create(
    { aid: nextAid(ctx), styleId },
    items.length ? items : [emptyListItem(ctx)],
  );
}

function emptyListItem(ctx: Ctx): PMNode {
  return schema.nodes.list_item!.create({ aid: nextAid(ctx) }, schema.nodes.paragraph!.create({ aid: nextAid(ctx) }));
}

function convertListItem(item: ListItem, ctx: Ctx): PMNode {
  const inner = convertBlocks(item.children, ctx);
  const content = inner.length > 0 && inner[0]!.type.name === "paragraph" ? inner : [schema.nodes.paragraph!.create({ aid: nextAid(ctx) }), ...inner];
  const styleId = item.checked === true ? MD_STYLE.taskChecked : item.checked === false ? MD_STYLE.taskUnchecked : null;
  return schema.nodes.list_item!.create({ aid: nextAid(ctx), styleId }, content);
}

function convertTable(node: Table, ctx: Ctx): PMNode {
  const align = node.align ?? [];
  const rows = node.children.map((row, ri) => {
    const cells = row.children.map((cell, ci) => {
      const a = align[ci];
      const tcPrRef = a ? `${MD_ALIGN}${a}` : null;
      const body = blocksFromInline(cell.children, ctx, "paragraph", {});
      const type = ri === 0 ? schema.nodes.table_header! : schema.nodes.table_cell!;
      return type.create({ tcPrRef }, body.length ? body : [schema.nodes.paragraph!.create({ aid: nextAid(ctx) })]);
    });
    return schema.nodes.table_row!.create(null, cells);
  });
  // NOTE: prosemirror-tables' `tableNodes()` (used verbatim by doc-model, which this package
  // may not modify) gives the `table` node spec no attrs at all — not `aid`, not `tblPrRef`,
  // despite `table` being listed in `IDENTIFIED_BLOCKS` and ARCHITECTURE.md §3 documenting
  // `table = row+ attrs: { aid, tblPrRef? }`. The `aid` passed here is silently dropped by
  // ProseMirror (unknown attrs on `.create()` are ignored, not errors). The ordinal is still
  // consumed so position-based anchor reattachment stays numerically consistent once that
  // doc-model gap is fixed. Documented rather than worked around: fixing the schema is out
  // of this package's scope.
  return schema.nodes.table!.create({ aid: nextAid(ctx) } as any, rows);
}

// -----------------------------------------------------------------------------------------
// Inline conversion
// -----------------------------------------------------------------------------------------

type Piece = { kind: "inline"; node: PMNode } | { kind: "figure"; node: PMNode };

function inlinePiece(node: PMNode): Piece {
  return { kind: "inline", node };
}

/** Builds one or more `paragraph`/`heading` blocks from inline content, splitting around any
 * image (the schema has no inline image; an image can only live inside a `figure`, so a
 * paragraph containing one is split around it — same strategy as the markdown-it bridge this
 * package replaces). */
function blocksFromInline(
  children: PhrasingContent[],
  ctx: Ctx,
  kind: "paragraph" | "heading",
  extraAttrs: Record<string, unknown>,
): PMNode[] {
  const pieces = convertInline(children, ctx);
  const type = schema.nodes[kind]!;
  const out: PMNode[] = [];
  let run: PMNode[] = [];
  const flush = () => {
    if (!run.length) return;
    // Whitespace left stranded by splitting around a figure is a separator, not content.
    // The source `[![a](x)](y)\n[![b](x)](y)` is one paragraph of two linked images joined
    // by a soft break; splitting it around the figures leaves that newline behind as a run
    // of its own, and emitting it as a paragraph writes blank lines into the file that were
    // never there. A whitespace-only paragraph is not representable in Markdown regardless.
    // A hard break stranded the same way is equally contentless: emitted as a paragraph it
    // becomes a lone `\` on its own line, which reparses as a literal backslash.
    if (run.every((n) => (n.isText && !/\S/.test(n.text ?? "")) || n.type.name === "hard_break")) {
      run = [];
      return;
    }
    out.push(type.create({ aid: nextAid(ctx), ...extraAttrs }, run));
    run = [];
  };
  for (const piece of pieces) {
    if (piece.kind === "figure") {
      flush();
      out.push(piece.node);
    } else {
      run.push(piece.node);
    }
  }
  flush();
  return out.length ? out : [type.create({ aid: nextAid(ctx), ...extraAttrs })];
}

const HTML_OPEN: Record<string, "underline" | "superscript" | "subscript"> = {
  "<u>": "underline",
  "<sup>": "superscript",
  "<sub>": "subscript",
};
const HTML_CLOSE: Record<string, "underline" | "superscript" | "subscript"> = {
  "</u>": "underline",
  "</sup>": "superscript",
  "</sub>": "subscript",
};
const HTML_BREAK = new Set(["<br>", "<br/>", "<br />"]);

function popMark(stack: Mark[], name: string): Mark[] {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]!.type.name === name) return [...stack.slice(0, i), ...stack.slice(i + 1)];
  }
  return stack;
}

function attachCommentToLast(out: Piece[], anchorId: string): boolean {
  for (let i = out.length - 1; i >= 0; i--) {
    const p = out[i]!;
    if (p.kind === "inline" && p.node.isText) {
      out[i] = inlinePiece(p.node.mark(p.node.marks.concat(schema.marks.comment!.create({ anchorId }))));
      return true;
    }
    if (p.kind !== "inline") break;
  }
  return false;
}

function convertInline(rawChildren: PhrasingContent[], ctx: Ctx, extraMarks: Mark[] = []): Piece[] {
  const children = mergeStrikethroughCollisions(rawChildren as any) as PhrasingContent[];
  const out: Piece[] = [];
  let htmlStack: Mark[] = [];
  let pendingComment: { anchorId: string; body: string } | null = null;

  const marksHere = () => [...extraMarks, ...htmlStack];

  /** True when the piece most recently emitted was a hard break. */
  const lastWasHardBreak = (): boolean => {
    const last = out[out.length - 1];
    return !!last && last.kind === "inline" && last.node.type.name === "hard_break";
  };

  const emit = (piece: Piece) => {
    if (pendingComment && piece.kind === "inline" && piece.node.isText) {
      piece = inlinePiece(piece.node.mark(piece.node.marks.concat(schema.marks.comment!.create({ anchorId: pendingComment.anchorId }))));
      pendingComment = null;
    }
    out.push(piece);
  };

  for (const child of children) {
    switch (child.type) {
      case "text": {
        // A `text` node's value carries the literal newline where the author wrapped the
        // line: CommonMark joins a physically-wrapped paragraph into one text run separated
        // by "\n", which RENDERS as a space but is real source formatting.
        //
        // It is preserved verbatim. Collapsing it to a space renders correctly and destroys
        // the file: saving a document a human wrapped at 80 columns rewrites every paragraph
        // in it, so the git diff of a one-word edit becomes the whole document. Markdown on
        // disk is the source of truth (ARCHITECTURE.md §4), and a source of truth that
        // reformats itself on save is not one.
        //
        // The single exception is the case this normalization originally existed to fix: a
        // newline immediately after a hard break. The hard break already emits its own line
        // ending, so keeping both yields a blank line that was never in the source and that
        // reparses as an unintended paragraph split. There, and only there, the leading
        // newline is dropped.
        let value = child.value;
        if (lastWasHardBreak()) value = value.replace(/^[ \t]*\r?\n/, "");
        const normalized = value;
        for (const p of splitCritic(normalized)) {
          if (p.kind === "text") {
            if (p.value.length) emit(inlinePiece(schema.text(p.value, marksHere())));
          } else if (p.kind === "ins") {
            const revId = newAid();
            ctx.revisions.push({ revId, kind: "insertion", substitution: false, text: p.value });
            if (p.value.length) {
              emit(inlinePiece(schema.text(p.value, [...marksHere(), schema.marks.insertion!.create({ revId, author: "", date: null, origin: "user" })])));
            }
          } else if (p.kind === "del") {
            const revId = newAid();
            ctx.revisions.push({ revId, kind: "deletion", substitution: false, text: p.value });
            if (p.value.length) {
              emit(inlinePiece(schema.text(p.value, [...marksHere(), schema.marks.deletion!.create({ revId, author: "", date: null, origin: "user" })])));
            }
          } else if (p.kind === "sub") {
            const revId = newAid();
            ctx.revisions.push({ revId, kind: "deletion", substitution: true, text: p.del });
            ctx.revisions.push({ revId, kind: "insertion", substitution: true, text: p.ins });
            if (p.del.length) {
              emit(inlinePiece(schema.text(p.del, [...marksHere(), schema.marks.deletion!.create({ revId, author: "", date: null, origin: "user" })])));
            }
            if (p.ins.length) {
              emit(inlinePiece(schema.text(p.ins, [...marksHere(), schema.marks.insertion!.create({ revId, author: "", date: null, origin: "user" })])));
            }
          } else {
            const anchorId = newAid();
            ctx.comments.push({ anchorId, body: p.value });
            if (!attachCommentToLast(out, anchorId)) {
              pendingComment = { anchorId, body: p.value };
            } else {
              // attachCommentToLast mutated `out` in place; nothing more to do.
            }
          }
        }
        break;
      }
      case "inlineCode":
        emit(inlinePiece(schema.text(child.value, [...marksHere(), schema.marks.code!.create()])));
        break;
      case "break":
        emit(inlinePiece(schema.nodes.hard_break!.create()));
        break;
      case "emphasis":
        for (const p of convertInline(child.children, ctx, [...marksHere(), schema.marks.em!.create()])) emit(p);
        break;
      case "strong":
        for (const p of convertInline(child.children, ctx, [...marksHere(), schema.marks.strong!.create()])) emit(p);
        break;
      case "delete":
        for (const p of convertInline(child.children, ctx, [...marksHere(), schema.marks.strike!.create()])) emit(p);
        break;
      case "link":
        for (const p of convertInline(child.children, ctx, [...marksHere(), schema.marks.link!.create({ href: child.url, title: child.title ?? null })])) emit(p);
        break;
      case "image": {
        const img = schema.nodes.image!.create({ src: child.url, alt: child.alt ?? null, title: child.title ?? null });
        out.push({ kind: "figure", node: schema.nodes.figure!.create({ aid: nextAid(ctx) }, img) });
        pendingComment = null; // a comment cannot attach across a block split
        break;
      }
      case "html": {
        const key = child.value.trim().toLowerCase();
        if (HTML_OPEN[key]) {
          htmlStack = [...htmlStack, (schema.marks as any)[HTML_OPEN[key]!]!.create()];
        } else if (HTML_CLOSE[key]) {
          htmlStack = popMark(htmlStack, HTML_CLOSE[key]!);
        } else if (HTML_BREAK.has(key)) {
          emit(inlinePiece(schema.nodes.hard_break!.create()));
        } else if (child.value.length) {
          emit(inlinePiece(schema.text(child.value, [...marksHere(), schema.marks.rPrRef!.create({ ref: MD_RAW_INLINE })])));
        }
        break;
      }
      default: {
        // linkReference, imageReference, footnoteReference, or any node type this package
        // does not yet understand: preserve the exact source text. This is what keeps
        // reference-style links round-tripping byte-for-byte — they are never resolved or
        // rewritten, just carried through as literal characters.
        const raw = sliceNode(ctx, child as any);
        if (raw.length) emit(inlinePiece(schema.text(raw, [...marksHere(), schema.marks.rPrRef!.create({ ref: MD_RAW_INLINE })])));
        break;
      }
    }
  }

  if (pendingComment) {
    // Nothing in this run to attach the comment to (e.g. a block containing only a comment).
    // Preserving the literal CriticMarkup bytes beats silently dropping the annotation.
    const dropped = ctx.comments.pop();
    if (dropped) {
      out.push(inlinePiece(schema.text(`{>>${dropped.body}<<}`, [...marksHere(), schema.marks.rPrRef!.create({ ref: MD_RAW_INLINE })])));
    }
  }

  return out;
}
