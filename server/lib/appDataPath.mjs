import os from "node:os";
import path from "node:path";

/**
 * Resolves the local, per-machine application-data directory for Yuzuki's
 * durable store. Pure function of its inputs (env/platform are parameters,
 * not read from globals internally) so tests can exercise every branch
 * without touching the real environment.
 *
 * Windows: `%LOCALAPPDATA%\Yuzuki`, falling back to
 * `<home>\AppData\Local\Yuzuki` if `LOCALAPPDATA` is unset (never roaming
 * `%APPDATA%` — see docs/product/YUZUKI_DESKTOP_DURABLE_SESSIONS_P0_CONTRACT.md
 * §13). Non-Windows (test runners, contributor machines): an XDG-style
 * fallback — this repository's evidence and tooling are Windows-first, but
 * the store must not crash outright on a different platform.
 *
 * Never derived from `process.cwd()` and never a path inside this repo.
 */
export function resolveYuzukiDataDir({ env = process.env, platform = process.platform, homedir = os.homedir } = {}) {
  // Select the path implementation by the *logical* platform parameter,
  // not the host OS actually running this code — otherwise this function
  // is not independently testable for the non-Windows branch on a Windows
  // test runner (node:path's default export is bound to the real host).
  const p = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    const base = env.LOCALAPPDATA && env.LOCALAPPDATA.length > 0 ? env.LOCALAPPDATA : p.join(homedir(), "AppData", "Local");
    return p.join(base, "Yuzuki");
  }
  const base = env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0 ? env.XDG_DATA_HOME : p.join(homedir(), ".local", "share");
  return p.join(base, "yuzuki");
}

/** The single durable SQLite file's resolved absolute path. */
export function resolveSessionsDbPath(options = {}) {
  const p = options.platform === "win32" || (options.platform === undefined && process.platform === "win32") ? path.win32 : path.posix;
  return p.join(resolveYuzukiDataDir(options), "sessions.db");
}
