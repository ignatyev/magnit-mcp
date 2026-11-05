import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { MagnitApiError, validateStoreCode } from "./magnit-api.js";

const execFile = promisify(execFileCallback);
const CART_URL = "https://magnit.ru/webgate/v1/carts/lite";
const CART_PATH = "/webgate/v1/carts/lite";
const MAX_DEBUG_JSON = 128_000;
const HEADER_ALLOWLIST = new Set([
  "x-service", "x-store-code", "x-magnit-bff", "x-permissions-jwt",
  "x-device-id", "x-device-tag", "x-app-version", "x-platform-version",
  "x-client-name", "x-device-platform", "x-new-magnit", "user-agent",
]);
const SAFE_LOGIN_FAILURES = new Set(["setup_required", "adb_missing", "adb_command_failed", "adb_forward_failed", "chrome_debug_endpoint_unavailable", "chrome_target_create_failed", "chrome_target_invalid", "chrome_target_attach_failed", "chrome_tab_activate_failed", "cdp_connect_failed", "cdp_network_enable_failed", "chrome_tab_navigate_failed", "login_unavailable"]);

function safeContext(headers) {
  const normalized = Object.create(null);
  for (const [key, value] of Object.entries(headers || {})) {
    const name = String(key).toLowerCase();
    if (!HEADER_ALLOWLIST.has(name)) continue;
    const text = typeof value === "string" ? value : Array.isArray(value) ? value.join(",") : "";
    if (text.length > 0 && text.length <= 8192 && !/[\r\n\0]/.test(text)) normalized[name] = text;
  }
  if (!["express", "dostavka"].includes(normalized["x-service"])) return null;
  try { validateStoreCode(normalized["x-store-code"]); } catch { return null; }
  if (!normalized["x-magnit-bff"]) return null;
  const result = {
    service: normalized["x-service"],
    storeCode: normalized["x-store-code"],
    bff: normalized["x-magnit-bff"],
    permissionsJwt: normalized["x-permissions-jwt"] === "null" || normalized["x-permissions-jwt"]?.length >= 64 ? normalized["x-permissions-jwt"] : null,
    observedInBrowser: true,
  };
  for (const [header, field, max] of [
    ["x-device-id", "deviceId", 128],
    ["x-device-tag", "deviceTag", 128],
    ["x-app-version", "appVersion", 64],
    ["x-platform-version", "platformVersion", 96],
    ["user-agent", "userAgent", 512],
  ]) {
    const value = normalized[header];
    if (typeof value === "string" && value.length <= max) result[field] = value;
  }
  return result;
}

export function extractCartRequestContext(method, requestUrl, headers) {
  if (typeof requestUrl !== "string" || !["GET", "PUT"].includes(String(method).toUpperCase())) return null;
  let url;
  try { url = new URL(requestUrl); } catch { return null; }
  if (url.origin !== "https://magnit.ru" || url.username || url.password || url.pathname !== CART_PATH || url.search || url.hash) return null;
  return safeContext(headers);
}

function allowedCartHeaders(headers) {
  const safe = Object.create(null);
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase();
    if (HEADER_ALLOWLIST.has(key) && typeof value === "string" && value.length > 0 && value.length <= 8192 && !/[\r\n\0]/.test(value)) safe[key] = value;
  }
  return safe;
}

export function magnitCookieHeader(cookies) {
  const pairs = [];
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (typeof cookie?.name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name)) continue;
    if (typeof cookie.value !== "string" || /[\r\n\0;]/.test(cookie.value)) continue;
    if (cookie.secure !== true) continue;
    const domain = String(cookie.domain || "").toLowerCase();
    if (domain !== "magnit.ru" && domain !== ".magnit.ru") continue;
    const path = typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/";
    if (!CART_PATH.startsWith(path)) continue;
    if (Number.isFinite(cookie.expires) && cookie.expires > 0 && cookie.expires * 1000 <= Date.now()) continue;
    pairs.push(`${cookie.name}=${cookie.value}`);
  }
  const header = pairs.join("; ");
  return header && Buffer.byteLength(header, "utf8") <= 8192 ? header : null;
}

