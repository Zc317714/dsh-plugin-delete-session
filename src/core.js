// Pure helpers for the delete-session plugin.
//
// Nothing in this module touches the DeepSeek Harness runtime directly, so it
// can be unit-tested with plain `node --test` (no host imports, no I/O).
// The plugin shell (src/index.js) wires these helpers to the real services.

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const SAFE_SEGMENT = /^[A-Za-z0-9._-]$/;

/**
 * Encode one path segment the same way the JSONL session backend does, so a
 * plugin can rebuild a session directory without the backend's private
 * helpers. Only used as a fallback: the backend's own `locate()` is preferred.
 */
export function encodeSegment(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("cannot encode an empty path segment");
  }
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character !== "~" && SAFE_SEGMENT.test(character)) out += character;
    else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/**
 * Build the human-navigable project directory key for a session cwd.
 */
export function projectKey(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("cannot encode an empty project path");
  }
  let readable = "";
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character === "/" || character === "\\" || character === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (character !== "~" && SAFE_SEGMENT.test(character)) {
      readable += character;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * Resolve a user supplied session id against the known session ids.
 *
 * Accepts the exact id, a unique prefix, or a unique substring. The GUI shows
 * ids in two shapes (`<uuid>` and `session-<uuid>`), so both spellings of the
 * same id are tried.
 */
export function matchSessionId(query, ids) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return { status: "invalid" };
  const all = Array.from(new Set(ids));
  const variants = [needle];
  if (needle.startsWith("session-")) variants.push(needle.slice("session-".length));
  else variants.push(`session-${needle}`);

  for (const variant of variants) {
    const exact = all.filter((id) => id.toLowerCase() === variant);
    if (exact.length === 1) return { status: "matched", id: exact[0] };
    if (exact.length > 1) return { status: "ambiguous", candidates: exact };
  }
  for (const variant of variants) {
    const prefix = all.filter((id) => id.toLowerCase().startsWith(variant));
    if (prefix.length === 1) return { status: "matched", id: prefix[0] };
    if (prefix.length > 1) return { status: "ambiguous", candidates: prefix };
  }
  for (const variant of variants) {
    const contains = all.filter((id) => id.toLowerCase().includes(variant));
    if (contains.length === 1) return { status: "matched", id: contains[0] };
    if (contains.length > 1) return { status: "ambiguous", candidates: contains };
  }
  return { status: "not-found" };
}

/**
 * One-shot confirmation tokens, used when no interactive question provider is
 * reachable (headless runs). Tokens expire so a stale token cannot delete a
 * session much later.
 */
export function createConfirmationStore(ttlMs = 120000) {
  const pending = new Map();
  return {
    issue(sessionId, now = Date.now()) {
      const token = randomUUID();
      pending.set(token, { sessionId, expiresAt: now + ttlMs });
      return token;
    },
    take(token, sessionId, now = Date.now()) {
      if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "missing" };
      const entry = pending.get(token);
      if (!entry) return { ok: false, reason: "unknown" };
      pending.delete(token);
      if (entry.expiresAt < now) return { ok: false, reason: "expired" };
      if (sessionId !== entry.sessionId) return { ok: false, reason: "mismatch" };
      return { ok: true };
    },
    size() {
      return pending.size;
    },
  };
}

/**
 * Resolve the on-disk directory that owns one session.
 *
 * Prefers the backend's own `locate()` so the plugin never has to guess the
 * storage layout; falls back to rebuilding the documented layout.
 */
export function sessionDirectory(persistence, header) {
  const id = header?.id;
  if (!persistence || typeof id !== "string" || id.length === 0) return undefined;
  if (typeof persistence.locate === "function") {
    try {
      const located = persistence.locate({ cwd: header.cwd, id });
      if (located && typeof located.path === "string") return dirname(located.path);
    } catch {
      // fall through to the manual layout
    }
  }
  const root = typeof persistence.root === "string" ? persistence.root : undefined;
  if (!root) return undefined;
  let project;
  try {
    project = header.cwd === undefined ? join(root, "_no-cwd") : join(root, projectKey(header.cwd));
  } catch {
    return undefined;
  }
  return join(project, encodeSegment(id));
}

/**
 * Decide whether an answer batch means "delete" or "cancel".
 *
 * The question provider answers with option labels; an empty selection means
 * the user skipped the question, which counts as cancel.
 */
export function readConfirmation(answers, labels) {
  const list = Array.isArray(answers) ? answers : [];
  const selected = [];
  for (const answer of list) {
    if (!answer) continue;
    if (Array.isArray(answer.selected)) {
      selected.push(...answer.selected.map((item) => String(item)));
    } else if (typeof answer.selected === "string") {
      selected.push(answer.selected);
    }
  }
  const confirmLabel = String(labels?.confirm ?? "删除").toLowerCase();
  const cancelLabel = String(labels?.cancel ?? "取消").toLowerCase();
  if (selected.some((label) => label.toLowerCase().includes(confirmLabel))) return "confirmed";
  if (selected.some((label) => label.toLowerCase().includes(cancelLabel))) return "cancelled";
  return "cancelled";
}
