import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

const node = {
  entryPoints: ["src/cli/index.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
  // Node builtins only; nothing to mark external.
  logLevel: "info",
};

const web = {
  entryPoints: ["src/web/app.ts"],
  outfile: "dist/web/app.js",
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "iife",
  logLevel: "info",
};

async function copyStatic() {
  await mkdir("dist/web", { recursive: true });
  await cp("src/web/index.html", "dist/web/index.html");
  await cp("src/web/styles.css", "dist/web/styles.css");
}

await rm("dist", { recursive: true, force: true });
await copyStatic();

if (watch) {
  const [a, b] = await Promise.all([context(node), context(web)]);
  await Promise.all([a.watch(), b.watch()]);
  console.log("watching…");
} else {
  await Promise.all([build(node), build(web)]);
  // chmod the bin so `interchange` is executable when linked
  const { chmod } = await import("node:fs/promises");
  await chmod("dist/cli.js", 0o755);
}
