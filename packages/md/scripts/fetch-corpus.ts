/**
 * Corpus downloader — NOT part of the library.
 *
 * House rule: `packages/md/src` is pure logic with no I/O. This script lives outside `src`,
 * is never imported by the library, and is the only place in the package that touches the
 * network or the disk.
 *
 * It collects REAL markdown from the wild into `corpus/md/`:
 *
 *   corpus/md/repos/<owner>__<repo>__<path>.md   real docs from well-known OSS repos
 *   corpus/md/spec/commonmark/NNN.md             every example from the CommonMark spec.json
 *   corpus/md/spec/gfm/NNN.md                    every example from the GFM spec.txt
 *
 * Run: bun run --cwd packages/md corpus
 */

const ROOT = new URL("../../../", import.meta.url).pathname;
const OUT = `${ROOT}corpus/md`;

const UA = { "user-agent": "scriv-md-corpus/0.1 (+local dev)" };

/** Repos chosen for genuine variety: prose, API reference, frontmatter, tables, HTML, code. */
const REPOS: Array<{ repo: string; branch: string; prefer?: RegExp; limit?: number }> = [
  { repo: "nodejs/node", branch: "main", prefer: /^doc\/api\//, limit: 14 },
  { repo: "electron/electron", branch: "main", prefer: /^docs\//, limit: 12 },
  { repo: "microsoft/TypeScript", branch: "main", limit: 8 },
  { repo: "facebook/react", branch: "main", limit: 8 },
  { repo: "vercel/next.js", branch: "canary", prefer: /^docs\//, limit: 12 },
  { repo: "denoland/deno", branch: "main", limit: 8 },
  { repo: "oven-sh/bun", branch: "main", prefer: /^docs\//, limit: 12 },
  { repo: "eslint/eslint", branch: "main", prefer: /^docs\/src\/(rules|use)\//, limit: 12 },
  { repo: "prettier/prettier", branch: "main", prefer: /^docs\//, limit: 10 },
  { repo: "remarkjs/remark", branch: "main", limit: 8 },
  { repo: "syntax-tree/mdast", branch: "main", limit: 4 },
  { repo: "tailwindlabs/tailwindcss", branch: "main", limit: 6 },
  { repo: "sveltejs/svelte", branch: "main", prefer: /^documentation\//, limit: 12 },
  { repo: "vuejs/docs", branch: "main", prefer: /^src\/guide\//, limit: 12 },
  { repo: "rust-lang/book", branch: "main", prefer: /^src\/ch/, limit: 12 },
  { repo: "hashicorp/terraform", branch: "main", limit: 8 },
  { repo: "helm/helm", branch: "main", limit: 6 },
  { repo: "moby/moby", branch: "master", limit: 8 },
  { repo: "gohugoio/hugo", branch: "master", limit: 8 },
  { repo: "jekyll/jekyll", branch: "master", prefer: /^docs\//, limit: 10 },
  { repo: "axios/axios", branch: "v1.x", limit: 5 },
  { repo: "expressjs/express", branch: "master", limit: 5 },
  { repo: "webpack/webpack", branch: "main", limit: 6 },
  { repo: "pytorch/pytorch", branch: "main", limit: 6 },
  { repo: "kubernetes/kubernetes", branch: "master", limit: 8 },
  { repo: "ohmyzsh/ohmyzsh", branch: "master", limit: 6 },
  { repo: "cli/cli", branch: "trunk", limit: 6 },
  { repo: "astral-sh/uv", branch: "main", prefer: /^docs\//, limit: 10 },
];

async function get(url: string, kind: "text" | "json" = "text"): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (res.status === 403 || res.status === 429) {
        await Bun.sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) return null;
      return kind === "json" ? await res.json() : await res.text();
    } catch {
      await Bun.sleep(500 * (attempt + 1));
    }
  }
  return null;
}

async function fetchRepo(spec: (typeof REPOS)[number]): Promise<number> {
  const [owner, name] = spec.repo.split("/") as [string, string];
  const tree = await get(
    `https://api.github.com/repos/${spec.repo}/git/trees/${spec.branch}?recursive=1`,
    "json",
  );
  let paths: string[] = [];
  if (tree && Array.isArray(tree.tree)) {
    const all = (tree.tree as Array<{ path: string; type: string; size?: number }>)
      .filter((e) => e.type === "blob" && /\.(md|markdown|mdx?)$/i.test(e.path))
      .filter((e) => !/\.mdx$/i.test(e.path)) // MDX is not markdown
      .filter((e) => (e.size ?? 0) > 200 && (e.size ?? 0) < 200_000)
      .map((e) => e.path);
    const preferred = spec.prefer ? all.filter((p) => spec.prefer!.test(p)) : [];
    const rest = all.filter((p) => !preferred.includes(p));
    // Deterministic spread: take every Nth so we do not get 12 near-identical siblings.
    const pick = (xs: string[], n: number) => {
      if (xs.length <= n) return xs;
      const step = xs.length / n;
      return Array.from({ length: n }, (_, i) => xs[Math.floor(i * step)]!);
    };
    const limit = spec.limit ?? 8;
    paths = [
      ...pick(preferred, Math.min(limit, Math.max(1, limit - 2))),
      ...pick(rest.filter((p) => /readme|contributing|changelog/i.test(p)), 2),
    ];
    if (paths.length === 0) paths = pick(all, limit);
  } else {
    paths = ["README.md"];
  }

  let n = 0;
  for (const p of paths) {
    const body = await get(
      `https://raw.githubusercontent.com/${spec.repo}/${spec.branch}/${p}`,
    );
    if (typeof body !== "string" || body.length < 100) continue;
    const flat = p.replace(/[^A-Za-z0-9._-]+/g, "_");
    await Bun.write(`${OUT}/repos/${owner}__${name}__${flat}`, body);
    n++;
  }
  return n;
}

async function fetchCommonMark(): Promise<number> {
  const spec = await get(
    "https://spec.commonmark.org/0.31.2/spec.json",
    "json",
  );
  if (!Array.isArray(spec)) return 0;
  let n = 0;
  for (const ex of spec as Array<{ markdown: string; example: number; section: string }>) {
    const id = String(ex.example).padStart(4, "0");
    const sec = ex.section.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
    await Bun.write(`${OUT}/spec/commonmark/${id}-${sec}.md`, ex.markdown);
    n++;
  }
  return n;
}

/** The GFM spec ships only as spec.txt; examples live in ``````````example fences. */
async function fetchGfm(): Promise<number> {
  const txt = await get(
    "https://raw.githubusercontent.com/github/cmark-gfm/master/test/spec.txt",
  );
  if (typeof txt !== "string") return 0;
  const lines = txt.split("\n");
  let n = 0;
  let i = 0;
  let section = "gfm";
  while (i < lines.length) {
    const line = lines[i]!;
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) section = h[1]!.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
    if (/^`{32}\s*example\s*$/.test(line)) {
      const buf: string[] = [];
      i++;
      // markdown side runs until the "." separator line
      while (i < lines.length && lines[i] !== ".") buf.push(lines[i++]!);
      while (i < lines.length && !/^`{32}\s*$/.test(lines[i]!)) i++;
      const md = buf.join("\n").replace(/→/g, "\t");
      if (md.trim().length > 0) {
        n++;
        await Bun.write(`${OUT}/spec/gfm/${String(n).padStart(4, "0")}-${section}.md`, md + "\n");
      }
    }
    i++;
  }
  return n;
}

const t0 = Date.now();
let total = 0;
for (const spec of REPOS) {
  const n = await fetchRepo(spec).catch(() => 0);
  total += n;
  console.log(`${n.toString().padStart(3)}  ${spec.repo}`);
}
const cm = await fetchCommonMark();
const gfm = await fetchGfm();
console.log(`\nrepos: ${total} files`);
console.log(`commonmark spec examples: ${cm}`);
console.log(`gfm spec examples: ${gfm}`);
console.log(`total: ${total + cm + gfm} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
