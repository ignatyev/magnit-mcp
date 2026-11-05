import test from "node:test";
import assert from "node:assert/strict";
import {
  AndroidMagnitLogin,
  extractCartRequestContext,
  isMagnitAuthenticated,
  magnitCookieHeader,
  selectAdbDevice,
  validateDebugWebSocket,
} from "../src/android-login.js";

const CART_URL = "https://magnit.ru/webgate/v1/carts/lite";

test("device selection requires an explicit serial when multiple Android devices are online", () => {
  const devices = [{ serial: "one", state: "device" }, { serial: "two", state: "device" }, { serial: "off", state: "offline" }];
  assert.equal(selectAdbDevice(devices), null);
  assert.equal(selectAdbDevice(devices, "two"), devices[1]);
  assert.equal(selectAdbDevice(devices, "missing"), null);
  assert.equal(selectAdbDevice([devices[0]]), devices[0]);
});

test("CDP websocket and observed cart context are pinned to exact local/Magnit endpoints", () => {
  assert.equal(validateDebugWebSocket("ws://127.0.0.1:9222/devtools/browser/abc", 9222, "browser"), true);
  assert.equal(validateDebugWebSocket("ws://attacker.example:9222/devtools/browser/abc", 9222, "browser"), false);
  assert.equal(validateDebugWebSocket("ws://127.0.0.1:9222/devtools/page/other", 9222, "page", "expected"), false);
  assert.equal(validateDebugWebSocket("ws://user@127.0.0.1:9222/devtools/page/expected", 9222, "page", "expected"), false);
  const headers = { "X-Service": "express", "X-Store-Code": "123456", "X-Magnit-Bff": "synthetic", Cookie: "must-not-be-read", Authorization: "must-not-be-read" };
  assert.deepEqual(extractCartRequestContext("GET", CART_URL, headers), { service: "express", storeCode: "123456", bff: "synthetic", permissionsJwt: null });
  assert.equal(extractCartRequestContext("GET", "https://magnit.ru:444/webgate/v1/carts/lite", headers), null);
  assert.equal(extractCartRequestContext("GET", "https://magnit.ru.attacker.example/webgate/v1/carts/lite", headers), null);
  assert.equal(extractCartRequestContext("POST", CART_URL, headers), null);
});

test("only secure cookies pinned to magnit.ru cart URL are serialized", () => {
  assert.equal(magnitCookieHeader([
    { name: "sid", value: "synthetic-value", domain: ".magnit.ru", path: "/", secure: true, expires: -1 },
    { name: "foreign", value: "secret", domain: ".example.com", path: "/", secure: true },
    { name: "insecure", value: "secret", domain: "magnit.ru", path: "/", secure: false },
  ]), "sid=synthetic-value");
});

test("session authorization check is pinned and distinguishes unauthorized/403", async () => {
  let seen;
  const session = { cookie: "sid=synthetic", context: {} };
  assert.equal(await isMagnitAuthenticated(session, async (url, init) => { seen = { url, init }; return Response.json({ authorized: true }); }), true);
  assert.equal(seen.url, "https://magnit.ru/_auth/session");
  assert.equal(seen.init.headers.Cookie, session.cookie);
  assert.equal(seen.init.redirect, "error");
  assert.equal(await isMagnitAuthenticated(session, async () => new Response("{}", { status: 401 })), false);
  await assert.rejects(isMagnitAuthenticated(session, async () => new Response("blocked", { status: 403 })), (error) => error.code === "access_denied");
});

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    queueMicrotask(() => this.emit("open", {}));
  }
  addEventListener(name, listener) { const list = this.listeners.get(name) || []; list.push(listener); this.listeners.set(name, list); }
  emit(name, event) { for (const listener of this.listeners.get(name) || []) listener(event); }
  send(raw) {
    const { id, method } = JSON.parse(raw);
    const result = method === "Network.getCookies" ? { cookies: [{ name: "sid", value: "synthetic-cookie", domain: ".magnit.ru", path: "/", secure: true, expires: -1 }] } : {};
    queueMicrotask(() => {
      this.emit("message", { data: JSON.stringify({ id, result }) });
      if (method === "Network.enable") this.emit("message", { data: JSON.stringify({ method: "Network.requestWillBeSent", params: { requestId: "cart-1", request: { method: "GET", url: CART_URL, headers: { "x-service": "express", "x-store-code": "123456", "x-magnit-bff": "synthetic-context" } } } }) });
    });
  }
  close() { this.emit("close", {}); }
}

