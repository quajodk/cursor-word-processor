import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { Fragment, Mark, Node as PMNode } from "prosemirror-model";
import { schema } from "@scriv/doc-model";

/**
 * Markdown ⇄ doc-model.
 *
 * ARCHITECTURE.md gives this job to `@scriv/md` (mdast, remark). That package is not written
 * yet, and this app has to open and save real `.md` files today, so the bridge lives here —
 * behind exactly two functions, so moving it to `@scriv/md` later is an import change and
 * nothing else. It parses with markdown-it (a real CommonMark implementation plus GFM tables
 * and strikethrough), never with regexes over the source.
 *
 * Known, deliberate limits — each one is a place where the schema has no representation:
 *   - Column alignment in GFM tables is dropped (the table cell attrs carry no `align`).
 *   - An image that is not alone in its paragraph becomes its own `figure`, splitting the
 *     paragraph around it. The schema has no inline image, and losing the image entirely
 *     would be worse than moving it onto its own line.
 *   - Raw HTML other than the inline tags that map to marks (`<u> <sup> <sub> <br>`) is kept
 *     verbatim as text rather than interpreted.
 *   - Reference-style links and setext headings are normalised to inline links and ATX
 *     headings on save, as any AST round-trip does.
 * YAML frontmatter is preserved byte-for-byte: it is lifted off before parsing and put back
 * on save, so opening and saving a Jekyll or Obsidian note does not eat its metadata.
 */

const md: MarkdownIt = new MarkdownIt("default", { html: true, linkify: false, typographer: false });

