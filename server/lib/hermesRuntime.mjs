import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { validateHermesProfile, PROFILE_FAILURE } from "./hermesProfilePolicy.mjs";

/**
 * Resolves WHICH local Hermes runtime the bridge starts, and with which
 * profile. Kept separate from hermesBridge.mjs so the bridge itself has
 * no filesystem or platform knowledge and stays trivially testable.
 *
 * Nothing here reads or returns a credential. The gateway session token
 * is minted inside the bridge at start time; this module only produces a
 * command line and a working directory.
 */

/**
 * Public-safe compiled fallback used when `HERMES_PROFILE` is unset. A
 * generic, non-personal name so this constant is safe to publish: local
 * model, manual approvals, cron denied, no cloud fallback, and no
 * memory/skill tooling exposed remain the required properties of whatever
 * profile is actually selected — enforced by `validateHermesProfile`
 * below, not by this name. `HERMES_PROFILE` always takes precedence, so
 * an existing deployment that already sets it explicitly is unaffected by
 * this constant changing.
 */
export const DEFAULT_PROFILE = "yuzuki-local";

/**
 * Default install root of the Hermes Agent source. Derived from the
 * platform's own app-data location rather than hardcoded to one machine's
 * user directory, and overridable with HERMES_AGENT_ROOT for anyone whose
 * install lives elsewhere.
 */
export function defaultAgentRoot(env = process.env, platform = process.platform) {
  if (env.HERMES_AGENT_ROOT) return env.HERMES_AGENT_ROOT;
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "hermes", "hermes-agent");
  }
  return path.join(os.homedir(), ".local", "share", "hermes", "hermes-agent");
}

/**
 * The interpreter that can import `hermes_cli`. Hermes installs its own
 * venv beside the source; using the venv's Python directly (rather than a
 * `hermes` shim on PATH) means the bridge runs the exact runtime the
 * safety review was performed against.
 */
export function resolvePython(agentRoot, platform = process.platform, exists = fs.existsSync) {
  const candidate =
    platform === "win32"
      ? path.join(agentRoot, "venv", "Scripts", "python.exe")
      : path.join(agentRoot, "venv", "bin", "python");
  return exists(candidate) ? candidate : null;
}

/**
 * Build the spawn descriptor for a dedicated, profile-scoped, loopback
 * Hermes backend.
 *
 * `--isolated` is load-bearing and NOT cosmetic: without it, `serve`
 * routes to the shared machine dashboard with the profile merely
 * "preselected" (observed directly — it prints exactly that). This sprint
 * requires a runtime genuinely scoped to the fiancée profile, so it must
 * get its own per-profile server.
 *
 * `--host 127.0.0.1` keeps the runtime on loopback, and `--port 0` lets
 * the OS pick a free port that the bridge learns from the child's
 * `HERMES_BACKEND_READY port=<n>` stdout announcement.
 */
/**
 * Reason text for each structured pre-start failure. Deliberately generic:
 * never a filesystem path, never the profile name itself — this is the
 * text `server/routes/hermesChat.mjs` may surface to a client, and this
 * task's contract forbids leaking either through that surface.
 */
function profileFailureReason(failure) {
  switch (failure) {
    case PROFILE_FAILURE.PROFILE_MISSING:
      return "The selected Hermes profile does not exist yet. Run setup to create it.";
    case PROFILE_FAILURE.PROFILE_CONFIG_INVALID:
      return "The selected Hermes profile's configuration could not be read.";
    case PROFILE_FAILURE.PROFILE_MODEL_MISSING:
      return "The selected Hermes profile has no model configured yet. Run setup to configure it.";
    case PROFILE_FAILURE.PROFILE_PROVIDER_UNSAFE:
      return "The selected Hermes profile is not configured for local-only use.";
    default:
      return "The selected Hermes profile could not be validated.";
  }
}

export function resolveHermesRuntime({
  env = process.env,
  platform = process.platform,
  exists = fs.existsSync,
  validateProfile = validateHermesProfile,
} = {}) {
  const agentRoot = defaultAgentRoot(env, platform);
  const profile = env.HERMES_PROFILE || DEFAULT_PROFILE;

  if (!exists(agentRoot)) {
    return { ok: false, reason: `The local Hermes runtime was not found at ${agentRoot}.`, profile };
  }
  const python = resolvePython(agentRoot, platform, exists);
  if (!python) {
    return {
      ok: false,
      reason: `The local Hermes runtime at ${agentRoot} has no usable virtual environment.`,
      profile,
    };
  }

  // Pre-start safety gate (this task): never spawn `serve` for a profile
  // that doesn't exist, can't be read, has no model configured, or can't
  // be positively confirmed local-only. PRIVATE never substitutes another
  // profile or provider on failure — it simply does not start.
  const validation = validateProfile(profile, { env, platform });
  if (!validation.ok) {
    return {
      ok: false,
      failure: validation.failure,
      reason: profileFailureReason(validation.failure),
      profile,
    };
  }

  return {
    ok: true,
    profile,
    cwd: agentRoot,
    command: python,
    args: [
      "-m",
      "hermes_cli.main",
      "--profile",
      profile,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--isolated",
    ],
  };
}
