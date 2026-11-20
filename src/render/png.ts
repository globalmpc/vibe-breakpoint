import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

let ready: Promise<void> | undefined;

/** SVG -> PNG with the bundled wasm and font (D-042, D-043). initWasm may run only once per process. */
export async function svgToPng(svg: string, assetsDir: string): Promise<Uint8Array> {
  ready ??= initWasm(readFileSync(join(assetsDir, "resvg.wasm")));
  try { await ready; } catch (e) { ready = undefined; throw e; }
  const fontBuffers = ["Regular", "Bold"].map((w) => new Uint8Array(readFileSync(join(assetsDir, `LiberationMono-${w}.ttf`))));
  return new Resvg(svg, { font: { fontBuffers, defaultFontFamily: "Liberation Mono", loadSystemFonts: false }, fitTo: { mode: "original" } }).render().asPng();
}
