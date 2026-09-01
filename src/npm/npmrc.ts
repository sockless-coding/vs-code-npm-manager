/**
 * Pure `.npmrc` parsing and merging. No VS Code or filesystem dependencies so it
 * can be unit tested directly. Filesystem discovery lives in `registries.ts`.
 *
 * Reference: https://docs.npmjs.com/cli/v10/configuring-npm/npmrc
 */

export interface ParsedNpmrc {
  /** Default registry, e.g. from `registry=...`. */
  registry?: string;
  /** scope (without leading `@`) -> registry URL, from `@scope:registry=...`. */
  scopedRegistries: Map<string, string>;
  /** `//host/path:_authToken=...` entries, keyed by the raw `host/path` prefix. */
  authTokens: Map<string, string>;
  /** `//host/path:_auth=...` (pre-encoded base64 `user:pass`). */
  basicAuth: Map<string, string>;
  /** `//host/path:_username=` / `:_password=` (base64 password) pairs. */
  userPass: Map<string, { username?: string; password?: string }>;
}

function empty(): ParsedNpmrc {
  return {
    scopedRegistries: new Map(),
    authTokens: new Map(),
    basicAuth: new Map(),
    userPass: new Map()
  };
}

const SCOPED_REGISTRY_RE = /^@([^:]+):registry$/;
const HOST_AUTH_RE = /^\/\/(.+):(_authToken|_auth|_username|_password|always-auth)$/;

/** Expand `${VAR}` references against `process.env`, as npm does when reading config. */
function expandEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");
}

export function parseNpmrc(text: string): ParsedNpmrc {
  const result = empty();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = expandEnv(line.slice(eq + 1).trim());
    // Strip a single layer of matching quotes, as npm's ini parser does.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) continue;

    if (key === "registry") {
      result.registry = value;
      continue;
    }

    const scoped = SCOPED_REGISTRY_RE.exec(key);
    if (scoped) {
      result.scopedRegistries.set(scoped[1], value);
      continue;
    }

    const hostAuth = HOST_AUTH_RE.exec(key);
    if (hostAuth) {
      const [, hostPath, kind] = hostAuth;
      if (kind === "_authToken") {
        result.authTokens.set(hostPath, value);
      } else if (kind === "_auth") {
        result.basicAuth.set(hostPath, value);
      } else if (kind === "_username") {
        const entry = result.userPass.get(hostPath) ?? {};
        entry.username = value;
        result.userPass.set(hostPath, entry);
      } else if (kind === "_password") {
        const entry = result.userPass.get(hostPath) ?? {};
        entry.password = Buffer.from(value, "base64").toString("utf8");
        result.userPass.set(hostPath, entry);
      }
    }
  }
  return result;
}

/**
 * Merge parsed configs. `configs` must be ordered from lowest to highest priority
 * (global -> user -> workspace root -> ... -> nearest). Nearest wins on key conflicts.
 */
export function mergeNpmrc(configs: ParsedNpmrc[]): ParsedNpmrc {
  const merged = empty();
  for (const cfg of configs) {
    if (cfg.registry) merged.registry = cfg.registry;
    for (const [k, v] of cfg.scopedRegistries) merged.scopedRegistries.set(k, v);
    for (const [k, v] of cfg.authTokens) merged.authTokens.set(k, v);
    for (const [k, v] of cfg.basicAuth) merged.basicAuth.set(k, v);
    for (const [k, v] of cfg.userPass) merged.userPass.set(k, { ...merged.userPass.get(k), ...v });
  }
  return merged;
}

/** Find the auth entry (of whichever kind) whose `host/path` prefix best matches `url`. */
export function findAuthPrefix(map: Map<string, unknown>, url: string): string | undefined {
  let host: string;
  let pathname: string;
  try {
    const u = new URL(url);
    host = u.host;
    pathname = u.pathname.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
  const full = `${host}${pathname}`;
  let best: string | undefined;
  for (const key of map.keys()) {
    const normalized = key.replace(/\/+$/, "");
    if (full === normalized || full.startsWith(normalized + "/") || host === normalized) {
      if (!best || normalized.length > best.replace(/\/+$/, "").length) {
        best = key;
      }
    }
  }
  return best;
}
