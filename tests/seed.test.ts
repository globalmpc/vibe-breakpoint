import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSeed, rowsFor, schemaErrors, seedSql, type DbColumn, type Seed } from "../src/seed/seed.js";

const load = (n: string) => readFileSync(`fixtures/${n}/expected/seed.json`, "utf8");
const pg = parseSeed(load("express-pg"));
const nd = parseSeed(load("next-drizzle"));
const col = (table: string, column: string, type: string, nullable: boolean, hasDefault: boolean): DbColumn => ({ table, column, type, nullable, hasDefault });
const cols: DbColumn[] = [
  col("users", "id", "integer", false, true), col("users", "email", "text", false, false), col("users", "password_hash", "text", false, false), col("users", "name", "text", true, false),
  col("projects", "id", "integer", false, true), col("projects", "owner_id", "integer", false, false), col("projects", "name", "text", false, false), col("projects", "created_at", "timestamp with time zone", true, true),
];
const mod = (f: (s: any) => void) => { const s = JSON.parse(load("express-pg")); f(s); return JSON.stringify(s); };

describe("parseSeed", () => {
  it("accepts fixtures", () => { expect(pg.test_users).toBe(50); expect(nd.tables).toHaveLength(2); });
  it.each([
    ["unknown gen", (s: any) => { s.tables[0].columns.email.gen = "nope"; }, "email"],
    ["fk to later table", (s: any) => { s.tables[0].columns.name = { gen: "fk", ref: "projects.id" }; }, "projects.id"],
    ["fk to same table", (s: any) => { s.tables[0].columns.name = { gen: "fk", ref: "users.id" }; }, "users.id"],
    ["fk to unlisted", (s: any) => { s.tables[1].columns.owner_id.ref = "x.id"; }, "x.id"],
    ["main_table missing", (s: any) => { s.main_table = "zzz"; }, "zzz"],
    ["size missing", (s: any) => { delete s.sizes.M; }, "sizes.M"],
    ["size zero", (s: any) => { s.sizes.S = 0; }, "sizes.S"],
    ["ratio 0", (s: any) => { s.tables[1].ratio = 0; }, "projects"],
    ["argon2", (s: any) => { s.tables[0].columns.password_hash.algo = "argon2"; }, "argon2"],
    ["test_users no password col", (s: any) => { delete s.tables[0].columns.password_hash; }, "password_hash"],
    ["test_users too big", (s: any) => { s.test_users = 101; }, "test_users"],
  ])("rejects %s", (_n, f, needle) => {
    expect(() => parseSeed(mod(f))).toThrow(new RegExp(`^seed\\.json: .*${needle.replace(".", "\\.")}`));
  });
  it("test_users needs an email generator on the password table (AC4)", () => {
    expect(() => parseSeed(mod((s) => { s.tables[0].columns.email = { gen: "auto" }; }))).toThrow(/test_users needs table "users" to have an "email" generator column/);
    expect(() => parseSeed(mod(() => {}))).not.toThrow();
  });
  it("rejects invalid JSON", () => { expect(() => parseSeed("{")).toThrow(/^seed\.json: invalid JSON/); });
  it("invalid JSON message never echoes the input (B2)", () => { expect(() => parseSeed("sk_live_ABCDEF123456")).toThrow(/^seed\.json: invalid JSON$/); });
});

describe("seedSql password_hash aliases (N7)", () => {
  it("two password_hash columns get distinct join aliases; one keeps working", () => {
    const s: Seed = JSON.parse(JSON.stringify(pg)); delete s.test_users;
    const one = seedSql(s, cols, "S");
    expect(one).toContain(") p0");
    expect(one).toContain("p0.h");
    s.tables[0].columns.password_hash2 = JSON.parse(JSON.stringify(s.tables[0].columns.password_hash));
    const two = seedSql(s, cols, "S");
    expect(two).toContain(") p0");
    expect(two).toContain(") p1");
    expect(two).toContain("p1.h");
  });
});

describe("schemaErrors", () => {
  it("passes the fixture", () => { expect(schemaErrors(pg, cols)).toEqual([]); });
  it("flags NOT NULL without default, not defaulted created_at", () => {
    const s: Seed = JSON.parse(JSON.stringify(pg)); delete s.tables[0].columns.password_hash; delete s.test_users;
    const e = schemaErrors(s, cols);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatch(/users.*password_hash/);
  });
  it("flags missing table, column, and unsupported auto type", () => {
    const s: Seed = JSON.parse(JSON.stringify(pg));
    s.tables.push({ name: "ghost", ratio: 1, columns: { a: { gen: "auto" } } });
    s.tables[0].columns.nope = { gen: "auto" };
    s.tables[1].columns.name = { gen: "auto" };
    const c = cols.map((x) => (x.table === "projects" && x.column === "name" ? { ...x, type: "USER-DEFINED" } : x));
    const e = schemaErrors(s, c).join("\n");
    expect(e).toContain('"ghost"');
    expect(e).toContain('"nope"');
    expect(e).toContain("USER-DEFINED");
  });
});

describe("seedSql", () => {
  const sql = seedSql(pg, cols, "S");
  it("is deterministic and seed-dependent", () => {
    expect(seedSql(pg, cols, "S")).toBe(sql);
    expect(seedSql({ ...pg, random_seed: 43 }, cols, "S")).not.toBe(sql);
  });
  it("has no nondeterminism", () => { for (const w of ["random(", "setseed(", "now()"]) expect(sql).not.toContain(w); });
  it("sizes, quoting, truncate", () => {
    expect(sql).toContain("generate_series(1, 100)");
    expect(sql).toContain("generate_series(1, 1000)");
    expect(sql).toContain('INSERT INTO "users"');
    expect(sql).toContain("RESTART IDENTITY CASCADE");
  });
  it("pgcrypto only with password_hash; salt format", () => {
    expect(sql).toContain("pgcrypto");
    expect(seedSql(nd, cols, "S")).not.toContain("pgcrypto");
    expect(/crypt\('vb-test-password', '(\$2a\$10\$[0-9a-f]{21}\.)'\)/.test(sql)).toBe(true);
  });
  it("doubles quotes in plain", () => {
    const s: Seed = JSON.parse(JSON.stringify(pg)); (s.tables[0].columns.password_hash as any).plain = "a'b";
    expect(seedSql(s, cols, "S")).toContain("crypt('a''b'");
  });
  it("rowsFor", () => { expect(rowsFor(pg, pg.tables[0], "S")).toBe(100); expect(rowsFor({ ...pg, sizes: { S: 1, M: 1, L: 1 } }, pg.tables[0], "S")).toBe(1); });
});
