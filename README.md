# Sockless npm Package Manager

A visual npm package manager for VS Code — browse, install, update and
consolidate your `package.json` dependencies with a Visual Studio–like
experience, instead of hand-editing JSON and shelling out to the CLI.

This is the npm/Node.js sibling of [Sockless NuGet Package
Manager](https://github.com/sockless-coding/vs-code-nuget-manager), built to
the same look and feel.

## Features

- **Browse** — search the npm registry (and any private/scoped registries
  configured in your `.npmrc`) with live results, package details, readme,
  license, downloads and dependency lists.
- **Installed** — every package actually referenced by a `package.json` in
  your workspace, direct and transitive, with a tree view showing *why* a
  transitive package is present.
- **Updates** — installed packages with a newer version available, with a
  one-click **Update All**.
- **Consolidate** — packages pinned to inconsistent versions across multiple
  `package.json` files in an npm/Yarn/pnpm workspace.
- **Install as** dependencies, devDependencies, peerDependencies or
  optionalDependencies, per package, per project.
- **Choose how a version is written** — `^` caret (default), `~` tilde,
  an exact version, or `>=` — via a "Save as" selector shown whenever you
  install or update a package. An **Update** defaults to whatever selector
  the package is already using, so bumping a version doesn't silently
  change its range style.
- **Pin / Unpin** a dependency to an exact version (held back from *Update
  All* until you unpin it) — vulnerability checks still apply either way.
- **Vulnerability scanning** via `npm audit`, surfaced right on the package
  row and in the detail pane, with a link to each advisory.
- **Supply-chain guardrail** — freshly published versions younger than a
  configurable minimum age are flagged and held back from the default
  version choice and from *Update All*.
- Works with **npm, Yarn (classic) and pnpm** — the package manager is
  detected per project from its lockfile, with a format-preserving edit to
  `package.json` as a fallback when no CLI is available.
- Understands **npm/Yarn/pnpm workspaces**: opening the manager from a
  workspace root package.json scopes install/update actions to every member
  package.

## Getting started

Open a folder containing a `package.json`, then either:

- Run **npm: Manage npm Packages...** from the Command Palette, or
- Click the package icon in the editor title bar while a `package.json` is
  open, or
- Right-click a `package.json` in the Explorer and choose **Manage npm
  Packages...**.

## Requirements

- VS Code 1.90 or newer.
- Node.js, and ideally npm, Yarn or pnpm on your `PATH`, so installs run
  through the real package manager and keep your lockfile in sync. Without
  one, the extension falls back to editing `package.json` directly and lets
  you know an install is needed to finish.

## Settings

| Setting | Default | Description |
|---|---|---|
| `npmManager.defaultIncludePrerelease` | `false` | Include prerelease (`-beta`, `-rc`, …) versions in search results by default. |
| `npmManager.additionalRegistries` | `[]` | Additional npm registries to query, merged with any registries discovered from `.npmrc`. |
| `npmManager.packageManagerPath` | `""` | Path to the npm/yarn/pnpm executable to use. Leave empty to auto-detect from lockfiles and use the one on `PATH`. |
| `npmManager.autoInstall` | `true` | Run an install automatically after adding, updating or removing packages, so the lockfile and `node_modules` stay in sync. |
| `npmManager.minimumPackageAgeDays` | `7` | Minimum age in days before a newly published version is trusted. Newer versions are flagged and held back from *Update All* and the default version selection. `0` disables the check. |
| `npmManager.usePackageManagerForEnumeration` | `false` | Reconcile the Installed view with `npm outdated --json` after the fast on-disk scan. Slower on large repos; npm-managed projects only. |

## How it works

- **Registries** are discovered from your `.npmrc` hierarchy (global, user,
  and every `.npmrc` found walking up from each workspace folder), including
  scoped registries (`@scope:registry=`) and auth tokens, plus anything added
  via `npmManager.additionalRegistries`.
- **Search and package details** come straight from the registry's search
  API and package document (`GET /<package>`), so version history, publish
  dates, dependencies and the readme come back in a single request.
- **The Installed view** is built from disk first — each `package.json`'s
  four dependency sections, plus the workspace's lockfile (or a
  `node_modules` scan when there's no lockfile yet) for resolved versions and
  the transitive graph — so it paints immediately. Update checks against the
  registry and `npm audit` run in the background afterwards and stream in.
- **Mutations** (install/update/uninstall) run through the detected package
  manager's CLI when available; pin/unpin and any unsupported combination
  (e.g. installing a peer dependency with Yarn classic) fall back to a
  format-preserving edit of `package.json` that keeps your indentation and
  line endings intact.

## Known limitations

- Yarn (classic) and pnpm are supported for install/update/uninstall and for
  enumerating installed packages, but `npm audit` reconciliation and the
  `npmManager.usePackageManagerForEnumeration` option are npm-only.
- Yarn classic has no CLI flag for adding a `peerDependency` or
  `optionalDependency` directly — those fall back to editing `package.json`.
- Only the `^` caret (each CLI's own default) and exact (`--save-exact`)
  selectors map onto a real CLI flag; choosing `~` tilde or `>=` always
  writes `package.json` directly, then runs an install to catch the
  lockfile up.
- Per-version download counts and package icons aren't part of the npm
  registry API, so they aren't shown (monthly download totals are, for
  packages on the public npmjs registry).

## License

MIT
