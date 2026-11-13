/*
 * dsh-plugin-delete-session — private HTTP surface for the GUI half.
 *
 * The web shell cannot reach the harness services directly, so the browser
 * half talks to this small JSON API instead. The routes live under a private
 * prefix (`/delete-session/api/...`) that only this plugin serves.
 *
 * Every delete request must carry `confirm: true`; the browser half only
 * sends it after the user confirmed in the dialog, so the server side keeps
 * the "second confirmation" rule even when the caller is the GUI.
 */

const API_PREFIX = "/delete-session/api";

/**
 * Serialize one payload as JSON.
 */
function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

/**
 * Read a JSON request body, tolerating an empty or malformed payload.
 */
async function readJsonBody(req) {
  const chunks = [];
  try {
    for await (const chunk of req) chunks.push(chunk);
  } catch {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Describe one session for the GUI list.
 */
function describeSession(entry, live) {
  const header = entry?.header ?? entry;
  return {
    id: header?.id,
    title: typeof header?.title === "string" ? header.title : undefined,
    live: Boolean(live),
  };
}

/**
 * Build the request handler for the private delete-session API.
 *
 * @param {object} ctx harness context (provides `sessions` and `sessionPersistence`)
 * @param {{collectSessions: Function, performDeletion: Function}} deps shared session helpers
 */
export function createDeleteSessionHandler(ctx, deps) {
  const { collectSessions, performDeletion } = deps;

  return async function handle(req, res) {
    const path = String(req?.url ?? "").split("?")[0].replace(/\/+$/, "");
    try {
      if (req.method === "GET" && path.endsWith(`${API_PREFIX}/sessions`)) {
        const { live, stored } = await collectSessions(ctx);
        const sessions = [];
        for (const session of live) {
          sessions.push(describeSession({ id: session.id, title: session.title }, true));
        }
        for (const entry of stored) {
          sessions.push(describeSession(entry, false));
        }
        sendJson(res, 200, { ok: true, sessions });
        return;
      }

      if (req.method === "POST" && path.endsWith(`${API_PREFIX}/delete`)) {
        const body = await readJsonBody(req);
        const sessionId = String(body?.sessionId ?? "").trim();
        if (!sessionId) {
          sendJson(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        if (body?.confirm !== true) {
          sendJson(res, 400, { ok: false, error: "confirmation is required" });
          return;
        }
        const { live, stored } = await collectSessions(ctx);
        const known = [
          ...live.map((session) => session.id),
          ...stored.map((entry) => entry.header.id),
        ];
        const target = known.includes(sessionId) ? sessionId : undefined;
        if (!target) {
          sendJson(res, 404, { ok: false, error: `unknown session ${sessionId}` });
          return;
        }
        const result = await performDeletion(ctx, live, stored, target);
        sendJson(res, 200, { ok: true, sessionId: target, ...result });
        return;
      }

      sendJson(res, 404, { ok: false, error: "unknown delete-session endpoint" });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };
}

/**
 * Register the private routes on the harness web server.
 *
 * The web server is optional: when it is not available the plugin keeps
 * working with its tools only.
 */
export function registerDeleteSessionRoutes(ctx, deps) {
  let webServer;
  try {
    webServer = ctx.get("webServer");
  } catch {
    webServer = undefined;
  }
  if (!webServer || typeof webServer.register !== "function") return undefined;
  return ctx.effect(
    () => webServer.register({ kind: "prefix", path: "/delete-session", handler: createDeleteSessionHandler(ctx, deps) }),
    "delete-session: private API routes",
  );
}

export { API_PREFIX };