export function selectAdbDevice(devices, requestedSerial = "") {
  const online = devices.filter((device) => device.state === "device" && device.serial);
  if (requestedSerial) return online.find((device) => device.serial === requestedSerial) || null;
  return online.length === 1 ? online[0] : null;
}

export async function isMagnitAuthenticated(session, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl("https://magnit.ru/_auth/session", {
      method: "GET",
      headers: { Accept: "application/json", Cookie: session.cookie },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    if (cause?.name === "TimeoutError" || cause?.name === "AbortError") throw new MagnitApiError("timeout", "Истекло время проверки сессии Магнит.");
    throw new MagnitApiError("upstream_unavailable", "Не удалось проверить сессию Магнит.");
  }
  if (response.status === 403) { await response.body?.cancel().catch(() => {}); throw new MagnitApiError("access_denied", "Магнит ограничил доступ к проверке сессии."); }
  if (response.status === 401) { await response.body?.cancel().catch(() => {}); return false; }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new MagnitApiError("upstream_error", "Не удалось проверить сессию Магнит."); }
  try {
    const text = await readDebugText(response, 64_000);
    const payload = JSON.parse(text);
    return payload?.authorized === true;
  } catch { throw new MagnitApiError("invalid_response", "Магнит вернул неизвестный ответ проверки сессии."); }
}

export function validateDebugWebSocket(raw, port, kind, expectedId = null) {
  try {
    const url = new URL(raw);
    const pathOk = kind === "browser"
      ? url.pathname === "/devtools/browser" || /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(url.pathname)
      : expectedId ? url.pathname === `/devtools/${kind}/${expectedId}` : new RegExp(`^/devtools/${kind}/[A-Za-z0-9-]+$`).test(url.pathname);
    return url.protocol === "ws:" && ["127.0.0.1", "localhost"].includes(url.hostname) && Number(url.port) === Number(port) && pathOk && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function parseDevices(output) {
  return String(output).split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/)).filter((fields) => fields.length >= 2).map(([serial, state]) => ({ serial, state }));
}

function publicLoginFailure(cause, stage) {
  if (cause?.code === "cancelled") return { code: "cancelled", message: "Вход отменён." };
  if (cause?.code === "setup_required") return { code: "setup_required", message: cause.publicMessage };
  if (cause?.code === "ENOENT" && stage === "adb_devices") return { code: "adb_missing", message: "Команда ADB не найдена. В Termux установите android-tools: pkg install android-tools, затем выполните adb devices -l." };
  if (stage === "adb_devices") return { code: "adb_command_failed", message: "ADB не смог проверить подключение. Проверьте беспроводную отладку, разрешение отладки на телефоне и вывод adb devices -l." };
  if (stage === "adb_forward") return { code: "adb_forward_failed", message: "ADB не создал локальную связь с Chrome. Разблокируйте телефон, откройте Chrome и повторите вход." };
  if (stage === "chrome_endpoint") return { code: "chrome_debug_endpoint_unavailable", message: "Chrome не открыл локальный DevTools endpoint. Убедитесь, что Chrome запущен и телефон разблокирован; обновление Chrome может помочь." };
  if (stage === "chrome_target") return { code: "chrome_target_create_failed", message: "Chrome не смог открыть новую вкладку Магнит. Откройте Chrome вручную, разблокируйте телефон и попробуйте ещё раз." };
  if (stage === "chrome_target_validation") return { code: "chrome_target_invalid", message: "Chrome вернул неизвестный ответ при создании вкладки. Ничего не сохранено; попробуйте обновить Chrome." };
  if (stage === "chrome_attach") return { code: "chrome_target_attach_failed", message: "Chrome создал вкладку, но не дал подключиться к ней. Обновите Chrome и попробуйте ещё раз." };
  if (stage === "chrome_activate") return { code: "chrome_tab_activate_failed", message: "Не удалось показать новую вкладку Chrome. Проверьте, что экран телефона включён и Chrome открыт." };
  if (stage === "cdp_connect") return { code: "cdp_connect_failed", message: "Не удалось подключить локальный DevTools к Chrome. Оставьте телефон разблокированным и попробуйте ещё раз." };
  if (stage === "cdp_enable") return { code: "cdp_network_enable_failed", message: "Chrome не включил наблюдение за входом и корзиной. Проверьте версию Chrome и повторите вход." };
  if (stage === "chrome_navigate") return { code: "chrome_tab_navigate_failed", message: "Chrome не смог открыть сайт Магнит в новой вкладке. Проверьте соединение телефона и повторите вход." };
  return { code: "login_unavailable", message: "Не удалось открыть защищённую вкладку Магнит. Проверьте Termux, ADB и Chrome; подробности запроса не сохранялись." };
}

