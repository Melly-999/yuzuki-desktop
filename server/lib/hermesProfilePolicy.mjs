import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Pre-start safety validation for the Hermes profile Yuzuki is about to
 * hand to `hermes --profile <name> serve`.
 *
 * Every check here is a pure filesystem/text read — nothing spawns a
 * process or opens a socket, mirroring the accepted Hermes runtime's own
 * pre-start-safe primitives (`profile_exists`, a raw `config.yaml` read).
 * Deliberately fails closed: this module never guesses at a schema shape
 * it cannot confirm, and it never trusts a provider by name alone. If a
 * `base_url` cannot be positively resolved to a loopback host, the
 * profile is rejected — even for a provider whose name suggests it is
 * local (e.g. `ollama`), since a name is not proof of where it points.
 */

export const PROFILE_FAILURE = Object.freeze({
  PROFILE_MISSING: "PROFILE_MISSING",
  PROFILE_CONFIG_INVALID: "PROFILE_CONFIG_INVALID",
  PROFILE_MODEL_MISSING: "PROFILE_MODEL_MISSING",
  PROFILE_PROVIDER_UNSAFE: "PROFILE_PROVIDER_UNSAFE",
});

/** Loopback-only. LAN/private-network ranges are intentionally excluded. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Default Hermes profile-data root, mirroring hermes_constants.py's
 * `_get_platform_default_hermes_home()` for the common case. `HERMES_HOME`,
 * when set, overrides it directly — this intentionally does not replicate
 * the Docker `<root>/profiles/<name>` parenting edge case from the Python
 * side, since Yuzuki has never passed `HERMES_HOME` and adding that is out
 * of this task's narrow scope.
 */
export function defaultHermesHome(env = process.env, platform = process.platform) {
  if (env.HERMES_HOME) return env.HERMES_HOME;
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "hermes");
  }
  return path.join(os.homedir(), ".hermes");
}

function profileConfigPath(profile, { env = process.env, platform = process.platform } = {}) {
  return path.join(defaultHermesHome(env, platform), "profiles", profile, "config.yaml");
}

