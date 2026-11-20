import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync("README.md", "utf8");

describe("README (spec §12)", () => {
  it("starts with the chart image and the file exists", () => {
    const img = readme.match(/!\[[^\]]*\]\(([^)]+)\)/);
    expect(img).not.toBeNull();
    expect(readme.indexOf(img![0])).toBeLessThan(readme.indexOf("## "));
    expect(existsSync(img![1])).toBe(true);
  });
  it.each(["## Install", "## What it measures", "## What it never touches", "## Requirements", "## How the breaking point is defined", "## Server profiles", "## Limits", "## Cleanup", "## License", "vibe-preflight", "vibe-bill"])("has %s", (s) => {
    expect(readme).toContain(s);
  });
  it("install commands (D-057)", () => {
    expect(readme).toContain("npx skills add globalmpc/vibe-breakpoint");
    expect(readme).not.toMatch(/marketplace|install\.sh/);
  });
  it("ships a licence file", () => expect(existsSync("LICENSE")).toBe(true));
});
