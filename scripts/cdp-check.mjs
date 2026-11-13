// CDP smoke test: the DSH web instance is already open in a headless Edge;
// this script drives it to prove the plugin's menu entry and dialog render.
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
  await sleep(500);

  console.log("url:", await evaluate(ws, "location.href"));
  console.log("ModuleLoader:", await evaluate(ws, "typeof window.__ModuleLoader__"));
  console.log("plugin stylesheet:", await evaluate(ws, "!!document.querySelector('style[data-dsds]')"));

  const rowInfo = await evaluate(ws, `(() => {
    const buttons = [...document.querySelectorAll('button')];
    return {
      total: buttons.length,
      labels: buttons.map((b) => (b.getAttribute('aria-label') || b.title || b.textContent || '').trim()).filter(Boolean).slice(0, 30),
    };
  })()`);
  console.log("buttons:", JSON.stringify(rowInfo));

  const opened = await evaluate(ws, `(() => {
    const buttons = [...document.querySelectorAll('button')];
    const label = (b) => (b.getAttribute('aria-label') || b.title || '').trim();
    const menu = buttons.find((b) => /会话.*的操作|session.*actions/i.test(label(b)))
      ?? buttons.find((b) => /^(⋯|…|\.\.\.|更多|more)$/i.test(label(b)));
    if (!menu) return { ok: false };
    menu.click();
    return { ok: true, label: label(menu) };
  })()`);
  console.log("menu trigger:", JSON.stringify(opened));
  await sleep(1500);

  const entry = await evaluate(ws, `(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    const item = items.find((el) => /删除会话|Delete session/i.test(el.textContent || ''));
    return {
      found: !!item,
      text: item ? (item.textContent || '').trim() : null,
      danger: item ? item.getAttribute('data-danger') : null,
      menuitems: items.map((el) => (el.textContent || '').trim()),
    };
  })()`);
  console.log("delete menu entry:", JSON.stringify(entry));

  if (!entry.found) {
    ws.close();
    return;
  }

  await evaluate(ws, `(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => /删除会话|Delete session/i.test(el.textContent || ''));
    item.click();
    return true;
  })()`);
  await sleep(1500);

  const dialog = await evaluate(ws, `(() => {
    const dlg = document.querySelector('.dsds-dialog');
    if (!dlg) return { ok: false, overlays: document.querySelectorAll('.dsds-overlay').length };
    return {
      ok: true,
      title: (dlg.querySelector('.dsds-dialog-title') || {}).textContent,
      description: (dlg.querySelector('.dsds-dialog-description') || {}).textContent,
      buttons: [...dlg.querySelectorAll('button')].map((b) => (b.textContent || '').trim()),
      role: dlg.getAttribute('role'),
      ariaModal: dlg.getAttribute('aria-modal'),
    };
  })()`);
  console.log("confirm dialog:", JSON.stringify(dialog));

  // Cancel must close the dialog without deleting anything.
  await evaluate(ws, `(() => {
    const dlg = document.querySelector('.dsds-dialog');
    const cancel = [...dlg.querySelectorAll('button')].find((b) => /取消|Cancel/i.test(b.textContent || ''));
    if (cancel) cancel.click();
    return true;
  })()`);
  await sleep(800);
  console.log("dialog after cancel:", await evaluate(ws, "!!document.querySelector('.dsds-dialog')"));

  ws.close();
}

main().catch((error) => {
  console.error("FAILED:", error.message);
  process.exitCode = 1;
});
