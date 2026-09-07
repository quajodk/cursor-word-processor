/**
 * Which parts of a Markdown file are prose.
 *
 * A workspace-wide rename that hits code is worse than no rename at all: renaming a defined
 * term should not touch `widgetId` in a fenced example, a `--widget` flag in a shell block,
 * or a `require('widget')` in an inline span. And the writer cannot review five hundred sites
 * one by one, so the sites they are shown have to be right by construction.
 *
 * WHY A RAW-TEXT SCANNER AND NOT THE mdast PARSE. The rename edits the FILE, at byte offsets,
 * and writes the result back — the same principle as splice-over-origin for .docx. Going
 * through parse → edit → serialize would rewrite the whole file: `@scriv/md` round-trips 96%
 * of the corpus byte-for-byte, and the other 4% would turn a one-word rename into a
 * whole-file diff. So the mask has to speak in offsets into the original text, which means
 * scanning the original text.
 *
 * It recognises what CommonMark says is code and nothing else. Anything it is unsure of is
 * treated as CODE rather than prose: a missed rename is a site the writer can fix by hand, a
 * rename inside a code fence is a broken example they may never notice.
 */

export interface Span { from: number; to: number }

/**
 * Byte ranges that are code, in order, non-overlapping.
 *
 * Covers: fenced blocks (``` and ~~~, any length ≥3, with the closing fence matched by
 * length and character as CommonMark requires), indented code blocks, inline code spans
 * (backtick runs matched by length), autolinks and raw HTML blocks, and link/image
 * destinations — because renaming a term inside a URL silently breaks the link.
 */
export function codeSpans(text: string): Span[] {
  const spans: Span[] = [];
  const lines = splitLines(text);

  let i = 0;
  let inFence: { char: string; len: number; from: number } | null = null;
  let inHtmlBlock = false;

  while (i < lines.length) {
    const line = lines[i]!;
    const body = text.slice(line.from, line.to);

    if (inFence) {
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(body);
      if (close && close[1]![0] === inFence.char && close[1]!.length >= inFence.len) {
        spans.push({ from: inFence.from, to: line.to });
        inFence = null;
      }
      i++;
      continue;
    }

    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(body);
    if (open) {
      inFence = { char: open[1]![0]!, len: open[1]!.length, from: line.from };
      i++;
      // An unclosed fence runs to the end of the file, which is what CommonMark says too.
      if (i >= lines.length) spans.push({ from: inFence.from, to: text.length });
      continue;
    }

    if (inHtmlBlock) {
      spans.push({ from: line.from, to: line.to });
      if (body.trim().length === 0) inHtmlBlock = false;
      i++;
      continue;
    }
    // An HTML block opens on a line starting with `<` and runs to the next blank line.
    if (/^\s{0,3}<[a-zA-Z!/?]/.test(body)) {
      inHtmlBlock = true;
      spans.push({ from: line.from, to: line.to });
      i++;
      continue;
    }

    // An indented code block: four spaces, and not a list continuation. Recognised only
    // after a blank line, which is the cheap approximation of "not inside a list item" —
    // and erring toward calling it code is the safe direction.
    if (/^(?: {4}|\t)/.test(body) && body.trim().length > 0) {
      const prev = i > 0 ? text.slice(lines[i - 1]!.from, lines[i - 1]!.to) : "";
      if (prev.trim().length === 0) {
        const from = line.from;
        let to = line.to;
        while (i + 1 < lines.length) {
          const next = text.slice(lines[i + 1]!.from, lines[i + 1]!.to);
          if (!/^(?: {4}|\t)/.test(next) && next.trim().length > 0) break;
          i++;
          to = lines[i]!.to;
        }
        spans.push({ from, to });
        i++;
        continue;
      }
    }

    for (const s of inlineSpans(text, line.from, line.to)) spans.push(s);
    i++;
  }

  spans.sort((a, b) => a.from - b.from);
  return merge(spans);
}

/** Inline code, autolinks and link destinations within one line. */
function inlineSpans(text: string, from: number, to: number): Span[] {
  const out: Span[] = [];
  const line = text.slice(from, to);

  // Inline code: a run of N backticks closed by a run of exactly N.
  const tick = /`+/g;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = tick.exec(line)) && guard++ < 500) {
    const len = m[0].length;
    const closeRe = new RegExp("(?<!`)`{" + len + "}(?!`)", "g");
    closeRe.lastIndex = m.index + len;
    const close = closeRe.exec(line);
    if (!close) continue;
    out.push({ from: from + m.index, to: from + close.index + len });
    tick.lastIndex = close.index + len;
  }

  // Link and image destinations, and autolinks. Renaming inside a URL breaks the link
  // silently, which is the worst kind of edit: it still looks right.
  for (const re of [/\]\(([^)\s]*)/g, /<([a-zA-Z][a-zA-Z0-9+.-]*:[^>\s]*)>/g, /^\s*\[[^\]]+\]:\s*(\S+)/g]) {
    re.lastIndex = 0;
    let d: RegExpExecArray | null;
    let g = 0;
    while ((d = re.exec(line)) && g++ < 500) {
      const start = d.index + d[0].indexOf(d[1]!);
      out.push({ from: from + start, to: from + start + d[1]!.length });
    }
  }
  return out;
}

function splitLines(text: string): Span[] {
  const out: Span[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl < 0) { out.push({ from: start, to: text.length }); break; }
    out.push({ from: start, to: nl });
    start = nl + 1;
  }
  return out;
}

function merge(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

/** True when [from, to) touches any masked span. */
export function isMasked(spans: Span[], from: number, to: number): boolean {
  // Binary search for the last span starting at or before `from`.
  let lo = 0, hi = spans.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.from <= from) { at = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (at >= 0 && spans[at]!.to > from) return true;
  const next = spans[at + 1];
  return next !== undefined && next.from < to;
}

/**
 * Frontmatter, which is data rather than prose.
 *
 * A `title:` in frontmatter genuinely should be renamed along with the body, but a `slug:`
 * or a `path:` should not. Returned separately so the caller can decide rather than having
 * the decision made for it here.
 */
export function frontmatterSpan(text: string): Span | null {
  if (!text.startsWith("---")) return null;
  const firstNl = text.indexOf("\n");
  if (firstNl < 0 || text.slice(3, firstNl).trim().length > 0) return null;
  const end = text.indexOf("\n---", firstNl);
  if (end < 0) return null;
  const lineEnd = text.indexOf("\n", end + 1);
  return { from: 0, to: lineEnd < 0 ? text.length : lineEnd };
}
