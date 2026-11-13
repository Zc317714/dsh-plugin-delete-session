import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { apply, name as pluginName } from "../src/index.js";

function makeCtx({ live = [], stored = [], provider = null, root, webServer = null } = {}) {
  const registered = new Map();
  const removed = [];
  const detached = [];
  const effects = [];
  const pending = [];
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return definition;
      },
    },
    sessions: {
      list: () => live,
      liveEntryFor(session) {
        if (!live.includes(session)) {
          throw new Error(`session "${session.id}" is not live in this store`);
        }
        return session;
      },
      detachEntered(entry) {
        detached.push(entry.id);
        const index = live.indexOf(entry);
        if (index >= 0) live.splice(index, 1);
      },
    },
    sessionPersistence: {
      root,
      async list() {
        return stored.map((header) => ({ header, formatStatus: "ok", revision: 1, sizeBytes: 1 }));
      },
      locate(meta) {
        return { kind: "jsonl", path: join(root, "project", meta.id, "session.v4.jsonl.zstd") };
      },
    },
    userQuestions: {
      async ask() {
        if (!provider) {
          const error = new Error("no user-questions answerer accepted the request");
          error.code = "NO_PROVIDER";
          throw error;
        }
        return { answers: [{ id: "delete-session-confirm", selected: provider }] };
      },
    },
    effect(fn) {
      effects.push(fn);
      fn();
      return () => {};
    },
    inject(names, callback) {
      if (names.every((name) => ctx[name] !== undefined)) {
        callback(ctx);
        return () => {};
      }
      pending.push({ names, callback });
      return () => {};
    },
  };
  if (webServer) ctx.webServer = webServer;
  ctx.get = (key) => ctx[key];
  return { ctx, registered, removed, detached, effects, pending };
}

test("plugin exposes the expected identity and registers both tools", () => {
  assert.equal(pluginName, "delete-session");
  const { ctx, registered } = makeCtx();
  apply(ctx, {});
  assert.deepEqual([...registered.keys()].sort(), ["delete_session", "list_sessions"]);
});

test("list_sessions reports live and stored sessions", async () => {
  const { ctx, registered } = makeCtx({
    live: [{ id: "session-live-1" }],
    stored: [{ id: "session-stored-1" }],
  });
  apply(ctx, {});
  const result = await registered.get("list_sessions").execute({}, {});
  assert.equal(result.count, 2);
  assert.deepEqual(result.sessionIds.sort(), ["session-live-1", "session-stored-1"]);
});

test("delete_session refuses an unknown session id", async () => {
  const { ctx, registered } = makeCtx();
  apply(ctx, {});
  const result = await registered.get("delete_session").execute({ sessionId: "missing" }, {});
  assert.equal(result.status, "not-found");
});

test("delete_session refuses to delete the session it is running in", async () => {
  const { ctx, registered } = makeCtx({ live: [{ id: "session-current" }] });
  apply(ctx, {});
  const result = await registered.get("delete_session").execute(
    { sessionId: "session-current" },
    { agent: { session: { id: "session-current" } } },
  );
  assert.equal(result.status, "refused");
});

test("delete_session returns a confirmation token when no interactive provider exists", async () => {
  const { ctx, registered } = makeCtx({ live: [{ id: "session-live-1" }] });
  apply(ctx, {});
  const first = await registered.get("delete_session").execute({ sessionId: "session-live-1" }, {});
  assert.equal(first.status, "confirmation-required");
  assert.ok(first.confirmationToken);

  const second = await registered.get("delete_session").execute(
    { sessionId: "session-live-1", confirmationToken: first.confirmationToken },
    {},
  );
  assert.equal(second.status, "deleted");
});

test("a confirmation token cannot be replayed for another session", async () => {
  const { ctx, registered } = makeCtx({ live: [{ id: "session-live-1" }, { id: "session-live-2" }] });
  apply(ctx, {});
  const first = await registered.get("delete_session").execute({ sessionId: "session-live-1" }, {});
  const replay = await registered.get("delete_session").execute(
    { sessionId: "session-live-2", confirmationToken: first.confirmationToken },
    {},
  );
  assert.equal(replay.status, "refused");
});

test("delete_session detaches a live session after an interactive confirmation", async () => {
  const live = [{ id: "session-live-1" }];
  const { ctx, registered, detached } = makeCtx({ live, provider: "删除" });
  apply(ctx, {});
  const result = await registered.get("delete_session").execute({ sessionId: "session-live-1" }, {});
  assert.equal(result.status, "deleted");
  assert.deepEqual(detached, ["session-live-1"]);
  assert.equal(live.length, 0);
});

test("delete_session cancels when the interactive answer is 取消", async () => {
  const live = [{ id: "session-live-1" }];
  const { ctx, registered, detached } = makeCtx({ live, provider: "取消" });
  apply(ctx, {});
  const result = await registered.get("delete_session").execute({ sessionId: "session-live-1" }, {});
  assert.equal(result.status, "cancelled");
  assert.deepEqual(detached, []);
});

test("delete_session removes the on-disk directory of a stored session", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-delete-session-"));
  try {
    const directory = join(root, "project", "session-stored-1");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.v4.jsonl.zstd"), "payload");
    const { ctx, registered } = makeCtx({
      stored: [{ id: "session-stored-1", cwd: "C:/project" }],
      provider: "删除",
      root,
    });
    apply(ctx, {});
    const result = await registered.get("delete_session").execute(
      { sessionId: "session-stored-1" },
      {},
    );
    assert.equal(result.status, "deleted");
    await assert.rejects(() => rm(join(directory, "session.v4.jsonl.zstd")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous prefixes are reported with candidates", async () => {
  const { ctx, registered } = makeCtx({ stored: [{ id: "session-a1" }, { id: "session-a2" }] });
  apply(ctx, {});
  const result = await registered.get("delete_session").execute({ sessionId: "session-a" }, {});
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.candidates.sort(), ["session-a1", "session-a2"]);
});

test("the plugin activates without a web server and only waits for it", () => {
  const { ctx, registered, pending } = makeCtx();
  apply(ctx, {});
  // The tools must be available even though no web server exists yet.
  assert.deepEqual([...registered.keys()].sort(), ["delete_session", "list_sessions"]);
  // The web routes are deferred until the web server appears.
  assert.deepEqual(pending.map((entry) => entry.names), [["webServer"]]);
});

test("the web routes are registered as soon as the web server is available", () => {
  const routes = [];
  const { ctx, registered, pending } = makeCtx({
    webServer: {
      register(route) {
        routes.push(route);
        return route;
      },
    },
  });
  apply(ctx, {});
  assert.deepEqual([...registered.keys()].sort(), ["delete_session", "list_sessions"]);
  assert.deepEqual(pending, []);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, "prefix");
  assert.equal(routes[0].path, "/delete-session");
  assert.equal(typeof routes[0].handler, "function");
});