async function readDebugText(response, maxBytes = MAX_DEBUG_JSON) {
  if (!response.ok || !response.body) throw new Error("debug_http_error");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error("debug_response_large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function responseJson(response, maxBytes = MAX_DEBUG_JSON) {
  return JSON.parse(await readDebugText(response, maxBytes));
}

class CdpClient extends EventEmitter {
  constructor(ws) {
    super();
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", async (event) => {
      let raw;
      try {
        const data = event.data;
        raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8") : await data.text();
      } catch { return; }
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (Number.isInteger(message.id)) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error("cdp_command_failed"));
        else pending.resolve(message.result);
      } else if (typeof message.method === "string") {
        this.emit(message.method, message.params || {}, message.sessionId || null);
      }
    });
    ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("cdp_closed")); }
      this.pending.clear();
    });
  }
  static async connect(url, WebSocketImpl, timeoutMs = 10_000) {
    const ws = new WebSocketImpl(url);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("cdp_connect_timeout")), timeoutMs);
        ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("cdp_connect_failed")); }, { once: true });
      });
    } catch (cause) { try { ws.close(); } catch {} throw cause; }
    return new CdpClient(ws);
  }
  send(method, params = {}, timeoutMs = 10_000, sessionId = null) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("cdp_command_timeout")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("cdp_send_failed")); }
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

// Store only redacted response counts from the official Android Chrome GET.
export function safeObservedCartSnapshot(rawBody, observedContext) {
  let body;
  try { body = JSON.parse(rawBody); } catch { return null; }
  if (!body || !Array.isArray(body.items) || !Array.isArray(body.formats) ||
      body.items.length > 250 || body.formats.length > 20 || !observedContext ||
      !["express", "dostavka"].includes(observedContext.service) ||
      !/^\d{4,8}$/.test(observedContext.storeCode)) return null;
  return {
    source: "official_android_chrome",
    service: observedContext.service,
    request_store_code: observedContext.storeCode,
    raw_item_count: body.items.length,
    raw_format_count: body.formats.length,
    selected_format_count: body.formats.filter(f=>f?.service === observedContext.service).length,
    unattributed_item_count: body.items.filter(item=>typeof item?.goodService !== "string").length,
    captured_at: new Date().toISOString(),
  };
}

export class AndroidMagnitLogin {
  constructor({ saveSession, requireCartContext = false, requestedSerial = process.env.ANDROID_DEVICE_SERIAL || "", exec = async (args) => (await execFile("adb", args, { encoding: "utf8", timeout: 12_000, maxBuffer: 64 * 1024 })).stdout, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, intervalMs = 1500, timeoutMs = 5 * 60_000 }) {
    this.saveSession = saveSession;
    this.requireCartContext = requireCartContext;
    this.requestedSerial = requestedSerial;
    this.exec = exec;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.state = { status: "idle", message: "Вход не запущен." };
    this.started = false;
    this.closed = false;
    this.authRequestIds = new Map();
    this.cartRequests = new Map();
    this.sessionSaveStarted = false;
    this.authenticated = false;
    this.verifying = false;
    this.context = null;
    this.cartSnapshot = null;
    this.cartCaptureComplete = false;
    this.cancelRequested = false;
  }

  snapshot() { return { ...this.state }; }
  setState(status, message) { const safeStatus = SAFE_LOGIN_FAILURES.has(status) || ["idle", "opening", "waiting", "verifying", "ready", "expired", "access_denied", "cancelled"].includes(status) ? status : "login_unavailable"; this.state = { status: safeStatus, message, updated_at: new Date().toISOString() }; }

