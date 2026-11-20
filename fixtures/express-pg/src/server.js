import crypto from "node:crypto";
import express from "express";
import pg from "pg";
import bcrypt from "bcryptjs";
import OpenAI from "openai";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(express.json());

const log = (...a) => process.env.LOG_LEVEL === "debug" && console.log(...a);

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  const { rows } = await pool.query("SELECT id, password_hash FROM users WHERE email = $1", [email]);
  if (!rows[0] || !(await bcrypt.compare(String(password), rows[0].password_hash))) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  const sig = crypto.createHmac("sha256", process.env.JWT_SECRET ?? "").update(String(rows[0].id)).digest("hex");
  res.cookie("session", `${rows[0].id}.${sig}`, { httpOnly: true });
  res.json({ ok: true });
});

// N+1: one query per project for its owner, no limit
app.get("/api/projects", async (_req, res) => {
  const { rows: projects } = await pool.query("SELECT * FROM projects ORDER BY id");
  for (const p of projects) {
    const { rows } = await pool.query("SELECT id, email, name FROM users WHERE id = $1", [p.owner_id]);
    p.owner = rows[0];
  }
  log("projects", projects.length);
  res.json(projects);
});

// no index on users.email
app.get("/api/users", async (req, res) => {
  const { rows } = await pool.query("SELECT id, email, name FROM users WHERE email = $1", [req.query.email]);
  res.json(rows);
});

// unbounded fetch
app.get("/api/feed", async (_req, res) => {
  const { rows } = await pool.query("SELECT * FROM projects ORDER BY created_at DESC");
  res.json(rows);
});

// deliberately slow (Phase 4 breaking-point fixture): holds a pool connection 1 s; needs the login cookie
app.get("/api/slow", async (req, res) => {
  if (!String(req.headers.cookie ?? "").includes("session=")) return res.status(401).json({ error: "login required" });
  await pool.query("SELECT pg_sleep(1)");
  res.json({ ok: true });
});

app.post("/api/summary", async (req, res) => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const out = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: `Summarize: ${req.body?.text ?? ""}` }],
  });
  res.json({ summary: out.choices[0]?.message?.content ?? "" });
});

app.listen(process.env.PORT || 3000);