const FRONTMATTER = /^(---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/;

export interface ParsedDocument {
  doc: PMNode;
  /** Verbatim frontmatter block, including its delimiters and trailing newline. */
  frontmatter: string;
}

export function parseMarkdown(source: string): ParsedDocument {
  const match = FRONTMATTER.exec(source);
  const frontmatter = match ? match[1]! : "";
  const body = frontmatter ? source.slice(frontmatter.length) : source;

  const tokens = md.parse(body, {});
  const blocks = new BlockBuilder().build(tokens);
  const content = blocks.length > 0 ? blocks : [schema.nodes.paragraph!.create()];
  return { doc: schema.node("doc", null, content), frontmatter };
}

export function serializeMarkdown(doc: PMNode, frontmatter = ""): string {
  const out = new Serializer().render(doc);
  return frontmatter + out;
}

// ---------------------------------------------------------------------------
// markdown-it tokens → doc-model nodes
// ---------------------------------------------------------------------------

const MARK_TOKENS: Record<string, string> = {
  strong: "strong",
  em: "em",
  s: "strike",
};

const HTML_MARKS: Record<string, string> = {
  "<u>": "underline",
  "<sup>": "superscript",
  "<sub>": "subscript",
};
const HTML_MARK_CLOSERS: Record<string, string> = {
  "</u>": "underline",
  "</sup>": "superscript",
  "</sub>": "subscript",
};

class BlockBuilder {
  build(tokens: Token[]): PMNode[] {
    const { nodes: built } = this.blocks(tokens, 0, tokens.length);
    return built;
  }

  /** Consumes `[start, end)` and returns the block nodes it describes. */
  private blocks(tokens: Token[], start: number, end: number): { nodes: PMNode[]; next: number } {
    const out: PMNode[] = [];
    let i = start;
    while (i < end) {
      const token = tokens[i]!;
      switch (token.type) {
        case "paragraph_open": {
          const close = this.matching(tokens, i, "paragraph_open", "paragraph_close", end);
          const inline = tokens[i + 1];
          out.push(...this.paragraphish(inline && inline.type === "inline" ? inline : null, "paragraph", null));
          i = close + 1;
          break;
        }
        case "heading_open": {
          const close = this.matching(tokens, i, "heading_open", "heading_close", end);
          const inline = tokens[i + 1];
          const level = Number(token.tag.slice(1)) || 1;
          out.push(...this.paragraphish(inline && inline.type === "inline" ? inline : null, "heading", { level }));
          i = close + 1;
          break;
        }
        case "blockquote_open": {
          const close = this.matching(tokens, i, "blockquote_open", "blockquote_close", end);
          const inner = this.blocks(tokens, i + 1, close).nodes;
          out.push(schema.nodes.blockquote!.create(null, inner.length ? inner : [schema.nodes.paragraph!.create()]));
          i = close + 1;
          break;
        }
        case "bullet_list_open":
        case "ordered_list_open": {
          const openType = token.type;
          const closeType = openType.replace("_open", "_close");
          const close = this.matching(tokens, i, openType, closeType, end);
          const items = this.listItems(tokens, i + 1, close);
          const isOrdered = openType === "ordered_list_open";
          const startAttr = Number(token.attrGet("start") ?? 1) || 1;
          const type = isOrdered ? schema.nodes.ordered_list! : schema.nodes.bullet_list!;
          out.push(
            type.create(
              isOrdered ? { start: startAttr } : null,
              items.length ? items : [schema.nodes.list_item!.create(null, schema.nodes.paragraph!.create())],
            ),
          );
          i = close + 1;
          break;
        }
        case "fence":
        case "code_block": {
          const lang = token.info ? token.info.trim().split(/\s+/)[0]! : null;
          const text = token.content.replace(/\n$/, "");
          out.push(
            schema.nodes.code_block!.create({ lang: lang || null }, text ? schema.text(text) : undefined),
          );
          i++;
          break;
        }
        case "hr":
          out.push(schema.nodes.horizontal_rule!.create());
          i++;
          break;
        case "table_open": {
          const close = this.matching(tokens, i, "table_open", "table_close", end);
          const table = this.table(tokens, i + 1, close);
          if (table) out.push(table);
          i = close + 1;
          break;
        }
        case "html_block": {
          // No html node in the schema: keep the source verbatim as text so saving does not
          // silently delete it. Newlines become hard breaks to preserve the shape.
          const inline = htmlBlockToInline(token.content);
          if (inline.length) out.push(schema.nodes.paragraph!.create(null, inline));
          i++;
          break;
        }
        default:
          i++;
      }
    }
    return { nodes: out, next: i };
  }

  private listItems(tokens: Token[], start: number, end: number): PMNode[] {
    const items: PMNode[] = [];
    let i = start;
    while (i < end) {
      if (tokens[i]!.type !== "list_item_open") {
        i++;
        continue;
      }
      const close = this.matching(tokens, i, "list_item_open", "list_item_close", end);
      const inner = this.blocks(tokens, i + 1, close).nodes;
      // `list_item` requires `paragraph block*`: a list item that starts with a nested list
      // (rare but legal) gets an empty leading paragraph so the document stays valid.
      const content =
        inner.length > 0 && inner[0]!.type.name === "paragraph"
          ? inner
          : [schema.nodes.paragraph!.create(), ...inner];
      items.push(schema.nodes.list_item!.create(null, content));
      i = close + 1;
    }
    return items;
  }

  private table(tokens: Token[], start: number, end: number): PMNode | null {
    const rows: PMNode[] = [];
    let i = start;
    while (i < end) {
      const token = tokens[i]!;
      if (token.type !== "tr_open") {
        i++;
        continue;
      }
      const trClose = this.matching(tokens, i, "tr_open", "tr_close", end);
      const cells: PMNode[] = [];
      let j = i + 1;
      while (j < trClose) {
        const cell = tokens[j]!;
        if (cell.type === "th_open" || cell.type === "td_open") {
          const openType = cell.type;
          const closeType = openType.replace("_open", "_close");
          const cellClose = this.matching(tokens, j, openType, closeType, trClose);
          const inline = tokens[j + 1];
          const body = this.paragraphish(inline && inline.type === "inline" ? inline : null, "paragraph", null);
          const type = openType === "th_open" ? schema.nodes.table_header! : schema.nodes.table_cell!;
          cells.push(type.create(null, body.length ? body : [schema.nodes.paragraph!.create()]));
          j = cellClose + 1;
        } else j++;
      }
      if (cells.length) rows.push(schema.nodes.table_row!.create(null, cells));
      i = trClose + 1;
    }
    return rows.length ? schema.nodes.table!.create(null, rows) : null;
  }

  /**
   * Builds a paragraph or heading from one `inline` token.
   *
   * Returns several blocks when the inline content contains an image: the schema has no
   * inline image, so the paragraph is split around it and the image becomes a `figure`.
   */
  private paragraphish(inline: Token | null, kind: "paragraph" | "heading", attrs: Record<string, unknown> | null): PMNode[] {
    const type = kind === "heading" ? schema.nodes.heading! : schema.nodes.paragraph!;
    if (!inline) return [type.create(attrs)];

    const pieces = new InlineBuilder().build(inline.children ?? []);
    const out: PMNode[] = [];
    let run: PMNode[] = [];
    const flush = () => {
      if (run.length) {
        out.push(type.create(attrs, run));
        run = [];
      }
    };
    for (const piece of pieces) {
      if (piece.kind === "figure") {
        flush();
        out.push(piece.node);
      } else run.push(piece.node);
    }
    flush();
    return out.length ? out : [type.create(attrs)];
  }

  private matching(tokens: Token[], open: number, openType: string, closeType: string, end: number): number {
    let depth = 0;
    for (let i = open; i < end; i++) {
      const type = tokens[i]!.type;
      if (type === openType) depth++;
      else if (type === closeType) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return end - 1;
  }
}

type InlinePiece = { kind: "inline" | "figure"; node: PMNode };

class InlineBuilder {
  private marks: readonly Mark[] = Mark.none;
  private readonly out: InlinePiece[] = [];

  build(tokens: Token[]): InlinePiece[] {
    for (const token of tokens) this.token(token);
    return this.out;
  }

  private token(token: Token): void {
    const markName = MARK_TOKENS[token.type.replace(/_(open|close)$/, "")];
    if (markName && token.type.endsWith("_open")) return this.push(markName);
    if (markName && token.type.endsWith("_close")) return this.pop(markName);

    switch (token.type) {
      case "text":
        this.text(token.content);
        return;
      case "softbreak":
        this.text("\n");
        return;
      case "hardbreak":
        this.out.push({ kind: "inline", node: schema.nodes.hard_break!.create(null, undefined, this.marks) });
        return;
      case "code_inline":
        this.out.push({
          kind: "inline",
          node: schema.text(token.content, addMark(this.marks, schema.marks.code!.create())),
        });
        return;
      case "link_open":
        this.push("link", { href: token.attrGet("href") ?? "", title: token.attrGet("title") });
        return;
      case "link_close":
        this.pop("link");
        return;
      case "image": {
        const alt = token.children ? plainText(token.children) : (token.content ?? "");
        const title = token.attrGet("title");
        const image = schema.nodes.image!.create({
          src: token.attrGet("src") ?? "",
          alt: alt || null,
          title: title || null,
        });
        const caption = title ? schema.nodes.caption!.create(null, schema.text(title)) : null;
        this.out.push({
          kind: "figure",
          node: schema.nodes.figure!.create(null, caption ? [image, caption] : [image]),
        });
        return;
      }
      case "html_inline": {
        const tag = token.content.toLowerCase().replace(/\s+/g, "");
        const opener = HTML_MARKS[tag];
        if (opener) return this.push(opener);
        const closer = HTML_MARK_CLOSERS[tag];
        if (closer) return this.pop(closer);
        if (tag === "<br>" || tag === "<br/>") {
          this.out.push({ kind: "inline", node: schema.nodes.hard_break!.create(null, undefined, this.marks) });
          return;
        }
        // Unrecognised HTML is content, not markup, as far as this schema is concerned.
        this.text(token.content);
        return;
      }
      default:
        if (token.children?.length) for (const child of token.children) this.token(child);
    }
  }

  private text(value: string): void {
    if (!value) return;
    this.out.push({ kind: "inline", node: schema.text(value, this.marks) });
  }

  private push(markName: string, attrs?: Record<string, unknown>): void {
    const type = schema.marks[markName];
    if (!type) return;
    this.marks = addMark(this.marks, type.create(attrs ?? null));
  }

  private pop(markName: string): void {
    const type = schema.marks[markName];
    if (!type) return;
    this.marks = this.marks.filter((m) => m.type !== type);
  }
}

function addMark(marks: readonly Mark[], mark: Mark): readonly Mark[] {
  return mark.addToSet(marks as Mark[]);
}

function plainText(tokens: Token[]): string {
  return tokens.map((t) => (t.type === "text" || t.type === "code_inline" ? t.content : plainText(t.children ?? []))).join("");
}

function htmlBlockToInline(content: string): PMNode[] {
  const lines = content.replace(/\n+$/, "").split("\n");
  const out: PMNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push(schema.nodes.hard_break!.create());
    if (line) out.push(schema.text(line));
  });
  return out;
}

