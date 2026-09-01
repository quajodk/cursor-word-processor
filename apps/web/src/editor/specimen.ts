import { schema } from "@scriv/doc-model";
import type { Node as PMNode } from "prosemirror-model";

/**
 * A specimen document, built directly through the `@scriv/doc-model` schema.
 *
 * Two jobs. It is the thing to look at when judging typography — every block type the schema
 * has, set on one page — and it is a working test that the schema, the view and the stylesheet
 * agree, without needing a Markdown codec to exist first. It is a document template, not a
 * fixture standing in for a data source: nothing here pretends to have come from disk.
 */

const N = schema.nodes;
const M = schema.marks;

function text(value: string, ...marks: string[]): PMNode {
  return schema.text(
    value,
    marks.map((m) => M[m]!.create()),
  );
}

function linked(value: string, href: string): PMNode {
  return schema.text(value, [M.link!.create({ href })]);
}

function p(...content: (PMNode | string)[]): PMNode {
  return N.paragraph!.create(null, content.map((c) => (typeof c === "string" ? schema.text(c) : c)));
}

function h(level: number, value: string): PMNode {
  return N.heading!.create({ level }, schema.text(value));
}

function li(...blocks: PMNode[]): PMNode {
  return N.list_item!.create(null, blocks);
}

function cell(value: string, header = false): PMNode {
  const type = header ? N.table_header! : N.table_cell!;
  return type.create(null, [value ? p(value) : N.paragraph!.create()]);
}

function row(values: string[], header = false): PMNode {
  return N.table_row!.create(null, values.map((v) => cell(v, header)));
}

export function specimenDoc(): PMNode {
  return N.doc!.create(null, [
    h(1, "On the setting of documents"),

    p(
      text("Typography", "em"),
      " is the part of a writing tool nobody asks for and everybody notices. A measured column, a real serif, and a rhythm the eye can rely on are not decoration: they are the difference between reading a document and parsing one.",
    ),

    p(
      "This page exercises every block the schema defines — headings at six levels, ordered and unordered lists, tables, block quotations, code, rules and figures — so that a change to the stylesheet can be judged in one glance rather than four.",
    ),

    h(2, "1  Measure and rhythm"),

    p(
      "The column is set to roughly 68 characters. Below about 45 the eye tires from returning too often; above about 80 it loses the line on the way back. Both failures are invisible in a screenshot and obvious after twenty minutes.",
    ),

    p(
      "Spacing is a single vertical rhythm. Every margin in this document is a multiple of the body leading, so blocks sit on a common grid whether or not anyone consciously notices it. Paragraphs are set continuously with a first-line indent, the way a book does it; ",
      text("Toggle paragraph style", "strong"),
      " in the command palette switches to the spaced setting a memo wants.",
    ),

    h(3, "1.1  Figures"),

    p(
      "Running text uses old-style figures, which have ascenders and descenders and sit in a line of prose without shouting: 1,482 respondents across 37 jurisdictions in 2019. Tables and section numbers use lining figures, which align in a column: see ",
      text("Table 1", "strong"),
      ".",
    ),

    N.blockquote!.create(null, [
      p(
        "The best typography is invisible; it does not call attention to itself, but rather to the meaning of the words it clothes. A block quotation should be recognisable as one without a coloured bar or a decorative glyph — a change of measure, size and colour is enough.",
      ),
    ]),

    h(2, "2  Structure"),

    p("Committee prose lives in numbered clauses. Nested ordered lists change marker style by depth:"),

    N.ordered_list!.create({ start: 1 }, [
      li(p("The Secretariat shall circulate the draft to all participating members.")),
      li(
        p("Members shall respond within thirty days, indicating one of:"),
        N.ordered_list!.create({ start: 1 }, [
          li(p("approval without comment;")),
          li(p("approval with editorial comment; or")),
          li(p("disapproval, with the technical reasons stated.")),
        ]),
      ),
      li(p("The editor shall prepare a disposition of comments.")),
    ]),

    p("Unordered lists hang their markers outside the measure so the text edge stays straight:"),

    N.bullet_list!.create(null, [
      li(p("Markers hang in the left margin rather than pushing the text right.")),
      li(
        p("Nesting changes the mark rather than only the indent:"),
        N.bullet_list!.create(null, [
          li(p("second level uses an en dash;")),
          li(
            p("third level a hollow bullet:"),
            N.bullet_list!.create(null, [li(p("as here."))]),
          ),
        ]),
      ),
      li(p("Spacing between items is tighter than between paragraphs, because a list is one thought.")),
    ]),

    h(2, "3  Tables"),

    p(
      "Tables are set in the manner of a printed journal: a heavy rule above the head, a light rule under it, a heavy rule below the body, and no vertical rules at all. Numerals are lining and tabular, so columns align on the decimal.",
    ),

    N.table!.create(null, [
      row(["Clause", "Requirement", "Conformance", "Cases"], true),
      row(["4.1", "Measure between 65 and 75 characters", "Mandatory", "1,204"]),
      row(["4.2", "Old-style figures in running text", "Recommended", "318"]),
      row(["4.3", "Hanging list markers", "Recommended", "96"]),
      row(["4.4", "No vertical rules in tabular matter", "Mandatory", "1,482"]),
    ]),

    h(3, "3.1  Inline detail"),

    p(
      "Inline marks: ",
      text("bold", "strong"),
      ", ",
      text("italic", "em"),
      ", ",
      text("underline", "underline"),
      ", ",
      text("struck through", "strike"),
      ", ",
      text("code()", "code"),
      ", a ",
      linked("hyperlink", "https://example.org/standard"),
      ", a footnote marker",
      text("12", "superscript"),
      " and a chemical subscript H",
      text("2", "subscript"),
      "O. Quotation marks are directional, dashes are dashes — not hyphens — and ellipses are single characters…",
    ),

    N.code_block!.create({ lang: "ts" }, schema.text('const measure = "34.5em"; // ≈ 68 characters at 19px')),

    N.horizontal_rule!.create(),

    h(4, "Colophon"),

    p(
      "Set in the system's Old Style serif at 19px on a 1.62 leading. Marks, headings and tabular matter are defined once in ",
      text("src/styles/document.css", "code"),
      " and nowhere else.",
    ),

    h(5, "Revision history"),

    p("Draft 3, circulated for comment. Superseded drafts are retained in the repository."),

    h(6, "Editorial note"),

    p("This page is generated from the schema, not parsed from a file. Save it anywhere with ⌘⇧S and @scriv/md will write it out as Markdown."),
  ]);
}
