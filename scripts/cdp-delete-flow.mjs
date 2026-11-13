// Drives the plugin's delete confirmation flow in the running headless Edge
// without touching real session data: window.fetch is stubbed so the client
// half still exercises its real request/refresh/close code path.
const DEBUG_PORT = process.argv[2] ?? "9222";

let nextId = 1;
function send(ws, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 20000);
    const handler = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const result = await send(ws, "Runtime.evaluate", { expression, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(`eval failed: ${result.exceptionDetails.text ?? "unknown"}`);
  }
  return result.result.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OPEN_MENU = `(() => {
  const label = (b) => (b.getAttribute('aria-label') || b.title || '').trim();
  const menu = [...document.querySelectorAll('button')].find((b) => /会话.*的操作|session.*actions/i.test(label(b)));
  if (!menu) return { ok: false };
  menu.click();
  return { ok: true, label: label(menu) };
})()`;

const OPEN_ENTRY = `(() => {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => /删除会话|Delete session/i.test(el.textContent || ''));
  if (!item) return { ok: false };
  item.click();
  return { ok: true };
})()`;

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("ws failed")));
  });
  await send(ws, "Runtime.enable");
  await sleep(300);

  // Stub fetch so the real delete is never sent.
  const stub = await evaluate(ws, `(() => {
    if (window.__dsdsOriginalFetch) return { ok: true, already: true };
    window.__dsdsOriginalFetch = window.fetch;
    window.__dsdsCalls = [];
    window.fetch = function (url, options) {
      window.__dsdsCalls.push({ url: String(url), method: (options && options.method) || 'GET', body: options && options.body ? String(options.body) : null });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, sessionId: 'stubbed', detached: false, removedFiles: true }),
        text: () => Promise.resolve('{}'),
      });
    };
    return { ok: true };
  })()`);
  console.log("fetch stub:", JSON.stringify(stub));

  console.log("menu trigger:", JSON.stringify(await evaluate(ws, OPEN_MENU)));
  await sleep(1200);
  console.log("open entry:", JSON.stringify(await evaluate(ws, OPEN_ENTRY)));
  await sleep(1200);

  const before = await evaluate(ws, `(() => {
    const dlg = document.querySelector('.dsds-dialog');
    return {
      open: !!dlg,
      title: dlg ? (dlg.querySelector('.dsds-dialog-title') || {}).textContent : null,
      sessionRows: document.querySelectorAll('.dsds-menu-item').length,
    };
  })()`);
  console.log("dialog before confirm:", JSON.stringify(before));

  const clicked = await evaluate(ws, `(() => {
    const dlg = document.querySelector('.dsds-dialog');
    const confirm = [...dlg.querySelectorAll('button')].find((b) => /^(删除|Delete)$/i.test((b.textContent || '').trim()));
    if (!confirm) return { ok: false };
    confirm.click();
    return { ok: true };
  })()`);
  console.log("confirm clicked:", JSON.stringify(clicked));
  await sleep(1500);

  console.log("fetch calls:", JSON.stringify(await evaluate(ws, "window.__dsdsCalls")));
  console.log("dialog after confirm:", await evaluate(ws, "!!document.querySelector('.dsds-dialog')"));

  // Restore the real fetch so the page keeps working normally.
  await evaluate(ws, `(() => {
    if (window.__dsdsOriginalFetch) window.fetch = window.__dsdsOriginalFetch;
    return true;
  })()`);

  ws.close();
}

main().catch((error) => {
  console.error("FAILED:", error.message);
  process.exitCode = 1;
});
