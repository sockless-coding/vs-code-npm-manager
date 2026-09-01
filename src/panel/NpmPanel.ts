/**
 * Owns the singleton webview panel: HTML shell, CSP, and the message pump between
 * the webview and a request handler supplied by the extension.
 */

import * as vscode from "vscode";
import { HostEvent, HostMessage, WebviewMessage, WebviewRequest } from "./messaging";

export type RequestHandler = (req: WebviewRequest) => Promise<unknown>;

export class NpmPanel {
  private static current: NpmPanel | undefined;

  static createOrShow(context: vscode.ExtensionContext, handler: RequestHandler): NpmPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (NpmPanel.current) {
      NpmPanel.current.panel.reveal(column);
      return NpmPanel.current;
    }
    const panel = vscode.window.createWebviewPanel("npmManager.manager", "Sockless npm Package Manager", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist"), vscode.Uri.joinPath(context.extensionUri, "media")]
    });
    NpmPanel.current = new NpmPanel(panel, context, handler);
    return NpmPanel.current;
  }

  static get instance(): NpmPanel | undefined {
    return NpmPanel.current;
  }

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    handler: RequestHandler
  ) {
    this.panel.webview.html = this.render(context.extensionUri);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (msg: WebviewMessage) => {
        try {
          const payload = await handler(msg);
          this.post({ type: "response", id: msg.id, ok: true, payload: payload as any });
        } catch (err: any) {
          this.post({ type: "response", id: msg.id, ok: false, error: err?.message ?? String(err) });
        }
      },
      null,
      this.disposables
    );
  }

  post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  sendEvent(event: HostEvent): void {
    this.post(event);
  }

  reveal(): void {
    this.panel.reveal();
  }

  dispose(): void {
    NpmPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private render(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "main.css"));
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "codicon.css")
    );
    const codiconFontUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "codicon.ttf")
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `connect-src https:`
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <link href="${codiconUri}" rel="stylesheet" />
  <style nonce="${nonce}">
    @font-face {
      font-family: "codicon";
      src: url("${codiconFontUri}") format("truetype");
    }
  </style>
  <title>Sockless npm Package Manager</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