function stripQuotes(value) {
  return value.trim().replace(/^["']|["']$/g, "");
}

function indentOf(line) {
  return line.match(/^(\s*)/)[1].length;
}

/**
 * Extracts the `model:` block's `provider` and `default`/`model` scalar
 * fields. Not a general YAML parser — a narrow, indentation-bounded scan
 * for exactly these keys. Returns `null` when no `model:` key exists at
 * all (config genuinely has nothing to read), or a shape describing what
 * was found, including an explicit `ambiguous` flag for a bare scalar
 * (`model: some-id` with no nested provider block, which carries no
 * provider information at all).
 *
 * Example synthetic config.yaml shape this reads:
 *   model:
 *     default: local-example-model
 *     provider: local-example-provider
 */
function readModelBlock(lines) {
  const modelLineIndex = lines.findIndex((line) => /^model:\s*(.*)$/.test(line));
  if (modelLineIndex === -1) return null;

  const inlineValue = lines[modelLineIndex].match(/^model:\s*(.*)$/)[1].trim();
  if (inlineValue) {
    return { model: stripQuotes(inlineValue), provider: null, ambiguous: true };
  }

  const baseIndent = indentOf(lines[modelLineIndex]);
  const fields = { model: null, provider: null, ambiguous: false };
  for (let i = modelLineIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (indentOf(line) <= baseIndent) break; // left the model: block
    const kv = line.trim().match(/^(default|model|provider):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = stripQuotes(rawValue);
    if (!value) continue;
    if ((key === "default" || key === "model") && !fields.model) fields.model = value;
    if (key === "provider") fields.provider = value;
  }
  return fields;
}

/**
 * Finds a `base_url` for `providerName`: first as a same-name entry in a
 * top-level `custom_providers:` list (`- name: <providerName>` ...
 * `base_url: <url>` within that same list item), then as a direct
 * `base_url:` scalar nested under `model:` itself, in case the profile
 * uses a simpler inline shape. Returns `null` — never a guess — when
 * neither form is found.
 *
 * Example synthetic config.yaml shape this reads:
 *   custom_providers:
 *     - name: local-example-provider
 *       base_url: http://127.0.0.1:11434/v1
 */
function findBaseUrlForProvider(lines, providerName) {
  const listRootIndex = lines.findIndex((line) => /^custom_providers:\s*$/.test(line));
  if (listRootIndex !== -1) {
    const listIndent = indentOf(lines[listRootIndex]);
    let itemIndent = null;
    let inMatchingItem = false;
    let matchingItemBaseUrl = null;
    for (let i = listRootIndex + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      const indent = indentOf(line);
      if (indent <= listIndent) break; // left custom_providers:
      const itemStart = line.match(/^(\s*)-\s*(.*)$/);
      if (itemStart && (itemIndent === null || indent === itemIndent)) {
        itemIndent = indent;
        inMatchingItem = false;
        matchingItemBaseUrl = null;
        const nameMatch = itemStart[2].match(/^name:\s*(.*)$/);
        if (nameMatch && stripQuotes(nameMatch[1]) === providerName) inMatchingItem = true;
        continue;
      }
      if (itemIndent === null) continue;
      const kv = line.trim().match(/^(name|base_url):\s*(.*)$/);
      if (!kv) continue;
      const [, key, rawValue] = kv;
      const value = stripQuotes(rawValue);
      if (key === "name" && value === providerName) inMatchingItem = true;
      if (key === "base_url" && inMatchingItem) matchingItemBaseUrl = value;
      if (inMatchingItem && matchingItemBaseUrl) return matchingItemBaseUrl;
    }
  }

  const modelLineIndex = lines.findIndex((line) => /^model:\s*$/.test(line));
  if (modelLineIndex !== -1) {
    const baseIndent = indentOf(lines[modelLineIndex]);
    for (let i = modelLineIndex + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      if (indentOf(line) <= baseIndent) break;
      const kv = line.trim().match(/^base_url:\s*(.*)$/);
      if (kv) return stripQuotes(kv[1]);
    }
  }

  return null;
}

function isLoopbackUrl(rawUrl) {
  try {
    // WHATWG URL keeps the brackets on an IPv6 hostname (e.g. "[::1]");
    // strip them so `::1` compares equal regardless of bracketing.
    const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return LOCAL_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/**
 * Validates that `profile` exists, has a readable/parseable config, has a
 * model explicitly configured, and resolves to a provider whose base URL
 * is positively confirmed loopback-local. Returns `{ ok: true, model,
 * provider }` or `{ ok: false, failure: PROFILE_FAILURE.* }` — never
 * throws, and never spawns anything.
 */
export function validateHermesProfile(
  profile,
  { env = process.env, platform = process.platform, readFileSync = fs.readFileSync } = {},
) {
  const configPath = profileConfigPath(profile, { env, platform });

  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return { ok: false, failure: PROFILE_FAILURE.PROFILE_MISSING };
  }
  if (typeof text !== "string") {
    return { ok: false, failure: PROFILE_FAILURE.PROFILE_MISSING };
  }

  const lines = text.split(/\r?\n/);
  let modelBlock;
  try {
    modelBlock = readModelBlock(lines);
  } catch {
    return { ok: false, failure: PROFILE_FAILURE.PROFILE_CONFIG_INVALID };
  }
  if (!modelBlock) {
    return { ok: false, failure: PROFILE_FAILURE.PROFILE_CONFIG_INVALID };
  }
  if (!modelBlock.model) {
    return { ok: false, failure: PROFILE_FAILURE.PROFILE_MODEL_MISSING };
  }
  if (modelBlock.ambiguous || !modelBlock.provider) {
    return { ok: false, failure: PROFILE_FAILURE.PROFILE_PROVIDER_UNSAFE };
  }

  const baseUrl = findBaseUrlForProvider(lines, modelBlock.provider);
  if (!baseUrl || !isLoopbackUrl(baseUrl)) {
    return { ok: false, failure: PROFILE_FAILURE.PROFILE_PROVIDER_UNSAFE };
  }

  return { ok: true, model: modelBlock.model, provider: modelBlock.provider };
}
