import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfigFromFile } from "vite";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LOOPBACK_HOST = "127.0.0.1";
const WILDCARD_HOST_PATTERN = /(?:^|\s)--host(?:=|\s+)(?:0\.0\.0\.0|::|\[::\])(?:\s|$)/;

test("public development and preview defaults resolve to loopback only", async () => {
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "development", isPreview: false },
    path.join(REPOSITORY_ROOT, "vite.config.ts"),
    REPOSITORY_ROOT,
    "silent",
    undefined,
    "runner",
  );

  assert.ok(loaded, "the public Vite configuration must load");
  assert.equal(loaded.config.server?.host, LOOPBACK_HOST);
  assert.equal(loaded.config.preview?.host, LOOPBACK_HOST);

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"),
  );
  for (const scriptName of ["dev", "preview"]) {
    const command = packageJson.scripts?.[scriptName];
    assert.equal(typeof command, "string", `${scriptName} script must exist`);
    assert.doesNotMatch(command, WILDCARD_HOST_PATTERN, `${scriptName} must not override Vite with a wildcard host`);
  }
});
