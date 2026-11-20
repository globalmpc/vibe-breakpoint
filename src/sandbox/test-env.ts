import { randomBytes } from "node:crypto";

export const MOCK_URL = "http://mock:4010";
const ALWAYS = ["NODE_ENV", "PORT", "DATABASE_URL", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "RESEND_BASE_URL"];
const hex = (n: number) => randomBytes(n).toString("hex");

const FIXED: Record<string, string> = {
  NODE_ENV: "production", PORT: "3000", HOST: "0.0.0.0", HOSTNAME: "0.0.0.0",
  NEXTAUTH_URL: "http://app:3000", AUTH_URL: "http://app:3000",
  PGHOST: "db", PGPORT: "5432", PGUSER: "vb", PGDATABASE: "vb",
};
const SERVICE_KEYS: [string, () => string][] = [
  ["OPENAI_API_KEY", () => "sk-vbfake" + hex(16)],
  ["ANTHROPIC_API_KEY", () => "sk-ant-vbfake" + hex(16)],
  ["STRIPE_SECRET_KEY", () => "sk_test_vbfake" + hex(12)],
  ["STRIPE_PUBLISHABLE_KEY", () => "pk_test_vbfake" + hex(12)],
  ["STRIPE_WEBHOOK_SECRET", () => "whsec_vbfake" + hex(12)],
  ["RESEND_API_KEY", () => "re_vbfake" + hex(12)],
];

function value(n: string, pw: string): string {
  if (n === "PGPASSWORD") return pw;
  if (n in FIXED) return FIXED[n];
  const dbUrl = `postgres://vb:${pw}@db:5432/vb`;
  const isUrl = /_(URL|URI)$/.test(n);
  if (n === "DIRECT_URL" || (isUrl && n.split("_").some((t) => ["DATABASE", "POSTGRES", "PG", "DB"].includes(t)))) return dbUrl;
  if (n === "OPENAI_BASE_URL") return MOCK_URL + "/v1";
  if (n.endsWith("_BASE_URL")) return MOCK_URL;
  const svc = SERVICE_KEYS.find(([k]) => n === k || n.endsWith("_" + k));
  if (svc) return svc[1]();
  if (n.includes("SECRET") || n.startsWith("JWT_") || /_(KEY|TOKEN|PASSWORD)$/.test(n)) return hex(32);
  if (isUrl) return MOCK_URL;
  return "vibe-breakpoint-placeholder";
}

export function testEnv(names: string[], dbPassword: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const n of new Set([...names, ...ALWAYS])) env[n] = value(n, dbPassword);
  return env;
}

export function envFileText(env: Record<string, string>): string {
  return Object.keys(env).sort().map((k) => `${k}=${env[k]}\n`).join("");
}

export function redact(text: string, env: Record<string, string>): string {
  const vals = [...new Set(Object.values(env))].filter((v) => v.length >= 8).sort((a, b) => b.length - a.length);
  return vals.reduce((t, v) => t.split(v).join("[redacted]"), text);
}
