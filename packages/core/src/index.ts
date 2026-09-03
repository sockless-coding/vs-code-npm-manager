/**
 * `@npm-manager/core` — the host-agnostic engine. An extension host implements
 * {@link HostServices}, calls {@link createEngine}, and pipes the resulting
 * {@link Engine} to a webview running `@npm-manager/webview-ui`.
 */

export type { HostServices, Disposable } from "./host";
export type { Engine } from "./engine";
export { createEngine } from "./engine";
export { Emitter, debounce, mapWithConcurrency } from "./util";

// Lower-level building blocks, exposed for hosts that need to pre-compute a scope
// (e.g. the Visual Studio sidecar deciding project vs. solution roots).
export { detectPackageManager } from "./node/cli";
export type { PackageManagerName } from "./node/cli";
export { parsePackageJson } from "./projects/packageJson";
export type { ParsedPackageJson } from "./projects/packageJson";
