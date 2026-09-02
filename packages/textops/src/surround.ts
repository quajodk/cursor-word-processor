import { TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import type { MarkType, ResolvedPos } from "prosemirror-model";
import { QUOTE_DELIMITERS } from "./data/locale-data";
import { isLiteralContext, marksAllowed } from "./text";

/**
 * Selection-aware surrounds.
 *
 * With text selected, typing a quote, bracket or emphasis character WRAPS the selection
 * instead of replacing it. This is the single most-felt text op: replacing a selection with
 * the character you typed is almost never what a writer meant, and every editor that gets it
 * right feels like an instrument for it.
 *
 * Three behaviours share one input handler, because they are the same question asked of
 * different selections:
 *   selection, opener typed   -> wrap it, and keep it selected so surrounds can nest
 *   caret, opener typed       -> auto-close, caret between the pair
 *   caret before a closer     -> type OVER it rather than doubling it
 */

/** Literal character pairs. Quotes are resolved per locale at call time. */
const BRACKETS: Record<string, [string, string]> = {
  "(": ["(", ")"],
  "[": ["[", "]"],
  "{": ["{", "}"],
};

/** Characters that apply a MARK rather than literal text. This is a rich editor whose source
 *  of truth is Markdown, so `*` means emphasis, not an asterisk. */
const MARK_FOR: Record<string, string> = {
  "*": "em",
  _: "em",
  "`": "code",
  "~": "strike",
};

function quotesFor(locale: string): { double: [string, string]; single: [string, string] } {
  const exact = QUOTE_DELIMITERS[locale];
  const lang = locale.toLowerCase().split(/[-_]/)[0] ?? "en";
  const q = exact ?? QUOTE_DELIMITERS[lang] ?? QUOTE_DELIMITERS["en"]!;
  return { double: [q[0], q[1]], single: [q[2], q[3]] };
}

/**
 * Is the caret already inside a quotation of this kind? Then the nested form is wanted —
 * “he said ‘no’ to that” rather than “he said “no” to that”.
 *
 * Scoped to the current block: quotations do not nest across paragraphs in any convention,
 * and scanning the document per keystroke would blow the latency budget.
 */
function insideQuote(text: string, offset: number, open: string, close: string): boolean {
  let depth = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

export interface SurroundOptions {
  locale?: string;
}

/**
 * Handle one typed character. Returns true when it was consumed as a surround.
 *
 * Wire this to `handleTextInput` on the view: it must run BEFORE the default insertion, and
 * it must be cheap, because it is on the keystroke path for every character typed.
 */
export function handleSurround(
  state: EditorState,
  from: number,
  to: number,
  ch: string,
  opts: SurroundOptions = {},
): Transaction | null {
  if (ch.length !== 1) return null;
  const locale = opts.locale ?? "en";
  const $from = state.doc.resolve(from);

  // Inside a code block or a code mark, every character is literal. Wrapping there would
  // corrupt the code rather than help the writer.
  if (isLiteralContext(state, $from)) return null;

  const empty = from === to;
  const markName = MARK_FOR[ch];
  const bracket = BRACKETS[ch];
  const q = quotesFor(locale);
  const isDouble = ch === '"';
  const isSingle = ch === "'";

  if (!markName && !bracket && !isDouble && !isSingle) {
    return empty ? typeOverCloser(state, from, ch) : null;
  }

  if (empty) {
    if (markName) return null; // no selection: `*` is just an asterisk until there is one
    const over = typeOverCloser(state, from, ch);
    if (over) return over;
    return autoClose(state, from, ch, bracket, isDouble, isSingle, q, locale);
  }

  // --- a selection: wrap it ---
  if (markName) return wrapWithMark(state, from, to, markName);

  let open: string, close: string;
  if (bracket) [open, close] = bracket;
  else {
    const blockText = $from.parent.textBetween(0, $from.parent.content.size, "\n", "￼");
    const offset = from - $from.start();
    const nested = insideQuote(blockText, offset, q.double[0], q.double[1]);
    [open, close] = isDouble ? (nested ? q.single : q.double) : q.single;
  }

  const tr = state.tr;
  tr.insertText(close, to);
  tr.insertText(open, from);
  // Keep the inner text selected — surrounds should nest by typing again.
  tr.setSelection(TextSelection.create(tr.doc, from + open.length, to + open.length));
  return tr;
}

/** Typing a closer directly before the same closer moves over it instead of doubling it. */
function typeOverCloser(state: EditorState, at: number, ch: string): Transaction | null {
  const CLOSERS = new Set([")", "]", "}", '"', "'", "”", "’", "»", "“"]);
  if (!CLOSERS.has(ch)) return null;
  const next = state.doc.textBetween(at, Math.min(at + 1, state.doc.content.size));
  if (next !== ch) return null;
  const tr = state.tr;
  tr.setSelection(TextSelection.create(tr.doc, at + 1));
  return tr;
}

function autoClose(
  state: EditorState,
  at: number,
  ch: string,
  bracket: [string, string] | undefined,
  isDouble: boolean,
  isSingle: boolean,
  q: { double: [string, string]; single: [string, string] },
  _locale: string,
): Transaction | null {
  let open: string, close: string;
  if (bracket) [open, close] = bracket;
  else if (isDouble || isSingle) {
    const $at = state.doc.resolve(at);
    const before = at > $at.start() ? state.doc.textBetween(at - 1, at) : "";
    // An apostrophe inside a word is a contraction, not an opening quote: "don't", "l'eau".
    if (isSingle && /[\p{L}\p{N}]/u.test(before)) {
      const tr = state.tr;
      tr.insertText(q.single[1], at);
      return tr;
    }
    const blockText = $at.parent.textBetween(0, $at.parent.content.size, "\n", "￼");
    const nested = insideQuote(blockText, at - $at.start(), q.double[0], q.double[1]);
    [open, close] = isDouble ? (nested ? q.single : q.double) : q.single;
  } else return null;

  const tr = state.tr;
  tr.insertText(open + close, at);
  tr.setSelection(TextSelection.create(tr.doc, at + open.length));
  return tr;
}

function wrapWithMark(state: EditorState, from: number, to: number, markName: string): Transaction | null {
  const type: MarkType | undefined = state.schema.marks[markName];
  if (!type) return null;
  const $from = state.doc.resolve(from);
  if (!marksAllowed(state, $from, type)) return null;

  const has = state.doc.rangeHasMark(from, to, type);
  const tr = state.tr;
  if (has) tr.removeMark(from, to, type);
  else tr.addMark(from, to, type.create());
  tr.setSelection(TextSelection.create(tr.doc, from, to));
  return tr;
}

/** Command form, for a binding rather than a typed character. */
export function surroundWith(ch: string, opts: SurroundOptions = {}): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const tr = handleSurround(state, from, to, ch, opts);
    if (!tr) return false;
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}
