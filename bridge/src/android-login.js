import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { MagnitApiError, validateStoreCode } from "./magnit-api.js";
import { viewMagnitCart } from "./cart.js";

const execFile = promisify(execFileCallback);
const CART_URL = "https://magnit.ru/webgate/v1/carts/lite";
const CART_PATH = "/webgate/v1/carts/lite";
const MAX_DEBUG_JSON = 128_000;
const HEADER_ALLOWLIST = new Set(["x-service", "x-store-code", "x-magnit-bff", "x-permissions-jwt"]);

function safeContext(headers) {
  const normalized = Object.create(null);
  for (const [key, value] of Object.entries(headers || {})) {
    const name = String(key).toLowerCase();
    if (!HEADER_ALLOWLIST.has(name)) continue;
    const text = typeof value === "string" ? value : Array.isArray(value) ? value.join(",") : "";
    if (text.length > 0 && text.length <= 8192 && !/[\r\n\0]/.test(text)) normalized[name] = text;
  }
  if (normalized["x-service"] !== "express") return null;
  try { validateStoreCode(normalized["x-store-code"]); } catch { return null; }
  if (!normalized["x-magnit-bff"]) return null;
  return {
    service: normalized["x-service"],
    storeCode: normalized["x-store-code"],
    bff: normalized["x-magnit-bff"],
    permissionsJwt: normalized["x-permissions-jwt"]?.length >= 64 ? normalized["x-permissions-jwt"] : null,
  };
}

export function extractCartRequestContext(method, requestUrl, headers) {
  if (typeof requestUrl !== "string" || !["GET", "PUT"].includes(String(method).toUpperCase())) return null;
  let url;
  try { url = new URL(requestUrl); } catch { return null; }
  if (url.origin !== "https://magnit.ru" || url.username || url.password || url.pathname !== CART_PATH) return null;
  return safeContext(headers);
}

export function magnitCookieHeader(cookies) {
  const pairs = [];
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (typeof cookie?.name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name)) continue;
    if (typeof cookie.value !== "string" || /[\r\n\0;]/.test(cookie.value)) continue;
    const domain = String(cookie.domain || "").toLowerCase();
    if (domain !== "magnit.ru" && domain !== ".magnit.ru") continue;
    if (cookie.secure !== true) continue;
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
    const pathOk = expectedId ? url.pathname === `/devtools/${kind}/${expectedId}` : new RegExp(`^/devtools/${kind}/[A-Za-z0-9-]+$`).test(url.pathname);
    return url.protocol === "ws:" && ["127.0.0.1", "localhost"].includes(url.hostname) && Number(url.port) === Number(port) && pathOk && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function parseDevices(output) {
  return String(output).split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/)).filter((fields) => fields.length >= 2).map(([serial, state]) => ({ serial, state }));
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
        this.emit(message.method, message.params || {});
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
  send(method, params = {}, timeoutMs = 10_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("cdp_command_timeout")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("cdp_send_failed")); }
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

export class AndroidMagnitLogin {
  constructor({ saveSession, requestedSerial = process.env.ANDROID_DEVICE_SERIAL || "", exec = async (args) => (await execFile("adb", args, { encoding: "utf8", timeout: 12_000, maxBuffer: 64 * 1024 })).stdout, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, intervalMs = 1500, timeoutMs = 5 * 60_000 }) {
    this.saveSession = saveSession;
    this.requestedSerial = requestedSerial;
    this.exec = exec;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.state = { status: "idle", message: "Вход не запущен." };
    this.started = false;
    this.closed = false;
    this.attempted = new Set();
    this.verifying = false;
    this.context = null;
    this.cancelRequested = false;
  }

  snapshot() { return { ...this.state }; }
  setState(status, message) { this.state = { status, message, updated_at: new Date().toISOString() }; }

  async start() {
    if (this.started) return this.startPromise || this.snapshot();
    this.started = true;
    this.startPromise = this.open();
    return this.startPromise;
  }

