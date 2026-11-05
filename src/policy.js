import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function constantTimeEqual(left, right) {
  return timingSafeEqual(createHash("sha256").update(String(left ?? "")).digest(), createHash("sha256").update(String(right ?? "")).digest());
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

export function sanitizeText(value, maxLength = 240) {
  return String(value ?? "")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[скрыто]")
    .replace(/(?<!\d)(?:\+?7|8)[\s().-]*\d(?:[\s().-]*\d){9,10}(?!\d)/g, "[телефон скрыт]")
    .replace(/\s+/g, " ").trim().slice(0, maxLength);
}
