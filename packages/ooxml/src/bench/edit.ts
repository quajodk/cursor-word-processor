/**
 * The one-word edit that T1 is built on.
 *
 * Both systems under test must receive the SAME edit, or the tier compares two different
 * experiments. So the word is chosen once, from the imported document model, and the same
 * `(old, new)` pair is then applied to pandoc's Markdown by literal substitution.
 *
 * Choosing it deterministically matters as much as choosing it fairly: the run has to be
 * reproducible, and picking "the first paragraph" would systematically test titles — the one
 * paragraph in a Word document least likely to sit in a run structure worth preserving. So the
 * target is the first qualifying paragraph at or after the middle of the document.
 */

import type { Node as PMNode } from "prosemirror-model";
import type { FidelitySidecar } from "../sidecar.ts";

export interface Edit {
  aid: string;
  oldWord: string;
  newWord: string;
  /** The paragraph text before and after, for the report. */
  before: string;
  after: string;
}

export interface EditedDoc {
  doc: PMNode;
  edit: Edit;
}

const WORD = /[\p{L}][\p{L}\p{M}'-]{3,}/u;

/**
 * Apply a one-word change. Returns null when no paragraph in the document offers a word long
 * enough to change — a real outcome for a form or a cover sheet, and reported as such rather
 * than papered over with a synthetic paragraph.
 */
export function editOneWord(doc: PMNode, sidecar: FidelitySidecar): EditedDoc | null {
  const candidates: Array<{ node: PMNode; aid: string }> = [];
  doc.descendants((node) => {
    if (node.type.name !== "paragraph" && node.type.name !== "heading") return true;
    const aid: string | null = node.attrs.aid ?? null;
    if (!aid || !sidecar.blocks[aid]) return true;
    // The word must live inside a single text node: an edit that spans a run boundary is a
    // different (and harder) test than the one this tier specifies.
    let ok = false;
    node.forEach((child) => { if (!ok && child.isText && WORD.test(child.text ?? "")) ok = true; });
    if (ok) candidates.push({ node, aid });
    return true;
  });
  if (candidates.length === 0) return null;

  const target = candidates[Math.floor(candidates.length / 2)]!;
  const before = plain(target.node);

  let oldWord = "";
  let newWord = "";
  const rebuilt: PMNode[] = [];
  target.node.forEach((child) => {
    if (oldWord === "" && child.isText && WORD.test(child.text ?? "")) {
      const m = WORD.exec(child.text!)!;
      oldWord = m[0];
      // A replacement that is not a substring of the original, so a scorer cannot accidentally
      // match the old text, and that stays a single word so the paragraph structure is intact.
      newWord = `${oldWord}zq`;
      rebuilt.push(child.type.schema.text(child.text!.replace(oldWord, newWord), child.marks));
    } else {
      rebuilt.push(child);
    }
  });
  if (oldWord === "") return null;

  const replacement = target.node.type.create(target.node.attrs, rebuilt, target.node.marks);
  const next = replaceNode(doc, target.node, replacement);
  if (!next) return null;

  return {
    doc: next,
    edit: { aid: target.aid, oldWord, newWord, before, after: plain(replacement) },
  };
}

function plain(node: PMNode): string {
  let s = "";
  node.forEach((c) => { if (c.isText) s += c.text ?? ""; else if (c.type.name === "hard_break") s += "\n"; });
  return s;
}

/** Structural replacement by node identity. ProseMirror nodes are immutable, so this rebuilds
 *  the spine from the target up to the root and shares every untouched subtree. */
function replaceNode(root: PMNode, target: PMNode, replacement: PMNode): PMNode | null {
  if (root === target) return replacement;
  let changed = false;
  const kids: PMNode[] = [];
  root.forEach((child) => {
    if (changed) { kids.push(child); return; }
    const r = replaceNode(child, target, replacement);
    if (r && r !== child) { kids.push(r); changed = true; }
    else kids.push(child);
  });
  if (!changed) return null;
  return root.type.create(root.attrs, kids, root.marks);
}
