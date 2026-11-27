// .vibe-breakpoint/run.json: optional, agent-written build/start command and extra env NAMES (D-068). Argv arrays only; strict validation is the control (prompt-injection surface).
export type RunJson = { build?: string[] | null; start?: string[]; env_names?: string[] };

const bad = (m: string): never => { throw new Error(`run.json: ${m}`); };
const FIRST = new Set(["node", "npm", "pnpm", "yarn"]); // npx is not allowed: it fetches and runs remote packages (R1-1)
// R1-1 defense in depth: no ad-hoc code, no remote package runners, no registry/config overrides
const RUNNERS = new Set(["exec", "dlx", "x", "create"]);
const NODE_CODE = /^(-e|-p|-r|--eval|--print|--require|--import|--loader|--experimental-loader)(=|$)/;
const CONFIG = /^--(registry|userconfig|globalconfig|cache|prefix)(=|$)/;
const TOKEN = /^[\w@%+=:,./-]+$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// would break the build or the app if set to a placeholder
export const RESERVED_ENV = /^(BUILD_CMD|PATH|HOME|SHELL|IFS|ENV|BASH_ENV|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|LD_\w+|(npm|pnpm)_config_\w+|YARN_\w+|COREPACK_\w+)$/i;

function argv(key: string, v: unknown): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 12) return bad(`${key} must be an array of 1 to 12 strings`);
  for (const t of v) {
    if (typeof t !== "string" || t.length < 1 || t.length > 120) return bad(`${key}: each token must be a string of 1 to 120 characters`);
    if (!TOKEN.test(t)) return bad(`${key}: tokens may only use letters, digits and _ @ % + = : , . / -`);
    if (t.includes("..") || t.startsWith("/")) return bad(`${key}: tokens must not contain ".." or start with "/"`);
  }
  if (!FIRST.has(v[0]) && !v[0].startsWith("node_modules/.bin/")) return bad(`${key}: first token must be node, npm, pnpm, yarn or a node_modules/.bin/ path`);
  if (v[0] !== "node" && !v[0].startsWith("node_modules/") && RUNNERS.has(v[1])) return bad(`${key}: exec, dlx, x and create are not allowed`);
  if (v.slice(1).some((t) => CONFIG.test(t))) return bad(`${key}: registry and config flags are not allowed`);
  if (v[0] === "node" && v.slice(1).some((t) => NODE_CODE.test(t))) return bad(`${key}: node -e, -p, -r, --import and --loader are not allowed`);
  return v;
}

export function parseRunJson(text: string): RunJson {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return bad("invalid JSON"); }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return bad("must be a JSON object");
  const o = j as Record<string, unknown>;
  if (Object.keys(o).some((k) => !["build", "start", "env_names"].includes(k))) bad("only build, start and env_names are allowed (names only, never values)");
  const out: RunJson = {};
  if (o.build !== undefined) out.build = o.build === null ? null : argv("build", o.build);
  if (o.start !== undefined) out.start = argv("start", o.start);
  if (o.env_names !== undefined) {
    const n = o.env_names;
    if (!Array.isArray(n) || n.length > 50 || n.some((x) => typeof x !== "string" || !NAME.test(x) || x.length > 100)) return bad("env_names must be up to 50 names matching [A-Za-z_][A-Za-z0-9_]*");
    out.env_names = [...new Set(n as string[])];
  }
  return out;
}
