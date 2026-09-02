# Sockless npm Package Manager — Visual Studio

The Visual Studio 2026 build of the npm package manager. Same panel and engine as
the VS Code extension; it just runs inside a Visual Studio tool window.

## How it is put together

```
apps/visualstudio/
  src/            classic-VSSDK VSIX (C#, .NET Framework, in-process package)
  sidecar/        Node entry point that runs the shared @npm-manager/core engine
  webview/        build output — the standalone @npm-manager/webview-ui bundle
```

The C# VSIX does **no** package-manager work of its own. It:

1. resolves the right-clicked Solution Explorer node to a set of root directories
   (`ProjectModelCollector`),
2. hosts a `WebView2` running `webview/index.html` (the shared React UI),
3. launches `sidecar/sidecar.js` with `node` and relays messages between the
   WebView2 and the sidecar over newline-delimited JSON on stdio,
4. answers the sidecar's IDE requests — open a URL, read/write a registry token,
   show a credential prompt — and pushes the options-page values as config.

Everything else (registry discovery, `.npmrc` parsing, search, `npm audit` chain
resolution, lockfile graphs, install/update/uninstall) is the exact same
TypeScript engine the VS Code extension uses.

## Open-scope behaviour

| Entry point | Roots handed to the engine | Result |
|---|---|---|
| Right-click a **project** | that project's directory | manager limited to that project |
| Right-click the **solution** | every project directory in the solution | packages aggregated across the solution, like a VS Code multi-root workspace |
| Right-click a **project with no `package.json`** | that project's directory | panel offers **Create package.json**, then behaves as a single project |

## Prerequisites

- **Visual Studio 2026** with the **Visual Studio extension development** workload.
- **Node.js** on `PATH` (the sidecar process; the engine also shells out to
  `npm`/`yarn`/`pnpm` as it does under VS Code).
- The NuGet package versions in
  [`src/SocklessNpm.VisualStudio.csproj`](src/SocklessNpm.VisualStudio.csproj)
  track "current Visual Studio". Against a VS 2026 (v18) install you may need to
  bump `Microsoft.VisualStudio.SDK` / `Microsoft.VSSDK.BuildTools` to the 18.x
  packages it ships, and widen the version range in
  [`src/source.extension.vsixmanifest`](src/source.extension.vsixmanifest).

## Build & run

The C# project is the **classic (non-SDK) VSIX project format** on purpose — the
VSIX packaging pipeline (`Microsoft.VsSDK.targets`) is only imported for a project
whose `<ProjectTypeGuids>` include the VSIX GUID. A `Microsoft.NET.Sdk`
("SDK-style") project compiles the assembly but never produces a `.vsix`, and
**`dotnet build` cannot build VSIX projects at all** — you must use full MSBuild
from a Visual Studio install.

```sh
# 1. from the repo root — build the shared webview + sidecar bundles
npm install
npm run build:vs        # -> apps/visualstudio/webview/ and src/Sidecar/sidecar.js

# 2a. one-shot: build the VSIX (locates MSBuild via vswhere, also runs step 1)
npm run package:vs
#     -> apps/visualstudio/src/bin/Release/SocklessNpm.VisualStudio.vsix

# 2b. or from a "Developer Command Prompt for VS 2026":
msbuild apps\visualstudio\src\SocklessNpm.VisualStudio.csproj -restore ^
        -t:Rebuild -p:Configuration=Release -p:DeployExtension=false

# 2c. or open apps/visualstudio/SocklessNpm.VisualStudio.sln in Visual Studio 2026
#     and press F5 -> deploys to the experimental instance and starts debugging
```

`npm run build:vs` must run before every VSIX build so `webview/` and
`Sidecar/sidecar.js` are current — they are `.gitignore`d build output.

If you compiled and only got `bin\Debug\...\SocklessNpm.VisualStudio.dll` with no
`.vsix`, you built with `dotnet build` or against an SDK-style project — use one
of the MSBuild paths above instead.

## Adding another Visual Studio target later

The VS-specific code is confined to `apps/visualstudio/src`. The sidecar
(`apps/visualstudio/sidecar`) and everything under `packages/` is host-agnostic,
so a second model (for example the out-of-process `VisualStudio.Extensibility`
SDK) would be a new sibling project that reuses the same sidecar and webview.
