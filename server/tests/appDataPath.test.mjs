import assert from "node:assert/strict";
import test from "node:test";
import { resolveYuzukiDataDir, resolveSessionsDbPath } from "../lib/appDataPath.mjs";

test("Windows: uses LOCALAPPDATA when present", () => {
  const dir = resolveYuzukiDataDir({ env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, platform: "win32" });
  assert.equal(dir, "C:\\Users\\test\\AppData\\Local\\Yuzuki");
});

test("Windows: falls back to <home>\\AppData\\Local when LOCALAPPDATA is unset", () => {
  const dir = resolveYuzukiDataDir({
    env: {},
    platform: "win32",
    homedir: () => "C:\\Users\\test",
  });
  assert.equal(dir, "C:\\Users\\test\\AppData\\Local\\Yuzuki");
});

test("never resolves to a roaming-profile (%APPDATA%) path", () => {
  const dir = resolveYuzukiDataDir({
    env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    platform: "win32",
  });
  assert.ok(!dir.includes("Roaming"));
});

test("non-Windows: uses an XDG-style fallback rather than crashing", () => {
  const dir = resolveYuzukiDataDir({ env: {}, platform: "linux", homedir: () => "/home/test" });
  assert.equal(dir, "/home/test/.local/share/yuzuki");
});

test("the resolved db path is a single file inside the data directory", () => {
  const dbPath = resolveSessionsDbPath({ env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, platform: "win32" });
  assert.equal(dbPath, "C:\\Users\\test\\AppData\\Local\\Yuzuki\\sessions.db");
});

test("the resolved path is never derived from process.cwd()", () => {
  const dbPath = resolveSessionsDbPath({ env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, platform: "win32" });
  assert.ok(!dbPath.startsWith(process.cwd()));
});
