import { schema } from "@scriv/doc-model";
import type { Node as PMNode } from "prosemirror-model";
import { CodecError, type CodecResult, type DocumentCodec } from "./codec";

/**
 * The provisional codec: plain text in, plain text out, byte for byte.
 *
 * It has no Markdown knowledge whatsoever — that belongs to `@scriv/md` and duplicating it here
 * would be the wrong kind of progress. What it does have is an exact round trip, which is the
 * property the file-I/O path actually needs to be trustworthy while the real codec lands:
 *
 *   - A *block* is a maximal run of lines that are not empty. It becomes one `paragraph`, with
 *     the interior line breaks kept as `hard_break` nodes.
 *   - The number of empty lines *before* each block rides on that block as a `txt:gap=N`
 *     `styleId`, and the empty lines after the last block ride in `meta`. Reassembling the file
 *     is then `lines.join("\n")` over the same line array we took apart, so `serialize(parse(x))
 *     === x` for every input, including CRLF-free files with irregular spacing and no trailing
 *     newline.
 *   - `serialize` refuses a document containing anything but paragraphs rather than flattening
 *     it. Losing a writer's headings on save is worse than a loud failure.
 *
 * The `txt:` attribute namespace is this file's alone and disappears with this file. It does not
 * collide with `@scriv/md`'s reserved `md:` namespace or with the OOXML fidelity sidecar's keys.
 */

const GAP = "txt:gap=";

interface PlainMeta {
  kind: "plain-text";
  /** Empty lines between the last block and end of file. */
  tail: number;
}

function gapOf(node: PMNode): number | null {
  const style: unknown = node.attrs.styleId;
  if (typeof style !== "string" || !style.startsWith(GAP)) return null;
  const n = Number(style.slice(GAP.length));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function paragraphFrom(lines: string[], gapBefore: number): PMNode {
  const inline: PMNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) inline.push(schema.nodes.hard_break!.create());
    if (line.length > 0) inline.push(schema.text(line));
  });
  return schema.nodes.paragraph!.create({ styleId: `${GAP}${gapBefore}` }, inline);
}

function linesOf(paragraph: PMNode): string[] {
  const out: string[] = [];
  let current = "";
  paragraph.forEach((child) => {
    if (child.type.name === "hard_break") {
      out.push(current);
      current = "";
    } else if (child.isText) {
      current += child.text ?? "";
    } else {
      throw new CodecError(
        `the provisional plain-text codec cannot write a "${child.type.name}" node — ` +
          `@scriv/md has not landed yet, so structured documents cannot be saved`,
      );
    }
  });
  out.push(current);
  return out;
}

function parse(text: string): CodecResult {
  const lines = text.split("\n");
  const blocks: PMNode[] = [];

  let i = 0;
  let gap = 0;
  while (i < lines.length) {
    if (lines[i] === "") {
      gap++;
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && lines[i] !== "") i++;
    blocks.push(paragraphFrom(lines.slice(start, i), gap));
    gap = 0;
  }
  // Whatever empty lines are left over trail the final block. A file that is entirely blank has
  // no block at all, so one of those blank lines becomes the (empty) paragraph the editor needs
  // and the rest stay in the tail — which keeps "" ⇄ "" and "\n\n" ⇄ "\n\n" exact.
  let tail = gap;
  if (blocks.length === 0) {
    blocks.push(paragraphFrom([""], 0));
    tail = Math.max(0, gap - 1);
  }

  const meta: PlainMeta = { kind: "plain-text", tail };
  return { doc: schema.nodes.doc!.create(null, blocks), meta };
}

function serialize(doc: PMNode, meta: unknown): string {
  const out: string[] = [];
  let index = 0;
  doc.forEach((node) => {
    if (node.type.name !== "paragraph") {
      throw new CodecError(
        `the provisional plain-text codec cannot write a "${node.type.name}" block — ` +
          `@scriv/md has not landed yet, so structured documents cannot be saved`,
      );
    }
    // A paragraph created by typing has no recorded gap: one blank line between blocks is the
    // convention every plain-text and Markdown file already follows.
    const gap = gapOf(node) ?? (index === 0 ? 0 : 1);
    for (let k = 0; k < gap; k++) out.push("");
    out.push(...linesOf(node));
    index++;
  });

  const tail = isPlainMeta(meta) ? meta.tail : 1;
  for (let k = 0; k < tail; k++) out.push("");
  return out.join("\n");
}

function isPlainMeta(meta: unknown): meta is PlainMeta {
  return typeof meta === "object" && meta !== null && (meta as PlainMeta).kind === "plain-text";
}

export const plainTextCodec: DocumentCodec = {
  id: "plain-text",
  label: "plain text (provisional — @scriv/md pending)",
  structural: false,
  parse,
  serialize,
};
