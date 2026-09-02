/**
 * End-to-end smoke test for the Visual Studio sidecar: spawn the built bundle,
 * run the C#-side handshake by hand against the repo's sample-workspace, and
 * assert the engine returns a populated initial state.
 *
 *   node apps/visualstudio/sidecar/test/smoke.mjs
 */

import { spawn } from "child_process";
import { once } from "events";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import * as path from "path";
import * as assert from "assert";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, "..", "dist", "sidecar.js");
const sampleWorkspace = path.resolve(here, "..", "..", "..", "..", "sample-workspace");

const child = spawn(process.execPath, [bundle], { stdio: ["pipe", "pipe", "inherit"] });
const rl = createInterface({ input: child.stdout });

const inbox = [];
const waiters = [];
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  const waiter = waiters.find((w) => w.match(msg));
  if (waiter) {
    waiters.splice(waiters.indexOf(waiter), 1);
    waiter.resolve(msg);
  } else {
    inbox.push(msg);
  }
});

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function waitFor(match, timeoutMs = 15000) {
  const hit = inbox.find(match);
  if (hit) {
    inbox.splice(inbox.indexOf(hit), 1);
    return Promise.resolve(hit);
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting for a sidecar message")), timeoutMs);
    waiters.push({ match, resolve: (m) => (clearTimeout(t), resolve(m)) });
  });
}

try {
  send({ t: "configure", roots: [sampleWorkspace], config: {} });
  await waitFor((m) => m.t === "ready");

  send({ t: "web", data: { kind: "ready", id: 1 } });
  const res = await waitFor((m) => m.t === "web" && m.data?.type === "response" && m.data.id === 1);

  assert.ok(res.data.ok, "ready request should succeed");
  const state = res.data.payload.initialState;
  assert.ok(state, "initialState present");
  assert.ok(Array.isArray(state.projects) && state.projects.length > 0, "discovered at least one project");
  assert.ok(Array.isArray(state.registries) && state.registries.length > 0, "has at least one registry");

  console.log(`OK — ${state.projects.length} project(s), ${state.registries.length} registr(y/ies) discovered`);
  child.stdin.end();
  await once(child, "exit");
  process.exit(0);
} catch (err) {
  console.error("SMOKE FAILED:", err.message);
  child.kill();
  process.exit(1);
}
