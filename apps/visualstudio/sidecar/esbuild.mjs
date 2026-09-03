import * as esbuild from "esbuild";
import { rmSync } from "fs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/sidecar.js",
  sourcemap: !production,
  minify: production,
  logLevel: "info"
};

async function run() {
  rmSync("dist", { recursive: true, force: true });
  if (watch) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    console.log("esbuild: watching vs-sidecar...");
  } else {
    await esbuild.build(config);
    console.log("esbuild: vs-sidecar build complete");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
