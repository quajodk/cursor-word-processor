import { codeSpans, frontmatterSpan, isMasked, type Span } from "./mask";

/**
 * Agent mode: an instruction that edits the whole workspace, reviewable before it lands.
 *
 * The founding brief asks for "agent mode across the workspace" alongside Cmd-K. The
 * blind-comparison task says what that has to be good at, in one line: *"Terminology: rename
 * a defined term consistently across the document."* Consistently is the hard word. A writer
 * can find-and-replace; what they cannot do by hand is decide, four hundred times, whether
 * this particular occurrence is the defined term or a different word that happens to be
 * spelled the same, and whether the sentence around it still reads.
 *
 * THREE PROPERTIES THIS IS BUILT AROUND:
 *
 * 1. THE DETERMINISTIC PART IS DETERMINISTIC. Finding occurrences, respecting word
 *    boundaries, carrying plurals and possessives, preserving case, and refusing to touch
 *    code are all decidable. They are done here, exactly, with no model involved — so the
 *    feature works with the network unplugged, which is house rule 3. A model is asked only
 *    about sites this cannot decide, and its answer is a suggestion like any other.
 *
 * 2. IT EDITS THE FILE, IT DOES NOT REGENERATE IT. Sites are byte offsets into the text on
 *    disk and the apply is a splice. Round-tripping through the Markdown parser would rewrite
 *    the whole file — `@scriv/md` reproduces 96% of the corpus byte-for-byte, and on the
 *    other 4% a one-word rename would land as a whole-file diff in someone's git history.
 *    Same principle as splice-over-origin for .docx, for the same reason.
 *
 * 3. NOTHING IS APPLIED THAT WAS NOT SHOWN. A change set is a proposal. Every site carries
 *    the line it sits on and why it was selected, and `applyChangeSet` takes the set of sites
 *    the writer accepted — not a boolean.
 */

export type Confidence =
  /** The term, exactly, on a word boundary, in prose. */
  | "exact"
  /** The term in a different case, or carrying a plural or possessive suffix. */
  | "variant"
  /** Found, but something about it needs a human: mid-word, in a heading anchor, in a link. */
  | "uncertain";

export interface Site {
  path: string;
  /** Byte offsets into the file as it is on disk. */
  from: number;
  to: number;
  before: string;
  after: string;
  confidence: Confidence;
  /** Why this site is what it is. Shown in review; never empty for `variant`/`uncertain`. */
  note?: string;
  /** The line the site sits on, and where the site starts within it. For review. */
  line: string;
  lineOffset: number;
  /** 1-based line number, so a site can be named the way an error is. */
  lineNumber: number;
}

export interface FileChange {
  path: string;
  sites: Site[];
}

export interface ChangeSet {
  instruction: string;
  files: FileChange[];
  /** Files read. The denominator for "12 of 340 files affected". */
  scanned: number;
  /** Files deliberately not searched, and why. Reported, never silent. */
  skipped: { path: string; reason: string }[];
}

export interface RenameOptions {
  /**
   * Rename inside YAML frontmatter too. Off by default: a `title:` should usually follow the
   * body but a `slug:` or `path:` must not, and getting that wrong breaks routing silently.
   * When on, frontmatter sites are marked `uncertain` so they are reviewed individually.
   */
  frontmatter?: boolean;
  /** Match case-insensitively and preserve each occurrence's case. Default true. */
  preserveCase?: boolean;
  /** Carry a trailing plural or possessive onto the replacement. Default true. */
  carrySuffix?: boolean;
  /** Hard cap on sites, so a one-letter term cannot produce an unreviewable set. */
  maxSites?: number;
}

const DEFAULTS = { frontmatter: false, preserveCase: true, carrySuffix: true, maxSites: 5000 };

/** Suffixes carried onto the replacement. Order matters: longest first. */
const SUFFIXES = ["’s", "'s", "es", "s"];

export interface SourceFile { path: string; text: string }

/**
 * Plan a workspace-wide rename.
 *
 * Pure: files in, change set out, no I/O. That is what lets it be tested against the real
 * corpus rather than against a directory someone built to make it pass — and it is what the
 * host seam requires of anything above it (ARCHITECTURE.md §1).
 */
