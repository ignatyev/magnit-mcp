import test from "node:test";
import assert from "node:assert/strict";
import {
  constantTimeEqual,
  createPhoneSessionCodec,
  isMagnitUrl,
  isSensitiveField,
  makeSearchUrl,
  safeMcpClick,
  selectAndroidDevice,
  sanitizeVisibleText,
} from "../src/policy.js";

test("catalog search always stays on Magnit's HTTPS search URL", () => {
  const url = new URL(makeSearchUrl("греческий йогурт", "543440"));
  assert.equal(url.origin, "https://magnit.ru");
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("term"), "греческий йогурт");
  assert.equal(url.searchParams.get("shopCode"), "543440");
  assert.equal(url.searchParams.get("shopType"), "dostavka");
  assert.throws(() => makeSearchUrl(" "));
  assert.throws(() => makeSearchUrl("x", "1/evil"));
});

test("navigation policy only accepts HTTPS Magnit hosts", () => {
  assert.equal(isMagnitUrl("https://magnit.ru/"), true);
  assert.equal(isMagnitUrl("https://id.magnit.ru/"), true);
  assert.equal(isMagnitUrl("http://magnit.ru/"), false);
  assert.equal(isMagnitUrl("https://magnit.ru.attacker.example/"), false);
  assert.equal(isMagnitUrl("https://example.com/"), false);
});

test("Android device selection is explicit when multiple devices are attached", async () => {
  const devices = [{ serial: async () => "one" }, { serial: async () => "two" }];
  assert.equal(await selectAndroidDevice(devices), null);
  assert.equal(await selectAndroidDevice(devices, "two"), devices[1]);
  assert.equal(await selectAndroidDevice(devices, "missing"), null);
  assert.equal(await selectAndroidDevice([devices[0]]), devices[0]);
});

test("MCP click references reject checkout, payment, sensitive forms, and external links", () => {
  assert.equal(safeMcpClick({ label: "В корзину" }), true);
  assert.equal(safeMcpClick({ label: "Войти" }), true);
  assert.equal(safeMcpClick({ label: "Далее" }), false);
  assert.equal(safeMcpClick({ label: "Оформить заказ" }), false);
  assert.equal(safeMcpClick({ label: "Оплатить" }), false);
  assert.equal(safeMcpClick({ label: "Continue", attributes: { sensitiveForm: true } }), false);
  assert.equal(safeMcpClick({ label: "Подробнее", href: "https://example.com/" }), false);
});

test("sensitive form detection covers password and SMS-code inputs", () => {
  assert.equal(isSensitiveField({ type: "password" }), true);
  assert.equal(isSensitiveField({ autocomplete: "one-time-code" }), true);
  assert.equal(isSensitiveField({ placeholder: "Код из SMS" }), true);
  assert.equal(isSensitiveField({ type: "search", placeholder: "Искать товары" }), false);
});

test("text sanitizer removes emails, phone numbers and digit tokens", () => {
  const safe = sanitizeVisibleText("Телефон +7 900 123-45-67, email x@y.ru, карта 12345678");
  assert.equal(safe.includes("+7 900"), false);
  assert.equal(safe.includes("x@y.ru"), false);
  assert.equal(safe.includes("12345678"), false);
  assert.match(safe, /\[скрыто\]/);
});

test("constant-time comparison accepts equal secrets and rejects different secrets", () => {
  assert.equal(constantTimeEqual("same", "same"), true);
  assert.equal(constantTimeEqual("same", "other"), false);
});

test("phone session cookies are signed, expire, and reject tampering", () => {
  let now = 1_000_000;
  const codec = createPhoneSessionCodec("a-test-secret-that-is-long-enough", () => now);
  const token = codec.issue("csrf-token", 5000);
  assert.equal(codec.verify(token)?.csrf, "csrf-token");
  assert.equal(codec.verify(`${token}x`), null);
  assert.equal(createPhoneSessionCodec("another-secret", () => now).verify(token), null);
  now += 5001;
  assert.equal(codec.verify(token), null);
});
