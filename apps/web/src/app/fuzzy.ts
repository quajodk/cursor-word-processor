/**
 * Subsequence matching for the palette and quick-open.
 *
 * Small on purpose. It ranks by the three things that actually decide whether the right row is
 * first: how tightly the typed characters cluster, whether they land on word starts, and how
 * early the match begins. Anything cleverer than that is unmeasurable at the sizes a workspace
 * file list reaches, and slower.
 */

export interface Match {
  score: number;
  /** Indices in the candidate that matched, for highlighting. */
  positions: number[];
}

const WORD_BREAK = /[\s/\\._\-:]/;

export function fuzzyMatch(candidate: string, query: string): Match | null {
  if (query.length === 0) return { score: 0, positions: [] };

  const hay = candidate.toLowerCase();
  const needle = query.toLowerCase();
  const positions: number[] = [];

  let score = 0;
  let at = 0;
  let previous = -2;

  for (let i = 0; i < needle.length; i++) {
    const ch = needle[i]!;
    if (ch === " ") continue; // spaces separate terms rather than having to match
    const found = hay.indexOf(ch, at);
    if (found < 0) return null;

    if (found === previous + 1) score += 8; // adjacency is the strongest signal
    if (found === 0 || WORD_BREAK.test(candidate[found - 1] ?? "")) score += 6;
    if (candidate[found] !== hay[found]) score += 2; // matched an uppercase initial

    score -= Math.min(4, found - previous - 1) * 0.5;
    positions.push(found);
    previous = found;
    at = found + 1;
  }

  // Prefer shorter candidates and matches that start early.
  score -= candidate.length * 0.02;
  score -= (positions[0] ?? 0) * 0.08;
  return { score, positions };
}

export function highlight(text: string, positions: number[]): { text: string; hit: boolean }[] {
  if (positions.length === 0) return [{ text, hit: false }];
  const set = new Set(positions);
  const out: { text: string; hit: boolean }[] = [];
  let buffer = "";
  let hit = set.has(0);
  for (let i = 0; i < text.length; i++) {
    const isHit = set.has(i);
    if (isHit !== hit) {
      out.push({ text: buffer, hit });
      buffer = "";
      hit = isHit;
    }
    buffer += text[i];
  }
  out.push({ text: buffer, hit });
  return out.filter((part) => part.text.length > 0);
}
