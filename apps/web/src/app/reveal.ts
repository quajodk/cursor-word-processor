import type { Node as PMNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { currentContext } from "../commands/registry";

/**
 * Go there.
 *
 * Three panels print an address at you — the search results print a line number, an agent site
 * prints a line number, a fidelity entry names a block `aid` — and none of them would take you
 * to it. Three builders stopped at the same edge, and the one implementation of the verb that
 * does exist, `revealThread` in `editor/comments.ts`, was never named as something the others
 * could use. This is that verb, named, for the two kinds of address the app actually has.
 *
 * AN ADDRESS IS IN A FILE; THE CARET IS IN A DOCUMENT. There is no line-number-to-position map
 * to look up: the codecs parse a file into blocks and keep no source offsets, and a heading
 * written `### Instrumentation` is a block whose text is `Instrumentation`, so a line's own
 * characters are not in the document either. What survives both directions is the *matched
 * text* — the term the agent found, the string the search matched — so navigation is by that
 * text, and the line number is used for the one thing it is good for: saying WHICH occurrence
 * of it, when a document says the same word eleven times.
 *
 * When the counts agree between the file and the document, that choice is exact. When they do
 * not — the file said the word inside a link target or a fence marker, where the document
 * cannot — it falls back to the occurrence nearest the same relative depth and says nothing,
 * because landing one paragraph out is still landing, and a refusal here would be the silent
 * empty box this whole pass is about.
 */

export interface SourceAddress {
  /**
   * The file, as the panel holds it.
   *
   * Absolute or workspace-relative, because the two panels that have an address hold it the
   * two different ways: a search hit comes back from the host absolute, and an agent site is
   * relative because `readWorkspace` makes it relative for display. Resolving that here rather
   * than at each call site is the point of having one module for this.
   */
  path: string;
  /** 1-based line, as the panel printed it. */
  line: number;
  /** 1-based column of `needle` within that line. */
  column: number;
  /** The text at the address. Selecting it is what "taking you there" means. */
  needle: string;
}

/**
 * Open the file if it is not already open, then select the addressed text.
 *
 * Opening goes through the shell's own `openFile`, so a dirty buffer is guarded exactly as it
 * is everywhere else and the tree reveals the file the same way. If that guard refuses, it has
 * already said why and this returns false rather than steering the caret around a document the
 * writer is not looking at.
 */
export async function revealSource(addr: SourceAddress): Promise<boolean> {
  const ctx = currentContext();
  if (!ctx || addr.needle.length === 0) return false;

  const path = absolute(ctx.root, addr.path);
  if (ctx.filePath !== path) {
    await ctx.ui.openFile(path);
    if (currentContext()?.filePath !== path) return false;
  }

  const live = currentContext();
  const view = live?.view;
  if (!live || !view) return false;

  const flat = flatten(view.state.doc);
  const inDoc = occurrences(flat.text, addr.needle);
  if (inDoc.length === 0) {
    live.ui.notify(
      `“${addr.needle}” is no longer at line ${addr.line} of this document. Search again to see where it went.`,
      "error",
    );
    return false;
  }

  let at = inDoc[0]!;
  try {
    const fileText = await live.host.fs.read(path);
    at = choose(fileText, addr, inDoc, flat.text.length);
  } catch {
    // Unreadable as text — a .docx, or a file that moved. The first occurrence is still a
    // better answer than none.
  }

  const from = flat.posAt(at);
  const to = flat.posAt(at + addr.needle.length);
  select(view, from, to);
  return true;
}

/**
 * Select the block a fidelity entry is about.
 *
 * `aid` is the document model's own stable block identity, maintained across edits, so unlike
 * a line number this address cannot go stale while you read the panel.
 */
export function revealBlock(aid: string): boolean {
  const view = currentContext()?.view;
  if (!view) return false;

  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.attrs["aid"] === aid) {
      found = pos;
      return false;
    }
    return true;
  });
  if (found < 0) return false;

  select(view, found + 1, found + 1);
  return true;
}

// ---------------------------------------------------------------------------- internals

/** The host takes absolute paths; a panel may be holding a workspace-relative one. */
function absolute(root: string, path: string): string {
  if (path.startsWith("/")) return path;
  return root.endsWith("/") ? root + path : `${root}/${path}`;
}

function select(view: EditorView, from: number, to: number): void {
  const doc = view.state.doc;
  const max = doc.content.size;
  const a = Math.max(0, Math.min(from, max));
  const b = Math.max(a, Math.min(to, max));
  // `between` rather than `create`: an address can land on a node boundary — the start of a
  // list item, the gap between two blocks — where a text selection does not exist and `create`
  // throws. `between` resolves to the closest place a caret can actually be.
  const selection = TextSelection.between(doc.resolve(a), doc.resolve(b));
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
  view.focus();
}

interface Flat {
  text: string;
  /** Document position for a character index into `text`. */
  posAt(index: number): number;
}

/**
 * The document as one string, with a newline between blocks, plus the map back to positions.
 *
 * The newline is what stops a match from spanning two paragraphs — without it the end of one
 * block and the start of the next read as adjacent characters and a two-word needle can match
 * text that is nowhere on screen together.
 */
function flatten(doc: PMNode): Flat {
  let text = "";
  const runs: { at: number; pos: number; len: number }[] = [];

  doc.descendants((node, pos) => {
    if (node.isText) {
      const value = node.text ?? "";
      runs.push({ at: text.length, pos, len: value.length });
      text += value;
      return false;
    }
    if (node.isBlock && text.length > 0 && !text.endsWith("\n")) text += "\n";
    return true;
  });

  return {
    text,
    posAt(index: number): number {
      if (runs.length === 0) return 0;
      let lo = 0;
      let hi = runs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (runs[mid]!.at <= index) lo = mid;
        else hi = mid - 1;
      }
      const run = runs[lo]!;
      const within = Math.max(0, Math.min(index - run.at, run.len));
      return run.pos + within;
    },
  };
}

function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** Which of the document's occurrences the address means. See the header for the two cases. */
function choose(fileText: string, addr: SourceAddress, inDoc: number[], docLength: number): number {
  const offset = offsetOf(fileText, addr.line, addr.column);
  const inFile = occurrences(fileText, addr.needle);

  if (inFile.length === inDoc.length) {
    let ordinal = 0;
    while (ordinal < inFile.length && inFile[ordinal]! < offset) ordinal++;
    return inDoc[Math.min(ordinal, inDoc.length - 1)]!;
  }

  const want = offset / Math.max(1, fileText.length);
  let best = inDoc[0]!;
  let bestGap = Infinity;
  for (const candidate of inDoc) {
    const gap = Math.abs(candidate / Math.max(1, docLength) - want);
    if (gap < bestGap) {
      bestGap = gap;
      best = candidate;
    }
  }
  return best;
}

/** Character offset of a 1-based line and column, clamped to the file. */
function offsetOf(text: string, line: number, column: number): number {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf("\n", at);
    if (next < 0) return text.length;
    at = next + 1;
  }
  return Math.min(at + Math.max(0, column - 1), text.length);
}
