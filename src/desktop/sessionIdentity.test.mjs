import test from "node:test";
import assert from "node:assert/strict";

import { resolveActiveSession } from "./sessionIdentity.mjs";

function resumed(overrides = {}) {
  return { sessionId: "hermes-1", title: "Resumed conversation", ...overrides };
}

test("no session open reports no identity rather than an empty-string one", () => {
  assert.deepEqual(resolveActiveSession(), { sessionId: null, title: null });
  assert.deepEqual(resolveActiveSession({ resumed: null, selected: null }), { sessionId: null, title: null });
});

test("a legacy local row cannot become the active send identity", () => {
  assert.deepEqual(
    resolveActiveSession({ selected: { session_id: "local-1", title: "Legacy row" } }),
    { sessionId: null, title: null },
  );
});

test("a resumed Hermes conversation is a real identity even though no local row is selected", () => {
  // Search -> result -> resume adopts Hermes's id even though no Yuzuki
  // durable-session row exists for it.
  const active = resolveActiveSession({ resumed: resumed(), selected: null });
  assert.deepEqual(active, { sessionId: "hermes-1", title: "Resumed conversation" });
  assert.notEqual(active.sessionId, null, "a resumed conversation must never read as 'no session'");
});

test("the resumed Hermes conversation remains canonical even if a stale local value is supplied", () => {
  assert.deepEqual(resolveActiveSession({ resumed: resumed(), selected: { session_id: "local-1" } }), {
    sessionId: "hermes-1",
    title: "Resumed conversation",
  });
});

test("the id and the title always come from the Hermes source", () => {
  const active = resolveActiveSession({ resumed: resumed({ title: null }) });
  assert.equal(active.sessionId, "hermes-1");
  assert.equal(active.title, null, "a titleless resumed session must not borrow the local row's title");
});

test("a resumed record naming no session cannot fall through to a legacy row", () => {
  assert.deepEqual(resolveActiveSession({ resumed: { sessionId: "", title: "x" }, selected: { session_id: "local-1" } }), {
    sessionId: null,
    title: null,
  });
});