  async start() {
    if (this.started) return this.startPromise || this.snapshot();
    this.started = true;
    this.startPromise = this.open();
    return this.startPromise;
  }

  async open() {
    this.setState("opening", "Открываем новую вкладку Магнит на выбранном Android-телефоне…");
    let stage = "adb_devices";
    try {
      const devices = parseDevices(await this.exec(["devices", "-l"]));
      if (this.cancelRequested) throw Object.assign(new Error("cancelled"), { code: "cancelled", publicMessage: "Вход отменён." });
      const selected = selectAdbDevice(devices, this.requestedSerial);
      if (!selected) {
        const message = devices.filter((device) => device.state === "device").length > 1 && !this.requestedSerial
          ? "Подключено несколько Android-устройств. Укажите ANDROID_DEVICE_SERIAL и перезапустите сервис."
          : "Android не найден или ADB не авторизован. Установите android-tools; вручную включите на телефоне беспроводную отладку и выполните adb pair/connect по адресам и портам из настроек телефона.";
        throw Object.assign(new Error("adb_device_unavailable"), { publicMessage: message, code: "setup_required" });
      }
      this.serial = selected.serial;
      stage = "adb_forward";
      const forwarded = String(await this.exec(["-s", this.serial, "forward", "tcp:0", "localabstract:chrome_devtools_remote"])).trim();
      const portMatch = forwarded.match(/(?:^|\D)(\d{2,5})(?:\D|$)/);
      const port = portMatch ? Number(portMatch[1]) : NaN;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("adb_forward_failed");
      this.port = port;
      if (this.cancelRequested) throw Object.assign(new Error("cancelled"), { code: "cancelled", publicMessage: "Вход отменён." });
      const debugBase = `http://127.0.0.1:${port}`;
      stage = "chrome_endpoint";
      const version = await responseJson(await this.fetchImpl(`${debugBase}/json/version`, { redirect: "error", signal: AbortSignal.timeout(5000) }));
      if (this.cancelRequested) throw Object.assign(new Error("cancelled"), { code: "cancelled", publicMessage: "Вход отменён." });
      if (!validateDebugWebSocket(version.webSocketDebuggerUrl, port, "browser")) throw new Error("debug_endpoint_invalid");
      stage = "cdp_connect";
      this.cdp = await CdpClient.connect(version.webSocketDebuggerUrl, this.WebSocketImpl);
      if (this.cancelRequested) throw Object.assign(new Error("cancelled"), { code: "cancelled", publicMessage: "Вход отменён." });
      stage = "chrome_target";
      const created = await this.cdp.send("Target.createTarget", { url: "about:blank" });
      stage = "chrome_target_validation";
      if (typeof created?.targetId !== "string" || !/^[A-Za-z0-9-]+$/.test(created.targetId)) throw new Error("debug_target_invalid");
      this.targetId = created.targetId;
      if (this.cancelRequested) throw Object.assign(new Error("cancelled"), { code: "cancelled", publicMessage: "Вход отменён." });
      stage = "chrome_attach";
      const attached = await this.cdp.send("Target.attachToTarget", { targetId: this.targetId, flatten: true });
      if (typeof attached?.sessionId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(attached.sessionId)) throw new Error("debug_session_invalid");
      this.sessionId = attached.sessionId;
      stage = "chrome_activate";
      await this.cdp.send("Target.activateTarget", { targetId: this.targetId });
      if (this.cancelRequested) throw Object.assign(new Error("cancelled"), { code: "cancelled", publicMessage: "Вход отменён." });
      this.cdp.on("Network.requestWillBeSent", (params, sessionId) => { if (sessionId === this.sessionId) this.observeRequest(params); });
      this.cdp.on("Network.requestWillBeSentExtraInfo", (params, sessionId) => { if (sessionId === this.sessionId) this.observeExtraHeaders(params); });
      this.cdp.on("Network.responseReceived", (params, sessionId) => { if (sessionId === this.sessionId) this.observeResponse(params); });
      this.cdp.on("Network.loadingFinished", (params, sessionId) => { if (sessionId === this.sessionId) void this.observeFinished(params); });
      this.cdp.on("Network.loadingFailed", (params, sessionId) => {
        if (sessionId === this.sessionId) { this.authRequestIds.delete(params.requestId); this.cartRequests.delete(params.requestId); }
      });
      stage = "cdp_enable";
      await this.cdp.send("Network.enable", {}, 10_000, this.sessionId);
      await this.cdp.send("Page.enable", {}, 10_000, this.sessionId);
      if (this.cancelRequested) throw Object.assign(new Error("cancelled"), { code: "cancelled", publicMessage: "Вход отменён." });
      stage = "chrome_navigate";
      const navigation = await this.cdp.send("Page.navigate", { url: "https://magnit.ru/" }, 15_000, this.sessionId);
      if (typeof navigation?.errorText === "string" && navigation.errorText) throw new Error("page_navigation_failed");
      if (this.cancelRequested) throw Object.assign(new Error("cancelled"), { code: "cancelled", publicMessage: "Вход отменён." });
      this.setState("waiting", this.requireCartContext
        ? "Откройте корзину нужной доставки в официальной вкладке Магнит. Сохраним параметры только после успешного чтения корзины сайтом."
        : "Завершите вход в официальной вкладке Магнит. Если вы уже вошли в Chrome, дождитесь проверки.");
      this.deadline = Date.now() + this.timeoutMs;
      this.timer = setInterval(() => void this.pollCookies(), this.intervalMs);
      void this.pollCookies();
      return this.snapshot();
    } catch (cause) {
      if (!this.cancelRequested) { const failure = publicLoginFailure(cause, stage); this.setState(failure.code, failure.message); }
      await this.cleanup();
      return this.snapshot();
    }
  }