test("Android login creates and closes only its own official tab and saves only after auth+cart verification", async () => {
  const adbCalls = [];
  const httpCalls = [];
  let saved;
  const exec = async (args) => {
    adbCalls.push(args);
    if (args[0] === "devices") return "List of devices attached\nsynthetic-device device product:phone\n";
    if (args.includes("forward") && args.includes("tcp:0")) return "43210";
    return "";
  };
  const fetchImpl = async (url, init = {}) => {
    httpCalls.push({ url, method: init.method || "GET" });
    if (url === "http://127.0.0.1:43210/json/version") return Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:43210/devtools/browser/browser-id" });
    if (url.startsWith("http://127.0.0.1:43210/json/new?")) return Response.json({ id: "page-id", url: "https://magnit.ru/", webSocketDebuggerUrl: "ws://127.0.0.1:43210/devtools/page/page-id" });
    if (url.includes("/json/activate/") || url.includes("/json/close/")) return new Response(null, { status: 200 });
    if (url === "https://magnit.ru/_auth/session") return Response.json({ authorized: true });
    if (url === CART_URL) return Response.json({ items: [], formats: [], totalBasePrice: 0, totalFinalPrice: 0, totalGoodsCount: 0 });
    throw new Error("Unexpected URL in synthetic test.");
  };
  const login = new AndroidMagnitLogin({ saveSession: async (session) => { saved = session; }, exec, fetchImpl, WebSocketImpl: FakeWebSocket, intervalMs: 5, timeoutMs: 1000 });
  await login.start();
  for (let i = 0; i < 100 && login.snapshot().status !== "ready"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(login.snapshot().status, "ready");
  assert.equal(saved.cookie, "sid=synthetic-cookie");
  assert.deepEqual(saved.context, { service: "express", storeCode: "123456", bff: "synthetic-context", permissionsJwt: null });
  assert.equal(httpCalls.filter((call) => call.url === CART_URL).length, 1);
  assert.equal(httpCalls.some((call) => call.url.includes("/json/close/page-id")), true);
  assert.equal(httpCalls.find((call) => call.url.includes("/json/activate/"))?.method, "GET");
  assert.equal(httpCalls.find((call) => call.url.includes("/json/close/"))?.method, "GET");
  assert.equal(adbCalls.some((args) => args.includes("--remove") && args.includes("tcp:43210")), true);
  assert.equal(JSON.stringify(login.snapshot()).includes("synthetic-cookie"), false);
});

test("cancellation while adb forward is pending still removes the newly-created forward", async () => {
  let finishForward;
  let forwardStarted = false;
  const adbCalls = [];
  const login = new AndroidMagnitLogin({
    saveSession: async () => assert.fail("cancelled login must not save session"),
    exec: async (args) => {
      adbCalls.push(args);
      if (args[0] === "devices") return "List of devices attached\nsynthetic-device device\n";
      if (args.includes("tcp:0")) { forwardStarted = true; return new Promise((resolve) => { finishForward = resolve; }); }
      return "";
    },
    fetchImpl: async () => assert.fail("cancelled forward must not open debug endpoints"),
    WebSocketImpl: FakeWebSocket,
  });
  const starting = login.start();
  for (let i = 0; i < 100 && !forwardStarted; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(forwardStarted, true);
  const cancelling = login.cancel();
  finishForward("43211");
  await Promise.all([starting, cancelling]);
  assert.equal(login.snapshot().status, "cancelled");
  assert.equal(adbCalls.some((args) => args.includes("--remove") && args.includes("tcp:43211")), true);
});