  async open() {
    this.setState("opening", "Открываем новую вкладку Магнит на выбранном Android-телефоне…");
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
      const forwarded = String(await this.exec(["-s", this.serial, "forward", "tcp:0", "localabstract:chrome_devtools_remote"])).trim();
      const portMatch = forwarded.match(/(?:^|\D)(\d{2,5})(?:\D|$)/);
      const port = portMatch ? Number(portMatch[1]) : NaN;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("adb_forward_failed");
      this.port = port;
      if (this.cancelRequested) throw Object.assign(new Error("cancelled"), { code: "cancelled", publicMessage: "Вход отменён." });
      const debugBase = `http://127.0.0.1:${port}`;
      const version = await responseJson(await this.fetchImpl(`${debugBase}/json/version`, { redirect: "error", signal: AbortSignal.timeout(5000) }));
      if (this.cancelRequested) throw Object.assign(new Error("cancelled"), { code: "cancelled", publicMessage: "Вход отменён." });
      if (!validateDebugWebSocket(version.webSocketDebuggerUrl, port, "browser")) throw new Error("debug_endpoint_invalid");
      const created = await responseJson(await this.fetchImpl(`${debugBase}/json/new?${encodeURIComponent("https://magnit.ru/")}`, { method: "PUT", redirect: "error", signal: AbortSignal.timeout(5000) }));
      if (typeof created.id !== "string" || !/^[A-Za-z0-9-]+$/.test(created.id) || created.url !== "https://magnit.ru/" || !validateDebugWebSocket(created.webSocketDebuggerUrl, port, "page", created.id)) throw new Error("debug_target_invalid");
      this.targetId = created.id;
      if (this.cancelRequested) throw Object.assign(new Error("cancelled"), { code: "cancelled", publicMessage: "Вход отменён." });
      const activated = await this.fetchImpl(`${debugBase}/json/activate/${encodeURIComponent(this.targetId)}`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(5000) });
      if (this.cancelRequested) throw Object.assign(new Error("cancelled"), { code: "cancelled", publicMessage: "Вход отменён." });
      if (!activated.ok) throw new Error("debug_activate_failed");
      this.cdp = await CdpClient.connect(created.webSocketDebuggerUrl, this.WebSocketImpl);
      if (this.cancelRequested) throw Object.assign(new Error("cancelled"), { code: "cancelled", publicMessage: "Вход отменён." });
      this.cdp.on("Network.requestWillBeSent", (params) => this.observeCartRequest(params));
      await this.cdp.send("Network.enable");
      if (this.cancelRequested) throw Object.assign(new Error("cancelled"), { code: "cancelled", publicMessage: "Вход отменён." });
      this.setState("waiting", "В открытой вкладке войдите в Магнит и откройте express-корзину. Код и пароль вводите только на сайте Магнит.");
      this.deadline = Date.now() + this.timeoutMs;
      this.timer = setInterval(() => void this.pollCookies(), this.intervalMs);
      void this.pollCookies();
      return this.snapshot();
    } catch (cause) {
      if (!this.cancelRequested) this.setState(cause?.code || "login_unavailable", cause?.publicMessage || "Не удалось открыть защищённую вкладку Магнит. Проверьте Termux, ADB и Chrome; подробности запроса не сохранялись.");
      await this.cleanup();
      return this.snapshot();
    }
  }

  observeCartRequest(params) {
    const request = params?.request;
    if (String(request?.method).toUpperCase() !== "GET") return;
    const context = extractCartRequestContext(request?.method, request?.url, request?.headers);
    if (context) this.context = context;
  }

  async pollCookies() {
    if (this.closed || !this.cdp || this.polling) return;
    if (Date.now() >= this.deadline) {
      this.setState("expired", "Время входа истекло. Нажмите «Войти в Магнит» и попробуйте ещё раз.");
      await this.cleanup();
      return;
    }
    this.polling=true;
    try {
      const result = await this.cdp.send("Network.getCookies", { urls: [CART_URL] });
      if (this.closed) return;
      const cookie = magnitCookieHeader(result?.cookies);
      if (!cookie || !this.context || this.verifying) return;
      const fingerprint = createHash("sha256").update(cookie).digest("hex");
      if (this.attempted.has(fingerprint) || this.attempted.size >= 5) return;
      this.attempted.add(fingerprint);
      this.verifying = true;
      this.setState("verifying", "Проверяем вход одним безопасным чтением корзины…");
      const session = { cookie, context: this.context };
      try {
        const authorized = await isMagnitAuthenticated(session, this.fetchImpl);
        if (this.closed) return;
        if (!authorized) {
          this.setState("waiting", "Сайт ещё не подтвердил вход. Завершите вход в открытой вкладке; этот Cookie повторно не проверялся.");
          return;
        }
        await viewMagnitCart({ session, storeCode: this.context.storeCode, mode: "express", fetchImpl: this.fetchImpl });
        if (this.closed) return;
        await this.saveSession(session);
        this.setState("ready", "Вход подтверждён. Теперь инструменты работают с HTTP-каталогом и express-корзиной.");
        await this.cleanup();
      } catch (cause) {
        if (this.closed) return;
        if (cause?.code === "access_denied") {
          this.setState("access_denied", "Магнит запретил проверку сессии (403). Вкладка закрыта; обход защиты не выполняется.");
          await this.cleanup();
          return;
        }
        const message = cause?.code === "session_rejected"
          ? "Магнит отклонил сессию. Завершите вход в открытой вкладке; этот вариант Cookie повторно не проверялся."
          : "Не удалось подтвердить сессию одним чтением корзины. Проверьте вкладку и попробуйте войти заново.";
        this.setState("waiting", message);
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

  async cleanup() {
    this.closed = true;
    clearInterval(this.timer);
    if (this.cleanupPromise) return this.cleanupPromise;
    const port=this.port;const targetId=this.targetId;const serial=this.serial;const cdp=this.cdp;
    this.port=null;this.targetId=null;this.cdp=null;
    this.cleanupPromise=(async()=>{
    if (port && targetId) {
      try { await this.fetchImpl(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(targetId)}`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(3000) }); } catch {}
    }
    cdp?.close();
    if (serial && port) {
      try { await this.exec(["-s", serial, "forward", "--remove", `tcp:${port}`]); } catch {}
    }
    })();
    return this.cleanupPromise;
  }
}

export function createAndroidLogin(options) { return new AndroidMagnitLogin(options); }
