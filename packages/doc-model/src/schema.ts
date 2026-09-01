import { Schema, type NodeSpec, type MarkSpec } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

/**
 * The schema is deliberately shaped like OOXML's block/run model so the .docx mapping is
 * structural rather than heuristic.
 *
 * Two attributes carry the entire fidelity story:
 *   `aid`    — stable block identity, maintained exactly across edits (see ./aid.ts).
 *   `*Ref`   — an opaque key into the fidelity sidecar. The editor NEVER interprets OOXML;
 *              it only carries the reference forward so export can splice it back.
 */

const blockAttrs = () => ({
  aid: { default: null as string | null },
  /** Word paragraph style id, e.g. "Heading1", "ListParagraph". Opaque here. */
  styleId: { default: null as string | null },
  /** Key into sidecar.pPr — unmodeled paragraph properties, verbatim. */
  pPrRef: { default: null as string | null },
});

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },

  paragraph: {
    group: "block",
    content: "inline*",
    attrs: blockAttrs(),
    parseDOM: [{ tag: "p" }],
    toDOM: (n) => ["p", { "data-aid": n.attrs.aid, "data-style": n.attrs.styleId ?? undefined }, 0],
  },

  heading: {
    group: "block",
    content: "inline*",
    defining: true,
    attrs: { ...blockAttrs(), level: { default: 1 } },
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (n) => [`h${n.attrs.level}`, { "data-aid": n.attrs.aid }, 0],
  },

  blockquote: {
    group: "block",
    content: "block+",
    defining: true,
    attrs: blockAttrs(),
    parseDOM: [{ tag: "blockquote" }],
    toDOM: (n) => ["blockquote", { "data-aid": n.attrs.aid }, 0],
  },

  code_block: {
    group: "block",
    content: "text*",
    marks: "",
    code: true,
    defining: true,
    attrs: { ...blockAttrs(), lang: { default: null as string | null } },
    parseDOM: [{ tag: "pre", preserveWhitespace: "full" as const }],
    toDOM: (n) => ["pre", { "data-aid": n.attrs.aid }, ["code", 0]],
  },

  /**
   * Lists carry `numRef` — a key into the sidecar's numbering definitions. Word numbering is
   * a separate part (`numbering.xml`) that we never parse; we only remember which list each
   * block belonged to so export can point at the original definition again.
   */
  bullet_list: {
    group: "block",
    content: "list_item+",
    attrs: { ...blockAttrs(), numRef: { default: null as string | null } },
    parseDOM: [{ tag: "ul" }],
    toDOM: (n) => ["ul", { "data-aid": n.attrs.aid }, 0],
  },
  ordered_list: {
    group: "block",
    content: "list_item+",
    attrs: { ...blockAttrs(), numRef: { default: null as string | null }, start: { default: 1 } },
    parseDOM: [{ tag: "ol" }],
    toDOM: (n) => ["ol", { "data-aid": n.attrs.aid, start: n.attrs.start === 1 ? undefined : n.attrs.start }, 0],
  },
  list_item: {
    content: "paragraph block*",
    defining: true,
    attrs: blockAttrs(),
    parseDOM: [{ tag: "li" }],
    toDOM: (n) => ["li", { "data-aid": n.attrs.aid }, 0],
  },

  horizontal_rule: {
    group: "block",
    attrs: blockAttrs(),
    parseDOM: [{ tag: "hr" }],
    toDOM: () => ["hr"],
  },

  figure: {
    group: "block",
    content: "image caption?",
    attrs: blockAttrs(),
    toDOM: (n) => ["figure", { "data-aid": n.attrs.aid }, 0],
    parseDOM: [{ tag: "figure" }],
  },
  caption: {
    content: "inline*",
    toDOM: () => ["figcaption", 0],
    parseDOM: [{ tag: "figcaption" }],
  },
  image: {
    inline: false,
    attrs: {
      src: { default: "" },
      alt: { default: null as string | null },
      title: { default: null as string | null },
      /** Key into sidecar.drawings — wrap mode, sizing, positioning, the embedded blob id. */
      drawingRef: { default: null as string | null },
    },
    draggable: true,
    parseDOM: [{ tag: "img[src]", getAttrs: (d) => ({ src: (d as HTMLElement).getAttribute("src"), alt: (d as HTMLElement).getAttribute("alt"), title: (d as HTMLElement).getAttribute("title") }) }],
    toDOM: (n) => ["img", { src: n.attrs.src, alt: n.attrs.alt, title: n.attrs.title }],
  },

  text: { group: "inline" },

  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
  },

  ...tableNodes({
    tableGroup: "block",
    cellContent: "block+",
    cellAttributes: {
      /** Key into sidecar.tcPr — shading, borders, vertical merge, cell width. */
      tcPrRef: { default: null, getFromDOM: (d) => d.getAttribute("data-tcpr"), setDOMAttr: (v, attrs) => { if (v) attrs["data-tcpr"] = v; } },
    },
  }),
};

