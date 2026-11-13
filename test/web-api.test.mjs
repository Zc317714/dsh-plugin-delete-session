import assert from "node:assert/strict";
import test from "node:test";

import {
  API_PREFIX,
  createDeleteSessionHandler,
  registerDeleteSessionRoutes,
} from "../src/web.js";

function makeRes() {
  const res = {
    status: null,
    headers: null,
    body: null,
    ended: false,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
      return res;
    },
    end(payload) {
      res.body = payload;
      res.ended = true;
      return res;
    },
  };
  return res;
}

function makeReq(method, url, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const chunks = payload ? [Buffer.from(payload, "utf8")] : [];
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeDeps(overrides = {}) {
  const calls = { deleted: [] };
  const deps = {
    calls,
    collectSessions: async () => ({
      sessions: {},
      persistence: {},
      live: [{ id: "live-1", title: "Live session" }],
      stored: [{ header: { id: "stored-1", title: "Stored session" } }],
    }),
    performDeletion: async (_ctx, live, stored, sessionId) => {
      calls.deleted.push({ sessionId, live, stored });
      return { detached: sessionId === "live-1", removedFiles: sessionId === "stored-1" };
    },
  };
  return Object.assign(deps, overrides);
}

test("GET sessions lists live and stored sessions", async () => {
  const handler = createDeleteSessionHandler({}, makeDeps());
  const res = makeRes();
  await handler(makeReq("GET", `${API_PREFIX}/sessions`), res);
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.sessions, [
    { id: "live-1", title: "Live session", live: true },
    { id: "stored-1", title: "Stored session", live: false },
  ]);
});

test("POST delete without sessionId is rejected", async () => {
  const handler = createDeleteSessionHandler({}, makeDeps());
  const res = makeRes();
  await handler(makeReq("POST", `${API_PREFIX}/delete`, { confirm: true }), res);
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error, "sessionId is required");
});

test("POST delete without confirmation is rejected", async () => {
  const deps = makeDeps();
  const handler = createDeleteSessionHandler({}, deps);
  const res = makeRes();
  await handler(makeReq("POST", `${API_PREFIX}/delete`, { sessionId: "stored-1" }), res);
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error, "confirmation is required");
  assert.deepEqual(deps.calls.deleted, []);
});

test("POST delete removes a known session", async () => {
  const deps = makeDeps();
  const handler = createDeleteSessionHandler({}, deps);
  const res = makeRes();
  await handler(makeReq("POST", `${API_PREFIX}/delete`, { sessionId: "stored-1", confirm: true }), res);
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.sessionId, "stored-1");
  assert.equal(payload.removedFiles, true);
  assert.equal(deps.calls.deleted.length, 1);
});

test("POST delete rejects an unknown session", async () => {
  const deps = makeDeps();
  const handler = createDeleteSessionHandler({}, deps);
  const res = makeRes();
  await handler(makeReq("POST", `${API_PREFIX}/delete`, { sessionId: "nope", confirm: true }), res);
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error, "unknown session nope");
  assert.deepEqual(deps.calls.deleted, []);
});

test("unknown endpoints answer with a JSON 404", async () => {
  const handler = createDeleteSessionHandler({}, makeDeps());
  const res = makeRes();
  await handler(makeReq("GET", `${API_PREFIX}/whatever`), res);
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error, "unknown delete-session endpoint");
});

test("handler failures answer with a JSON 500", async () => {
  const deps = makeDeps({
    collectSessions: async () => {
      throw new Error("boom");
    },
  });
  const handler = createDeleteSessionHandler({}, deps);
  const res = makeRes();
  await handler(makeReq("GET", `${API_PREFIX}/sessions`), res);
  assert.equal(res.status, 500);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "boom");
});

test("registerDeleteSessionRoutes registers a prefix route", () => {
  const registered = [];
  const ctx = {
    get(name) {
      if (name === "webServer") {
        return {
          register(route) {
            registered.push(route);
            return () => {};
          },
        };
      }
      throw new Error(`unknown service ${name}`);
    },
    effect(fn) {
      return fn();
    },
  };
  registerDeleteSessionRoutes(ctx, makeDeps());
  assert.equal(registered.length, 1);
  assert.equal(registered[0].kind, "prefix");
  assert.equal(registered[0].path, "/delete-session");
  assert.equal(typeof registered[0].handler, "function");
});

test("registerDeleteSessionRoutes stays inert without a web server", () => {
  const ctx = {
    get() {
      throw new Error("not found");
    },
    effect() {
      throw new Error("must not be used");
    },
  };
  assert.equal(registerDeleteSessionRoutes(ctx, makeDeps()), undefined);
});
