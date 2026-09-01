import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { IDENTIFIED_BLOCKS } from "./schema";

/**
 * Stable block identity.
 *
 * The fidelity design (docs/DOCX-FIDELITY.md) splits anchoring into two regimes:
 *
 *   in-session   — exact. Every block's `aid` rides ProseMirror's transactions. We observed
 *                  every change, so there is nothing to guess. This is that mechanism.
 *   out-of-session — fuzzy. The .md was edited by another tool; anchors are recovered by
 *                  sequence alignment. See @scriv/ooxml/anchor.
 *
 * The whole tractability of the docx problem rests on the first regime covering almost all
 * real use. Keep this correct and cheap: it runs on every transaction.
 */

export const aidPluginKey = new PluginKey<AidState>("scriv-aid");

export interface AidState {
  /** Blocks whose identity was created during this session, for the fidelity ledger. */
  fresh: Set<string>;
}

let counter = 0;
export function newAid(): string {
  // 8 hex chars: time-ordered prefix + counter + entropy. Ordered ids make alignment
  // debugging legible and keep sidecar diffs stable-ish under git.
  counter = (counter + 1) & 0xffff;
  const t = (Date.now() & 0xffff).toString(16).padStart(4, "0");
  const c = counter.toString(16).padStart(2, "0");
  const r = ((Math.random() * 256) | 0).toString(16).padStart(2, "0");
  return t + c + r;
}

export function needsAid(node: PMNode): boolean {
  return IDENTIFIED_BLOCKS.has(node.type.name);
}

/**
 * Repairs aids over a set of candidate positions.
 *
 * Duplicates arise from splits and from paste. Convention: **the first occurrence keeps the
 * identity**, later ones get fresh ids. For a paragraph split that means the original anchor
 * — and therefore the original Word paragraph properties, comments and revision history —
 * stays with the first half. That matches how a writer thinks about splitting a paragraph,
 * and it matches the split rule in docs/DOCX-FIDELITY.md.
 */
export function repairAids(state: EditorState, candidates?: number[]): { tr: Transaction; fresh: string[] } | null {
  const doc = state.doc;

  // Collect every aid in the document once, with the position of its first occurrence.
  // Only reached when structure actually changed, never on the typing path.
  const firstAt = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (!needsAid(node)) return true;
    const aid: string | null = node.attrs.aid;
    if (aid && !firstAt.has(aid)) firstAt.set(aid, pos);
    return true;
  });

  const fresh: string[] = [];
  let tr = state.tr;
  let changed = false;

  const fix = (node: PMNode, pos: number) => {
    const aid: string | null = node.attrs.aid;
    // Keep it if present and this is where it first appears.
    if (aid && firstAt.get(aid) === pos) return;
    const next = newAid();
    firstAt.set(next, pos);
    fresh.push(next);
    tr = tr.setNodeMarkup(tr.mapping.map(pos), undefined, { ...node.attrs, aid: next }, node.marks);
    changed = true;
  };

  if (candidates && candidates.length > 0) {
    for (const pos of candidates) {
      if (pos < 0 || pos >= doc.content.size) continue;
      const node = doc.nodeAt(pos);
      if (node && needsAid(node)) fix(node, pos);
    }
  } else {
    doc.descendants((node, pos) => { if (needsAid(node)) fix(node, pos); return true; });
  }

  return changed ? { tr, fresh } : null;
}

/**
 * Blocks that were newly *introduced* by a transaction.
 *
 * The distinction that keeps this off the keystroke path: a block the user is merely typing
 * into starts BEFORE the changed range, while a block that was inserted or split starts
 * INSIDE it. Typing therefore yields zero candidates and we bail in O(1) per step.
 */
function introducedBlocks(trs: readonly Transaction[], state: EditorState): number[] {
  const out: number[] = [];
  for (const tr of trs) {
    if (!tr.docChanged) continue;
    for (let i = 0; i < tr.steps.length; i++) {
      const map = tr.steps[i]!.getMap();
      map.forEach((_os, _oe, ns, ne) => {
        if (ne <= ns) return;
        // Map through the remaining steps of this transaction, then through later ones.
        let from = ns, to = ne;
        for (let j = i + 1; j < tr.steps.length; j++) {
          const m = tr.steps[j]!.getMap();
          from = m.map(from, -1); to = m.map(to, 1);
        }
        const idx = trs.indexOf(tr);
        for (let k = idx + 1; k < trs.length; k++) {
          from = trs[k]!.mapping.map(from, -1); to = trs[k]!.mapping.map(to, 1);
        }
        if (to > state.doc.content.size) to = state.doc.content.size;
        if (from >= to) return;
        state.doc.nodesBetween(from, to, (node, pos) => {
          // `pos >= from - 1` means the node itself begins inside the changed region,
          // i.e. it was introduced rather than edited.
          if (needsAid(node) && pos >= from - 1) out.push(pos);
          return true;
        });
      });
    }
  }
  return out;
}

/**
 * `appendTransaction` is the correct hook: the user's transaction is already applied, so
 * splits and pastes are reflected in the document, and the repair lands as a separate
 * transaction excluded from history (undo should not step through id assignment).
 */
export function aidPlugin(): Plugin<AidState> {
  return new Plugin<AidState>({
    key: aidPluginKey,
    state: {
      init: () => ({ fresh: new Set<string>() }),
      apply: (tr, value) => {
        const added = tr.getMeta(aidPluginKey) as string[] | undefined;
        if (!added || added.length === 0) return value;
        const next = new Set(value.fresh);
        for (const a of added) next.add(a);
        return { fresh: next };
      },
    },
    appendTransaction(trs, _old, newState) {
      const candidates = introducedBlocks(trs, newState);
      if (candidates.length === 0) return null;   // the typing fast path
      const res = repairAids(newState, candidates);
      if (!res) return null;
      res.tr.setMeta(aidPluginKey, res.fresh);
      res.tr.setMeta("addToHistory", false);
      return res.tr;
    },
  });
}

/** Index of aid → position. Used by the sidecar, the diff engines and the blame gutter. */
export function aidIndex(doc: PMNode): Map<string, { pos: number; node: PMNode }> {
  const m = new Map<string, { pos: number; node: PMNode }>();
  doc.descendants((node, pos) => {
    if (needsAid(node) && node.attrs.aid) m.set(node.attrs.aid, { pos, node });
    return true;
  });
  return m;
}
