/*!
 * dsh-plugin-delete-session — Client half (browser)
 *
 * Loaded by the DSH client-modules handshake as a classic script:
 *   window.__ModuleLoader__.load({ id: "dsh-plugin-delete-session", factory(require) { ... } })
 *
 * The file is written in plain classic-script form on purpose: this machine has
 * no esbuild/pnpm available, so there is no bundler step. `require("react")`
 * resolves inside the loader factory because the web shell seeds react into the
 * browser module table.
 *
 * What it adds to the GUI:
 *   - a "删除会话 / Delete session" entry in every session row's "…" menu
 *     (slot `sidebar.workspaces.session.menu.item`, order 500, after the
 *     host's own Archive entry at 400);
 *   - a confirmation dialog rendered through the `shell.overlay` slot, so the
 *     deletion always needs an explicit second step.
 *
 * Styling only uses `--dsw-alias-*` theme tokens; every class is prefixed with
 * `dsds-` so nothing collides with the host's own styles.
 */
(function () {
  "use strict";

  var NS = "dsh-plugin-delete-session";
  var API_BASE = "/delete-session/api";

  var STR = {
    en: {
      menu: "Delete session",
      title: "Delete this session?",
      description: "The session and its local records will be removed permanently. This cannot be undone.",
      named: "Session: {name}",
      cancel: "Cancel",
      confirm: "Delete",
      working: "Deleting…",
      failed: "Deletion failed: {reason}",
      done: "Session deleted.",
    },
    zh: {
      menu: "删除会话",
      title: "确认删除该会话？",
      description: "该会话及其本地记录将被永久删除，此操作不可撤销。",
      named: "会话：{name}",
      cancel: "取消",
      confirm: "删除",
      working: "正在删除…",
      failed: "删除失败：{reason}",
      done: "会话已删除。",
    },
  };

  function tr(locale, key, vars) {
    var table = STR[locale] || STR.en;
    var text = table[key] || STR.en[key] || key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
    });
  }

  function detectLocale() {
    try {
      var lang = (document.documentElement && document.documentElement.lang) || "";
      if (lang.toLowerCase().indexOf("zh") === 0) return "zh";
    } catch (error) {
      /* ignore: fall through to English */
    }
    return "en";
  }

  function createStore(initial) {
    var value = initial;
    var listeners = [];
    return {
      get: function () {
        return value;
      },
      set: function (next) {
        value = next;
        listeners.slice().forEach(function (listener) {
          try {
            listener();
          } catch (error) {
            /* a broken subscriber must not break the store */
          }
        });
      },
      subscribe: function (listener) {
        listeners.push(listener);
        return function () {
          listeners = listeners.filter(function (candidate) {
            return candidate !== listener;
          });
        };
      },
    };
  }

  var CSS = [
    ".dsds-menu-item{",
    "display:flex;align-items:center;gap:8px;width:100%;",
    "box-sizing:border-box;padding:6px 10px;border:0;border-radius:6px;",
    "background:transparent;color:var(--dsw-alias-label-primary,inherit);",
    "font:inherit;text-align:left;cursor:pointer;",
    "}",
    ".dsds-menu-item:hover{background:var(--dsw-alias-state-business-primary,rgba(0,0,0,.06));}",
    ".dsds-menu-item:focus-visible{outline:2px solid var(--dsw-alias-label-primary,currentColor);outline-offset:-2px;}",
    ".dsds-menu-item[data-danger='true']{color:var(--dsw-alias-state-error-primary,#b3261e);}",
    ".dsds-menu-separator{height:1px;margin:4px 0;background:var(--dsw-alias-label-tertiary,rgba(0,0,0,.12));}",
    ".dsds-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;}",
    ".dsds-overlay-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.45);}",
    ".dsds-dialog{position:relative;max-width:420px;width:calc(100% - 32px);",
    "border-radius:12px;padding:20px;box-shadow:0 12px 40px rgba(0,0,0,.28);",
    "background:var(--dsw-alias-background-primary,#fff);",
    "color:var(--dsw-alias-label-primary,#111);display:flex;flex-direction:column;gap:12px;",
    "}",
    ".dsds-dialog-title{margin:0;font-size:15px;font-weight:600;}",
    ".dsds-dialog-description{margin:0;font-size:13px;line-height:1.5;",
    "color:var(--dsw-alias-label-tertiary,#555);word-break:break-all;}",
    ".dsds-dialog-actions{display:flex;justify-content:flex-end;gap:8px;}",
    ".dsds-button{padding:6px 14px;border-radius:6px;border:1px solid transparent;font:inherit;cursor:pointer;",
    "background:var(--dsw-alias-background-secondary,#f2f2f2);",
    "color:var(--dsw-alias-label-primary,#111);",
    "}",
    ".dsds-button:hover{background:var(--dsw-alias-state-business-primary,rgba(0,0,0,.06));}",
    ".dsds-button[data-variant='danger']{",
    "background:var(--dsw-alias-state-error-primary,#b3261e);",
    "color:var(--dsw-alias-label-primary-inverted,#fff);",
    "}",
    ".dsds-status{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary,#b3261e);}",
  ].join("");

  function ensureStyles() {
    if (typeof document === "undefined") return;
    if (document.querySelector("style[data-dsds]")) return;
    var style = document.createElement("style");
    style.setAttribute("data-dsds", "");
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  window.__ModuleLoader__.load({
    id: "dsh-plugin-delete-session",
    factory: function (require) {
      var React = require("react");
      var h = React.createElement;

      /* The dialog request is shared between the menu entry and the overlay. */
      var request = createStore(null);
      var ctxRef = { current: null };

      function localeService() {
        try {
          return ctxRef.current ? ctxRef.current.locale : null;
        } catch (error) {
          /* the locale service is optional */
          return null;
        }
      }

      function subscribeLocale(notify) {
        var service = localeService();
        if (service && typeof service.subscribe === "function") return service.subscribe(notify);
        if (typeof MutationObserver !== "undefined" && typeof document !== "undefined" && document.documentElement) {
          var observer = new MutationObserver(notify);
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
          return function () {
            observer.disconnect();
          };
        }
        return function () {};
      }

      function readLocale() {
        var service = localeService();
        var active = service && typeof service.getLocale === "function" ? service.getLocale().active : "";
        if (active === "zh" || active === "en") return active;
        return detectLocale();
      }

      function useLocale() {
        return React.useSyncExternalStore(subscribeLocale, readLocale, readLocale);
      }

      function locale() {
        return readLocale();
      }

      function useRequest() {
        return React.useSyncExternalStore(request.subscribe, request.get, request.get);
      }

      function DeleteSessionMenuItem(props) {
        var sessionId = props.sessionId;
        var displayTitle = props.displayTitle;
        var setMenuOpen = function () {};
        if (typeof props.useMenuOpenState === "function") {
          try {
            var pair = props.useMenuOpenState();
            if (pair && typeof pair[1] === "function") setMenuOpen = pair[1];
          } catch (error) {
            /* the menu stays open; the overlay still renders */
          }
        }
        var text = tr(locale(), "menu");
        return h(
          React.Fragment,
          null,
          h("div", { className: "dsds-menu-separator", role: "separator" }),
          h(
            "button",
            {
              type: "button",
              role: "menuitem",
              className: "dsds-menu-item",
              "data-danger": "true",
              onClick: function () {
                setMenuOpen(false);
                request.set({ sessionId: sessionId, title: displayTitle || sessionId });
              },
            },
            text
          )
        );
      }

      function DeleteSessionConfirmDialog() {
        var pending = useRequest();
        var state = React.useState({ phase: "idle", error: "" });
        var phase = state[0].phase;
        var error = state[0].error;
        var setState = state[1];

        var close = React.useCallback(function () {
          if (phase === "busy") return;
          request.set(null);
          setState({ phase: "idle", error: "" });
        }, [phase]);

        React.useEffect(function () {
          if (!pending) return undefined;
          function onKeyDown(event) {
            if (event.key === "Escape") close();
          }
          document.addEventListener("keydown", onKeyDown);
          return function () {
            document.removeEventListener("keydown", onKeyDown);
          };
        }, [pending, close]);

        if (!pending) return null;

        var lang = locale();

        function confirm() {
          setState({ phase: "busy", error: "" });
          fetch(API_BASE + "/delete", {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify({ sessionId: pending.sessionId, confirm: true }),
          })
            .then(function (response) {
              return response.json().then(function (payload) {
                return { ok: response.ok, payload: payload };
              });
            })
            .then(function (result) {
              if (!result.ok || result.payload?.ok === false) {
                var reason = (result.payload && (result.payload.error || result.payload.message)) || "unknown error";
                setState({ phase: "error", error: reason });
                return;
              }
              request.set(null);
              setState({ phase: "idle", error: "" });
              refreshSessions();
            })
            .catch(function (error) {
              setState({ phase: "error", error: String((error && error.message) || error) });
            });
        }

        return h(
          "div",
          { className: "dsds-overlay" },
          h("div", { className: "dsds-overlay-backdrop", onClick: close }),
          h(
            "div",
            {
              className: "dsds-dialog",
              role: "dialog",
              "aria-modal": "true",
              "aria-label": tr(lang, "title"),
              tabIndex: -1,
            },
            h("h2", { className: "dsds-dialog-title" }, tr(lang, "title")),
            h("p", { className: "dsds-dialog-description" }, tr(lang, "description")),
            h("p", { className: "dsds-dialog-description" }, tr(lang, "named", { name: pending.title || pending.sessionId })),
            error ? h("p", { className: "dsds-status", role: "alert" }, tr(lang, "failed", { reason: error })) : null,
            h(
              "div",
              { className: "dsds-dialog-actions" },
              h(
                "button",
                { type: "button", className: "dsds-button", onClick: close, disabled: phase === "busy" },
                phase === "busy" ? tr(lang, "working") : tr(lang, "cancel")
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "dsds-button",
                  "data-variant": "danger",
                  onClick: confirm,
                  disabled: phase === "busy",
                },
                tr(lang, "confirm")
              )
            )
          )
        );
      }

      function refreshSessions() {
        try {
          var sessions = ctxRef.current ? ctxRef.current.sessions : null;
          if (sessions && typeof sessions.refresh === "function") {
            sessions.refresh();
            return;
          }
        } catch (error) {
          /* the sidebar will refresh on the next host event */
        }
      }

      function apply(ctx) {
        ctxRef.current = ctx;
        ensureStyles();

        try {
          if (ctx.locale && typeof ctx.locale.register === "function") {
            /* register synchronously: the slot entries below reference this namespace */
            var disposeDictionary = ctx.locale.register(NS, { zh: STR.zh, en: STR.en });
            ctx.effect(function () {
              return disposeDictionary;
            }, "delete-session: dictionaries");
          }
        } catch (error) {
          /* the plugin still works with its own dictionary */
        }

        ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
          yield ctx.slots.register(
            {
              name: "sidebar.workspaces.session.menu.item",
              id: "delete-session",
              order: 500,
              locale: NS,
            },
            DeleteSessionMenuItem
          );
        });

        ctx.slots.inject("shell.overlay", function* () {
          yield ctx.slots.register(
            {
              name: "shell.overlay",
              id: "delete-session-confirm",
              locale: NS,
            },
            DeleteSessionConfirmDialog
          );
        });
      }

      return {
        inject: ["slots", "locale", "sessions"],
        apply: apply,
      };
    },
  });
})();
