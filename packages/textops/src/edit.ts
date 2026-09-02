import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { blockAt, offsetOf, posOf, siblingBlock, graphemeStep } from "./text";
import { sentences, words } from "./segment";

/**
 * Structural edits: transpose, join, kill, duplicate, move.
 *
 * The kill ring is Emacs's, and it is here because it is the one clipboard idea that suits
 * writing: consecutive kills accumulate, so killing three lines and yanking gives you three
 * lines, and yank-pop cycles what you killed before without touching the system clipboard.
 */

export const killRingKey = new PluginKey<KillRing>("scriv-kill-ring");

export interface KillRing {
  entries: string[];
  /** Index into `entries` for the next yank-pop. */
  cursor: number;
  /** True when the last command was itself a kill, so the next one appends. */
  appending: boolean;
  /** Range of the most recent yank, so yank-pop can replace it. */
  lastYank: { from: number; to: number } | null;
}

const EMPTY: KillRing = { entries: [], cursor: 0, appending: false, lastYank: null };
const MAX_RING = 60;

export function killRingPlugin(): Plugin<KillRing> {
  return new Plugin<KillRing>({
    key: killRingKey,
    state: {
      init: () => EMPTY,
      apply(tr, value) {
        const meta = tr.getMeta(killRingKey) as Partial<KillRing> | undefined;
        if (!meta) {
          // Any other transaction ends a kill run and invalidates the yank position.
          return value.appending || value.lastYank ? { ...value, appending: false, lastYank: null } : value;
        }
        return { ...value, ...meta };
      },
    },
  });
}

function pushKill(state: EditorState, tr: Transaction, text: string): void {
  const ring = killRingKey.getState(state) ?? EMPTY;
  if (!text) return;
  const entries = ring.appending && ring.entries.length > 0
    ? [ring.entries[0] + text, ...ring.entries.slice(1)]
    : [text, ...ring.entries].slice(0, MAX_RING);
  tr.setMeta(killRingKey, { entries, cursor: 0, appending: true, lastYank: null });
}

