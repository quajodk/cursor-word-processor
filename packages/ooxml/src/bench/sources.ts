/**
 * Candidate corpus URLs — public, real-world .docx files from the wild.
 *
 * Rules for anything added here:
 *  - Must be publicly downloadable without auth, from an organisation that
 *    published it as a working document (a form, a template people fill in, a
 *    report, a standards draft), not a file authored to exercise a parser.
 *  - No files from the user's machine. Nothing from ~/Downloads.
 *  - Prefer documents produced by Microsoft Word — those are the ones whose
 *    rsid churn, run splitting and style tables we actually have to survive.
 *
 * Many of these will 404 over time; the fetcher reports failures and the
 * manifest records only what actually landed. That is intentional: the corpus
 * is defined by MANIFEST.json (checked in), not by this list.
 */

import type { Candidate } from "./corpus";

export const CANDIDATES: Candidate[] = [
  /* ---------- EU / Horizon Europe: long, heavily-styled templates with
       multi-level numbering, tables, headers/footers, content controls ------ */
  {
    url: "https://ec.europa.eu/info/funding-tenders/opportunities/docs/2021-2027/horizon/temp-form/af/af_he-ria-ia_en.docx",
    source: "European Commission — Horizon Europe RIA/IA application form (Part B template)",
  },
  {
    url: "https://ec.europa.eu/info/funding-tenders/opportunities/docs/2021-2027/horizon/temp-form/af/af_he-msca-pf_en.docx",
    source: "European Commission — Horizon Europe MSCA Postdoctoral Fellowship form",
  },
  {
    url: "https://ec.europa.eu/info/funding-tenders/opportunities/docs/2021-2027/common/temp-form/report/technical-report-part-b_he_en.docx",
    source: "European Commission — Horizon Europe periodic technical report template",
  },
  {
    url: "https://ec.europa.eu/info/funding-tenders/opportunities/docs/2021-2027/horizon/temp-form/af/af_he-erc-adg_en.docx",
    source: "European Commission — ERC Advanced Grant application form",
  },
  {
    url: "https://ec.europa.eu/info/funding-tenders/opportunities/docs/2021-2027/common/temp-form/perf/data-management-plan_he_en.docx",
    source: "European Commission — Horizon Europe Data Management Plan template",
  },

  /* ---------- ETSI / 3GPP: standards drafting skeletons. Deep multi-level
       numbering, cross-reference fields, huge style tables. ----------------- */
  {
    url: "https://portal.etsi.org/Services/editHelp/How-to-start/Templates-and-forms",
    source: "ETSI — templates index (HTML; expected to fail validation, kept as a probe)",
  },
  {
    url: "https://www.3gpp.org/ftp/Information/WORD_TEMPLATES/TS-TR_Skeleton.doc",
    source: "3GPP — TS/TR skeleton (legacy .doc; expected to fail validation)",
  },

  /* ---------- WHO / UN / World Bank -------------------------------------- */
  {
    url: "https://cdn.who.int/media/docs/default-source/documents/emergencies/eios-technical-report-template.docx",
    source: "WHO — EIOS technical report template",
  },
  {
    url: "https://www.who.int/docs/default-source/documents/publications/who-style-guide.docx",
    source: "WHO — style guide",
  },
  {
    url: "https://unece.org/sites/default/files/2021-03/ECE-TRANS-WP29-2021-59e.docx",
    source: "UNECE — WP.29 vehicle regulation working document",
  },

  /* ---------- US federal ------------------------------------------------- */
  {
    url: "https://www.nist.gov/document/nist-technical-series-publication-template-docx",
    source: "NIST — technical series publication template",
  },
  {
    url: "https://www.energy.gov/sites/default/files/2023-03/Sample%20Project%20Management%20Plan.docx",
    source: "US DOE — sample project management plan",
  },

  /* ---------- Journals / academic templates ------------------------------ */
  {
    url: "https://www.acm.org/binaries/content/assets/publications/taps/acm_submission_template.docx",
    source: "ACM — primary article submission template",
  },
  {
    url: "https://www.ieee.org/content/dam/ieee-org/ieee/web/org/conferences/conference-template-a4.docx",
    source: "IEEE — conference proceedings template (A4)",
  },
  {
    url: "https://www.ieee.org/content/dam/ieee-org/ieee/web/org/conferences/conference-template-letter.docx",
    source: "IEEE — conference proceedings template (US Letter)",
  },

  /* ---------- UK / AU / CA government ------------------------------------ */
  {
    url: "https://assets.publishing.service.gov.uk/media/5a7f5b3ded915d74e33f5b26/Consultation_response_form.docx",
    source: "UK Government — consultation response form",
  },
];

/**
 * Additional URLs discovered at runtime (search, directory listings) are
 * appended here by the fetch script via --url / --list so that the static list
 * stays a curated record rather than a dumping ground.
 */
export const EXTRA_LIST_ENV = "SCRIV_CORPUS_URLS";
