/**
 * Visual Studio sidecar entry point.
 *
 * Speaks newline-delimited JSON on stdio with the C# VSIX:
 *
 *   C# -> sidecar
 *     { t: "configure", roots: string[], config: object }
 *     { t: "scope", openScope?: string[], initializableDirs?: {dir,name}[] }
 *     { t: "web", data: <WebviewMessage> }            // a message from WebView2
 *     { t: "callResult", id: number, value: unknown } // answer to a "call"
 *
 *   sidecar -> C#
 *     { t: "ready" }                                   // sent EXACTLY ONCE
 *     { t: "web", data: <HostMessage> }               // forward to WebView2
 *     { t: "call", id: number, method: string, payload: object }  // ask the IDE
 *
 * `ready` is emitted only for the first `configure`. A later `configure` (roots
 * changed because the manager was reopened from a different project/solution)
 * re-runs discovery silently — echoing `ready` there would make the C# side
 * re-send `configure` and spin forever.
 *
 * stderr is the engine log; stdout is protocol only.
 */

import * as readline from "readline";
import { createEngine, type Engine } from "@npm-manager/core";
import type { WebviewMessage } from "@npm-manager/shared";
import { SidecarHost, type HostBridge } from "./SidecarHost";

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let nextCallId = 1;
const pendingCalls = new Map<number, (value: unknown) => void>();

const bridge: HostBridge = {
  call(method, payload) {
    const id = nextCallId++;
    return new Promise((resolve) => {
      pendingCalls.set(id, resolve);
      send({ t: "call", id, method, payload });
    });
  }
};

const host = new SidecarHost(bridge);
let engine: Engine | undefined;

function ensureEngine(): Engine {
  if (!engine) {
    engine = createEngine(host);
    engine.events.event((evt) => send({ t: "web", data: evt }));
  }
  return engine;
}

async function handleLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  switch (msg.t) {
    case "configure": {
      const firstTime = !engine;
      host.configure({ roots: msg.roots ?? [], config: msg.config ?? {} });
      const e = ensureEngine();
      if (firstTime) {
        await e.ready();
        send({ t: "ready" });
      } else {
        // Roots and/or settings changed — re-discover, but do NOT echo `ready`.
        await e.refresh();
      }
      return;
    }

    case "scope": {
      const e = ensureEngine();
      if (Array.isArray(msg.openScope)) e.setOpenScope(msg.openScope);
      if (Array.isArray(msg.initializableDirs)) e.setInitializableDirs(msg.initializableDirs);
      return;
    }

    case "web": {
      const e = ensureEngine();
      const request = msg.data as WebviewMessage;
      try {
        const payload = await e.handle(request);
        send({ t: "web", data: { type: "response", id: request.id, ok: true, payload } });
      } catch (err: any) {
        send({
          t: "web",
          data: { type: "response", id: request.id, ok: false, error: err?.message ?? String(err) }
        });
      }
      return;
    }

    case "callResult": {
      const resolve = pendingCalls.get(msg.id);
      if (resolve) {
        pendingCalls.delete(msg.id);
        resolve(msg.value);
      }
      return;
    }
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => void handleLine(line));
rl.on("close", () => {
  engine?.dispose();
  process.exit(0);
});
