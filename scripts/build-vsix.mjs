/**
 * Build the Visual Studio VSIX.
 *
 *   node scripts/build-vsix.mjs [Debug|Release]
 *
 * VSIX packaging only runs under full MSBuild from a Visual Studio install
 * (`dotnet build` cannot produce a .vsix). This locates MSBuild via vswhere,
 * restores, and builds. Run `npm run build:vs` first so the webview + sidecar
 * bundles are staged.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import * as path from "path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuration = process.argv[2] || "Release";
const project = path.join(root, "apps", "visualstudio", "src", "SocklessNpm.VisualStudio.csproj");

const vswhere = path.join(
  process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
  "Microsoft Visual Studio",
  "Installer",
  "vswhere.exe"
);

function findMsBuild() {
  if (existsSync(vswhere)) {
    try {
      const out = execFileSync(vswhere, [
        "-latest", "-prerelease",
        "-requires", "Microsoft.Component.MSBuild",
        "-find", "MSBuild\\**\\Bin\\MSBuild.exe"
      ], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
      if (out && existsSync(out)) return out;
    } catch {
      /* fall through */
    }
  }
  return "msbuild"; // hope it is on PATH (Developer Command Prompt)
}

const msbuild = findMsBuild();
console.log(`> ${msbuild}`);
const args = [project, "-restore", "-t:Rebuild", `-p:Configuration=${configuration}`, "-p:DeployExtension=false", "-v:m", "-nologo"];
execFileSync(msbuild, args, { stdio: "inherit" });

const vsix = path.join(root, "apps", "visualstudio", "src", "bin", configuration, "vs-npm-manager.vsix");
console.log(existsSync(vsix) ? `\nVSIX: ${vsix}` : "\nBuild finished but no .vsix was produced — check the log above.");
