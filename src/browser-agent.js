import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CdpClient, selectAdbDevice, validateDebugWebSocket } from "./android-login.js";
import { MagnitApiError } from "./magnit-api.js";

const execFile = promisify(execFileCallback);
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const TAB_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CHECKOUT_ACTION = /(?:оформить\s*заказ|подтвердить\s*заказ|разместить\s*заказ|оплатить|оплата\s*сейчас|купить\s*в\s*1\s*клик|buy\s*now|place\s*order|confirm\s*order|complete\s*purchase|pay\s*now|pay\s*with|checkout|submit\s*order)/i;

function error(code, message) { return new MagnitApiError(code, message); }
function requireString(value, name, max = 320) {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
      /[\r\n\0]/.test(value)) throw error("browser_invalid_arguments", "Invalid " + name);
  return value;
}

// Avoid turning the user's phone into a network scanner or opening local device
// configuration pages. All destinations are user-chosen public HTTPS websites.
export function validateShoppingUrl(value) {
  const input = requireString(value, "url", 2048);
  let parsed;
  try { parsed = new URL(input); } catch { throw error("browser_invalid_url", "Введите полный адрес HTTPS-магазина."); }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port ||
      !host.includes(".") || host === "localhost" ||
      /\.(?:local|internal|localhost|test|invalid)$/.test(host) ||
      /^\d+(?:\.\d+){3}$/.test(host) || host.includes(":"))
    throw error("browser_invalid_url", "Разрешены только общедоступные HTTPS-сайты без нестандартного порта.");
  return parsed.href;
}

function safePageUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return null;
    try { validateShoppingUrl(raw); } catch { return null; }
    return parsed.origin + parsed.pathname.slice(0, 220);
  } catch { return null; }
}

async function connectAndroidChrome({ requestedSerial = process.env.ANDROID_DEVICE_SERIAL || "",
  adb = async args => (await execFile("adb", args, {
    encoding: "utf8", timeout: 12_000, maxBuffer: 64 * 1024,
  })).stdout,
  fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket,
} = {}) {
  let serial = null, port = null, cdp = null;
  try {
    const output = String(await adb(["devices", "-l"]));
    const devices = output.split(/\r?\n/).slice(1).map(line => line.trim().split(/\s+/))
      .filter(parts => parts.length >= 2).map(([serial, state]) => ({ serial, state }));
    const device = selectAdbDevice(devices, requestedSerial);
    if (!device) throw error("browser_adb_unavailable", "Телефон не подключён к ADB. Проверьте беспроводную отладку.");
    serial = device.serial;
    const forwarded = String(await adb(["-s", serial, "forward", "tcp:0", "localabstract:chrome_devtools_remote"])).trim();
    const match = forwarded.match(/(?:^|\D)(\d{2,5})(?:\D|$)/);
    port = match ? Number(match[1]) : null;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      port = null;
      throw error("browser_cdp_unavailable", "ADB не подключил Chrome DevTools.");
    }
    const response = await fetchImpl("http://127.0.0.1:" + port + "/json/version", {
      redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw error("browser_cdp_unavailable", "Chrome DevTools не отвечает.");
    const version = await response.json();
    if (!validateDebugWebSocket(version.webSocketDebuggerUrl, port, "browser"))
      throw error("browser_cdp_unavailable", "Chrome вернул неизвестный DevTools endpoint.");
    cdp = await CdpClient.connect(version.webSocketDebuggerUrl, WebSocketImpl);
    return {
      cdp,
      close: async () => {
        cdp?.close();
        if (serial && port) {
          try { await adb(["-s", serial, "forward", "--remove", "tcp:" + port]); } catch {}
        }
      },
    };
  } catch (cause) {
    cdp?.close();
    if (serial && port) {
      try { await adb(["-s", serial, "forward", "--remove", "tcp:" + port]); } catch {}
    }
    if (cause instanceof MagnitApiError) throw cause;
    throw error("browser_cdp_unavailable", "Не удалось связаться с Chrome на Android.");
  }
}

async function withBrowser(action, options) {
  const connection = await connectAndroidChrome(options);
  try { return await action(connection.cdp); }
  finally { await connection.close(); }
}

async function targetList(cdp) {
  const result = await cdp.send("Target.getTargets", {}, 10_000);
  return Array.isArray(result?.targetInfos) ? result.targetInfos
    .filter(info => info?.type === "page" && TAB_ID.test(info.targetId) && safePageUrl(info.url))
    : [];
}
async function withTab(cdp, tabId, operation) {
  const selected = requireString(tabId, "tab_id", 128);
  if (!TAB_ID.test(selected)) throw error("browser_invalid_arguments", "Некорректный ID вкладки.");
  const tabs = await targetList(cdp);
  const tab = tabs.find(info => info.targetId === selected);
  if (!tab) throw error("browser_tab_not_found", "Вкладка недоступна. Используйте browser_list_tabs.");
  const attached = await cdp.send("Target.attachToTarget", {
    targetId: selected, flatten: true,
  }, 10_000);
  const sid = attached?.sessionId;
  if (typeof sid !== "string" || !TAB_ID.test(sid))
    throw error("browser_cdp_unavailable", "Не удалось подключиться к вкладке Chrome.");
  try {
    await cdp.send("Runtime.enable", {}, 10_000, sid);
    await cdp.send("Page.enable", {}, 10_000, sid);
    return await operation(sid, tab);
  } finally {
    try { await cdp.send("Target.detachFromTarget", { sessionId: sid }, 3000); } catch {}
  }
}
async function evaluate(cdp, sessionId, callback, args = {}, timeoutMs = 12_000) {
  const expression = "(" + callback.toString() + ")(" + JSON.stringify(args) + ")";
  const reply = await cdp.send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  }, timeoutMs, sessionId);
  if (reply?.exceptionDetails || reply?.result?.subtype === "error")
    throw error("browser_page_error", "Страница не выполнила действие.");
  return reply?.result?.value;
}

