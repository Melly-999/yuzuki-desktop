import test from "node:test";
import assert from "node:assert/strict";

import {
  ROUTING_MODES,
  buildRoutingRequest,
  describeRoutingProvenance,
  routingFailureMessage,
  selectableRoutingOptions,
} from "./routingUi.mjs";

test("the routing control exposes exactly the seven canonical modes with PRIVATE first", () => {
  assert.deepEqual(ROUTING_MODES.map((mode) => mode.value), [
    "PRIVATE", "SAVER", "FAST", "SMART", "DEEP", "CREATIVE", "ADVANCED",
  ]);
  assert.match(ROUTING_MODES[0].description, /Local only/);
  assert.match(ROUTING_MODES[0].description, /No cloud fallback/);
});

test("normal modes forward only routingMode while ADVANCED requires one selected registry id", () => {
  assert.deepEqual(buildRoutingRequest("SMART", "must-not-cross"), { routingMode: "SMART" });
  assert.deepEqual(buildRoutingRequest("ADVANCED", "approved-model"), {
    routingMode: "ADVANCED", requestedModelId: "approved-model",
  });
  assert.throws(() => buildRoutingRequest("ADVANCED", ""), /MODEL_NOT_SELECTED/);
});

test("only Hermes-marked selectable models can enter the ADVANCED selector", () => {
  const models = [
    { id: "ready", selectable: true },
    { id: "disabled", selectable: false },
    { id: "ambiguous" },
  ];
  assert.deepEqual(selectableRoutingOptions(models).map((model) => model.id), ["ready"]);
});

test("safe provenance distinguishes ordinary fallback from fail-closed contract violations", () => {
  assert.equal(describeRoutingProvenance({
    requested_mode: "SMART", fallback_occurred: true, fallback_reason: "provider unavailable",
  }).kind, "fallback");
  for (const requested_mode of ["PRIVATE", "ADVANCED"]) {
    const result = describeRoutingProvenance({ requested_mode, fallback_occurred: true });
    assert.equal(result.kind, "violation");
    assert.match(result.text, /contract violation/);
  }
});

test("routing failures use bounded user-facing messages", () => {
  for (const status of [
    "ROUTING_NOT_CONFIGURED", "PROVIDER_NOT_CONFIGURED", "PROVIDER_DISABLED",
    "PROVIDER_UNAVAILABLE", "MODEL_NOT_FOUND", "MODEL_DISALLOWED", "MODEL_INCAPABLE",
    "LOCAL_ROUTE_UNAVAILABLE", "REGISTRY_UNAVAILABLE",
  ]) {
    assert.doesNotMatch(routingFailureMessage(status), /key|token|credential path|env/i);
  }
});