  observeRequest(params) {
    const request = params?.request;
    const requestId = params?.requestId;
    if (typeof requestId === "string") this.authRequestIds.delete(requestId);
    if (String(request?.method).toUpperCase() !== "GET") return;
    // Never trust a cart request until the official tab receives HTTP 200.
    if (typeof requestId === "string" && typeof request?.url === "string" && request.url === CART_URL) {
      if (this.cartRequests.size >= 32) this.cartRequests.delete(this.cartRequests.keys().next().value);
      this.cartRequests.set(requestId, { headers: allowedCartHeaders(request.headers), confirmed: false });
    }
    if (typeof params?.requestId === "string" && typeof request?.url === "string") {
      try {
        const url = new URL(request.url);
        if (url.origin === "https://magnit.ru" && url.pathname === "/_auth/session" && !url.username && !url.password && !url.search && !url.hash) {
          if (this.authRequestIds.size >= 16) this.authRequestIds.delete(this.authRequestIds.keys().next().value);
          this.authRequestIds.set(requestId, false);
        }
      } catch {}
    }
  }

  observeExtraHeaders(params) {
    const pending = this.cartRequests.get(params?.requestId);
    if (pending) {
      Object.assign(pending.headers, allowedCartHeaders(params.headers));
      if (pending.confirmed) this.context = safeContext(pending.headers) || this.context;
    }
  }

  observeResponse(params) {
    const response = params?.response;
    const pending = this.cartRequests.get(params?.requestId);
    if (pending) {
      if (response?.status === 200 && response.url === CART_URL) {
        pending.confirmed = true;
        this.context = safeContext(pending.headers) || this.context;
      } else this.cartRequests.delete(params.requestId);
    }
    if (typeof params?.requestId !== "string" || !this.authRequestIds.has(params.requestId)) return;
    if (response?.status !== 200 || typeof response.url !== "string") { this.authRequestIds.delete(params.requestId); return; }
    let url;
    try { url = new URL(response.url); } catch { this.authRequestIds.delete(params.requestId); return; }
    if (url.origin !== "https://magnit.ru" || url.username || url.password || url.pathname !== "/_auth/session" || url.search || url.hash) { this.authRequestIds.delete(params.requestId); return; }
    this.authRequestIds.set(params.requestId, true);
  }

