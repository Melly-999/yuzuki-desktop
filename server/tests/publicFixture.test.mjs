import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { createHermesChatRoutes } from "../routes/hermesChat.mjs";
import {
  publicFixtureEnabled,
  fixtureSessions,
  fixtureSearch,
  fixtureStatus,
  fixtureRoutingOptions,
} from "../lib/publicFixture.mjs";

/**
 * Public fixture mode (YUZUKI-V11-PUBLIC-PRIVACY-DOCS-AND-SYNTHETIC-ASSETS-001).
 *
 * The property that matters is isolation: when the mode is on, no runtime
 * is resolved, spawned, or queried, so a screenshot capture cannot reach
 * real SessionDB state. These tests assert that by failing loudly if any
 * runtime seam is touched at all.
 */

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers || {});
    },
    write(chunk) {
      this.body = (this.body || "") + chunk;
    },
    end(chunk) {
      if (chunk) this.body = (this.body || "") + chunk;
    },
  };
}

function fakeReq(body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.headers = {};
  req.method = body === undefined ? "GET" : "POST";
  return req;
}

/** Any use of these is a contract violation in fixture mode. */
function forbiddenSeams() {
  return {
    resolveRuntime: () => {
      throw new Error("fixture mode must never resolve a runtime");
    },
    spawnImpl: () => {
      throw new Error("fixture mode must never spawn a process");
    },
    bridgeFactory: () => {
      throw new Error("fixture mode must never construct a bridge");
    },
  };
}

function fixtureRoutes() {
  return createHermesChatRoutes({ env: { YUZUKI_PUBLIC_FIXTURE: "1" }, ...forbiddenSeams() });
}

function parsed(res) {
  return JSON.parse(res.body);
}

test("fixture mode is off unless the env var is exactly \"1\"", () => {
  assert.equal(publicFixtureEnabled({}), false);
  assert.equal(publicFixtureEnabled({ YUZUKI_PUBLIC_FIXTURE: "0" }), false);
  assert.equal(publicFixtureEnabled({ YUZUKI_PUBLIC_FIXTURE: "true" }), false);
  assert.equal(publicFixtureEnabled({ YUZUKI_PUBLIC_FIXTURE: "1" }), true);
});

test("status is served from the fixture without resolving or spawning a runtime", async () => {
  const routes = fixtureRoutes();
  const res = fakeRes();
  await routes.handleStatus(fakeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parsed(res).hermes, fixtureStatus());
});

test("sessions are served from the fixture without touching a session database", async () => {
  const routes = fixtureRoutes();
  const res = fakeRes();
  await routes.handleSessions(fakeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parsed(res).sessions, fixtureSessions());
});

test("search is served from the fixture and still enforces the real input contract", async () => {
  const routes = fixtureRoutes();

  const ok = fakeRes();
  await routes.handleSearch(fakeReq({ query: "project" }), ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(parsed(ok).results, fixtureSearch("project").results);

  const rejected = fakeRes();
  await routes.handleSearch(fakeReq({ query: "x" }), rejected);
  assert.equal(rejected.statusCode, 400, "validation still applies in fixture mode");
});

test("routing options are served from the fixture without a live registry", async () => {
  const routes = fixtureRoutes();
  const res = fakeRes();
  await routes.handleRoutingOptions(fakeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(parsed(res), fixtureRoutingOptions());
});

test("fixture output is deterministic: repeated calls are byte-identical", () => {
  assert.equal(JSON.stringify(fixtureSessions()), JSON.stringify(fixtureSessions()));
  assert.equal(JSON.stringify(fixtureStatus()), JSON.stringify(fixtureStatus()));
  assert.equal(JSON.stringify(fixtureSearch("plan")), JSON.stringify(fixtureSearch("plan")));
});

test("fixture content carries no private identifier, real path, or credential-shaped value", () => {
  const serialized = JSON.stringify({
    status: fixtureStatus(),
    sessions: fixtureSessions(),
    search: fixtureSearch(""),
    routing: fixtureRoutingOptions(),
  });
  assert.ok(!/private-profile-fixture/i.test(serialized));
  assert.ok(!/C:\\|\/home\/|AppData/i.test(serialized));
  assert.ok(!/sk-[A-Za-z0-9]{8,}|api[_-]?key|token/i.test(serialized));
});

test("without fixture mode the runtime seams are used as before", async () => {
  let resolved = false;
  const routes = createHermesChatRoutes({
    env: {},
    resolveRuntime: () => {
      resolved = true;
      return { ok: false, reason: "No local Hermes runtime installed." };
    },
  });
  const res = fakeRes();
  await routes.handleStatus(fakeReq(), res);
  assert.equal(resolved, true, "normal mode must still consult the real resolver");
  assert.equal(parsed(res).hermes.profile, null);
});