// The page helpers are constant functions, not agent-authored JavaScript.
// URLs, field values and CSS selectors are always serialized as data.
function inspectDom({ limit = 35, textLimit = 2000 } = {}) {
  function visible(el) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== "hidden" &&
      style.display !== "none";
  }
  function selector(el) {
    const segments = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 15; n = n.parentElement, i++) {
      const tag = n.tagName.toLowerCase();
      if (n.id && document.querySelectorAll("#" + CSS.escape(n.id)).length === 1) {
        segments.unshift("#" + CSS.escape(n.id)); break;
      }
      if (n.parentElement) {
        const same = Array.from(n.parentElement.children).filter(c => c.tagName === n.tagName);
        segments.unshift(tag + (same.length > 1 ?
          ":nth-of-type(" + (same.indexOf(n) + 1) + ")" : ""));
      } else segments.unshift(tag);
    }
    return segments.join(" > ");
  }
  const nodes = Array.from(document.querySelectorAll(
    "button,a[href],input:not([type=hidden]),textarea,select,[role=button],[contenteditable=true]"
  )).filter(visible).slice(0, Math.min(limit, 65));
  const elements = nodes.map(el => ({
    selector: selector(el),
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute("type") || "").slice(0, 32),
    role: (el.getAttribute("role") || "").slice(0, 32),
    text: (el.getAttribute("aria-label") || el.getAttribute("placeholder") ||
      (el.tagName === "INPUT" ? "" : el.innerText) || "").trim().slice(0, 110),
    disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
    sensitive: el.matches("input[type=password],input[autocomplete=one-time-code]," +
      "input[autocomplete=cc-number],input[autocomplete=cc-csc]"),
  }));
  const text = (document.body?.innerText || "").slice(0, Math.min(textLimit, 5000));
  return {
    title: document.title.slice(0, 170),
    url: location.origin + location.pathname.slice(0, 220),
    ready_state: document.readyState,
    text, elements,
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
  };
}
function clickTarget({ selector, forbiddenWords }) {
  let matches;
  try { matches = document.querySelectorAll(selector); }
  catch { return { ok: false, code: "invalid_selector" }; }
  if (matches.length !== 1) return { ok: false, code: matches.length ? "multiple_elements" : "element_not_found" };
  const el = matches[0];
  const label = (el.getAttribute("aria-label") || el.innerText || el.value || "").trim().slice(0, 170);
  if (new RegExp(forbiddenWords, "i").test(label) ||
      new RegExp(forbiddenWords, "i").test(String(el.getAttribute("href") || "")))
    return { ok: false, code: "checkout_blocked" };
  if (el.closest("form")?.querySelector('input[autocomplete="cc-number"],input[autocomplete="cc-csc"]'))
    return { ok: false, code: "payment_form_blocked" };
  if (el.disabled || el.getAttribute("aria-disabled") === "true")
    return { ok: false, code: "element_disabled" };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height || rect.left >= innerWidth || rect.top >= innerHeight ||
      rect.right <= 0 || rect.bottom <= 0) return { ok: false, code: "element_not_visible" };
  return { ok: true, x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2), label: label.slice(0, 80) };
}
function typeInto({ selector, text, replace }) {
  let matches;
  try { matches = document.querySelectorAll(selector); }
  catch { return { ok: false, code: "invalid_selector" }; }
  if (matches.length !== 1) return { ok: false, code: matches.length ? "multiple_elements" : "element_not_found" };
  const el = matches[0];
  const tag = el.tagName.toLowerCase();
  const kind = (el.getAttribute("type") || "text").toLowerCase();
  const meta = [el.name, el.id, el.autocomplete, el.getAttribute("aria-label")].join(" ").toLowerCase();
  if (!["input", "textarea"].includes(tag) && !el.isContentEditable)
    return { ok: false, code: "not_text_input" };
  if (tag === "input" && !["text", "search", "email", "tel", "url", "number"].includes(kind))
    return { ok: false, code: "restricted_input" };
  if (/(?:password|passcode|otp|one-time|credit.card|card.number|cvv|cvc|cc-number|cc-csc|security.code)/.test(meta))
    return { ok: false, code: "sensitive_input" };
  if (el.disabled || el.readOnly) return { ok: false, code: "element_disabled" };
  el.focus();
  if (el.isContentEditable) {
    el.textContent = replace ? text : el.textContent + text;
  } else {
    const setter = Object.getOwnPropertyDescriptor(
      tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value"
    )?.set;
    if (!setter) return { ok: false, code: "unsupported_input" };
    setter.call(el, replace ? text : el.value + text);
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, character_count: text.length };
}
function waitFor({ selector, timeoutMs }) {
  return new Promise(resolve => {
    const start = Date.now();
    const poll = () => {
      let el;
      try { el = document.querySelector(selector); }
      catch { resolve({ ok: false, code: "invalid_selector" }); return; }
      if (el && el.getBoundingClientRect().width && el.getBoundingClientRect().height)
        { resolve({ ok: true, found: true }); return; }
      if (Date.now() - start >= timeoutMs) { resolve({ ok: false, code: "wait_timeout" }); return; }
      setTimeout(poll, 150);
    };
    poll();
  });
}
function scrollPage({ x, y }) {
  scrollBy({ left: x, top: y, behavior: "instant" });
  return { ok: true, x: Math.round(scrollX), y: Math.round(scrollY) };
}

