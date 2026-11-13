# dsh-plugin-delete-session

Delete a DeepSeek Harness session by session id — with a mandatory second
confirmation before anything is removed.

## What it adds

| Tool | Purpose |
| --- | --- |
| `delete_session` | Delete one session by id (full id, unique prefix, or unique substring). |
| `list_sessions` | List every session id the harness currently knows about (live + stored). |

## Confirmation model

Deletion never happens on the first call:

1. The tool asks an interactive question (`确认删除会话 …？`) with the options
   `删除` / `取消`. Choosing `取消` aborts with `status: "cancelled"`.
2. When no answer provider is reachable (headless runs, no live agent), the
   tool issues a one-shot `confirmationToken` and returns
   `status: "confirmation-required"`. The token must be passed back on a
   second `delete_session` call; it is bound to the session id and expires
   after 120 seconds.

A token that is unknown, expired, or issued for a different session is
refused with `status: "refused"` and nothing is deleted.

## How deletion works

The harness exposes no public delete API, so the plugin uses the two
supported shapes:

* **Live session** — `ctx.sessions.liveEntryFor(session)` +
  `ctx.sessions.detachEntered(entry)`. The session leaves the live store and
  `session/disposed` is emitted, so the GUI list refreshes on its own.
* **Stored session** — the session directory under
  `~/.dsh/sessions/<project>/<session>/` is removed. The session index
  reconciles itself, because the id disappears from
  `ctx.sessionPersistence.list()`.

A session that is both live and stored is handled by both paths.

## GUI integration (v0.2.0)

The plugin also contributes a **删除会话** entry to the session row "⋯" menu
in the DeepSeek Harness web/desktop GUI:

1. Open the "⋯" menu of any session row in the sidebar.
2. Click **删除会话** (rendered last, marked as a destructive action).
3. A modal asks **确认删除该会话？** with `取消` / `删除` buttons. `取消`
   (or `Escape`) closes it without deleting anything.

After a confirmed deletion the sidebar list is refreshed
(`ctx.sessions.refresh()`), so the row disappears immediately.

### How the GUI half talks to the host

The harness exposes no delete API to the client, so the plugin serves a small
private HTTP API from the host side and calls it from the client half:

| Endpoint | Purpose |
| --- | --- |
| `GET /delete-session/api/sessions` | List the session ids the host knows about. |
| `POST /delete-session/api/delete` | Delete one session; body `{ "sessionId": "...", "confirm": true }`. |

The client half is a classic script registered through
`window.__ModuleLoader__.load(...)`; it renders its own markup (no
primitives dependency) and only uses `--dsw-alias-*` design tokens.

### Verification

`test/web-api.test.mjs` covers the host-side API with a mocked request/
response pair (`node --test`). `scripts/cdp-check.mjs` and
`scripts/cdp-delete-flow.mjs` drive a running instance through the Chrome
DevTools Protocol: the first checks that the menu entry and the confirmation
dialog render, the second stubs `fetch` to confirm the request shape
(`POST /delete-session/api/delete` with `{sessionId, confirm:true}`) and the
list refresh without deleting real sessions.

```
node scripts/cdp-check.mjs 9222      # needs a headless Edge with --remote-debugging-port
node scripts/cdp-delete-flow.mjs 9222
```

## Install

### From GitHub (recommended)

The plugin manager understands git install specs, so a plain GitHub URL is
enough:

```
dsh plugin --profile <your-profile> add github:Zc317714/dsh-plugin-delete-session
```

Then **restart the harness** and the **删除会话** entry shows up in the
session row "⋯" menu.

### From a local checkout

```
dsh plugin --profile <your-profile> add <path-to-this-package>
```

### Notes

* The `desktop` profile is managed exclusively by the Electron application,
  so `dsh plugin --profile desktop ...` is rejected with
  `profile "desktop" is managed exclusively by the Electron application`.
  Desktop users install the plugin through the GUI plugin manager, or by
  adding the package to `~/.dsh/profiles/desktop/package.json` (both the
  `dependencies` map and the `dsh.profile.bundles` roster).
* Replacing an installed package requires a host restart so the new module
  generation is loaded — the host half applies at startup and has no hot
  reload (the client bundle does).
* The package is plain JavaScript; there is no build step. `src/client/index.js`
  is the client bundle and is shipped as-is inside the `files` list.

## License

MIT — see [LICENSE](LICENSE).
