/**
 * The contract every extension host implements so the engine can run unchanged
 * on top of it. VS Code backs this with its workspace/configuration/secret APIs;
 * the Visual Studio target backs it with a Node sidecar fed by the C# VSIX.
 *
 * Everything here is intentionally small and synchronous where it can be — the
 * engine treats a `HostServices` as ambient capability, not as a service to be
 * mocked per call.
 */

export interface Disposable {
  dispose(): void;
}

export interface HostServices {
  /**
   * A setting value under the `npmManager` namespace (e.g. `"autoInstall"`),
   * falling back to `def` when the host has no opinion.
   */
  getConfig<T>(key: string, def: T): T;

  /** Fires whenever any `npmManager` setting changes. */
  onConfigChange(cb: () => void): Disposable;

  /** Absolute paths of the roots the manager is scoped to (workspace folders, a solution, or a single project). */
  getWorkspaceRoots(): string[];

  /**
   * All files matching a glob (relative, POSIX separators) beneath the workspace
   * roots, as absolute paths. `exclude` is an optional glob to prune.
   */
  findFiles(glob: string, exclude?: string): Promise<string[]>;

  /** Watch a glob beneath the roots; `cb` is invoked (debounced by the host) on any create/change/delete. */
  watchFiles(glob: string, cb: () => void): Disposable;

  getSecret(key: string): Promise<string | undefined>;
  setSecret(key: string, value: string): Promise<void>;

  /** Ask the user for a secret (token/password); `undefined` if they dismiss it. */
  promptForSecret(opts: { title: string; prompt: string }): Promise<string | undefined>;

  openExternal(url: string): Promise<void>;

  /** Append a line to the host's output/log surface. */
  log(line: string): void;
}
