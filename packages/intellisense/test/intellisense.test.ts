import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseMarkdown } from "@scriv/md";
import { WorkspaceIndex, complete, triggerAt, extractBibtex } from "../src/index";

const md = (src: string) => parseMarkdown(src).doc;
const ctx = (blockText: string, offset = blockText.length, path: string | null = "a.md") =>
  ({ blockText, offset, path });

describe("entity extraction", () => {
  test("finds a repeated proper name", () => {
    const ix = new WorkspaceIndex();
    ix.setDocument("a.md", md(
      "The European Medicines Agency published guidance.\n\n" +
      "Later the European Medicines Agency revised it.\n",
    ));
    const names = ix.symbols().filter((s) => s.kind === "entity").map((s) => s.label);
    expect(names).toContain("European Medicines Agency");
  });

  test("does not treat a sentence-initial word as a name", () => {
    // "Measurements" and "However" start sentences and are capitalised for that reason
    // alone. This is what a stop-word list is normally used for, and a stop-word list would
    // only work in English.
    const ix = new WorkspaceIndex();
    ix.setDocument("a.md", md(
      "Measurements were taken. However the result held.\n\n" +
      "Measurements were repeated. However nothing changed.\n",
    ));
    const names = ix.symbols().filter((s) => s.kind === "entity").map((s) => s.label);
    expect(names).not.toContain("Measurements");
    expect(names).not.toContain("However");
  });

  test("a name is still found when it also happens to start a sentence", () => {
    const ix = new WorkspaceIndex();
    ix.setDocument("a.md", md(
      "Copenhagen hosted the meeting.\n\nThe delegates left Copenhagen on Friday.\n",
    ));
    const names = ix.symbols().filter((s) => s.kind === "entity").map((s) => s.label);
    expect(names).toContain("Copenhagen");
  });

  test("a single mention is not offered", () => {
    const ix = new WorkspaceIndex();
    ix.setDocument("a.md", md("We met Aurelia Fernandez once and never again.\n"));
    expect(ix.symbols().filter((s) => s.kind === "entity")).toEqual([]);
  });

  test("scripts without case produce nothing rather than garbage", () => {
    const ix = new WorkspaceIndex();
    ix.setDocument("a.md", md("यह एक वाक्य है। यह दूसरा वाक्य है।\n\nयह तीसरा वाक्य है।\n"));
    expect(ix.symbols().filter((s) => s.kind === "entity")).toEqual([]);
  });
});

describe("headings and citations", () => {
  test("headings become cross-reference targets", () => {
    const ix = new WorkspaceIndex();
    ix.setDocument("a.md", md("# Coastal Erosion\n\n## Method\n\ntext\n"));
    const h = ix.symbols().filter((s) => s.kind === "heading").map((s) => s.label);
    expect(h).toEqual(["Coastal Erosion", "Method"]);
  });

  test("inline citation keys are collected", () => {
    const ix = new WorkspaceIndex();
    ix.setDocument("a.md", md("As shown [@smith2020] and again [@smith2020; @jones1999].\n"));
    const c = ix.symbols().filter((s) => s.kind === "citation").map((s) => s.label).sort();
    expect(c).toEqual(["@jones1999", "@smith2020"]);
  });

  test("bibtex keys complete before they are ever cited", () => {
    const syms = extractBibtex(
      '@article{darwin1859,\n  author = {Charles Darwin},\n  title = {On the Origin of Species}\n}\n',
      "refs.bib",
    );
    expect(syms[0]?.label).toBe("@darwin1859");
    expect(syms[0]?.documentation).toContain("Charles Darwin");
  });
});

