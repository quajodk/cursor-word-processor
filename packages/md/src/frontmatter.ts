import type { Frontmatter } from "./types";

/**
 * Frontmatter is document *metadata*, not content: it is lifted off the source before the
 * Markdown parser ever sees it, kept verbatim in {@link Frontmatter.block}, and written back
 * byte-for-byte on serialization. It never becomes a node in the document.
 *
 * `raw` is authoritative. `data` is a convenience view produced by a small YAML subset parser
 * (this package may not depend on a YAML library and may not do I/O); anything the subset
 * parser does not understand is simply absent from `data` and still present in `raw`.
 */

const FENCES = ["---", "+++"] as const;

export interface Split {
  frontmatter: Frontmatter | null;
  /** The source with the frontmatter block removed. */
  body: string;
}

export function splitFrontmatter(src: string): Split {
  for (const fence of FENCES) {
    // Must be the very first thing in the file, alone on its line.
    if (!src.startsWith(fence)) continue;
    const firstEol = eolAt(src, fence.length);
    if (firstEol < 0) continue;
    if (src.slice(fence.length, firstEol.at).trim() !== "") continue;

    let pos = firstEol.after;
    const contentStart = pos;
    while (pos <= src.length) {
      const lineEnd = eolAt(src, pos);
      const line = src.slice(pos, lineEnd < 0 ? src.length : lineEnd.at);
      const closes = line.trimEnd() === fence || (fence === "---" && line.trimEnd() === "...");
      if (closes) {
        const raw = src.slice(contentStart, pos);
        const blockEnd = lineEnd < 0 ? src.length : lineEnd.after;
        return {
          frontmatter: {
            fence,
            raw,
            block: src.slice(0, blockEnd),
            data: parseYamlSubset(fence === "---" ? raw : ""),
          },
          body: src.slice(blockEnd),
        };
      }
      if (lineEnd < 0) break;
      pos = lineEnd.after;
    }
  }
  return { frontmatter: null, body: src };
}

type Eol = { at: number; after: number };
/** Position of the next line ending at/after `from`, and the index just past it. */
function eolAt(s: string, from: number): Eol | -1 {
  const i = s.indexOf("\n", from);
  if (i < 0) return -1;
  const at = i > from && s.charCodeAt(i - 1) === 13 ? i - 1 : i;
  return { at, after: i + 1 };
}

// -----------------------------------------------------------------------------------------
// A deliberately small YAML reader: block maps, block sequences, quoted/plain scalars,
// nesting by indentation, `#` comments. It refuses rather than guesses: anchors, aliases,
// flow collections, multi-line scalars and tags are left out of `data`.
// -----------------------------------------------------------------------------------------

interface Line {
  indent: number;
  text: string;
}

export function parseYamlSubset(raw: string): Record<string, unknown> {
  const lines: Line[] = [];
  for (const l of raw.split("\n")) {
    const stripped = stripComment(l);
    if (stripped.trim() === "") continue;
    lines.push({ indent: l.length - l.trimStart().length, text: stripped.trim() });
  }
  const [value] = readBlock(lines, 0, lines.length > 0 ? lines[0]!.indent : 0);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Returns [value, nextIndex]. */
function readBlock(lines: Line[], i: number, indent: number): [unknown, number] {
  if (i >= lines.length) return [null, i];
  if (lines[i]!.text.startsWith("- ") || lines[i]!.text === "-") {
    const arr: unknown[] = [];
    while (i < lines.length && lines[i]!.indent === indent) {
      const line = lines[i]!;
      if (!(line.text.startsWith("- ") || line.text === "-")) break;
      const rest = line.text.slice(1).trim();
      i++;
      if (rest === "") {
        const [v, ni] = readBlock(lines, i, i < lines.length ? lines[i]!.indent : indent + 2);
        arr.push(v);
        i = ni;
      } else if (/^[^\s:]+:(\s|$)/.test(rest) && i <= lines.length) {
        // `- key: value` — an inline map opening a sequence item.
        const sub: Line[] = [{ indent: 0, text: rest }];
        while (i < lines.length && lines[i]!.indent > indent) {
          sub.push({ indent: lines[i]!.indent - indent - 2, text: lines[i]!.text });
          i++;
        }
        const [v] = readBlock(sub, 0, 0);
        arr.push(v);
      } else {
        arr.push(scalar(rest));
      }
    }
    return [arr, i];
  }

  const map: Record<string, unknown> = {};
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!;
    const m = /^("[^"]*"|'[^']*'|[^:]+):(?:\s+(.*))?$/.exec(line.text);
    if (!m) break;
    const key = String(scalar(m[1]!.trim()));
    const inline = m[2] === undefined ? "" : m[2].trim();
    i++;
    if (inline !== "") {
      map[key] = scalar(inline);
      continue;
    }
    if (i < lines.length && lines[i]!.indent > indent) {
      const [v, ni] = readBlock(lines, i, lines[i]!.indent);
      map[key] = v;
      i = ni;
    } else if (
      i < lines.length &&
      lines[i]!.indent === indent &&
      (lines[i]!.text.startsWith("- ") || lines[i]!.text === "-")
    ) {
      // Sequences may sit at the same indent as their key.
      const [v, ni] = readBlock(lines, i, indent);
      map[key] = v;
      i = ni;
    } else {
      map[key] = null;
    }
  }
  return [map, i];
}

function scalar(s: string): unknown {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c));
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  if (s.startsWith("[") || s.startsWith("{")) {
    try {
      return JSON.parse(s.replace(/'/g, '"'));
    } catch {
      return s;
    }
  }
  return s;
}
