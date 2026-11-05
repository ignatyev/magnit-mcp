import test from "node:test";
import assert from "node:assert/strict";
import { constantTimeEqual, createPhoneSessionCodec, sanitizeText } from "../src/policy.js";

test("constant-time comparison handles equal and unequal secrets", () => {
  assert.equal(constantTimeEqual("same", "same"), true);
  assert.equal(constantTimeEqual("same", "other"), false);
  assert.equal(constantTimeEqual(undefined, ""), true);
});

test("phone session tokens are signed, expire, and reject tampering", () => {
  let now = 1_000_000;
  const codec = createPhoneSessionCodec("a-test-secret-that-is-long-enough", () => now);
  const token = codec.issue("csrf-token", 5000);
  assert.equal(codec.verify(token)?.csrf, "csrf-token");
  assert.equal(codec.verify(`${token}x`), null);
  assert.equal(createPhoneSessionCodec("another-secret", () => now).verify(token), null);
  now += 5001;
  assert.equal(codec.verify(token), null);
});

test("upstream text is bounded and masks contact details", () => {
  const safe = sanitizeText("Телефон +7 900 123-45-67, email x@y.ru");
  assert.equal(safe.includes("+7 900"), false);
  assert.equal(safe.includes("x@y.ru"), false);
  assert.match(safe, /\[скрыто\]/);
  assert.equal(sanitizeText("x".repeat(20), 8).length, 8);
});
