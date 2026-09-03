/**
 * `HostServices` backed by the VS Code extension API.
 */

import * as vscode from "vscode";
import type { Disposable, HostServices } from "@npm-manager/core";

export class VsCodeHost implements HostServices {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  getConfig<T>(key: string, def: T): T {
    return vscode.workspace.getConfiguration("npmManager").get<T>(key, def);
  }

  onConfigChange(cb: () => void): Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("npmManager")) cb();
    });
  }

  getWorkspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }

  async findFiles(glob: string, exclude?: string): Promise<string[]> {
    const uris = await vscode.workspace.findFiles(glob, exclude);
    return uris.map((u) => u.fsPath);
  }

  watchFiles(glob: string, cb: () => void): Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(glob, false, false, false);
    watcher.onDidChange(cb);
    watcher.onDidCreate(cb);
    watcher.onDidDelete(cb);
    return watcher;
  }

  getSecret(key: string): Promise<string | undefined> {
    return Promise.resolve(this.context.secrets.get(key));
  }

  async setSecret(key: string, value: string): Promise<void> {
    if (value) await this.context.secrets.store(key, value);
    else await this.context.secrets.delete(key);
  }

  async promptForSecret(opts: { title: string; prompt: string }): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: opts.title,
      prompt: opts.prompt,
      password: true,
      ignoreFocusOut: true
    });
  }

  async openExternal(url: string): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  log(line: string): void {
    this.output.appendLine(line);
  }
}
