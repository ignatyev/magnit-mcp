import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { MagnitApiError } from "./magnit-api.js";
import { CdpClient, selectAdbDevice, validateDebugWebSocket } from "./android-login.js";

const execFile = promisify(execFileCallback);
const ORIGIN = "https://magnit.ru";
const CART_PATH = "/webgate/v1/carts/lite";
const MAX_BODY_BYTES = 2_000_000;
const HEADER_ALLOWLIST = new Set([
  "accept", "content-type", "x-client-name", "x-device-platform",
  "x-service", "x-store-code", "x-magnit-bff", "x-permissions-jwt",
  "x-device-id", "x-device-tag", "x-app-version", "x-platform-version",
  "x-new-magnit",
]);

function fail(code, message) { return new MagnitApiError(code, message); }

function validateTarget(raw, method) {
  let url;
  try { url = new URL(raw); }
  catch { throw fail("chrome_request_rejected", "Invalid browser request URL."); }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash)
    throw fail("chrome_request_rejected", "Browser requests must stay on magnit.ru.");
  const path = url.pathname;
  const allowed = path === CART_PATH ? ["GET", "PUT"] :
    path === "/webgate/v2/goods/search" ? ["POST"] :
    /^\/webgate\/v3\/categories\/store\/[0-9]{4,8}$/.test(path) ? ["GET"] :
    /^\/webgate\/v2\/goods\/[A-Za-z0-9._:-]{1,128}\/stores\/[0-9]{4,8}$/.test(path) ? ["GET"] :
    path === "/webgate/customer_addresses/v1/address_book" ? ["GET"] :
    path === "/webgate/v1/stores-facade/store" ? ["POST"] :
    path === "/webgate/v2/orders/history/list" ? ["GET"] : [];
  if (!allowed.includes(method))
    throw fail("chrome_request_rejected", "This Magnit endpoint or method is not allowed.");
  return path + url.search;
}

function allowedBrowserHeaders(source) {
  const result = {};
  for (const [key, value] of Object.entries(source || {})) {
    const name = key.toLowerCase();
    if (HEADER_ALLOWLIST.has(name) && typeof value === "string" &&
        value.length <= 8192 && !/[\r\n\0]/.test(value)) result[name] = value;
  }
  // Chrome generates Cookie, User-Agent, Origin, Referer and sec-* itself.
  return result;
}

function evalFetchExpression(request) {
  return "(async()=>{const req=" + JSON.stringify(request) + ";" +
    "if(location.origin!=='https://magnit.ru')return {status:0,error:'origin_mismatch'};" +
    "const target=new URL(req.path,location.origin);" +
    "if(target.origin!==location.origin)return {status:0,error:'origin_mismatch'};" +
    "const controller=new AbortController();" +
    "const timer=setTimeout(()=>controller.abort(),20000);" +
    "try{const response=await fetch(target.href,{" +
    "method:req.method,headers:req.headers,credentials:'include',redirect:'error'," +
    "signal:controller.signal,...(req.body!==null?{body:req.body}:{})});" +
    "const body=await response.text();" +
    "if(body.length>2000000)return {status:0,error:'response_too_large'};" +
    "return {status:response.status,body};" +
    "}catch{return {status:0,error:'network_failed'}}" +
    "finally{clearTimeout(timer)}})()";
}

