// The ONLY module allowed to read real .env* files (names only, values discarded).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { SKIP_DIRS } from "./copy.js";

const CODE_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".vue", ".svelte", ".astro"]);
const VITE_BUILTIN = new Set(["MODE", "DEV", "PROD", "SSR", "BASE_URL"]);
const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/;
const CODE_RES = [
  new RegExp(`process\\.env\\.(${NAME})`, "g"),
  new RegExp(`process\\.env\\[\\s*["'\`](${NAME})["'\`]\\s*\\]`, "g"),
  new RegExp(`os\\.environ\\[\\s*["'](${NAME})["']\\s*\\]`, "g"),
  new RegExp(`os\\.getenv\\(\\s*["'](${NAME})["']`, "g"),
];
const VITE_RE = new RegExp(`import\\.meta\\.env\\.(${NAME})`, "g");
const MAX_BYTES = 1_000_000; // ponytail: files > 1 MB are skipped; raise if a real source file is that large

function matches(re: RegExp, text: string, out: Set<string>, skip?: Set<string>) {
  for (const m of text.matchAll(re)) if (!skip?.has(m[1])) out.add(m[1]);
}

function composeNames(text: string, out: Set<string>) {
  matches(new RegExp(`\\$\\{(${NAME})`, "g"), text, out);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = /^(\s*)environment:\s*$/.exec(lines[i]);
    if (!h) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      if (l.search(/\S/) <= h[1].length) break;
      const m = /^\s*-\s*([A-Za-z_]\w*)\s*(?:=|$)/.exec(l) ?? /^\s*([A-Z_][A-Z0-9_]*)\s*:/.exec(l);
      if (m) out.add(m[1]);
    }
  }
}

function vercelNames(text: string, out: Set<string>) {
  try {
    const j = JSON.parse(text);
    for (const o of [j?.env, j?.build?.env]) if (o && typeof o === "object") for (const k of Object.keys(o)) if (new RegExp(`^${NAME}$`).test(k)) out.add(k);
  } catch { /* unparseable: skip */ }
}

function netlifyNames(text: string, out: Set<string>) {
  let on = false;
  for (const l of text.split("\n")) {
    const h = /^\s*\[(.+)\]\s*$/.exec(l);
    if (h) { on = h[1].trim().endsWith("environment"); continue; }
    const m = on && /^\s*([A-Za-z_]\w*)\s*=/.exec(l);
    if (m) out.add(m[1]);
  }
}

function fileNames(name: string, text: string, out: Set<string>) {
  if (/^\.env/.test(name)) {
    for (const l of text.split("\n")) { const m = ENV_LINE.exec(l); if (m) out.add(m[1]); }
  } else if (/^docker-compose.*\.ya?ml$/.test(name)) composeNames(text, out);
  else if (name === "vercel.json") vercelNames(text, out);
  else if (name === "netlify.toml") netlifyNames(text, out);
  else if (CODE_EXT.has(extname(name))) {
    for (const re of CODE_RES) matches(re, text, out);
    matches(VITE_RE, text, out, VITE_BUILTIN);
  }
}

const relevant = (n: string) =>
  n.startsWith(".env") || /^docker-compose.*\.ya?ml$/.test(n) || n === "vercel.json" || n === "netlify.toml" || CODE_EXT.has(extname(n));

function walk(dir: string, out: Set<string>) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); }
    else if (e.isFile() && relevant(e.name)) {
      if (statSync(p).size > MAX_BYTES) continue;
      // text stays local: only names leave this function (real env files included)
      fileNames(e.name, readFileSync(p, "utf8"), out);
    }
  }
}

export function envNames(projectDir: string): string[] {
  const out = new Set<string>();
  walk(projectDir, out);
  return [...out].sort();
}
