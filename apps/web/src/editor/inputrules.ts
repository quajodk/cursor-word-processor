import { schema } from "@scriv/doc-model";
import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import type { Plugin } from "prosemirror-state";

/**
 * Input rules — what happens as you type, not how a file is read.
 *
 * These are editor affordances (the same class of thing as a word processor turning `--` into a
 * dash), not a Markdown parser: nothing here ever sees a file. Reading and writing Markdown is
 * `@scriv/md`'s job and is reached through `src/doc/codec.ts`.
 *
 * The typographic rules matter more than they look. A document whose quotation marks are all
 * vertical, whose dashes are hyphens and whose ellipses are three full stops reads as a text
 * file no matter how well it is set — and that is exactly the comparison being judged.
 *
 * Order is load-bearing: prosemirror-inputrules takes the first rule that matches, so the
 * block-level rules (anchored with `^`) are tried before the typographic ones. Otherwise
 * `--- ` at the start of a paragraph would become an em dash instead of a horizontal rule.
 */

const { paragraph, heading, blockquote, bullet_list, ordered_list, code_block, horizontal_rule } = schema.nodes;

function blockRules(): InputRule[] {
  return [
    textblockTypeInputRule(/^(#{1,6})\s$/, heading!, (match) => ({ level: match[1]!.length })),
    textblockTypeInputRule(/^```(\w+)?\s$/, code_block!, (match) => ({ lang: match[1] ?? null })),
    wrappingInputRule(/^\s*>\s$/, blockquote!),
    wrappingInputRule(/^\s*([-+*])\s$/, bullet_list!),
    wrappingInputRule(
      /^(\d+)[.)]\s$/,
      ordered_list!,
      (match) => ({ start: Number(match[1]) }),
      (match, node) => node.childCount + (node.attrs.start as number) === Number(match[1]),
    ),
    new InputRule(/^(?:---|\*\*\*|___)\s$/, (state, _match, start, end) => {
      const tr = state.tr.replaceRangeWith(start, end, horizontal_rule!.create());
      // A rule as the last block leaves the caret nowhere to go.
      if (tr.doc.lastChild?.type.name === "horizontal_rule") {
        tr.insert(tr.doc.content.size, paragraph!.create());
      }
      return tr;
    }),
  ];
}

/**
 * Directional quotes. An opener is one that follows the start of a block, a space, or an opening
 * bracket; everything else closes. That is the rule typesetters use, and it gets apostrophes
 * right (`don't`) at the cost of the known casualty, a leading elision like `'90s`.
 */
function typographicRules(): InputRule[] {
  return [
    new InputRule(/\.\.\.$/, "…"),
    new InputRule(/---\s$/, "— "),
    new InputRule(/(?<=[^-\s])--\s$/, "– "),

    new InputRule(/(^|[\s([{—–‘])"$/, "$1“"),
    new InputRule(/"$/, "”"),
    new InputRule(/(^|[\s([{—–“])'$/, "$1‘"),
    new InputRule(/'$/, "’"),

    new InputRule(/->$/, "→"),
    new InputRule(/<-$/, "←"),
    new InputRule(/\(c\)$/, "©"),
    new InputRule(/\(r\)$/, "®"),
    new InputRule(/\(tm\)$/, "™"),
    new InputRule(/\+-$/, "±"),
  ];
}

export function scrivInputRules(): Plugin {
  return inputRules({ rules: [...blockRules(), ...typographicRules()] });
}
