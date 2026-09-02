#!/usr/bin/env bun
/**
 * Discovers real-world .docx files on Zenodo and emits a TSV candidate list.
 *
 * Zenodo is a good corpus source for this rig specifically because its .docx
 * holdings are *working documents* — accepted manuscripts, PhD theses, project
 * deliverables, supplementary materials, survey instruments — written by real
 * authors in real Word, in many languages, and frequently still carrying
 * tracked changes and comments from peer review. They are not files anybody
 * authored to exercise a parser.
 *
 *   bun run src/bench/discover-zenodo.ts > /tmp/zenodo.tsv
 *   bun run src/bench/fetch-corpus.ts --list /tmp/zenodo.tsv
 *
 * Output: url<TAB>provenance<TAB>preferred-name
 */

const API = "https://zenodo.org/api/records";

/** Topic slices chosen to spread the corpus across document genres and
 *  languages rather than pulling 60 near-identical journal manuscripts. */
const QUERIES: { q: string; note: string; want: number }[] = [
  { q: "filetype:docx AND thesis", note: "thesis / dissertation", want: 8 },
  { q: "filetype:docx AND deliverable", note: "EU project deliverable report", want: 8 },
  { q: "filetype:docx AND questionnaire", note: "survey instrument / questionnaire", want: 5 },
  { q: "filetype:docx AND guidelines", note: "guidelines / handbook", want: 5 },
  { q: "filetype:docx AND (manual OR handbook)", note: "manual / handbook", want: 5 },
  { q: "filetype:docx AND protocol", note: "study or lab protocol", want: 5 },
  { q: "filetype:docx AND supplementary", note: "supplementary material", want: 6 },
  { q: "filetype:docx AND (report AND annual)", note: "annual report", want: 5 },
  { q: "filetype:docx AND standard", note: "standard / specification draft", want: 4 },
  { q: "filetype:docx AND policy", note: "policy paper", want: 4 },
  /* Deliberate non-English slices — the corpus must not be all-English. */
  { q: "filetype:docx AND (español OR informe OR investigación)", note: "Spanish-language document", want: 4 },
  { q: "filetype:docx AND (français OR rapport OR recherche)", note: "French-language document", want: 4 },
  { q: "filetype:docx AND (deutsch OR bericht OR forschung)", note: "German-language document", want: 4 },
  { q: "filetype:docx AND (中文 OR 研究 OR 报告)", note: "Chinese-language document", want: 3 },
  { q: "filetype:docx AND (русский OR отчет OR исследование)", note: "Russian-language document", want: 3 },
  { q: "filetype:docx AND (português OR relatório)", note: "Portuguese-language document", want: 3 },
  { q: "filetype:docx AND (italiano OR relazione)", note: "Italian-language document", want: 3 },
  { q: "filetype:docx AND (العربية OR تقرير)", note: "Arabic-language document", want: 3 },
];

/* Files smaller than this are usually one-page forms with nothing in them;
   larger than this and we are downloading somebody's image library, not a
   document. The 50+ page documents we need land comfortably inside. */
const MIN_BYTES = 12_000;
const MAX_BYTES = 22_000_000;
/** Bias toward big documents for a few slots — we need 50+ page files. */
const BIG_MIN = 900_000;

interface ZFile {
  key: string;
  size: number;
  links?: { self?: string };
}
interface ZHit {
  id: number;
  metadata: { title: string; publication_date?: string; language?: string; license?: { id?: string } };
  files?: ZFile[];
}

async function search(q: string, size: number, page: number, sort: string): Promise<ZHit[]> {
  const url = `${API}?q=${encodeURIComponent(q)}&size=${size}&page=${page}&sort=${sort}`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    console.error(`# zenodo ${res.status} for ${q}`);
    return [];
  }
  const j = (await res.json()) as { hits?: { hits?: ZHit[] } };
  return j.hits?.hits ?? [];
}

const seen = new Set<string>();
const rows: string[] = [];

function emit(hit: ZHit, f: ZFile, note: string, big: boolean): boolean {
  const link = f.links?.self;
  if (!link || seen.has(link)) return false;
  seen.add(link);
  const title = hit.metadata.title.replace(/\s+/g, " ").slice(0, 90);
  const lic = hit.metadata.license?.id ?? "see record";
  const provenance = `Zenodo ${hit.id} — ${note}${big ? " (large)" : ""} — "${title}" [${lic}]`;
  const name = f.key.replace(/\.docx?$/i, "").replace(/[^A-Za-z0-9]+/g, "-").slice(0, 50);
  rows.push(`${link}\t${provenance}\t${name}`);
  return true;
}

for (const { q, note, want } of QUERIES) {
  let got = 0;
  let bigGot = 0;
  /* Two sort orders per slice: "mostrecent" and "bestmatch" surface disjoint
     sets, which widens variety without paging deep. */
  for (const sort of ["bestmatch", "mostrecent"]) {
    for (let page = 1; page <= 3 && got < want; page++) {
      const hits = await search(q, 25, page, sort);
      if (hits.length === 0) break;
      for (const hit of hits) {
        if (got >= want) break;
        for (const f of hit.files ?? []) {
          if (!/\.docx$/i.test(f.key)) continue;
          if (f.size < MIN_BYTES || f.size > MAX_BYTES) continue;
          const big = f.size >= BIG_MIN;
          /* Reserve up to a third of each slice for large documents. */
          if (big && bigGot >= Math.max(1, Math.ceil(want / 3))) continue;
          if (emit(hit, f, note, big)) {
            got++;
            if (big) bigGot++;
          }
          break; // one file per record — keep the corpus source-diverse
        }
      }
    }
  }
  console.error(`# ${note}: ${got}`);
}

console.log(rows.join("\n"));
console.error(`# total ${rows.length} candidates`);

export {};