const marks: Record<string, MarkSpec> = {
  strong: { parseDOM: [{ tag: "strong" }, { tag: "b" }, { style: "font-weight=bold" }], toDOM: () => ["strong", 0] },
  em: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: () => ["em", 0] },
  strike: { parseDOM: [{ tag: "s" }, { tag: "del" }], toDOM: () => ["s", 0] },
  underline: { parseDOM: [{ tag: "u" }], toDOM: () => ["u", 0] },
  code: { code: true, parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
  superscript: { excludes: "subscript", parseDOM: [{ tag: "sup" }], toDOM: () => ["sup", 0] },
  subscript: { excludes: "superscript", parseDOM: [{ tag: "sub" }], toDOM: () => ["sub", 0] },

  link: {
    attrs: { href: { default: "" }, title: { default: null as string | null } },
    inclusive: false,
    parseDOM: [{ tag: "a[href]", getAttrs: (d) => ({ href: (d as HTMLElement).getAttribute("href"), title: (d as HTMLElement).getAttribute("title") }) }],
    toDOM: (m) => ["a", { href: m.attrs.href, title: m.attrs.title }, 0],
  },

  /**
   * Unmodeled run formatting, by reference. A run whose `rPr` we do not understand keeps its
   * exact original XML in the sidecar and carries only this key. Export splices the original
   * `rPr` back verbatim.
   */
  rPrRef: {
    attrs: { ref: { default: "" } },
    parseDOM: [{ tag: "span[data-rpr]", getAttrs: (d) => ({ ref: (d as HTMLElement).getAttribute("data-rpr") }) }],
    toDOM: (m) => ["span", { "data-rpr": m.attrs.ref, class: "scriv-rpr" }, 0],
  },

  /** Anchor only. Thread content lives in the sidecar so it survives the sentence being reworded. */
  comment: {
    attrs: { anchorId: { default: "" } },
    inclusive: false,
    parseDOM: [{ tag: "span[data-comment]", getAttrs: (d) => ({ anchorId: (d as HTMLElement).getAttribute("data-comment") }) }],
    toDOM: (m) => ["span", { "data-comment": m.attrs.anchorId, class: "scriv-comment" }, 0],
  },

  /**
   * Tracked changes. Deliberately shared with AI suggestions: "accept this AI rewrite" and
   * "accept this colleague's tracked change" are one code path, and an AI edit can be
   * exported as a real Word revision.
   */
  insertion: {
    attrs: { revId: { default: "" }, author: { default: "" }, date: { default: null as string | null }, origin: { default: "user" as "user" | "ai" } },
    inclusive: false,
    parseDOM: [{ tag: "ins[data-rev]", getAttrs: (d) => ({ revId: (d as HTMLElement).getAttribute("data-rev"), author: (d as HTMLElement).getAttribute("data-author") ?? "", origin: (d as HTMLElement).getAttribute("data-origin") ?? "user" }) }],
    toDOM: (m) => ["ins", { "data-rev": m.attrs.revId, "data-author": m.attrs.author, "data-origin": m.attrs.origin, class: `scriv-ins scriv-ins-${m.attrs.origin}` }, 0],
  },
  deletion: {
    attrs: { revId: { default: "" }, author: { default: "" }, date: { default: null as string | null }, origin: { default: "user" as "user" | "ai" } },
    inclusive: false,
    parseDOM: [{ tag: "del[data-rev]", getAttrs: (d) => ({ revId: (d as HTMLElement).getAttribute("data-rev"), author: (d as HTMLElement).getAttribute("data-author") ?? "", origin: (d as HTMLElement).getAttribute("data-origin") ?? "user" }) }],
    toDOM: (m) => ["del", { "data-rev": m.attrs.revId, "data-author": m.attrs.author, "data-origin": m.attrs.origin, class: `scriv-del scriv-del-${m.attrs.origin}` }, 0],
  },
};

export const schema = new Schema({ nodes, marks });
export type ScrivSchema = typeof schema;

/** Node types that carry a stable block identity (`aid`) and may hold sidecar refs. */
export const IDENTIFIED_BLOCKS = new Set([
  "paragraph", "heading", "blockquote", "code_block",
  "bullet_list", "ordered_list", "list_item", "horizontal_rule", "figure", "table",
]);
