/*
 * dsh-plugin-delete-session — delete a DeepSeek Harness session by id.
 *
 * The harness exposes no public "delete session" API, so this plugin
 * implements the two supported shapes:
 *
 *   - a live session  -> `ctx.sessions.detachEntered(entry)`, which removes it
 *     from the live store and emits `session/disposed`, so the GUI list
 *     refreshes on its own;
 *   - a stored session -> the session directory on disk is removed; the
 *     session index reconciles itself because the id disappears from
 *     `sessionPersistence.list()`.
 *
 * Every deletion is confirmed twice: an interactive question is asked first
 * and, when no answer provider is reachable, a one-shot confirmation token is
 * issued so the second call can carry the proof.
 */

import { rm } from "node:fs/promises";

import { defineTool } from "@deepseek-ai/dsh-tools";

import { createConfirmationStore, matchSessionId, readConfirmation, sessionDirectory } from "./core.js";
import { registerDeleteSessionRoutes } from "./web.js";

const CONFIRM_LABEL = "删除";
const CANCEL_LABEL = "取消";

/**
 * Read one harness service without assuming it is present.
 *
 * `ctx.get` needs an active fiber, and a service may be missing entirely in
 * a headless run, so every lookup degrades to `undefined` instead of throwing.
 */
function resolveService(ctx, name) {
  try {
    const found = ctx.get(name);
    if (found !== undefined) return found;
  } catch {
    // fall through to the property form
  }
  try {
    return ctx[name];
  } catch {
    return undefined;
  }
}

/**
 * Collect every session id the harness currently knows about.
 *
 * Live sessions come from the session store, stored ones from the session
 * persistence backend; a session can appear in both lists.
 */
export async function collectSessions(ctx) {
  const sessions = resolveService(ctx, "sessions");
  const persistence = resolveService(ctx, "sessionPersistence");

  const live = [];
  if (sessions && typeof sessions.list === "function") {
    try {
      for (const session of sessions.list()) {
        if (session && typeof session.id === "string") live.push(session);
      }
    } catch {
      // an empty live list is a valid answer
    }
  }

  const stored = [];
  if (persistence && typeof persistence.list === "function") {
    try {
      const entries = await persistence.list({});
      for (const entry of entries ?? []) {
        const header = entry?.header;
        if (header && typeof header.id === "string") stored.push(entry);
      }
    } catch {
      // an empty stored list is a valid answer
    }
  }

  return { sessions, persistence, live, stored };
}

/**
 * Ask the user to confirm the deletion.
 *
 * @returns {Promise<{state: "confirmed" | "cancelled" | "unavailable", reason?: string}>}
 */
async function confirmDeletion(ctx, exec, sessionId) {
  const userQuestions = resolveService(ctx, "userQuestions");
  if (!userQuestions || typeof userQuestions.ask !== "function") {
    return { state: "unavailable", reason: "no-question-provider" };
  }
  const question = {
    id: "delete-session-confirm",
    question: `确认删除会话 ${sessionId}？该操作不可撤销。`,
    options: [
      { label: CONFIRM_LABEL, description: "永久删除该会话及其本地记录" },
      { label: CANCEL_LABEL, description: "保留该会话" },
    ],
  };
  try {
    const answered = await userQuestions.ask({
      questions: [question],
      ...(exec?.agent !== undefined ? { agent: exec.agent } : {}),
      ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
      wait: { callId: exec?.callId },
    });
    const decision = readConfirmation(answered?.answers, { confirm: CONFIRM_LABEL, cancel: CANCEL_LABEL });
    return { state: decision === "confirmed" ? "confirmed" : "cancelled" };
  } catch (error) {
    if (error?.name === "AbortError" || error?.code === "ASK_ABORTED") throw error;
    return { state: "unavailable", reason: error?.code ?? error?.message ?? "ask-failed" };
  }
}

/**
 * Remove the session from disk and from the live store.
 */
export async function performDeletion(ctx, live, stored, sessionId) {
  const sessions = resolveService(ctx, "sessions");
  const persistence = resolveService(ctx, "sessionPersistence");

  let detached = false;
  const liveSession = live.find((session) => session.id === sessionId);
  if (liveSession && sessions && typeof sessions.detachEntered === "function") {
    const entry = sessions.liveEntryFor(liveSession);
    sessions.detachEntered(entry);
    detached = true;
  }

  let removedFiles = false;
  const storedEntry = stored.find((entry) => entry.header.id === sessionId);
  if (storedEntry && persistence) {
    const directory = sessionDirectory(persistence, storedEntry.header);
    if (directory) {
      await rm(directory, { recursive: true, force: true });
      removedFiles = true;
    }
  }

  return { detached, removedFiles };
}

/**
 * Build the two tools this plugin contributes.
 */
