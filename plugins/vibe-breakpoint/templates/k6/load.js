// Static k6 script (no codegen). Config arrives as JSON in -e VB_CONFIG; the summary leaves via a stdout marker.
import http from "k6/http";
import { sleep } from "k6";

const c = JSON.parse(__ENV.VB_CONFIG);

export const options = {
  scenarios: { load: { executor: "constant-vus", vus: c.users, duration: c.duration_s + "s", gracefulStop: "10s" } },
  noCookiesReset: true,
  discardResponseBodies: true,
  summaryTrendStats: ["med", "p(95)", "max"],
};

const value = (name) => {
  if (name === "user.email") return `user${((__VU - 1) % c.test_users) + 1}@example.test`;
  if (name === "user.password") return c.password;
  return `user${1 + Math.floor(Math.random() * c.email_rows)}@example.test`; // random.email
};
const fill = (s, enc) => s.replace(/\{\{([^}]*)\}\}/g, (_, n) => (enc ? encodeURIComponent(value(n)) : value(n)));
const fillDeep = (x) =>
  typeof x === "string" ? fill(x, false) : Array.isArray(x) ? x.map(fillDeep)
  : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fillDeep(v)])) : x;

export default function () {
  for (const step of c.flow) {
    if (step.save && step.save.cookie && __ITER > 0) continue; // login once per VU
    const body = step.body ? JSON.stringify(fillDeep(step.body)) : null;
    http.request(step.method, c.base + fill(step.path, true), body, {
      headers: body ? { "Content-Type": "application/json" } : {},
      timeout: "10s",
      tags: { name: step.name },
    });
    if (c.think_time_s > 0) sleep(c.think_time_s);
  }
}

export function handleSummary(d) {
  return { stdout: "\nVB_SUMMARY " + JSON.stringify({ metrics: d.metrics }) + "\n" };
}
