/**
 * `HostServices` for the Visual Studio target. Filesystem work happens here in
 * Node; anything that needs the IDE (secret storage, an input box, opening a
 * browser) is round-tripped to the C# VSIX over the control channel.
 */

import * as fs from "fs";
import * as path from "path";
import type { Disposable, HostServices } from "@npm-manager/core";

export interface HostBridge {
  /** Send a control request to C# and await its result. */
  call(method: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface SidecarConfigureInput {
  roots: string[];
  config: Record<string, unknown>;
}

export class SidecarHost implements HostServices {
  private roots: string[] = [];
  private config: Record<string, unknown> = {};
  private readonly configListeners = new Set<() => void>();
  private readonly watchers = new Set<{ glob: string; cb: () => void }>();

  constructor(private readonly bridge: HostBridge) {}

  /** Apply (or re-apply) the roots/config the C# host pushed. */
  configure(input: SidecarConfigureInput): void {
    this.roots = input.roots.map((r) => path.resolve(r));
    this.config = input.config ?? {};
    for (const l of [...this.configListeners]) l();
    for (const w of [...this.watchers]) w.cb();
  }

  getConfig<T>(key: string, def: T): T {
    return key in this.config ? (this.config[key] as T) : def;
  }

  onConfigChange(cb: () => void): Disposable {
    this.configListeners.add(cb);
    return { dispose: () => this.configListeners.delete(cb) };
  }

  getWorkspaceRoots(): string[] {
    return this.roots;
  }

  async findFiles(glob: string, exclude?: string): Promise<string[]> {
    const match = globToRegExp(glob);
    const skip = exclude ? globToRegExp(exclude) : undefined;
    const out: string[] = [];
    for (const root of this.roots) {
      for (const file of walk(root)) {
        const rel = toPosix(path.relative(root, file));
        if (skip?.test(rel)) continue;
        if (match.test(rel)) out.push(file);
      }
    }
    return [...new Set(out)];
  }

  watchFiles(glob: string, cb: () => void): Disposable {
    const entry = { glob, cb };
    this.watchers.add(entry);
    const fsWatchers = this.roots.map((root) => {
      try {
        return fs.watch(root, { recursive: true }, (_evt, name) => {
          if (!name) return cb();
          const rel = toPosix(String(name));
          if (/(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(rel)) cb();
        });
      } catch {
        return undefined;
      }
    });
    return {
      dispose: () => {
        this.watchers.delete(entry);
        for (const w of fsWatchers) w?.close();
      }
    };
  }

  async getSecret(key: string): Promise<string | undefined> {
    const v = await this.bridge.call("getSecret", { key });
    return typeof v === "string" && v ? v : undefined;
  }

  async setSecret(key: string, value: string): Promise<void> {
    await this.bridge.call("setSecret", { key, value });
  }

  async promptForSecret(opts: { title: string; prompt: string }): Promise<string | undefined> {
    const v = await this.bridge.call("promptForSecret", { ...opts });
    return typeof v === "string" && v ? v : undefined;
  }

  async openExternal(url: string): Promise<void> {
    await this.bridge.call("openExternal", { url });
  }

  log(line: string): void {
    process.stderr.write(line.endsWith("\n") ? line : line + "\n");
  }
}

/* ------------------------------- helpers -------------------------------- */

const IGNORED_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "bin", "obj"]);

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Minimal glob -> RegExp for the handful of patterns the engine uses. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:[^/]+/)*";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      const alts = glob.slice(i + 1, end).split(",");
      re += "(?:" + alts.map(escapeRe).join("|") + ")";
      i = end;
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp("^" + re + "$");
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
