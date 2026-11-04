import { createHash, timingSafeEqual } from "node:crypto";
import { createHmac } from "node:crypto";

export const MAGNIT_HOME = "https://magnit.ru/";
const ALLOWED_HOST = /(^|\.)magnit\.ru$/i;
const BLOCKED_ACTION = /(?:оплат|заказ|оформить|подтвердить|купить|покупк|payment|checkout|submit)/i;
const SECRET_FIELD = /(?:password|passcode|otp|one.?time|sms|code|парол|код)/i;
const ALLOWED_MCP_LABELS = new Set(["в корзину", "добавить в корзину", "добавить", "корзина", "войти", "назад", "закрыть", "поиск", "−", "+", "-"]);

export function isMagnitUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

export function makeSearchUrl(query, shopCode = "", shopType = "dostavka") {
  const term = String(query ?? "").trim();
  if (!term || term.length > 120) throw new Error("Введите запрос до 120 символов.");
  if (!new Set(["dostavka", "supermarket", "hypermarket"]).has(shopType)) {
    throw new Error("Неизвестный формат магазина.");
  }
  if (shopCode && !/^\d{4,8}$/.test(shopCode)) throw new Error("Код магазина должен состоять из 4–8 цифр.");
  const url = new URL("https://magnit.ru/search");
  url.searchParams.set("term", term);
  url.searchParams.set("shopType", shopType);
  if (shopCode) url.searchParams.set("shopCode", shopCode);
  return url.href;
}

export async function selectAndroidDevice(devices, requestedSerial) {
  if (!Array.isArray(devices) || devices.length === 0) return null;
  if (!requestedSerial) return devices.length === 1 ? devices[0] : null;
  for (const device of devices) {
    const serial = typeof device.serial === "function" ? await device.serial() : device.serial;
    if (serial === requestedSerial) return device;
  }
  return null;
}

export function isSensitiveField({ type = "", name = "", autocomplete = "", placeholder = "", label = "" }) {
  return [type, name, autocomplete, placeholder, label].some((v) => SECRET_FIELD.test(String(v)));
}

export function isBlockedAction(label, attributes = {}) {
  const text = String(label ?? "").trim();
  return BLOCKED_ACTION.test(text) || /^(submit|payment|order)$/i.test(String(attributes.action ?? ""));
}

export function safeMcpClick({ label, href, attributes = {} }) {
  const normalizedLabel = String(label ?? "").trim().toLowerCase();
  if (!ALLOWED_MCP_LABELS.has(normalizedLabel) || isBlockedAction(normalizedLabel, attributes)) return false;
  if (href && !isMagnitUrl(href)) return false;
  if (attributes.sensitiveForm) return false;
  return true;
}

export function constantTimeEqual(left, right) {
  const a = createHash("sha256").update(String(left ?? "")).digest();
  const b = createHash("sha256").update(String(right ?? "")).digest();
  return timingSafeEqual(a, b);
}

export function createPhoneSessionCodec(secret, now = () => Date.now()) {
  return {
    issue(csrf, lifetimeMs = 7 * 24 * 60 * 60 * 1000) {
      const encoded = Buffer.from(JSON.stringify({ csrf, exp: now() + lifetimeMs })).toString("base64url");
      const mac = createHmac("sha256", secret).update(encoded).digest("base64url");
      return `${encoded}.${mac}`;
    },
    verify(value) {
      const [encoded, providedMac, extra] = String(value || "").split(".");
      if (!encoded || !providedMac || extra) return null;
      const expectedMac = createHmac("sha256", secret).update(encoded).digest("base64url");
      if (!constantTimeEqual(providedMac, expectedMac)) return null;
      try {
        const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        if (typeof payload.csrf !== "string" || !payload.csrf || !Number.isInteger(payload.exp) || payload.exp < now()) return null;
        return payload;
      } catch { return null; }
    },
  };
}

export function sanitizeVisibleText(value, maxLength = 280) {
  return String(value ?? "")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[скрыто]")
    .replace(/(?<!\d)(?:\+?7|8)[\s().-]*\d(?:[\s().-]*\d){9,10}(?!\d)/g, "[телефон скрыт]")
    .replace(/\b\d{4,8}\b/g, "[скрыто]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
