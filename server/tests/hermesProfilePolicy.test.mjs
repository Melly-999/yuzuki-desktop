import test from "node:test";
import assert from "node:assert/strict";

import { validateHermesProfile, PROFILE_FAILURE } from "../lib/hermesProfilePolicy.mjs";
import { resolveHermesRuntime, DEFAULT_PROFILE } from "../lib/hermesRuntime.mjs";
import { CAPABILITIES, LOCAL_RUNTIME_TRUTH } from "../lib/productTruth.mjs";

/**
 * Focused tests for the public-safe Hermes profile contract
 * (YUZUKI-V11-PUBLIC-PROFILE-CONTRACT-IMPLEMENTATION-001): pre-start
 * profile/provider validation, and the absence of any private identifier
 * from the surfaces this task touched.
 */

const LOCAL_CONFIG = [
  "model:",
  "  default: example-model",
  "  provider: example-local-provider",
  "custom_providers:",
  "  - name: example-local-provider",
  "    base_url: http://127.0.0.1:11434/v1",
].join("\n");

const CLOUD_CONFIG = [
  "model:",
  "  default: example-model",
  "  provider: example-cloud-provider",
  "custom_providers:",
  "  - name: example-cloud-provider",
  "    base_url: https://api.example-cloud.test/v1",
].join("\n");

const AMBIGUOUS_CONFIG_NO_BASE_URL = ["model:", "  default: example-model", "  provider: example-provider"].join(
  "\n",
);

const AMBIGUOUS_CONFIG_BARE_SCALAR = "model: example-model\n";

const NO_MODEL_CONFIG = [
  "model:",
  "  provider: example-local-provider",
  "custom_providers:",
  "  - name: example-local-provider",
  "    base_url: http://127.0.0.1:11434/v1",
].join("\n");

function readFileSyncFor(text) {
  return () => text;
}

