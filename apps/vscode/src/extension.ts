import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { createEngine, type Engine } from "@npm-manager/core";
import { VsCodeHost } from "./VsCodeHost";
import { NpmPanel } from "./NpmPanel";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("npm Package Manager");
  context.subscriptions.push(output);

  const host = new VsCodeHost(context, output);
  const engine = createEngine(host);
  context.subscriptions.push({ dispose: () => engine.dispose() });
  await engine.ready();

  engine.events.event((evt) => NpmPanel.instance?.sendEvent(evt));

  context.subscriptions.push(
    vscode.commands.registerCommand("npmManager.openManager", async (uri?: vscode.Uri) => {
      const alreadyOpen = !!NpmPanel.instance;
      const scope = applyScope(engine, uri);
      NpmPanel.createOrShow(context, (req) => engine.handle(req));
      if (alreadyOpen) {
        NpmPanel.instance?.sendEvent({ type: "event", event: "scopeChanged", preselectProjectPaths: scope });
      }
    }),
    vscode.commands.registerCommand("npmManager.refresh", () => engine.refresh())
  );
}

export function deactivate(): void {
  /* nothing to clean up beyond context.subscriptions */
}

/**
 * Translate the file/folder the manager was opened from into a selection scope
 * and (for a folder with no package.json) an offer to create one.
 */
function applyScope(engine: Engine, uri: vscode.Uri | undefined): string[] {
  engine.setInitializableDirs([]);
  if (!uri) {
    engine.setOpenScope([]);
    return [];
  }

  let isDir = false;
  try {
    isDir = fs.statSync(uri.fsPath).isDirectory();
  } catch {
    /* fall through as a file path */
  }

  if (isDir) {
    const pkg = path.join(uri.fsPath, "package.json");
    if (fs.existsSync(pkg)) {
      const scope = engine.resolveSelectionScope(pkg);
      engine.setOpenScope(scope);
      return scope;
    }
    engine.setInitializableDirs([{ dir: uri.fsPath, name: path.basename(uri.fsPath) }]);
    engine.setOpenScope([]);
    return [];
  }

  const scope = engine.resolveSelectionScope(uri.fsPath);
  engine.setOpenScope(scope);
  return scope;
}