export function planRename(
  files: readonly SourceFile[],
  term: string,
  replacement: string,
  options: RenameOptions = {},
): ChangeSet {
  const opts = { ...DEFAULTS, ...options };
  const trimmed = term.trim();
  const out: FileChange[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let total = 0;

  if (trimmed.length === 0) {
    return { instruction: renameInstruction(term, replacement), files: [], scanned: files.length, skipped };
  }

  for (const file of files) {
    // A term this short matches inside too much to review. Refused rather than truncated:
    // a change set the writer cannot read is one they will accept without reading.
    if (trimmed.length < 2) {
      skipped.push({ path: file.path, reason: `"${trimmed}" is too short to rename safely` });
      continue;
    }

    const sites = sitesIn(file, trimmed, replacement, opts);
    if (sites.length === 0) continue;
    if (total + sites.length > opts.maxSites) {
      skipped.push({ path: file.path, reason: `would exceed the ${opts.maxSites}-site review cap` });
      continue;
    }
    total += sites.length;
    out.push({ path: file.path, sites });
  }

  return { instruction: renameInstruction(trimmed, replacement), files: out, scanned: files.length, skipped };
}

function renameInstruction(term: string, replacement: string): string {
  return `Rename “${term}” to “${replacement}”`;
}

function sitesIn(file: SourceFile, term: string, replacement: string, opts: Required<RenameOptions>): Site[] {
  const { text, path } = file;
  const masked: Span[] = codeSpans(text);
  const fm = opts.frontmatter ? null : frontmatterSpan(text);
  const lines = lineIndex(text);
  const sites: Site[] = [];

  const needle = opts.preserveCase ? term.toLowerCase() : term;
  const haystack = opts.preserveCase ? text.toLowerCase() : text;

  let at = haystack.indexOf(needle);
  while (at >= 0) {
    const end = at + term.length;
    const site = classify(text, at, end, term, replacement, opts);
    if (site) {
      const inCode = isMasked(masked, at, site.to);
      const inFrontmatter = fm !== null && at < fm.to;
      if (!inCode && !inFrontmatter) {
        const ln = lineAt(lines, at);
        sites.push({
          path, from: at, to: site.to,
          before: site.before, after: site.after,
          confidence: site.confidence, note: site.note,
          line: text.slice(ln.from, ln.to),
          lineOffset: at - ln.from,
          lineNumber: ln.number,
        });
      }
    }
    at = haystack.indexOf(needle, at + 1);
  }
  return sites;
}

interface Classified {
  /**
   * End of the site, which is NOT `from + term.length` when a plural or possessive is being
   * carried. Returning it was easy to forget and produced a `to` one suffix short of
   * `before`, so every carried site would have written "settingss" over "configurations".
   */
  to: number;
  before: string;
  after: string;
  confidence: Confidence;
  note?: string;
}

/**
 * Decide whether an occurrence is a rename site, and what it becomes.
 *
 * The boundary test is on the characters either side rather than a `\b` regex, because a
 * defined term is frequently several words ("Working Group", "data subject") and `\b` around
 * a phrase means something different from what it means around a word.
 */
function classify(
  text: string,
  from: number,
  to: number,
  term: string,
  replacement: string,
  opts: Required<RenameOptions>,
): Classified | null {
  const before = text[from - 1] ?? " ";
  const matched = text.slice(from, to);

  // A letter or digit immediately before means this is inside a longer word: `subwidget`.
  if (isWordChar(before)) return null;

  let end = to;
  let suffix = "";
  if (opts.carrySuffix) {
    for (const s of SUFFIXES) {
      if (text.slice(to, to + s.length).toLowerCase() === s && !isWordChar(text[to + s.length] ?? " ")) {
        suffix = text.slice(to, to + s.length);
        end = to + s.length;
        break;
      }
    }
  }
  if (isWordChar(text[end] ?? " ")) return null;

  const exactCase = matched === term;
  const cased = opts.preserveCase ? applyCase(matched, replacement) : replacement;
  const carried = suffix.length > 0 ? cased + carrySuffix(cased, suffix) : cased;

  if (exactCase && suffix.length === 0) {
    return { to: end, before: matched, after: replacement, confidence: "exact" };
  }
  // An all-caps occurrence of a term that is not itself all-caps is very often an acronym or
  // a heading in caps, and blindly upper-casing the replacement is usually right but not
  // always — so it is offered, and flagged.
  if (matched === matched.toUpperCase() && term !== term.toUpperCase() && /[a-z]/i.test(matched)) {
    return {
      to: end,
      before: text.slice(from, end),
      after: carried,
      confidence: "uncertain",
      note: "all-capitals: this may be an acronym or a display heading rather than the term",
    };
  }
  return {
    to: end,
    before: text.slice(from, end),
    after: carried,
    confidence: "variant",
    note: [
      exactCase ? null : "different case",
      suffix.length > 0 ? `carries “${suffix}”` : null,
    ].filter(Boolean).join(", ") || undefined,
  };
}

/**
 * Carry a plural or possessive onto the replacement, adjusting for the replacement's own
 * ending. "box" + "s" is "boxes"; "Widget" + "'s" is "Widget's".
 */
function carrySuffix(replacement: string, suffix: string): string {
  const lower = suffix.toLowerCase();
  if (lower === "'s" || lower === "’s") return suffix;
  const needsEs = /(s|x|z|ch|sh)$/i.test(replacement);
  if (lower === "es") return needsEs ? suffix : suffix.slice(1);
  return needsEs ? (suffix === suffix.toUpperCase() ? "ES" : "es") : suffix;
}

/** Give the replacement the same case shape as the occurrence it replaces. */
function applyCase(matched: string, replacement: string): string {
  if (matched === matched.toUpperCase() && /[A-Z]/.test(matched)) return replacement.toUpperCase();
  if (matched === matched.toLowerCase()) return replacement.toLowerCase();
  if (matched[0] === matched[0]?.toUpperCase() && matched.slice(1) === matched.slice(1).toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

const isWordChar = (c: string) => /[\p{L}\p{N}_]/u.test(c);

interface Line { from: number; to: number; number: number }

function lineIndex(text: string): Line[] {
  const out: Line[] = [];
  let start = 0, n = 1;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl < 0) { out.push({ from: start, to: text.length, number: n }); break; }
    out.push({ from: start, to: nl, number: n++ });
    start = nl + 1;
  }
  return out;
}

function lineAt(lines: Line[], offset: number): Line {
  let lo = 0, hi = lines.length - 1, at = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.from <= offset) { at = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return lines[at]!;
}

/* ------------------------------------------------------------------ applying */

/** A site, identified the way the UI identifies it. */
export const siteKey = (s: Site): string => `${s.path}:${s.from}:${s.to}`;

export interface ApplyResult {
  path: string;
  text: string;
  applied: number;
}

/**
 * Produce the new text for each file, given the sites the writer accepted.
 *
 * Splices back-to-front so earlier offsets stay valid, and returns text rather than writing:
 * this package is above the host seam and does not touch the disk.
 */
export function applyChangeSet(
  files: readonly SourceFile[],
  changes: ChangeSet,
  accepted: ReadonlySet<string>,
): ApplyResult[] {
  const byPath = new Map(files.map((f) => [f.path, f.text]));
  const out: ApplyResult[] = [];

  for (const file of changes.files) {
    const text = byPath.get(file.path);
    if (text === undefined) continue;
    const take = file.sites.filter((s) => accepted.has(siteKey(s))).sort((a, b) => b.from - a.from);
    if (take.length === 0) continue;

    let next = text;
    for (const s of take) {
      // The file may have changed since the plan was made. A site whose text is no longer
      // what the plan saw is skipped rather than overwritten — the alternative is corrupting
      // a file the writer edited while reviewing.
      if (next.slice(s.from, s.to) !== s.before) continue;
      next = next.slice(0, s.from) + s.after + next.slice(s.to);
    }
    if (next !== text) out.push({ path: file.path, text: next, applied: take.length });
  }
  return out;
}

/** Sites whose file no longer matches what the plan saw. Surfaced before an apply, not after. */
export function staleSites(files: readonly SourceFile[], changes: ChangeSet): Site[] {
  const byPath = new Map(files.map((f) => [f.path, f.text]));
  const stale: Site[] = [];
  for (const file of changes.files) {
    const text = byPath.get(file.path);
    for (const s of file.sites) {
      if (text === undefined || text.slice(s.from, s.to) !== s.before) stale.push(s);
    }
  }
  return stale;
}

export interface ChangeSetSummary {
  files: number;
  sites: number;
  byConfidence: Record<Confidence, number>;
}

export function summarizeChangeSet(changes: ChangeSet): ChangeSetSummary {
  const byConfidence: Record<Confidence, number> = { exact: 0, variant: 0, uncertain: 0 };
  let sites = 0;
  for (const f of changes.files) {
    for (const s of f.sites) { byConfidence[s.confidence]++; sites++; }
  }
  return { files: changes.files.length, sites, byConfidence };
}
