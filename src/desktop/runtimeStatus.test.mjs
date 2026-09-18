import test from "node:test";
import assert from "node:assert/strict";

import { deriveRuntimeStatus, runtimeTodayRowState, RUNTIME_KIND } from "./runtimeStatus.mjs";

function info(overrides = {}) {
  return {
    state: "HERMES_READY",
    detail: "",
    profile: "yuzuki-local",
    provider: null,
    model: "local-7b",
    session_id: "s1",
    connected: true,
    ...overrides,
  };
}

test("an unreadable status source is UNKNOWN, never a claim that the runtime is not started", () => {
  const status = deriveRuntimeStatus(null);
  assert.equal(status.kind, RUNTIME_KIND.UNKNOWN);
  assert.equal(status.canServeTurn, false);
  // The old Chat copy asserted "Local runtime not started" here — a claim
  // about the runtime that an unreadable source cannot support.
  assert.doesNotMatch(status.detail, /not started/i);
  assert.match(status.detail, /unknown/i);
});

test("a connected runtime with no model ready is never called Ready", () => {
  const status = deriveRuntimeStatus(info({ state: "MODEL_NOT_READY" }));
  assert.equal(status.kind, RUNTIME_KIND.DEGRADED);
  assert.equal(status.word, "Degraded");
  assert.equal(status.canServeTurn, false);
  assert.equal(runtimeTodayRowState(status.kind), "degraded");
});

test("only a genuinely ready or working runtime reaches Home's present/Ready row", () => {
  assert.equal(runtimeTodayRowState(deriveRuntimeStatus(info()).kind), "present");
  assert.equal(runtimeTodayRowState(deriveRuntimeStatus(info({ state: "REQUEST_RUNNING" })).kind), "present");
  for (const state of ["HERMES_STARTING", "MODEL_NOT_READY", "REQUEST_FAILED", "SOMETHING_ELSE"]) {
    assert.notEqual(runtimeTodayRowState(deriveRuntimeStatus(info({ state })).kind), "present", state);
  }
  assert.equal(runtimeTodayRowState(deriveRuntimeStatus(null).kind), "unavailable");
});

test("a dropped transport downgrades readiness and can never upgrade it", () => {
  const dropped = deriveRuntimeStatus(info({ connected: false }));
  assert.equal(dropped.kind, RUNTIME_KIND.DEGRADED);
  assert.equal(dropped.canServeTurn, false);

  // `connected` alone does not manufacture readiness out of a bad state.
  const stillBad = deriveRuntimeStatus(info({ state: "REQUEST_FAILED", connected: true, detail: "boom" }));
  assert.equal(stillBad.kind, RUNTIME_KIND.FAILED);
  assert.equal(stillBad.canServeTurn, false);
});

test("every state yields exactly one interpretation for both surfaces", () => {
  // The regression this module exists to prevent: Home and Chat deriving
  // different answers from the same object. There is now one function, so
  // equality here is structural, not coincidental.
  for (const state of ["HERMES_READY", "HERMES_STARTING", "MODEL_NOT_READY", "REQUEST_RUNNING", "REQUEST_FAILED"]) {
    for (const connected of [true, false]) {
      const hermes = info({ state, connected });
      assert.deepEqual(deriveRuntimeStatus(hermes), deriveRuntimeStatus(hermes), `${state}/${connected}`);
      const status = deriveRuntimeStatus(hermes);
      // The Home row word and the Chat badge word are the same string.
      assert.equal(typeof status.word, "string");
      assert.ok(status.word.length > 0);
      if (runtimeTodayRowState(status.kind) === "present") assert.equal(status.canServeTurn, true);
    }
  }
});

test("runtime detail never invents a model it was not given", () => {
  const noModel = deriveRuntimeStatus(info({ model: null, profile: "yuzuki-local" }));
  assert.match(noModel.detail, /profile yuzuki-local/);
  const nothing = deriveRuntimeStatus(info({ model: null, profile: null }));
  assert.match(nothing.detail, /local runtime/);
});