export async function browserAction(name, args = {}, deps = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw error("browser_invalid_arguments", "Ожидались параметры браузерного инструмента.");
  const action = String(name);
  if (!["browser_list_tabs","browser_open_tab","browser_navigate","browser_inspect",
        "browser_get_page_state","browser_click","browser_type","browser_scroll",
        "browser_wait_for","browser_screenshot"].includes(action))
    throw error("browser_unknown_tool", "Неизвестная команда браузера.");

  if (action === "browser_open_tab" || action === "browser_navigate")
    validateShoppingUrl(args.url);
  if (action === "browser_click" || action === "browser_type" || action === "browser_wait_for")
    requireString(args.selector, "selector", 320);
  if (action === "browser_type" &&
      (typeof args.text !== "string" || args.text.length > 1000 || /[\r\0]/.test(args.text)))
    throw error("browser_invalid_arguments", "Длина текста должна быть не больше 1000 символов.");
  return withBrowser(async cdp => {
    if (action === "browser_list_tabs") {
      const tabs = await targetList(cdp);
      return { tabs: tabs.slice(0, 60).map(t => ({
        tab_id: t.targetId, title: String(t.title || "").slice(0, 170),
        url: safePageUrl(t.url),
      })) };
    }
    if (action === "browser_open_tab") {
      const url = validateShoppingUrl(args.url);
      const target = await cdp.send("Target.createTarget", { url }, 12_000);
      if (!TAB_ID.test(target?.targetId || ""))
        throw error("browser_tab_unavailable", "Chrome не создал вкладку.");
      try { await cdp.send("Target.activateTarget", { targetId: target.targetId }, 5000); } catch {}
      return { tab_id: target.targetId, url: safePageUrl(url), opened: true };
    }
    return withTab(cdp, args.tab_id, async (sid, tab) => {
      if (action === "browser_navigate") {
        const url = validateShoppingUrl(args.url);
        const result = await cdp.send("Page.navigate", { url }, 15_000, sid);
        if (result?.errorText) throw error("browser_navigation_failed", "Chrome не открыл сайт.");
        return { navigated: true, tab_id: tab.targetId, url: safePageUrl(url) };
      }
      if (action === "browser_inspect" || action === "browser_get_page_state") {
        const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(args.limit, 65)) : 35;
        const textLimit = action === "browser_get_page_state" ? 3500 : 1600;
        return await evaluate(cdp, sid, inspectDom, { limit, textLimit });
      }
      if (action === "browser_click") {
        const found = await evaluate(cdp, sid, clickTarget, {
          selector: args.selector, forbiddenWords: CHECKOUT_ACTION.source,
        });
        if (!found?.ok) throw error(found?.code || "browser_click_failed",
          "Нельзя нажать элемент: " + (found?.code || "unknown"));
        // Android uses touch; do not silently repeat an ambiguous gesture.
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart",
          touchPoints: [{ x: found.x, y: found.y }] }, 10_000, sid);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd",
          touchPoints: [] }, 10_000, sid);
        return { clicked: true, tab_id: tab.targetId, label: found.label,
          outcome_verified: false, note: "Проверьте корзину или состояние страницы. При ошибке не повторяйте клик вслепую." };
      }
      if (action === "browser_type") {
        const typed = await evaluate(cdp, sid, typeInto, {
          selector: args.selector, text: args.text, replace: args.replace !== false,
        });
        if (!typed?.ok) throw error(typed?.code || "browser_type_failed",
          "Не удалось заполнить поле: " + (typed?.code || "unknown"));
        return { typed: true, tab_id: tab.targetId, character_count: typed.character_count };
      }
      if (action === "browser_scroll") {
        const x = Number.isInteger(args.x) ? Math.max(-2000, Math.min(args.x, 2000)) : 0;
        const y = Number.isInteger(args.y) ? Math.max(-2000, Math.min(args.y, 2000)) : 600;
        return await evaluate(cdp, sid, scrollPage, { x, y });
      }
      if (action === "browser_wait_for") {
        const timeoutMs = Number.isInteger(args.timeout_ms) ?
          Math.max(300, Math.min(args.timeout_ms, 12000)) : 5000;
        return await evaluate(cdp, sid, waitFor, { selector: args.selector, timeoutMs }, timeoutMs + 3000);
      }
      if (action === "browser_screenshot") {
        const result = await cdp.send("Page.captureScreenshot", { format: "png",
          captureBeyondViewport: false }, 15_000, sid);
        if (typeof result?.data !== "string" || result.data.length > 8_000_000)
          throw error("browser_screenshot_failed", "Chrome не вернул допустимый скриншот.");
        const buffer = Buffer.from(result.data, "base64");
        if (buffer.length > MAX_SCREENSHOT_BYTES ||
            !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
          throw error("browser_screenshot_failed", "Некорректный PNG от Chrome.");
        const dir = resolve(process.env.BROWSER_SCREENSHOT_DIR || "./data/browser-screenshots");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, "chrome-" + randomUUID() + ".png");
        await writeFile(path, buffer, { mode: 0o600, flag: "wx" });
        return { screenshot_file: path, bytes: buffer.length, tab_id: tab.targetId,
          note: "Файл остаётся локально в Termux; он может содержать личные данные страницы." };
      }
      throw error("browser_unknown_tool", "Unknown browser action.");
    });
  }, deps);
}
