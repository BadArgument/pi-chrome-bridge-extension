import { mkdir, readFile, rm, copyFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const distDir = path.join(root, "chrome-extension", "dist");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await Promise.all([
  build({
    entryPoints: [path.join(root, "chrome-extension", "src", "sw", "index.ts")],
    outfile: path.join(distDir, "sw.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    sourcemap: false,
  }),
  build({
    entryPoints: [path.join(root, "chrome-extension", "src", "content", "executor.ts")],
    outfile: path.join(distDir, "content.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    sourcemap: false,
  }),
  build({
    entryPoints: [path.join(root, "chrome-extension", "src", "options", "index.ts")],
    outfile: path.join(distDir, "options.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    sourcemap: false,
  }),
]);

await copyFile(path.join(root, "chrome-extension", "manifest.json"), path.join(distDir, "manifest.json"));
await copyFile(path.join(root, "chrome-extension", "src", "options", "index.html"), path.join(distDir, "options.html"));

const manifest = JSON.parse(await readFile(path.join(distDir, "manifest.json"), "utf8"));
if (manifest.background?.service_worker !== "sw.js") {
  throw new Error("manifest.json background.service_worker must point to sw.js");
}