// ---------------------------------------------------------------------------
// doc-model nodes → markdown
// ---------------------------------------------------------------------------

/** Ordered so that nesting is stable across a round trip. */
const MARK_SYNTAX: { name: string; open: string; close: string }[] = [
  { name: "strong", open: "**", close: "**" },
  { name: "em", open: "*", close: "*" },
  { name: "strike", open: "~~", close: "~~" },
  { name: "underline", open: "<u>", close: "</u>" },
  { name: "superscript", open: "<sup>", close: "</sup>" },
  { name: "subscript", open: "<sub>", close: "</sub>" },
];

class Serializer {
  render(doc: PMNode): string {
    const out = this.blocks(doc.content, "");
    return out.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n*$/, "\n");
  }

  private blocks(fragment: Fragment, indent: string): string {
    const parts: string[] = [];
    fragment.forEach((child) => parts.push(this.block(child, indent)));
    return parts.filter((p) => p.length > 0).join("\n");
  }

  private block(node: PMNode, indent: string): string {
    switch (node.type.name) {
      case "paragraph":
        return prefixLines(this.inline(node.content), indent) + "\n";
      case "heading":
        return indent + "#".repeat(clamp(node.attrs.level as number, 1, 6)) + " " + this.inline(node.content).replace(/\n/g, " ") + "\n";
      case "blockquote": {
        const inner = this.blocks(node.content, "");
        return inner
          .split("\n")
          .map((line) => (line ? `${indent}> ${line}` : `${indent}>`))
          .join("\n")
          .replace(/\n+$/, "\n");
      }
      case "code_block": {
        const text = node.textContent;
        const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
        const lang = (node.attrs.lang as string | null) ?? "";
        return prefixLines(`${fence}${lang}\n${text}\n${fence}`, indent) + "\n";
      }
      case "bullet_list":
        return this.list(node, indent, () => "- ");
      case "ordered_list": {
        const start = Number(node.attrs.start ?? 1) || 1;
        return this.list(node, indent, (index) => `${start + index}. `);
      }
      case "horizontal_rule":
        return indent + "---\n";
      case "figure":
        return indent + this.figure(node) + "\n";
      case "table":
        return this.table(node, indent);
      default: {
        // Any block we do not have syntax for still has to keep its text.
        if (node.isTextblock) return prefixLines(this.inline(node.content), indent) + "\n";
        return this.blocks(node.content, indent);
      }
    }
  }

  private list(node: PMNode, indent: string, marker: (index: number) => string): string {
    const parts: string[] = [];
    node.content.forEach((item, _offset, index) => {
      const bullet = marker(index);
      const childIndent = indent + " ".repeat(bullet.length);
      const body = this.blocks(item.content, childIndent);
      // The first line carries the marker; continuation lines are already indented to match.
      parts.push(indent + bullet + body.slice(childIndent.length).replace(/\n$/, ""));
    });
    return parts.join("\n") + "\n";
  }

  private figure(node: PMNode): string {
    let src = "";
    let alt = "";
    let title: string | null = null;
    node.content.forEach((child) => {
      if (child.type.name === "image") {
        src = String(child.attrs.src ?? "");
        alt = String(child.attrs.alt ?? "");
        title = (child.attrs.title as string | null) ?? null;
      } else if (child.type.name === "caption") {
        title = child.textContent || title;
      }
    });
    const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
    return `![${escapeInline(alt)}](${encodeLinkTarget(src)}${titlePart})`;
  }

  private table(node: PMNode, indent: string): string {
    const rows: string[][] = [];
    let columns = 0;
    node.content.forEach((row) => {
      const cells: string[] = [];
      row.content.forEach((cell) => cells.push(this.inline(cell.content).replace(/\n/g, " ").replace(/\|/g, "\\|").trim()));
      columns = Math.max(columns, cells.length);
      rows.push(cells);
    });
    if (rows.length === 0) return "";
    const pad = (cells: string[]) => {
      const filled = [...cells];
      while (filled.length < columns) filled.push("");
      return `| ${filled.join(" | ")} |`;
    };
    const lines = [pad(rows[0]!), `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`];
    for (let i = 1; i < rows.length; i++) lines.push(pad(rows[i]!));
    return prefixLines(lines.join("\n"), indent) + "\n";
  }

  /** Inline content with marks applied. Marks are closed and reopened at run boundaries. */
  private inline(fragment: Fragment): string {
    let out = "";
    let active: string[] = [];

    const closeDown = (target: string[]) => {
      while (active.length > target.length || (active.length > 0 && active[active.length - 1] !== target[active.length - 1])) {
        const name = active.pop()!;
        out += syntax(name).close;
      }
    };

    fragment.forEach((child) => {
      if (child.type.name === "hard_break") {
        closeDown([]);
        active = [];
        out += "\\\n";
        return;
      }
      if (!child.isText) {
        // A block-level node inside inline content (an image that escaped a figure, say).
        closeDown([]);
        active = [];
        out += child.textContent;
        return;
      }

      const link = child.marks.find((m) => m.type.name === "link");
      const codeMark = child.marks.find((m) => m.type.name === "code");
      const names = MARK_SYNTAX.filter((s) => child.marks.some((m) => m.type.name === s.name)).map((s) => s.name);

      // `active` is a stack; keep the common prefix and reopen the rest.
      let shared = 0;
      while (shared < active.length && shared < names.length && active[shared] === names[shared]) shared++;
      closeDown(names.slice(0, shared));
      active = names.slice(0, shared);
      for (const name of names.slice(shared)) {
        out += syntax(name).open;
        active.push(name);
      }

      let text = child.text ?? "";
      if (codeMark) {
        const ticks = "`".repeat(longestBacktickRun(text) + 1);
        const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
        text = `${ticks}${padding}${text}${padding}${ticks}`;
      } else {
        text = escapeInline(text);
      }
      if (link) {
        const title = link.attrs.title ? ` "${String(link.attrs.title).replace(/"/g, '\\"')}"` : "";
        text = `[${text}](${encodeLinkTarget(String(link.attrs.href ?? ""))}${title})`;
      }
      out += text;
    });

    closeDown([]);
    return out;
  }
}

