import { cpSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative } from "node:path";

export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git", "node_modules", ".next", "dist", "build", ".turbo", ".vercel", "coverage", ".vibe-breakpoint",
]);

const SAFE_ENV = new Set([".env.example", ".env.sample", ".env.template"]);

export function isRealEnvFile(name: string): boolean {
  return name === ".npmrc" || (name.startsWith(".env") && !SAFE_ENV.has(name)); // .npmrc can hold registry tokens (D-056)
}

// D-027: keep a symlink only if relative, resolving inside the project, and not to a real env file
function safeLink(p: string, root: string): boolean {
  try {
    if (isAbsolute(readlinkSync(p))) return false;
    const real = realpathSync(p);
    const rel = relative(root, real);
    return !rel.startsWith("..") && !isAbsolute(rel) && !isRealEnvFile(basename(real));
  } catch {
    return false;
  }
}

export function copyProject(src: string, dest: string): void {
  const root = realpathSync(src);
  cpSync(root, dest, {
    recursive: true,
    verbatimSymlinks: true,
    // root is never rejected, so a project folder named "build" still copies (D-020)
    filter: (p) => {
      if (p === root) return true;
      const n = basename(p);
      if (SKIP_DIRS.has(n) || isRealEnvFile(n)) return false;
      return !lstatSync(p).isSymbolicLink() || safeLink(p, root);
    },
  });
}
