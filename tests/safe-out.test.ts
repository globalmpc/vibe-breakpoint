import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { safeWriteOut } from "../src/sandbox/safe-out.js";

const proj = () => { const p = mkdtempSync(join(tmpdir(), "vb-safe-")); mkdirSync(join(p, ".vibe-breakpoint")); return p; };

describe("safeWriteOut (AC1, AC2)", () => {
  it("writes normally, nested", () => {
    const p = proj();
    safeWriteOut(p, "out/result.json", "a"); safeWriteOut(p, "out/k6/10.json", "b"); safeWriteOut(p, "out/result.json", "c");
    expect(readFileSync(join(p, ".vibe-breakpoint/out/result.json"), "utf8")).toBe("c");
    expect(readFileSync(join(p, ".vibe-breakpoint/out/k6/10.json"), "utf8")).toBe("b");
  });
  it("rejects a symlinked result.json and leaves the target alone", () => {
    const p = proj(); mkdirSync(join(p, ".vibe-breakpoint/out")); writeFileSync(join(p, "target"), "keep");
    symlinkSync(join(p, "target"), join(p, ".vibe-breakpoint/out/result.json"));
    expect(() => safeWriteOut(p, "out/result.json", "x")).toThrow(/symlink/);
    expect(readFileSync(join(p, "target"), "utf8")).toBe("keep");
  });
  it("rejects a symlinked out dir and a symlinked out/k6 dir", () => {
    const p = proj(); const other = mkdtempSync(join(tmpdir(), "vb-other-"));
    symlinkSync(other, join(p, ".vibe-breakpoint/out"));
    expect(() => safeWriteOut(p, "out/result.json", "x")).toThrow(/symlink/);
    const q = proj(); mkdirSync(join(q, ".vibe-breakpoint/out")); symlinkSync(other, join(q, ".vibe-breakpoint/out/k6"));
    expect(() => safeWriteOut(q, "out/k6/1.json", "x")).toThrow(/symlink/);
  });
  it("rejects a symlinked .vibe-breakpoint", () => {
    const p = mkdtempSync(join(tmpdir(), "vb-safe-")); symlinkSync(mkdtempSync(join(tmpdir(), "vb-other-")), join(p, ".vibe-breakpoint"));
    expect(() => safeWriteOut(p, "out/result.json", "x")).toThrow(/symlink/);
  });
});
