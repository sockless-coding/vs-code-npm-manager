/**
 * Copy the freshly built standalone webview bundle into the Visual Studio
 * extension's `webview/` folder, which the VSIX embeds and WebView2 serves.
 * Also drops the sidecar bundle next to the C# project.
 */

import { cpSync, mkdirSync, rmSync, existsSync, copyFileSync } from "fs";
import { fileURLToPath } from "url";
import * as path from "path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const webviewDist = path.join(root, "packages", "webview-ui", "dist");
const webviewOut = path.join(root, "apps", "visualstudio", "webview");
const sidecarBundle = path.join(root, "apps", "visualstudio", "sidecar", "dist", "sidecar.js");
const sidecarOut = path.join(root, "apps", "visualstudio", "src", "Sidecar");

if (!existsSync(webviewDist)) {
  console.error(`Missing ${webviewDist}. Run "npm run build --workspace @npm-manager/webview-ui" first.`);
  process.exit(1);
}

rmSync(webviewOut, { recursive: true, force: true });
mkdirSync(webviewOut, { recursive: true });
cpSync(webviewDist, webviewOut, { recursive: true });
console.log(`staged webview -> ${path.relative(root, webviewOut)}`);

if (existsSync(sidecarBundle)) {
  mkdirSync(sidecarOut, { recursive: true });
  copyFileSync(sidecarBundle, path.join(sidecarOut, "sidecar.js"));
  console.log(`staged sidecar -> ${path.relative(root, path.join(sidecarOut, "sidecar.js"))}`);
}