async function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Run a bounded sequence of same-origin browser requests in a temporary
// authenticated official Chrome tab. No Node.js HTTPS fallback is possible.
export async function withMagnitChrome({
  session, operation, requestedSerial = process.env.ANDROID_DEVICE_SERIAL || "",
  adb = async args => (await execFile("adb", args, {
    encoding: "utf8", timeout: 12_000, maxBuffer: 64 * 1024,
  })).stdout, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket,
}) {
  if (!session?.cookie || session.context?.observedInBrowser !== true ||
      !["express", "dostavka"].includes(session.context.service) ||
      !/^[0-9]{4,8}$/.test(session.context.storeCode))
    throw fail("chrome_context_required", "Сначала синхронизируйте нужную корзину в официальном Chrome.");
  if (typeof operation !== "function")
    throw fail("invalid_arguments", "Chrome operation must be a function.");

  let serial = null, port = null, cdp = null, targetId = null, sessionId = null;
  try {
    const output = String(await adb(["devices", "-l"]));
    const devices = output.split(/\r?\n/).slice(1).map(s => s.trim().split(/\s+/))
      .filter(parts => parts.length >= 2).map(([serial, state]) => ({ serial, state }));
    const device = selectAdbDevice(devices, requestedSerial);
    if (!device) throw fail("chrome_device_unavailable", "ADB не видит Chrome. Проверьте беспроводную отладку.");
    serial = device.serial;

    const forwarded = String(await adb(["-s", serial, "forward", "tcp:0", "localabstract:chrome_devtools_remote"])).trim();
    const match = forwarded.match(/(?:^|\D)([0-9]{2,5})(?:\D|$)/);
    port = match ? Number(match[1]) : null;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      port = null;
      throw fail("chrome_device_unavailable", "Не удалось соединиться с Chrome DevTools.");
    }
    const response = await fetchImpl("http://127.0.0.1:" + port + "/json/version", {
      redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw fail("chrome_device_unavailable", "Chrome DevTools не ответил.");
    const info = await response.json();
    if (!validateDebugWebSocket(info.webSocketDebuggerUrl, port, "browser"))
      throw fail("chrome_device_unavailable", "Недопустимый адрес Chrome DevTools.");
    cdp = await CdpClient.connect(info.webSocketDebuggerUrl, WebSocketImpl);

    const target = await cdp.send("Target.createTarget", { url: "about:blank" }, 10_000);
    if (typeof target?.targetId !== "string" || !/^[A-Za-z0-9-]+$/.test(target.targetId))
      throw fail("chrome_device_unavailable", "Chrome не создал временную вкладку.");
    targetId = target.targetId;
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true }, 10_000);
    if (typeof attached?.sessionId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(attached.sessionId))
      throw fail("chrome_device_unavailable", "Chrome не разрешил подключиться к вкладке.");
    sessionId = attached.sessionId;
    await cdp.send("Page.enable", {}, 10_000, sessionId);
    await cdp.send("Runtime.enable", {}, 10_000, sessionId);
    const nav = await cdp.send("Page.navigate", { url: ORIGIN + "/" }, 12_000, sessionId);
    if (nav?.errorText) throw fail("chrome_navigation_failed", "Chrome не открыл magnit.ru.");

    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const value = await cdp.send("Runtime.evaluate", {
          expression: "location.origin", returnByValue: true,
        }, 2500, sessionId);
        if (!value.exceptionDetails && value?.result?.value === ORIGIN) { ready = true; break; }
      } catch { /* Page can still be navigating. */ }
      await delay(300);
    }
    if (!ready) throw fail("chrome_navigation_failed", "Не удалось открыть magnit.ru в Chrome.");

    const browserFetch = async (rawUrl, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      const path = validateTarget(rawUrl, method);
      const headers = allowedBrowserHeaders(options.headers);
      if (path.split("?")[0] === CART_PATH &&
          (headers["x-service"] !== session.context.service ||
           headers["x-store-code"] !== session.context.storeCode))
        throw fail("chrome_context_mismatch", "Код магазина или сервис не соответствует Chrome.");
      const body = typeof options.body === "string" ? options.body : null;
      if (body && Buffer.byteLength(body, "utf8") > 120_000)
        throw fail("chrome_request_rejected", "Слишком большой запрос для Chrome.");
      if (method === "GET" && body !== null)
        throw fail("chrome_request_rejected", "GET не должен содержать тело.");

      const command = await cdp.send("Runtime.evaluate", {
        expression: evalFetchExpression({ method, path, headers, body }),
        awaitPromise: true, returnByValue: true,
      }, 30_000, sessionId);
      const result = command?.result?.value;
      if (command?.exceptionDetails || !result || !Number.isInteger(result.status) ||
          result.status < 200 || result.status > 599 ||
          typeof result.body !== "string" ||
          Buffer.byteLength(result.body, "utf8") > MAX_BODY_BYTES)
        throw fail("chrome_request_failed", "Chrome не завершил запрос. Проверьте корзину перед повторной записью.");
      return new Response(result.body, {
        status: result.status, headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    };
    return await operation(browserFetch);
  } catch (error) {
    if (error instanceof MagnitApiError) throw error;
    throw fail("chrome_transport_unavailable", "Chrome недоступен для операции. Проверьте ADB и авторизацию Магнита.");
  } finally {
    if (cdp && targetId) {
      try { await cdp.send("Target.closeTarget", { targetId }, 3000); } catch {}
    }
    cdp?.close();
    if (serial && port) {
      try { await adb(["-s", serial, "forward", "--remove", "tcp:" + port]); } catch {}
    }
  }
}
