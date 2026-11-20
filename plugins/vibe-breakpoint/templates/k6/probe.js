// Static k6 script (no codegen). Config arrives as JSON in -e VB_CONFIG; the result leaves via one VB_PROBE stdout line.
// mode "prep": setup() logs in, one warm-up request per target, then the cookies as they are AFTER the warm-up (rotation) are logged as one VB_COOKIES line (stderr, --log-format raw).
// mode "run": cookies come in via config, c.iterations sequential requests of the single target (1 VU).
import http from "k6/http";
import { Counter } from "k6/metrics";

const c = JSON.parse(__ENV.VB_CONFIG);
const failed = new Counter("vb_fail");
const prep = c.mode === "prep";

export const options = {
  scenarios: { probe: { executor: "shared-iterations", vus: 1, iterations: prep ? 1 : c.iterations, maxDuration: "10m", gracefulStop: "10s" } },
  noCookiesReset: true,
  discardResponseBodies: true,
  summaryTrendStats: ["med"],
};

const value = (name, iter) => {
  if (name === "user.email") return "user1@example.test";
  if (name === "user.password") return c.password;
  return `user${1 + ((iter * 7919) % c.email_rows)}@example.test`; // random.email, deterministic
};
const fill = (s, iter, enc) => s.replace(/\{\{([^}]*)\}\}/g, (_, n) => (enc ? encodeURIComponent(value(n, iter)) : value(n, iter)));
const fillDeep = (x, iter) =>
  typeof x === "string" ? fill(x, iter, false) : Array.isArray(x) ? x.map((v) => fillDeep(v, iter))
  : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fillDeep(v, iter)])) : x;

const send = (step, iter) => {
  const body = step.body ? JSON.stringify(fillDeep(step.body, iter)) : null;
  return http.request(step.method, c.base + fill(step.path, iter, true), body, {
    headers: body ? { "Content-Type": "application/json" } : {},
    timeout: "120s",
    tags: { name: step.name },
  });
};

// cookies for the base URL and for every step path (a cookie scoped to /api is only returned for /api/...), merged
const collect = (jar) => {
  const all = {};
  for (const u of [c.base, ...c.flow.map((st) => c.base + fill(st.path, 0, true))]) Object.assign(all, jar.cookiesForURL(u));
  return all;
};

export function setup() {
  if (!prep) return {};
  const jar = http.cookieJar();
  const login = [];
  for (const step of c.flow) {
    if (!(step.save && step.save.cookie)) continue;
    const res = send(step, 0);
    login.push(res.status);
    if (res.status === 0 || res.status >= 400) throw new Error(`probe login failed (status ${res.status})`);
  }
  return { cookies: collect(jar), login };
}

let seeded = false; // module scope = once per VU; re-setting every iteration would undo cookie rotation
export default function (data) {
  const jar = http.cookieJar();
  if (!seeded) {
    seeded = true;
    // ponytail: restored with path "/" on the base URL, so a path-scoped cookie is sent to every path; fine for the single-origin sandbox, narrow it if a cookie ever collides across paths.
    for (const [name, values] of Object.entries(prep ? data.cookies : c.cookies || {})) jar.set(c.base, name, values[0], { path: "/" });
  }
  for (const step of c.flow) {
    if (!c.targets.includes(step.name)) continue;
    const res = send(step, __ITER);
    if (res.status === 0 || res.status >= 400) failed.add(1);
  }
  if (prep) console.log("VB_COOKIES " + JSON.stringify(collect(jar))); // never printed by the tool
}

export function handleSummary(d) {
  const fails = d.metrics.vb_fail ? d.metrics.vb_fail.values.count : 0;
  const out = { fails };
  if (prep) { out.cookies = d.setup_data ? d.setup_data.cookies : {}; out.login = d.setup_data ? d.setup_data.login : []; }
  return { stdout: "\nVB_PROBE " + JSON.stringify(out) + "\n" };
}
