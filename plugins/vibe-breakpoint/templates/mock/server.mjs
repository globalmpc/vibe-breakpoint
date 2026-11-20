import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const TEXT = "vibe-breakpoint mock response";
const LATENCY = Number(process.env.MOCK_LATENCY_MS) || 0;
const PREFIX = { customers: "cus", payment_intents: "pi", "checkout/sessions": "cs", subscriptions: "sub", charges: "ch", refunds: "re", prices: "price", products: "prod" };
const calls = new Map(); // "service method path" -> count (no bodies, ever)
let n = 0;

function respond(method, path, body) {
  const now = Math.floor(Date.now() / 1000);
  if (method === "POST") {
    if (path === "/v1/chat/completions") return ["openai", { id: "chatcmpl-vbmock", object: "chat.completion", created: now, model: "vb-mock", choices: [{ index: 0, message: { role: "assistant", content: TEXT }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }];
    if (path === "/v1/responses") return ["openai", { id: "resp_vbmock", object: "response", status: "completed", model: "vb-mock", output: [{ type: "message", id: "msg_vbmock", role: "assistant", status: "completed", content: [{ type: "output_text", text: TEXT, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }];
    if (path === "/v1/embeddings") {
      const k = Math.min(2048, Array.isArray(body?.input) ? body.input.length : 1);
      return ["openai", { object: "list", data: Array.from({ length: k }, (_, index) => ({ object: "embedding", index, embedding: Array(1536).fill(0) })), model: "vb-mock", usage: { prompt_tokens: 1, total_tokens: 1 } }];
    }
    if (path === "/v1/messages") return ["anthropic", { id: "msg_vbmock", type: "message", role: "assistant", model: "vb-mock", content: [{ type: "text", text: TEXT }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }];
    if (path === "/emails") return ["resend", { id: randomUUID() }];
    if (path.startsWith("/v1/")) {
      const segs = path.slice(4).split("/").filter(Boolean);
      const named = segs.filter((s) => !/\d|^[a-z]+_[A-Za-z0-9]+$/.test(s) || s in PREFIX);
      const last = named[named.length - 1] ?? "object";
      const pre = PREFIX[named.slice(-2).join("/")] ?? PREFIX[last] ?? "obj";
      return ["stripe", { id: `${pre}_vbmock${++n}`, object: last.replace(/s$/, "") }];
    }
  }
  return ["unknown", {}];
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const path = (req.url ?? "/").split("?")[0];
  const send = (obj) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (path === "/__vb/health") return send({});
  if (path === "/__vb/log") return send({ schema: 1, calls: [...calls.entries()].map(([k, count]) => { const [service, method, p] = k.split(" "); return { service, method, path: p, count }; }) });
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* not JSON */ }
  const [service, obj] = respond(req.method, path, body);
  const key = `${service} ${req.method} ${path}`;
  calls.set(key, (calls.get(key) ?? 0) + 1);
  if (LATENCY) await new Promise((r) => setTimeout(r, LATENCY));
  send(obj);
}).listen(Number(process.env.MOCK_PORT) || 4010);
