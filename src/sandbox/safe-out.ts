import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/** Write `<project>/.vibe-breakpoint/<rel>` without ever following a symlink (product rule 1). Throws on any symlink in the path. */
export function safeWriteOut(project: string, rel: string, data: string | Buffer): void {
  const root = realpathSync(project);
  const base = join(root, ".vibe-breakpoint");
  const parts = rel.split("/");
  const file = parts.pop()!;
  let cur = root;
  for (const p of [".vibe-breakpoint", ...parts]) {
    cur = join(cur, p);
    let st = lstatSync(cur, { throwIfNoEntry: false });
    if (!st) { mkdirSync(cur); st = lstatSync(cur); }
    if (st.isSymbolicLink()) throw new Error(`refusing to write output: ${cur.slice(root.length + 1)} is a symlink`);
    if (!st.isDirectory()) throw new Error(`refusing to write output: ${cur.slice(root.length + 1)} is not a directory`);
  }
  const real = realpathSync(cur);
  if (real !== base && !real.startsWith(base + sep)) throw new Error("refusing to write output: path leaves .vibe-breakpoint");
  const dest = join(cur, file);
  if (lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`refusing to write output: ${join(...parts, file)} is a symlink`);
  const tmp = join(dirname(dest), `.${file}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, data, { flag: "wx" });
    renameSync(tmp, dest); // rename replaces a link at dest rather than following it
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}
