/**
 * Registry discovery and authentication.
 *
 * Sources, in increasing priority:
 *   1. global npm config (`%APPDATA%\npm\etc\npmrc`, `/usr/local/etc/npmrc`, `/etc/npmrc`)
 *   2. user-level `~/.npmrc`
 *   3. every `.npmrc` found walking up from each workspace folder
 *   4. `npmManager.additionalRegistries` from VS Code settings
 *
 * When a registry needs auth we use, in order: a token/password from `.npmrc`, a
 * token previously saved in VS Code SecretStorage, or an interactive prompt
 * (stored for next time).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HostServices } from "../host";
import { ParsedNpmrc, findAuthPrefix, mergeNpmrc, parseNpmrc } from "./npmrc";
import { hostOf } from "./httpClient";

export interface Registry {
  name: string;
  url: string;
  enabled: boolean;
  scope?: string;
  hasAuth: boolean;
}

const SECRET_PREFIX = "npmManager.registryToken:";
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

export class RegistryRegistry {
  private registries: Registry[] = [];
  private merged: ParsedNpmrc = { scopedRegistries: new Map(), authTokens: new Map(), basicAuth: new Map(), userPass: new Map() };

  constructor(private readonly host: HostServices) {}

  getRegistries(): Registry[] {
    return this.registries;
  }

  getEnabledRegistries(): Registry[] {
    return this.registries.filter((r) => r.enabled);
  }

  findByName(name: string): Registry | undefined {
    return this.registries.find((r) => r.name === name);
  }

  /** The registry to use for a (possibly scoped) package name. */
  registryForPackage(packageId: string): Registry | undefined {
    const scope = packageId.startsWith("@") ? packageId.split("/")[0].slice(1) : undefined;
    if (scope) {
      const scoped = this.registries.find((r) => r.scope === scope && r.enabled);
      if (scoped) return scoped;
    }
    return this.registries.find((r) => !r.scope && r.enabled) ?? this.registries[0];
  }

  refresh(): void {
    const configs = collectConfigFiles(this.host.getWorkspaceRoots()).map((file) => safeParse(file));
    this.merged = mergeNpmrc(configs);

    const registries: Registry[] = [];
    const defaultUrl = normalize(this.merged.registry || DEFAULT_REGISTRY);
    registries.push({ name: hostOf(defaultUrl), url: defaultUrl, enabled: true, hasAuth: hasAuthFor(this.merged, defaultUrl) });

    for (const [scope, url] of this.merged.scopedRegistries) {
      const norm = normalize(url);
      registries.push({
        name: `@${scope}`,
        url: norm,
        enabled: true,
        scope,
        hasAuth: hasAuthFor(this.merged, norm)
      });
    }

    const additional = this.host.getConfig<{ name: string; url: string }[]>("additionalRegistries", []);
    for (const a of additional) {
      if (!a?.url) continue;
      const norm = normalize(a.url);
      if (registries.some((r) => r.url === norm)) continue;
      registries.push({ name: a.name || hostOf(norm), url: norm, enabled: true, hasAuth: hasAuthFor(this.merged, norm) });
    }

    this.registries = registries;
  }

  /** Returns an `Authorization` header value for a request URL, or undefined. */
  async getAuthHeader(requestUrl: string): Promise<string | undefined> {
    const tokenKey = findAuthPrefix(this.merged.authTokens, requestUrl);
    if (tokenKey) {
      return `Bearer ${this.merged.authTokens.get(tokenKey)}`;
    }
    const authKey = findAuthPrefix(this.merged.basicAuth, requestUrl);
    if (authKey) {
      return `Basic ${this.merged.basicAuth.get(authKey)}`;
    }
    const userPassKey = findAuthPrefix(this.merged.userPass, requestUrl);
    if (userPassKey) {
      const { username, password } = this.merged.userPass.get(userPassKey)!;
      if (username && password) {
        return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
      }
    }

    const registry = this.registries.find((r) => hostOf(r.url) === hostOf(requestUrl));
    if (!registry) return undefined;
    const saved = await this.host.getSecret(SECRET_PREFIX + registry.name);
    return saved ? `Bearer ${saved}` : undefined;
  }

  /** Prompt for a token and persist it for the registry. Returns true if saved. */
  async promptForCredentials(registryName: string): Promise<boolean> {
    const registry = this.findByName(registryName);
    if (!registry) return false;

    const token = await this.host.promptForSecret({
      title: `Credentials for ${registry.name}`,
      prompt: `Enter an access token for ${hostOf(registry.url)}`
    });
    if (!token) return false;
    await this.host.setSecret(SECRET_PREFIX + registry.name, token);
    return true;
  }

  async clearCredentials(registryName: string): Promise<void> {
    await this.host.setSecret(SECRET_PREFIX + registryName, "");
  }
}

function hasAuthFor(merged: ParsedNpmrc, url: string): boolean {
  return (
    !!findAuthPrefix(merged.authTokens, url) ||
    !!findAuthPrefix(merged.basicAuth, url) ||
    !!findAuthPrefix(merged.userPass, url)
  );
}

function normalize(url: string): string {
  const trimmed = url.trim();
  return trimmed.endsWith("/") ? trimmed : trimmed + "/";
}

function safeParse(file: string): ParsedNpmrc {
  try {
    return parseNpmrc(fs.readFileSync(file, "utf8"));
  } catch {
    return { scopedRegistries: new Map(), authTokens: new Map(), basicAuth: new Map(), userPass: new Map() };
  }
}

/** Ordered lowest -> highest priority. */
function collectConfigFiles(roots: string[]): string[] {
  const files: string[] = [];
  const home = os.homedir();

  const globalCandidates =
    process.platform === "win32"
      ? [path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm", "etc", "npmrc")]
      : ["/etc/npmrc", "/usr/local/etc/npmrc"];
  for (const c of globalCandidates) {
    if (fileExists(c)) files.push(c);
  }

  const userConfig = path.join(home, ".npmrc");
  if (fileExists(userConfig)) files.push(userConfig);

  for (const root of roots) {
    const chain: string[] = [];
    let dir = root;
    let prev = "";
    while (dir && dir !== prev) {
      const p = path.join(dir, ".npmrc");
      if (fileExists(p)) chain.push(p);
      prev = dir;
      dir = path.dirname(dir);
    }
    // chain is nearest-first; reverse so nearest ends up last (highest priority).
    files.push(...chain.reverse());
  }

  return dedupe(files);
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    const key = process.platform === "win32" ? i.toLowerCase() : i;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(i);
    }
  }
  return out;
}