function syntax(name: string): { open: string; close: string } {
  return MARK_SYNTAX.find((s) => s.name === name) ?? { open: "", close: "" };
}

/**
 * Escapes only what would otherwise change meaning when re-parsed. `<` is deliberately left
 * alone: raw HTML is preserved as text, and escaping it would corrupt it on every save.
 */
function escapeInline(text: string): string {
  return text
    .replace(/([\\`*_[\]])/g, "\\$1")
    .replace(/^(\s*)([#>])/gm, "$1\\$2")
    .replace(/^(\s*)([-+])(\s)/gm, "$1\\$2$3")
    .replace(/^(\s*)(\d+)\.(\s)/gm, "$1$2\\.$3");
}

function encodeLinkTarget(href: string): string {
  if (!href) return "";
  return /[\s()]/.test(href) ? `<${href}>` : href;
}

function prefixLines(text: string, indent: string): string {
  if (!indent) return text;
  return text
    .split("\n")
    .map((line) => (line ? indent + line : line))
    .join("\n");
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value) || min));
}

// ---------------------------------------------------------------------------
// Non-markdown text files
// ---------------------------------------------------------------------------

/**
 * Any other text file opens as a single `code_block` and saves back byte-for-byte. scriv is a
 * writing tool, not a code editor, but refusing to open a `.txt` or a `.json` sitting next to
 * the manuscript would be worse than showing it plainly.
 */
export function plainTextDocument(text: string, lang: string | null): PMNode {
  const body = text.replace(/\n$/, "");
  return schema.node("doc", null, [
    schema.nodes.code_block!.create({ lang }, body ? schema.text(body) : undefined),
  ]);
}

export function serializePlainText(doc: PMNode): string {
  const parts: string[] = [];
  doc.content.forEach((child) => parts.push(child.textContent));
  return parts.join("\n") + "\n";
}