test("missing profile: no config file -> PROFILE_MISSING, fails closed", () => {
  const result = validateHermesProfile("yuzuki-local", {
    readFileSync: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure, PROFILE_FAILURE.PROFILE_MISSING);
});

test("malformed config: no model: key at all -> PROFILE_CONFIG_INVALID", () => {
  const result = validateHermesProfile("yuzuki-local", {
    readFileSync: readFileSyncFor("custom_providers:\n  - name: x\n    base_url: http://127.0.0.1:1\n"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure, PROFILE_FAILURE.PROFILE_CONFIG_INVALID);
});

test("missing model: model: block present but no default/model value -> PROFILE_MODEL_MISSING", () => {
  const result = validateHermesProfile("yuzuki-local", { readFileSync: readFileSyncFor(NO_MODEL_CONFIG) });
  assert.equal(result.ok, false);
  assert.equal(result.failure, PROFILE_FAILURE.PROFILE_MODEL_MISSING);
});

test("allowed local provider (loopback base_url) -> accepted", () => {
  const result = validateHermesProfile("yuzuki-local", { readFileSync: readFileSyncFor(LOCAL_CONFIG) });
  assert.equal(result.ok, true);
  assert.equal(result.model, "example-model");
  assert.equal(result.provider, "example-local-provider");
});

test("cloud provider (https, non-loopback base_url) -> PROFILE_PROVIDER_UNSAFE, never accepted", () => {
  const result = validateHermesProfile("yuzuki-local", { readFileSync: readFileSyncFor(CLOUD_CONFIG) });
  assert.equal(result.ok, false);
  assert.equal(result.failure, PROFILE_FAILURE.PROFILE_PROVIDER_UNSAFE);
});

test("ambiguous provider: named provider but no discoverable base_url -> fails closed, not assumed local", () => {
  const result = validateHermesProfile("yuzuki-local", {
    readFileSync: readFileSyncFor(AMBIGUOUS_CONFIG_NO_BASE_URL),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure, PROFILE_FAILURE.PROFILE_PROVIDER_UNSAFE);
});

test("ambiguous provider: bare `model: <id>` scalar carries no provider info -> fails closed", () => {
  const result = validateHermesProfile("yuzuki-local", {
    readFileSync: readFileSyncFor(AMBIGUOUS_CONFIG_BARE_SCALAR),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure, PROFILE_FAILURE.PROFILE_PROVIDER_UNSAFE);
});

test("loopback endpoints accepted: 127.0.0.1, localhost, ::1 — LAN ranges are not treated as local", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    const config = [
      "model:",
      "  default: example-model",
      "  provider: p",
      "custom_providers:",
      "  - name: p",
      `    base_url: http://${host}:11434/v1`,
    ].join("\n");
    const result = validateHermesProfile("yuzuki-local", { readFileSync: readFileSyncFor(config) });
    assert.equal(result.ok, true, `expected ${host} to be accepted as loopback`);
  }

  const lanConfig = [
    "model:",
    "  default: example-model",
    "  provider: p",
    "custom_providers:",
    "  - name: p",
    "    base_url: http://192.168.1.50:11434/v1",
  ].join("\n");
  const lanResult = validateHermesProfile("yuzuki-local", { readFileSync: readFileSyncFor(lanConfig) });
  assert.equal(lanResult.ok, false, "a LAN address must not be treated as automatically local-safe");
  assert.equal(lanResult.failure, PROFILE_FAILURE.PROFILE_PROVIDER_UNSAFE);
});

test("validation never enumerates or discovers profiles: it only ever reads the one path for the exact profile it was given", () => {
  const requestedPaths = [];
  validateHermesProfile("yuzuki-local", {
    readFileSync: (p) => {
      requestedPaths.push(p);
      return LOCAL_CONFIG;
    },
  });
  assert.equal(requestedPaths.length, 1, "must read exactly one path, never scan a directory of profiles");
  assert.ok(requestedPaths[0].includes("yuzuki-local"), "must read the requested profile's own config, nothing else");
});

test("HERMES_PROFILE env override still takes precedence over the compiled fallback", () => {
  const resolved = resolveHermesRuntime({
    env: { HERMES_AGENT_ROOT: "/agent", HERMES_PROFILE: "an-explicitly-chosen-profile" },
    platform: "linux",
    exists: () => true,
    validateProfile: (profile) => {
      assert.equal(profile, "an-explicitly-chosen-profile");
      return { ok: true, model: "m", provider: "p" };
    },
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.profile, "an-explicitly-chosen-profile");
});

test("unset HERMES_PROFILE resolves to the generic compiled fallback, never a private name", () => {
  const resolved = resolveHermesRuntime({
    env: { HERMES_AGENT_ROOT: "/agent" },
    platform: "linux",
    exists: () => true,
    validateProfile: () => ({ ok: true, model: "m", provider: "p" }),
  });
  assert.equal(resolved.profile, "yuzuki-local");
  assert.equal(DEFAULT_PROFILE, "yuzuki-local");
});

test("Hermes serve is never spawned when profile validation fails: no command/args are produced", () => {
  const resolved = resolveHermesRuntime({
    env: { HERMES_AGENT_ROOT: "/agent" },
    platform: "linux",
    exists: () => true,
    validateProfile: () => ({ ok: false, failure: PROFILE_FAILURE.PROFILE_PROVIDER_UNSAFE }),
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.failure, PROFILE_FAILURE.PROFILE_PROVIDER_UNSAFE);
  assert.equal(resolved.command, undefined);
  assert.equal(resolved.args, undefined);
  // Never leaks a filesystem path or the profile's own name in the reason
  // a route is allowed to surface to a client.
  assert.ok(!/[\\/]/.test(resolved.reason), "reason must not contain a filesystem path");
});

test("a validation failure never falls back to a different profile or providers -- it just fails", () => {
  const resolved = resolveHermesRuntime({
    env: { HERMES_AGENT_ROOT: "/agent" },
    platform: "linux",
    exists: () => true,
    validateProfile: (profile) => {
      assert.equal(profile, "yuzuki-local");
      return { ok: false, failure: PROFILE_FAILURE.PROFILE_MISSING };
    },
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.profile, "yuzuki-local", "must report the profile it actually tried, not a substitute");
});

test("productTruth exposes no private profile identifier or private deployment path", () => {
  const serialized = JSON.stringify({ CAPABILITIES, LOCAL_RUNTIME_TRUTH });
  assert.ok(!/private-profile-fixture/i.test(serialized), "must not contain a sensitive profile identifier");
  assert.ok(!/AppData[\\/]Local[\\/]hermes/i.test(serialized), "must not contain a private deployment path");
  assert.equal(LOCAL_RUNTIME_TRUTH.profile_configured, true);
  assert.equal(LOCAL_RUNTIME_TRUTH.profile, undefined, "the private-identifier field must be gone, not just renamed");
});