/** Kill to end of line, or the line break itself when already at the end. */
export const killLine: Command = (state, dispatch) => {
  const { head } = state.selection;
  const block = blockAt(state.doc.resolve(head));
  if (!block) return false;
  const text = block.text;
  const off = offsetOf(block, head);
  const nl = text.indexOf("\n", off);
  let from = head, to: number;
  if (nl === -1) to = block.end;
  else if (nl === off) to = posOf(block, nl + 1);
  else to = posOf(block, nl);

  if (to <= from) {
    // At the very end of a block: join the next one, which is what "kill to end" means there.
    const next = siblingBlock(state.doc, block, 1);
    if (!next) return false;
    if (dispatch) {
      const tr = state.tr.delete(block.end, next.start);
      pushKill(state, tr, "\n");
      dispatch(tr.scrollIntoView());
    }
    return true;
  }
  if (dispatch) {
    const tr = state.tr.delete(from, to);
    pushKill(state, tr, state.doc.textBetween(from, to, "\n"));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Kill from the caret to the end of the sentence it is in. */
export const killToSentenceEnd: Command = (state, dispatch) => {
  const { head } = state.selection;
  const block = blockAt(state.doc.resolve(head));
  if (!block) return false;
  const off = offsetOf(block, head);
  for (const s of sentences(block.text)) {
    if (off >= s.start && off < s.end) {
      // Take the whitespace that followed the sentence too. Sentence ranges deliberately
      // exclude it so that repeated expand-selection does not creep forward, but deleting a
      // sentence and leaving its trailing space behind gives a double space every time.
      let end = s.end;
      while (end < block.text.length && /[ \t]/.test(block.text[end]!)) end++;
      const to = posOf(block, end);
      if (dispatch) {
        const tr = state.tr.delete(head, to);
        pushKill(state, tr, state.doc.textBetween(head, to, "\n"));
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
  }
  return false;
};

export const yank: Command = (state, dispatch) => {
  const ring = killRingKey.getState(state) ?? EMPTY;
  const text = ring.entries[0];
  if (!text) return false;
  if (dispatch) {
    const { from, to } = state.selection;
    const tr = state.tr.insertText(text, from, to);
    tr.setMeta(killRingKey, { cursor: 0, appending: false, lastYank: { from, to: from + text.length } });
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Replace the text just yanked with the next entry in the ring. */
export const yankPop: Command = (state, dispatch) => {
  const ring = killRingKey.getState(state) ?? EMPTY;
  if (!ring.lastYank || ring.entries.length < 2) return false;
  const next = (ring.cursor + 1) % ring.entries.length;
  const text = ring.entries[next]!;
  if (dispatch) {
    const { from, to } = ring.lastYank;
    const tr = state.tr.insertText(text, from, to);
    tr.setMeta(killRingKey, { cursor: next, appending: false, lastYank: { from, to: from + text.length } });
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Swap the two characters around the caret. At the end of a block, the two before it. */
export const transposeChars: Command = (state, dispatch) => {
  const { head, empty } = state.selection;
  if (!empty) return false;
  const block = blockAt(state.doc.resolve(head));
  if (!block) return false;
  let b = head;
  if (b >= block.end) b = block.end;
  const a = graphemeStep(block.text, offsetOf(block, b), -1);
  if (a < 0) return false;
  const mid = posOf(block, a);
  const start = posOf(block, graphemeStep(block.text, a, -1));
  if (start < block.start || mid <= start || b <= mid) return false;
  const left = state.doc.textBetween(start, mid);
  const right = state.doc.textBetween(mid, b);
  if (!left || !right) return false;
  if (dispatch) {
    const tr = state.tr.insertText(right + left, start, b);
    tr.setSelection(TextSelection.create(tr.doc, start + right.length + left.length));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Swap the word before the caret with the one after it. */
export const transposeWords: Command = (state, dispatch) => {
  const { head, empty } = state.selection;
  if (!empty) return false;
  const block = blockAt(state.doc.resolve(head));
  if (!block) return false;
  const off = offsetOf(block, head);
  const ws = words(block.text);
  let i = ws.findIndex((w) => w.start > off || (off >= w.start && off <= w.end));
  if (i < 0) i = ws.length - 1;
  // Choose the pair straddling the caret: the word at or before it, and the next.
  const atOrBefore = ws.findIndex((w) => off >= w.start && off <= w.end);
  const first = atOrBefore >= 0 ? atOrBefore : i - 1;
  const a = ws[first], b = ws[first + 1];
  if (!a || !b) return false;
  if (dispatch) {
    const aFrom = posOf(block, a.start), aTo = posOf(block, a.end);
    const bFrom = posOf(block, b.start), bTo = posOf(block, b.end);
    const aText = state.doc.textBetween(aFrom, aTo);
    const bText = state.doc.textBetween(bFrom, bTo);
    // Right first: replacing the left range would shift the right one.
    const tr = state.tr.insertText(aText, bFrom, bTo).insertText(bText, aFrom, aTo);
    tr.setSelection(TextSelection.create(tr.doc, bTo + (bText.length - aText.length)));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Join this block with the next, inserting a single space where they meet. */
export const joinForward: Command = (state, dispatch) => {
  const block = blockAt(state.selection.$head);
  if (!block) return false;
  const next = siblingBlock(state.doc, block, 1);
  if (!next) return false;
  if (dispatch) {
    const needsSpace = block.text.length > 0 && !/\s$/.test(block.text) && next.text.length > 0;
    const tr = state.tr.delete(block.end, next.start);
    if (needsSpace) tr.insertText(" ", block.end);
    tr.setSelection(TextSelection.create(tr.doc, block.end));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

function blockNodeAt(state: EditorState): { node: PMNode; pos: number } | null {
  const $h = state.selection.$head;
  for (let d = $h.depth; d > 0; d--) {
    const node = $h.node(d);
    if (node.isBlock && $h.node(d - 1).type.name === "doc") return { node, pos: $h.before(d) };
  }
  const top = $h.node(1);
  return top ? { node: top, pos: $h.before(1) } : null;
}

export const duplicateBlock: Command = (state, dispatch) => {
  const b = blockNodeAt(state);
  if (!b) return false;
  if (dispatch) {
    const end = b.pos + b.node.nodeSize;
    // The copy is inserted without its `aid`; the identity plugin mints a fresh one, which
    // is what makes the duplicate a new block rather than a second claimant to the original.
    const copy = b.node.type.create({ ...b.node.attrs, aid: null }, b.node.content, b.node.marks);
    dispatch(state.tr.insert(end, copy).scrollIntoView());
  }
  return true;
};

export function moveBlock(dir: 1 | -1): Command {
  return (state, dispatch) => {
    const b = blockNodeAt(state);
    if (!b) return false;
    const $pos = state.doc.resolve(b.pos);
    const index = $pos.index(0);
    const target = index + dir;
    if (target < 0 || target >= state.doc.childCount) return false;
    if (dispatch) {
      const end = b.pos + b.node.nodeSize;
      let tr = state.tr.delete(b.pos, end);
      let insertAt = 0;
      const doc = tr.doc;
      for (let i = 0; i < target; i++) insertAt += doc.child(i).nodeSize;
      tr = tr.insert(insertAt, b.node);
      const caret = state.selection.head - b.pos + insertAt;
      tr.setSelection(TextSelection.create(tr.doc, Math.min(Math.max(caret, insertAt + 1), tr.doc.content.size - 1)));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export function deleteWord(dir: 1 | -1): Command {
  return (state, dispatch) => {
    const { head, empty } = state.selection;
    if (!empty) return false;
    const block = blockAt(state.doc.resolve(head));
    if (!block) return false;
    const off = offsetOf(block, head);
    const ws = words(block.text);
    let target: number | null = null;
    if (dir === -1) {
      for (const w of ws) if (w.end < off || (w.start < off && w.end >= off)) target = w.start;
    } else {
      for (const w of ws) if (w.start >= off) { target = w.end; break; }
    }
    if (target === null) target = dir === -1 ? 0 : block.text.length;
    const pos = posOf(block, target);
    if (pos === head) return false;
    if (dispatch) {
      const [from, to] = dir === -1 ? [pos, head] : [head, pos];
      const tr = state.tr.delete(from, to);
      pushKill(state, tr, state.doc.textBetween(from, to, "\n"));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}
