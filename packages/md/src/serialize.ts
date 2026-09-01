import { toMarkdown } from "mdast-util-to-markdown";
import { gfmToMarkdown } from "mdast-util-gfm";
import type { Node as PMNode } from "prosemirror-model";
import { toMdastRoot } from "./to-mdast";
import { parseMarkdown } from "./from-mdast";
import { criticToMarkdown } from "./critic";
import type { DocMeta, StyleProfile } from "./types";
import { DEFAULT_STYLE } from "./types";

/**
 * doc-model → Markdown text. The inverse of `parseMarkdown`.
 *
 * `meta` is the {@link DocMeta} a prior `parseMarkdown` produced (or `DEFAULT_STYLE` /
 * `{frontmatter:null, comments:[], revisions:[]}` for a document authored fresh in the
 * editor with no source file yet). Style options are document-wide in
 * `mdast-util-to-markdown` — there is no per-node override — so a file is serialized in
 * whichever bullet/emphasis/fence/etc. convention it was detected to already use.
 */
export function serializeMarkdown(doc: PMNode, meta: DocMeta = { frontmatter: null, style: DEFAULT_STYLE, comments: [], revisions: [] }): string {
  const root = toMdastRoot(doc, meta);
  const style = meta.style;

  const options: Record<string, unknown> = {
    bullet: style.bullet,
    bulletOrdered: style.bulletOrdered,
    emphasis: style.emphasis,
    strong: style.strong,
    fence: style.fence,
    fences: style.fences,
    rule: style.rule,
    ruleRepetition: style.ruleRepetition,
    ruleSpaces: style.ruleSpaces,
    setext: style.setext,
    closeAtx: style.closeAtx,
    listItemIndent: style.listItemIndent,
    incrementListMarker: style.incrementListMarker,
    quote: style.quote,
    resourceLink: style.resourceLink,
    extensions: [narrowTildeEscaping(gfmToMarkdown()), criticToMarkdown(), tableStyle(style)],
  };

  if (style.hardBreak === "spaces") {
    // `mdast-util-to-markdown`'s core `break` handler always emits a trailing backslash; it
    // has no built-in option for the two-trailing-spaces style. Overriding the handler is
    // the documented extension point for exactly this (`Options.handlers`). This is a
    // simplified port of the core handler — it always assumes a break is legal here, unlike
    // the core version which falls back to a bare space inside constructs (table cells,
    // setext heading text) that cannot contain a real line break. That fallback is rare in
    // practice and, when missed, degrades to a literal two-space-and-newline that most
    // renderers still treat as a break — a known, minor gap.
    (options.extensions as unknown[]).push({ handlers: { break: () => "  \n" } });
  }

  let out = toMarkdown(root as any, options as any);

  // The narrowed tilde rule is an optimisation, and GFM's single-tilde strikethrough makes
  // it impossible to prove safe statically: two lone tildes elsewhere in the same paragraph
  // can pair up and invent a strikethrough that was never in the document. So it is VERIFIED
  // rather than trusted — if the narrowed output would read back with different strike marks
  // than the document has, it is discarded and the document re-serialized with GFM's own
  // (over-eager but sound) escaping. Only documents that actually contain a tilde pay for it.
  if (out.includes("~") && countStrikes(readBack(out)) !== countStrikes(doc)) {
    const safe = { ...options, extensions: [gfmToMarkdown(), criticToMarkdown(), tableStyle(style)] };
    out = toMarkdown(root as any, safe as any);
  }

  if (style.finalNewline === false && out.endsWith("\n")) out = out.slice(0, -1);

  const fm = meta.frontmatter;
  return fm ? fm.block + (fm.gap ?? "") + out : out;
}


function countStrikes(doc: PMNode): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.marks.some((m) => m.type.name === "strike")) n++;
    return true;
  });
  return n;
}

/** Reparse our own output. Never throws: a failure means "not equivalent", which is safe. */
function readBack(src: string): PMNode {
  return parseMarkdown(src).doc;
}

/**
 * GFM marks `~` unsafe unconditionally, because `~~` opens strikethrough. That escapes every
 * ordinary tilde in prose — `~99%` is written back as `\~99%`, which is a visible change to
 * text the writer never touched.
 *
 * A lone tilde cannot open strikethrough, so escaping is only required when a second tilde
 * follows. Narrowing the rule to `after: "~"` still breaks every real `~~` pair (the first of
 * the pair is escaped, so it reparses as literal text) while leaving prose alone.
 */
function narrowTildeEscaping(ext: unknown): unknown {
  const clone = (e: any): any => {
    if (!e || typeof e !== "object") return e;
    const out: any = { ...e };
    if (Array.isArray(e.unsafe)) {
      out.unsafe = e.unsafe.map((u: any) =>
        u?.character === "~" && u.after === undefined && u.before === undefined
          ? { ...u, after: "~" }
          : u,
      );
    }
    if (Array.isArray(e.extensions)) out.extensions = e.extensions.map(clone);
    return out;
  };
  return clone(ext);
}

/**
 * Tables, rendered the way the source writes them.
 *
 * `mdast-util-gfm-table` re-derives every column width from the cell contents, so a compact
 * hand-written table comes back re-padded and its `---` delimiters shrink to `-`. Neither is
 * a content change, but both rewrite the file on save, which is the thing this package exists
 * not to do. Delimiter width and padding are detected from the source like `bullet` and
 * `fence`, and reproduced here.
 */
function tableStyle(style: StyleProfile): unknown {
  return {
    handlers: {
      table(node: any, _parent: unknown, state: any, info: any) {
        const exitTable = state.enter("table");
        const align: (string | null)[] = node.align ?? [];
        const rows: string[][] = (node.children ?? []).map((row: any) =>
          (row.children ?? []).map((cell: any) => {
            const exitCell = state.enter("tableCell");
            const value = state.containerPhrasing(cell, { ...info, before: " ", after: " " });
            exitCell();
            return value;
          }),
        );
        const cols = Math.max(align.length, ...rows.map((r) => r.length), 0);
        const widths: number[] = [];
        for (let c = 0; c < cols; c++) {
          widths.push(style.tablePad ? Math.max(0, ...rows.map((r) => (r[c] ?? "").length)) : 0);
        }

        const delimiterFor = (c: number): string => {
          const a = align[c];
          // The dash COUNT is independent of the alignment colons. Subtracting the colons
          // from a target total width makes the emitted dash count vary by column, so
          // re-detecting the style from our own output yields a different winner and the
          // file changes again on the next save. Holding the count fixed makes
          // detect → serialize → detect a fixed point.
          const colons = a === "center" ? 2 : a ? 1 : 0;
          const dashes = "-".repeat(
            style.tablePad ? Math.max(1, (widths[c] ?? 0) - colons) : style.tableDelimiter,
          );
          if (a === "left") return ":" + dashes;
          if (a === "right") return dashes + ":";
          if (a === "center") return ":" + dashes + ":";
          return dashes;
        };

        const renderRow = (cells: string[]): string => {
          const out: string[] = [];
          for (let c = 0; c < cols; c++) {
            const v = cells[c] ?? "";
            out.push(style.tablePad ? v.padEnd(widths[c] ?? 0) : v);
          }
          return "| " + out.join(" | ") + " |";
        };

        const lines = [renderRow(rows[0] ?? [])];
        lines.push("| " + Array.from({ length: cols }, (_, c) => delimiterFor(c)).join(" | ") + " |");
        for (let i = 1; i < rows.length; i++) lines.push(renderRow(rows[i]!));
        exitTable();
        return lines.join("\n");
      },
    },
  };
}