  async observeFinished(params) {
    const requestId = params?.requestId;
    if (typeof requestId !== "string") return;
    const pendingCart = this.cartRequests.get(requestId);
    if (pendingCart?.confirmed) {
      const observed = safeContext(pendingCart.headers);
      if (observed) {
        this.context = observed;
        try {
          const result = await this.cdp?.send("Network.getResponseBody", { requestId }, 10_000, this.sessionId);
          if (!this.closed && typeof result?.body === "string" && result.body.length <= 350_000) {
            const bytes = result.base64Encoded ? Buffer.from(result.body, "base64") : Buffer.from(result.body, "utf8");
            if (bytes.length <= 256_000)
              this.cartSnapshot = safeObservedCartSnapshot(bytes.toString("utf8"), observed);
          }
        } catch { /* Diagnostic response is optional. No raw data is retained. */ }
        finally { this.cartCaptureComplete = true; }
      }
    }
    this.cartRequests.delete(requestId);
    const confirmed = this.authRequestIds.get(requestId) === true;
    this.authRequestIds.delete(requestId);
    if (!confirmed) return;
    try {
      const result = await this.cdp?.send("Network.getResponseBody", { requestId }, 10_000, this.sessionId);
      if (this.closed || typeof result?.body !== "string" || result.body.length > 88_000) return;
      const body = result.base64Encoded ? Buffer.from(result.body, "base64") : Buffer.from(result.body, "utf8");
      if (body.length > 64_000) return;
      const payload = JSON.parse(body.toString("utf8"));
      this.authenticated = payload?.authorized === true;
    } catch { /* Ignore body access/parse errors; do not retain response data. */ }
  }

  async pollCookies() {
    if (this.closed || !this.cdp || this.polling) return;
    if (Date.now() >= this.deadline) {
      this.setState("expired", "Время входа истекло. Нажмите «Войти в Магнит» и попробуйте ещё раз.");
      await this.cleanup();
      return;
    }
    if (!this.authenticated) return;
    if (this.requireCartContext && (!this.context || !this.cartCaptureComplete)) return;
    this.polling=true;
    try {
      const result = await this.cdp.send("Network.getCookies", { urls: [CART_URL] }, 10_000, this.sessionId);
      if (this.closed) return;
      const cookie = magnitCookieHeader(result?.cookies);
      if (!cookie || !this.authenticated || this.verifying || this.sessionSaveStarted) return;
      this.sessionSaveStarted = true;
      this.verifying = true;
      this.setState("verifying", "Вход подтверждён. Сохраняем сессию Магнит…");
      const session = { cookie, context: this.context || null,
        ...(this.cartSnapshot ? { browserCartSnapshot: this.cartSnapshot } : {}) };
      try {
        await this.saveSession(session);
        this.setState("ready", "Вход сохранён. Для работы с корзиной выберите магазин в поиске.");
        await this.cleanup();
      } catch {
        if (this.closed) return;
        this.setState("login_unavailable", "Вход подтверждён, но локально сохранить сессию не удалось. Вкладка Магнит оставлена открытой; проверьте место и доступ к хранилищу.");
        await this.cleanup({ closeTab: false });
      } finally { this.verifying = false; }
    } catch {
      if (this.closed) return;
      this.setState("waiting", "Chrome пока не передал доступную сессию. Оставьте вкладку открытой и завершите вход на сайте Магнит.");
    } finally { this.polling=false; }
  }

  async cancel() {
    this.cancelRequested = true;
    if (this.closed) return this.snapshot();
    this.setState("cancelled", "Вход отменён; временная вкладка закрыта.");
    await this.startPromise?.catch(() => {});
    await this.cleanup();
    return this.snapshot();
  }

  async cleanup({ closeTab = true } = {}) {
    this.closed = true;
    clearInterval(this.timer);
    if (this.cleanupPromise) return this.cleanupPromise;
    const port=this.port;const targetId=this.targetId;const serial=this.serial;const cdp=this.cdp;
    this.port=null;this.targetId=null;this.cdp=null;this.sessionId=null;
    this.cleanupPromise=(async()=>{
    if (closeTab && cdp && targetId) try { await cdp.send("Target.closeTarget", { targetId }, 3000); } catch {}
    cdp?.close();
    if (serial && port) {
      try { await this.exec(["-s", serial, "forward", "--remove", `tcp:${port}`]); } catch {}
    }
    })();
    return this.cleanupPromise;
  }
}

export function createAndroidLogin(options) { return new AndroidMagnitLogin(options); }
