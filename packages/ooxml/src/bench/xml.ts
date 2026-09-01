/**
 * Minimal XML tree for scoring. Uses saxes so we get the same parse the splice
 * engine uses, but here we want a tree, not byte offsets.
 *
 * Names are stored EXPANDED as `{namespaceURI}localName`. Comparing expanded
 * names rather than prefixed ones is the one normalisation that is unarguably
 * correct: `w:p` and `foo:p` bound to the same namespace are the same element
 * by definition of XML Namespaces. A comparator that matched on prefix would
 * report a difference where the XML infoset has none.
 */

import { SaxesParser } from "saxes";

export interface XNode {
  /** `{ns}local`, e.g. `{...wordprocessingml/2006/main}p`. */
  name: string;
  /** Local name without namespace, for cheap matching. */
  local: string;
  /** Expanded-name -> value. Attribute ORDER IS NOT PRESERVED — see normalize.ts. */
  attrs: Map<string, string>;
  children: XNode[];
  /** Concatenated character data directly inside this element. */
  text: string;
  parent: XNode | null;
}

export const W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}";
export const R_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}";
export const XML_NS = "{http://www.w3.org/XML/1998/namespace}";

export function parseXml(xml: string): XNode {
  const root: XNode = { name: "#root", local: "#root", attrs: new Map(), children: [], text: "", parent: null };
  let cur = root;
  const parser = new SaxesParser({ xmlns: true, position: false });

  parser.on("opentag", (tag) => {
    const ns = tag.uri ? `{${tag.uri}}` : "";
    const node: XNode = {
      name: `${ns}${tag.local}`,
      local: tag.local,
      attrs: new Map(),
      children: [],
      text: "",
      parent: cur,
    };
    for (const a of Object.values(tag.attributes)) {
      const at = a as { uri: string; local: string; value: string; prefix: string };
      /* Namespace declarations are not attributes of the element in any
         meaningful sense — they bind prefixes, and prefixes are already
         resolved away. Dropping them is required, not optional: two files with
         identical content but different xmlns declaration sets are identical. */
      if (at.prefix === "xmlns" || at.local === "xmlns") continue;
      const ans = at.uri ? `{${at.uri}}` : "";
      node.attrs.set(`${ans}${at.local}`, at.value);
    }
    cur.children.push(node);
    cur = node;
  });
  parser.on("text", (t) => {
    cur.text += t;
  });
  parser.on("cdata", (t) => {
    cur.text += t;
  });
  parser.on("closetag", () => {
    cur = cur.parent ?? root;
  });
  parser.on("error", (e) => {
    throw e;
  });

  parser.write(xml).close();
  return root;
}

/** First child element with the given expanded name. */
export function child(n: XNode | null | undefined, name: string): XNode | null {
  if (!n) return null;
  for (const c of n.children) if (c.name === name) return c;
  return null;
}

export function children(n: XNode | null | undefined, name: string): XNode[] {
  if (!n) return [];
  return n.children.filter((c) => c.name === name);
}

/** Depth-first descendants with the given expanded name. */
export function descendants(n: XNode | null | undefined, name: string): XNode[] {
  const out: XNode[] = [];
  if (!n) return out;
  const walk = (x: XNode): void => {
    for (const c of x.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(n);
  return out;
}

export function attr(n: XNode | null | undefined, name: string): string | undefined {
  return n?.attrs.get(name);
}

/** `w:val` of a child element, the OOXML idiom for a scalar property. */
export function val(n: XNode | null | undefined, childName: string): string | undefined {
  return attr(child(n, childName), `${W}val`);
}

/** All text content beneath a node, in document order. */
export function allText(n: XNode): string {
  let s = n.text;
  for (const c of n.children) s += allText(c);
  return s;
}
