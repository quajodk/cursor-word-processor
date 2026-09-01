import type { Root } from "mdast";
import type { StyleProfile } from "./types";
import { DEFAULT_STYLE } from "./types";

/**
 * Detects the `StyleProfile` a source file was actually written in, by reading real
 * character positions off the already-parsed mdast tree (never a second regex pass over
 * the raw source). `mdast-util-to-markdown` takes these as document-wide options — it has
 * no notion of "this list uses `-`, that one uses `*`" — so this is a majority vote per
 * field: whichever marker appears most often wins, ties broken toward {@link DEFAULT_STYLE}.
 *
 * This is what keeps `serialize(parse(x))` close to `x` instead of renormalizing every
 * bullet, fence and emphasis marker in a file that consistently used a non-default one.
 */
export function detectStyle(src: string, tree: Root): StyleProfile {
  const votes = {
    bullet: new Tally<StyleProfile["bullet"]>(DEFAULT_STYLE.bullet),
    bulletOrdered: new Tally<StyleProfile["bulletOrdered"]>(DEFAULT_STYLE.bulletOrdered),
    emphasis: new Tally<StyleProfile["emphasis"]>(DEFAULT_STYLE.emphasis),
    strong: new Tally<StyleProfile["strong"]>(DEFAULT_STYLE.strong),
    fence: new Tally<StyleProfile["fence"]>(DEFAULT_STYLE.fence),
    fences: new Tally<boolean>(DEFAULT_STYLE.fences),
    rule: new Tally<StyleProfile["rule"]>(DEFAULT_STYLE.rule),
    ruleRepetition: new Tally<number>(DEFAULT_STYLE.ruleRepetition),
    ruleSpaces: new Tally<boolean>(DEFAULT_STYLE.ruleSpaces),
    setext: new Tally<boolean>(DEFAULT_STYLE.setext),
    closeAtx: new Tally<boolean>(DEFAULT_STYLE.closeAtx),
    incrementListMarker: new Tally<boolean>(DEFAULT_STYLE.incrementListMarker),
    quote: new Tally<StyleProfile["quote"]>(DEFAULT_STYLE.quote),
    hardBreak: new Tally<StyleProfile["hardBreak"]>(DEFAULT_STYLE.hardBreak),
  };

  const at = (offset: number, len = 1) => src.slice(offset, offset + len);

  const walk = (node: any): void => {
    const pos = node.position;
    switch (node.type) {
      case "list": {
        if (node.ordered) {
          const first = node.children?.[0];
          if (first?.position) {
            const s = src.slice(first.position.start.offset, Math.min(first.position.start.offset + 12, first.position.end.offset));
            const m = /^\s*\d+([.)])/.exec(s);
            if (m) votes.bulletOrdered.add(m[1] as StyleProfile["bulletOrdered"]);
          }
          if (node.children && node.children.length >= 2) {
            const a = firstLineNumber(src, node.children[0]);
            const b = firstLineNumber(src, node.children[1]);
            if (a != null && b != null) votes.incrementListMarker.add(b === a + 1);
          }
        } else {
          const first = node.children?.[0];
          if (first?.position) votes.bullet.add(at(first.position.start.offset) as StyleProfile["bullet"]);
        }
        break;
      }
      case "emphasis":
        if (pos) votes.emphasis.add(at(pos.start.offset) as StyleProfile["emphasis"]);
        break;
      case "strong":
        if (pos) votes.strong.add(at(pos.start.offset) as StyleProfile["strong"]);
        break;
      case "code":
        if (pos) {
          const c = at(pos.start.offset);
          if (c === "`" || c === "~") {
            votes.fences.add(true);
            votes.fence.add(c as StyleProfile["fence"]);
          } else {
            votes.fences.add(false);
          }
        }
        break;
      case "thematicBreak":
        if (pos) {
          const line = src.slice(pos.start.offset, pos.end.offset);
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            votes.rule.add(trimmed[0] as StyleProfile["rule"]);
            votes.ruleSpaces.add(trimmed.includes(" "));
            votes.ruleRepetition.add(trimmed.replace(/\s+/g, "").length);
          }
        }
        break;
      case "heading":
        if (pos && node.depth <= 2) {
          const startsAtx = src.charAt(pos.start.offset) === "#";
          votes.setext.add(!startsAtx);
          if (startsAtx) {
            const line = src.slice(pos.start.offset, pos.end.offset).replace(/\s+$/, "");
            votes.closeAtx.add(/#+$/.test(line) && line.trim() !== "#".repeat(node.depth));
          }
        } else if (pos) {
          votes.setext.add(src.charAt(pos.start.offset) !== "#");
        }
        break;
      case "break":
        if (pos) {
          // A `break` token's own span starts AT its marker (the backslash itself, or the
          // first of the trailing spaces) — not after it — so the character to test is at
          // `start.offset`, not `start.offset - 1`.
          votes.hardBreak.add(src.charAt(pos.start.offset) === "\\" ? "backslash" : "spaces");
        }
        break;
      case "definition":
      case "link":
      case "image":
        if (pos && "title" in node && node.title != null) {
          const line = src.slice(pos.start.offset, pos.end.offset);
          const idx = line.lastIndexOf(String(node.title));
          const q = idx > 0 ? line[idx - 1] : undefined;
          if (q === '"' || q === "'") votes.quote.add(q);
        }
        break;
      default:
        break;
    }
    if (Array.isArray(node.children)) for (const c of node.children) walk(c);
  };

  walk(tree);

  return {
    bullet: votes.bullet.winner(),
    bulletOrdered: votes.bulletOrdered.winner(),
    emphasis: votes.emphasis.winner(),
    strong: votes.strong.winner(),
    fence: votes.fence.winner(),
    fences: votes.fences.winner(),
    rule: votes.rule.winner(),
    ruleRepetition: votes.ruleRepetition.winner(),
    ruleSpaces: votes.ruleSpaces.winner(),
    setext: votes.setext.winner(),
    closeAtx: votes.closeAtx.winner(),
    listItemIndent: DEFAULT_STYLE.listItemIndent,
    incrementListMarker: votes.incrementListMarker.winner(),
    quote: votes.quote.winner(),
    resourceLink: DEFAULT_STYLE.resourceLink,
    hardBreak: votes.hardBreak.winner(),
    finalNewline: src.length === 0 || src.endsWith("\n"),
  };
}

function firstLineNumber(src: string, item: any): number | null {
  if (!item?.position) return null;
  const s = src.slice(item.position.start.offset, Math.min(item.position.start.offset + 12, item.position.end.offset));
  const m = /^\s*(\d+)[.)]/.exec(s);
  return m ? Number(m[1]) : null;
}

class Tally<T> {
  private counts = new Map<T, number>();
  constructor(private readonly fallback: T) {}
  add(v: T) {
    this.counts.set(v, (this.counts.get(v) ?? 0) + 1);
  }
  winner(): T {
    let best: T = this.fallback;
    let bestCount = 0;
    for (const [v, n] of this.counts) {
      if (n > bestCount) {
        best = v;
        bestCount = n;
      }
    }
    return best;
  }
}
