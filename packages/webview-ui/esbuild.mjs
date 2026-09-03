/**
 * Standalone build of the webview UI, used by hosts that embed a prebuilt copy
 * (the Visual Studio VSIX). The VS Code extension bundles the same entry point
 * from source through its own esbuild config instead.
 *
 * Output: dist/{webview.js, main.css, codicon.css, codicon.ttf, index.html}
 */

import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const OUT = "dist";

function copyStaticAssets() {
  mkdirSync(OUT, { recursive: true });
  const codicons = require.resolve("@vscode/codicons/package.json").replace(/package\.json$/, "dist/");
  copyFileSync(codicons + "codicon.css", `${OUT}/codicon.css`);
  copyFileSync(codicons + "codicon.ttf", `${OUT}/codicon.ttf`);
  copyFileSync(require.resolve("@npm-manager/assets/main.css"), `${OUT}/main.css`);
  copyFileSync(require.resolve("@npm-manager/assets/icon.png"), `${OUT}/icon.png`);
  writeFileSync(`${OUT}/index.html`, INDEX_HTML);
}

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="main.css" rel="stylesheet" />
  <link href="codicon.css" rel="stylesheet" />
  <title>npm Package Manager</title>
</head>
<body>
  <div id="root"></div>
  <script src="webview.js"></script>
</body>
</html>
`;

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: ["src/main.tsx"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: `${OUT}/webview.js`,
  sourcemap: !production,
  minify: production,
  loader: { ".ttf": "file" },
  define: { "process.env.NODE_ENV": production ? '"production"' : '"development"' },
  logLevel: "info"
};

async function run() {
  rmSync(OUT, { recursive: true, force: true });
  copyStaticAssets();
  if (watch) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    console.log("esbuild: watching webview-ui...");
  } else {
    await esbuild.build(config);
    console.log("esbuild: webview-ui build complete");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
