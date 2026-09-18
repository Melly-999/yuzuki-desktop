import test from "node:test";
import assert from "node:assert/strict";

import {
  INITIAL_SESSION_SEARCH_STATE,
  normalizeSessionSearchQuery,
  reduceSessionSearchState,
} from "./sessionSearch.mjs";

test("search query validation rejects unsafe input and preserves valid FTS syntax", () => {
  for (const query of ["", "x", "bad\u0000query", "x".repeat(201)]) {
    assert.equal(normalizeSessionSearchQuery(query).ok, false);
  }
  assert.deepEqual(normalizeSessionSearchQuery('  zażółć OR "gęślą"  '), {
    ok: true,
    query: 'zażółć OR "gęślą"',
  });
});

test("search state transitions cover loading, results, empty, invalid, unavailable, and error", () => {
  const searching = reduceSessionSearchState(INITIAL_SESSION_SEARCH_STATE, { type: "start" });
  assert.equal(searching.kind, "searching");
  assert.equal(reduceSessionSearchState(searching, { type: "success", results: [{ sessionId: "s1" }] }).kind, "results");
  assert.equal(reduceSessionSearchState(searching, { type: "success", results: [] }).kind, "empty");
  assert.equal(reduceSessionSearchState(searching, { type: "invalid", message: "bad" }).kind, "invalid_query");
  assert.equal(reduceSessionSearchState(searching, { type: "unavailable", message: "down" }).kind, "hermes_unavailable");
  assert.equal(reduceSessionSearchState(searching, { type: "error", message: "failed" }).kind, "error");
});