describe("when the popup opens", () => {
  test("stays shut while ordinary prose is being typed", () => {
    expect(triggerAt(ctx("The nor"))).toBeNull();
  });

  test("opens on a citation sigil immediately", () => {
    const t = triggerAt(ctx("As shown in @smi"))!;
    expect(t.query).toBe("smi");
    expect(t.kinds).toEqual(["citation"]);
  });

  test("opens on a cross-reference sigil", () => {
    const t = triggerAt(ctx("see [[Met"))!;
    expect(t.query).toBe("Met");
    expect(t.kinds).toEqual(["heading"]);
  });

  test("a sigil stops applying once whitespace follows it", () => {
    expect(triggerAt(ctx("email me at foo@bar then talk")) ?.kinds ?? []).toEqual([]);
  });

  test("a bare word never opens the popup on its own, at any length", () => {
    // Restraint is the feature. Every threshold low enough to be useful is also low enough
    // to interrupt an ordinary sentence.
    expect(triggerAt(ctx("Eu"))).toBeNull();
    expect(triggerAt(ctx("Euro"))).toBeNull();
    expect(triggerAt(ctx("European"))).toBeNull();
    expect(triggerAt(ctx("European"), true)).not.toBeNull();
  });

  test("an explicit request always opens", () => {
    expect(triggerAt(ctx(""), true)).not.toBeNull();
  });
});

describe("ranking", () => {
  const ix = new WorkspaceIndex();
  ix.setDocument("a.md", md(
    "# Method\n\nThe European Medicines Agency met. The European Medicines Agency agreed.\n\n" +
    "The Environmental Modelling Almanac appeared. The Environmental Modelling Almanac sold.\n",
  ));

  test("a prefix match outranks a scattered subsequence", () => {
    const items = complete(ix.symbols(), ctx("Europ"), true);
    expect(items[0]?.label).toBe("European Medicines Agency");
  });

  test("returns the ranges that matched, for highlighting", () => {
    const items = complete(ix.symbols(), ctx("Europ"), true);
    expect(items[0]?.matches[0]).toEqual([0, 5]);
  });

  test("a citation query does not have to repeat the sigil", () => {
    const bib = new WorkspaceIndex();
    bib.setBibliography("refs.bib", "@book{tolkien1954,\n  title = {The Fellowship}\n}\n");
    const items = complete(bib.symbols(), ctx("see @tolk"));
    expect(items[0]?.label).toBe("@tolkien1954");
  });

  test("frequency breaks ties but never beats a better match", () => {
    const items = complete(ix.symbols(), ctx("Environmental"), true);
    expect(items[0]?.label).toBe("Environmental Modelling Almanac");
  });
});

describe("against the real corpus", () => {
  const root = join(import.meta.dir, "../../../corpus/md/repos");
  const files = (() => {
    try {
      return readdirSync(root).filter((f) => f.endsWith(".md")).slice(0, 40).map((f) => join(root, f));
    } catch { return []; }
  })();

  test("indexes real documents without throwing, and finds real names", () => {
    expect(files.length).toBeGreaterThan(0); // without this the test passes having asserted nothing
    if (files.length === 0) { console.warn("\n[intellisense] corpus/md absent - skipping"); return; }
    const ix = new WorkspaceIndex();
    let indexed = 0;
    for (const f of files) {
      if (statSync(f).size > 400_000) continue;
      try { ix.setDocument(f, md(readFileSync(f, "utf8"))); indexed++; } catch { /* parse failures belong to @scriv/md */ }
    }
    const syms = ix.symbols();
    const byKind = new Map<string, number>();
    for (const s of syms) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
    console.log(`\n[intellisense] ${indexed} real documents -> ${syms.length} symbols ` +
      `(${[...byKind].map(([k, v]) => `${v} ${k}`).join(", ")})`);
    expect(indexed).toBeGreaterThan(0);
    expect(syms.length).toBeGreaterThan(0);

    // What matters is the TOP of the list, because that is all a popup ever shows. Chasing
    // the last rare false positive would mean tuning against this particular corpus, which
    // is the special-casing the house rules forbid; a stray sentence-opener at rank 200 is
    // invisible. So the assertion is that no positional artefact reaches the visible ranks.
    const entities = syms.filter((s) => s.kind === "entity")
      .sort((a, b) => b.frequency - a.frequency);
    const top = entities.slice(0, 20).map((s) => s.label);
    console.log(`[intellisense] top entities: ${top.slice(0, 10).join(", ")}`);
    for (const junk of ["The", "This", "It", "If", "When", "However", "Fix", "Add"]) {
      expect(top).not.toContain(junk);
    }
  }, 120_000);
});
