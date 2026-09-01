import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

function copyCodicons() {
  const dir = require.resolve("@vscode/codicons/package.json").replace(/package\.json$/, "dist/");
  mkdirSync("media", { recursive: true });
  copyFileSync(dir + "codicon.css", "media/codicon.css");
  copyFileSync(dir + "codicon.ttf", "media/codicon.ttf");
}

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info"
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ["src/webview/main.tsx"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: "dist/webview.js",
  sourcemap: !production,
  minify: production,
  loader: { ".ttf": "file" },
  define: { "process.env.NODE_ENV": production ? '"production"' : '"development"' },
  logLevel: "info"
};

async function run() {
  // Start from a clean dist so stale files (e.g. dev source maps) never ship.
  rmSync("dist", { recursive: true, force: true });
  copyCodicons();
  if (watch) {
    const ctxA = await esbuild.context(extensionConfig);
    const ctxB = await esbuild.context(webviewConfig);
    await Promise.all([ctxA.watch(), ctxB.watch()]);
    console.log("esbuild: watching...");
  } else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
    console.log("esbuild: build complete");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
