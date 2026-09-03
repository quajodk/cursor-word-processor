/**
 * The comparison task's document steps, run end to end on a real Word document.
 *
 * Not a benchmark: the same import -> edit -> export path the app uses, exercising the edits
 * a real revision pass makes, then reporting what a Word user would actually receive back.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { importDocx } from "../src/import";
import { exportDocx } from "../src/export";
import type { Node as PMNode } from "prosemirror-model";

const FILE = process.argv[2]
  ?? "corpus/docx/FAIR4RS-community-consultation-May2021-0236767f.docx";
const orig = new Uint8Array(readFileSync(FILE));
const t0 = Date.now();
const { doc, sidecar, origin, ledger } = importDocx(orig);
const importMs = Date.now() - t0;

let paras = 0, words = 0;
doc.descendants((n) => { if (n.type.name === "paragraph") paras++; if (n.isText) words += (n.text ?? "").split(/\s+/).filter(Boolean).length; return true; });

// --- the revision pass -------------------------------------------------------------
// 3. Terminology: rename a defined term everywhere it appears.
const TERM = /\bresearch software\b/gi;
let renamed = 0;
const rewrite = (node: PMNode): PMNode => {
  if (node.isText) {
    const before = node.text ?? "";
    const after = before.replace(TERM, (m) => { renamed++; return m[0] === m[0].toUpperCase() ? "Research Code" : "research code"; });
    return after === before ? node : (node.type.schema.text(after, node.marks) as PMNode);
  }
  if (node.childCount === 0) return node;
  const kids: PMNode[] = [];
  let changed = false;
  node.forEach((c) => {
    const next = rewrite(c);
    if (next !== c) changed = true;
    kids.push(next);
  });
  // Rebuild only when something below actually changed, so untouched subtrees keep their
  // identity — which is what lets the exporter recognise them as copyable verbatim.
  return changed ? node.type.create(node.attrs, kids, node.marks) : node;
};
const edited = rewrite(doc);

const t1 = Date.now();
const out = exportDocx(edited, sidecar, origin);
const exportMs = Date.now() - t1;

mkdirSync(".scriv-cache/task", { recursive: true });
writeFileSync(".scriv-cache/task/revised.docx", out.bytes);

// --- what did the Word user receive? -----------------------------------------------
const A = unzipSync(orig), B = unzipSync(out.bytes);
const ka = Object.keys(A).sort(), kb = Object.keys(B).sort();
const changed = ka.filter((k) => {
  const a = A[k]!, b = B[k];
  return !b || a.length !== b.length || Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0;
});
const pOf = (x: string) => x.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? [];
const xa = pOf(strFromU8(A["word/document.xml"]!)), xb = pOf(strFromU8(B["word/document.xml"]!));
let diff = 0; for (let i = 0; i < Math.min(xa.length, xb.length); i++) if (xa[i] !== xb[i]) diff++;

console.log(`document      : ${paras} paragraphs, ~${words} words, ${(orig.length/1024).toFixed(0)} KB`);
console.log(`import        : ${importMs} ms   export: ${exportMs} ms`);
console.log(`term renamed  : ${renamed} occurrences of "research software"`);
console.log(`zip parts     : ${ka.length} in, ${kb.length} out, same names: ${JSON.stringify(ka)===JSON.stringify(kb)}`);
console.log(`parts changed : ${changed.length} -> ${JSON.stringify(changed)}`);
console.log(`paragraphs    : ${xa.length} in, ${xb.length} out, ${diff} differ`);
console.log(`ledger        : ${ledger.length} entries (${ledger.filter(e=>e.severity==="degraded").length} degraded)`);