function buildTools(ctx, confirmation) {
  const deleteSession = defineTool({
    name: "delete_session",
    description:
      "按会话 ID 删除一个 DeepSeek Harness 会话。删除前必须二次确认：" +
      "有交互问答时会弹出确认框；没有应答方时先返回 confirmationToken，" +
      "需要再次调用本工具并带上该令牌才会真正删除。可用完整 ID、唯一前缀或唯一子串指定会话。",
    parameters: {
      sessionId: {
        type: "string",
        required: true,
        description: "要删除的会话 ID（完整 ID、唯一前缀或唯一子串）",
      },
      confirmationToken: {
        type: "string",
        description: "上一步返回的确认令牌；仅在没有交互确认渠道时需要",
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: renderDeleteResult(args, value) }],
    },
    execute: async (args, exec) => {
      const query = String(args?.sessionId ?? "").trim();
      if (!query) {
        return { status: "invalid", message: "sessionId 不能为空" };
      }

      const { sessions, persistence, live, stored } = await collectSessions(ctx);
      const known = [...live.map((session) => session.id), ...stored.map((entry) => entry.header.id)];
      const match = matchSessionId(query, known);
      if (match.status === "invalid") {
        return { status: "invalid", message: "sessionId 不能为空" };
      }
      if (match.status === "not-found") {
        return { status: "not-found", message: `没有找到与会话 ID ${query} 匹配的会话`, sessionIds: known };
      }
      if (match.status === "ambiguous") {
        return { status: "ambiguous", message: `会话 ID ${query} 匹配到多个会话，请提供更完整的 ID`, candidates: match.candidates };
      }

      const sessionId = match.id;
      const currentSessionId = exec?.agent?.session?.id;
      if (typeof currentSessionId === "string" && currentSessionId === sessionId) {
        return {
          status: "refused",
          sessionId,
          message: `会话 ${sessionId} 是当前正在运行的会话，为避免破坏运行状态不予删除，请在其它会话中执行。`,
        };
      }
      const token = typeof args?.confirmationToken === "string" ? args.confirmationToken : undefined;
      if (token !== undefined) {
        const verdict = confirmation.take(token, sessionId);
        if (!verdict.ok) {
          return {
            status: "refused",
            reason: verdict.reason,
            message: `确认令牌无效或已过期（${verdict.reason}），会话 ${sessionId} 未被删除`,
            sessionId,
          };
        }
      } else {
        const decision = await confirmDeletion(ctx, exec, sessionId);
        if (decision.state === "cancelled") {
          return { status: "cancelled", message: `已取消删除会话 ${sessionId}`, sessionId };
        }
        if (decision.state === "unavailable") {
          const issued = confirmation.issue(sessionId);
          return {
            status: "confirmation-required",
            sessionId,
            confirmationToken: issued,
            reason: decision.reason,
            message:
              `当前没有可用的交互确认渠道（${decision.reason}）。` +
              `请再次调用 delete_session，传入 sessionId=${sessionId} 和 confirmationToken=${issued} 以确认删除。`,
          };
        }
      }

      const result = await performDeletion(ctx, live, stored, sessionId);
      return {
        status: "deleted",
        sessionId,
        detached: result.detached,
        removedFiles: result.removedFiles,
        message: `已删除会话 ${sessionId}`,
      };
    },
  });

  const listSessions = defineTool({
    name: "list_sessions",
    description: "列出当前 harness 已知的所有会话 ID（活跃会话与已落盘会话），便于确定要删除的会话 ID。",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: renderListResult(value) }],
    },
    execute: async () => {
      const { live, stored } = await collectSessions(ctx);
      const liveIds = live.map((session) => session.id);
      const storedIds = stored.map((entry) => entry.header.id);
      const ids = [...new Set([...liveIds, ...storedIds])];
      return {
        count: ids.length,
        live: liveIds,
        stored: storedIds,
        sessionIds: ids,
      };
    },
  });

  return { deleteSession, listSessions };
}

function renderDeleteResult(args, value) {
  const status = value?.status ?? "unknown";
  const header = `delete_session(${args?.sessionId ?? ""}) → ${status}`;
  const details = [];
  if (value?.message) details.push(value.message);
  if (value?.sessionId) details.push(`sessionId: ${value.sessionId}`);
  if (value?.candidates) details.push(`candidates: ${value.candidates.join(", ")}`);
  if (value?.sessionIds) details.push(`known: ${value.sessionIds.join(", ")}`);
  if (value?.confirmationToken) details.push(`confirmationToken: ${value.confirmationToken}`);
  return details.length > 0 ? `${header}\n${details.join("\n")}` : header;
}

function renderListResult(value) {
  const ids = value?.sessionIds ?? [];
  if (ids.length === 0) return "没有找到任何会话。";
  return [`共 ${ids.length} 个会话：`, ...ids.map((id) => `- ${id}`)].join("\n");
}

/**
 * Cordis plugin entry point.
 */
export function apply(ctx, config = {}) {
  const confirmation = createConfirmationStore(config?.confirmationTtlMs ?? 120000);
  const { deleteSession, listSessions } = buildTools(ctx, confirmation);
  ctx.tools.register(deleteSession);
  ctx.tools.register(listSessions);
  registerDeleteSessionRoutes(ctx, { collectSessions, performDeletion });
}

export const name = "delete-session";
export const inject = ["tools", "webServer"];
