import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const CART_PATH = "/webgate/v1/carts/lite";
const ALLOWED_HEADERS = new Set(["cookie", "x-service", "x-store-code", "x-magnit-bff", "x-permissions-jwt"]);

function safeHeaderValue(value, max = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value) ? value : null;
}

function validCookieHeader(value) {
  if (!safeHeaderValue(value, 8192)) return false;
  const pairs = value.split(";").map((part) => part.trim());
  return pairs.length > 0 && pairs.every((pair) => {
    const index = pair.indexOf("=");
    return index > 0 && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(pair.slice(0, index)) && !/[\r\n\0;]/.test(pair.slice(index + 1));
  });
}

export function extractMagnitSessionFromHar(raw) {
  let har;
  try { har = JSON.parse(raw); } catch { return { ok: false, code: "invalid_har" }; }
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) return { ok: false, code: "invalid_har" };
  let sawCart = false;
  let missingCookie = false;
  let sawUnsupportedContext = false;
  let candidate = null;
  for (const entry of entries) {
    const request = entry?.request;
    if (typeof request?.url !== "string" || typeof request?.method !== "string") continue;
    let url;
    try { url = new URL(request.url); } catch { continue; }
    if (url.origin !== "https://magnit.ru" || url.username || url.password || url.pathname !== CART_PATH || !["GET", "PUT"].includes(request.method.toUpperCase())) continue;
    sawCart = true;
    const headers = Object.create(null);
    for (const header of Array.isArray(request.headers) ? request.headers : []) {
      const name = String(header?.name ?? "").toLowerCase();
      if (ALLOWED_HEADERS.has(name) && typeof header.value === "string") headers[name] = header.value;
    }
    if (!validCookieHeader(headers.cookie)) { missingCookie = true; continue; }
    const service = safeHeaderValue(headers["x-service"], 32);
    const storeCode = safeHeaderValue(headers["x-store-code"], 16);
    const bff = safeHeaderValue(headers["x-magnit-bff"], 256);
    if (!service || !/^[A-Za-z0-9_-]+$/.test(service) || !storeCode || !/^\d{4,8}$/.test(storeCode) || !bff) continue;
    if (service !== "express") { sawUnsupportedContext = true; continue; }
    const permissionsJwt = safeHeaderValue(headers["x-permissions-jwt"], 8192);
    candidate = {
      ok: true,
      session: {
        cookie: headers.cookie,
        context: { service, storeCode, bff, permissionsJwt: permissionsJwt && permissionsJwt.length >= 64 ? permissionsJwt : null },
      },
    };
  }
  if (candidate) return candidate;
  if (sawCart && missingCookie) return { ok: false, code: "sanitized_export", reason: "missing_cookie" };
  if (sawUnsupportedContext) return { ok: false, code: "unsupported_context" };
  return { ok: false, code: sawCart ? "incomplete_session" : "unsupported_har" };
}

export function createEncryptedSessionStore({ secret, filename = "./data/magnit-session.enc" }) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("Session encryption secret is unavailable.");
  const path = resolve(filename);
  const key = scryptSync(secret, "magnit-pocket-session-v1", 32);
  return {
    async save(session) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(session)), cipher.final()]);
      const packed = JSON.stringify({ v: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), data: data.toString("base64url") });
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(temporary, packed, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    },
    async load() {
      let packed;
      try { packed = JSON.parse(await readFile(path, "utf8")); } catch { return null; }
      try {
        if (packed.v !== 1) return null;
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(packed.iv, "base64url"));
        decipher.setAuthTag(Buffer.from(packed.tag, "base64url"));
        const plain = Buffer.concat([decipher.update(Buffer.from(packed.data, "base64url")), decipher.final()]);
        const session = JSON.parse(plain.toString("utf8"));
        if (typeof session?.cookie !== "string" || !session.cookie) return null;
        if (session.context != null && (typeof session.context !== "object" || !/^\d{4,8}$/.test(String(session.context.storeCode ?? "")) || session.context.service !== "express" || typeof session.context.bff !== "string" || !session.context.bff)) return null;
        return session;
      } catch { return null; }
    },
    async clear() { await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; }); },
  };
}

export function publicSessionState(session) {
  const contextReady = !!(session?.context?.storeCode && session.context.service === "express");
  return session ? { ready: true, auth_saved: true, context_ready: contextReady, cart_context_ready: contextReady && session.context.observedInBrowser === true, cart_http_access: session.context?.observedInBrowser === true ? "browser_observed" : "unverified", store_code: contextReady ? session.context.storeCode : null, service: contextReady ? session.context.service : null, cart_reconciliation_required: session.cartReconciliationRequired === true } : { ready: false, auth_saved: false, context_ready: false, cart_context_ready: false, cart_http_access: "unverified", store_code: null, service: null, cart_reconciliation_required: false };
}

export function bindExpressSearchContext(session, storeCode) {
  if (!session?.cookie) return session;
  if (typeof storeCode !== "string" || !/^\d{4,8}$/.test(storeCode)) throw new Error("store_code должен содержать 4–8 цифр.");
  const previous = session.context;
  const sameStore = previous?.service === "express" && previous.storeCode === storeCode;
  const context = {
    service: "express",
    storeCode,
    bff: previous?.bff || "1",
    permissionsJwt: sameStore ? previous.permissionsJwt || null : null,
    observedInBrowser: sameStore && previous.observedInBrowser === true,
  };
  // Device/app identity is tied to the browser, not the selected store.
  // An observed context for a different store is no longer considered verified.
  for (const key of ["deviceId", "deviceTag", "appVersion", "platformVersion", "userAgent"]) {
    if (typeof previous?.[key] === "string") context[key] = previous[key];
  }
  return { ...session, context };
}
