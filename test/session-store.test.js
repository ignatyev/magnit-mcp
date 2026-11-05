import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEncryptedSessionStore, extractMagnitSessionFromHar, bindExpressSearchContext, publicSessionState } from "../src/session-store.js";

const syntheticEntry = ({ url = "https://magnit.ru/webgate/v1/carts/lite", cookie, service = "express" } = {}) => ({
  request: {
    method: "GET",
    url,
    headers: [
      ...(cookie ? [{ name: "Cookie", value: cookie }] : []),
      { name: "x-service", value: service },
      { name: "x-store-code", value: "123456" },
      { name: "x-magnit-bff", value: "synthetic-context" },
      { name: "x-permissions-jwt", value: "fake" },
      { name: "Authorization", value: "must-not-be-copied" },
    ],
  },
});

test("sanitized HAR is rejected and never substitutes placeholder JWT for Cookie", () => {
  const result = extractMagnitSessionFromHar(JSON.stringify({ log: { entries: [syntheticEntry()] } }));
  assert.deepEqual(result, { ok: false, code: "sanitized_export", reason: "missing_cookie" });
});

test("HAR import only accepts exact HTTPS Magnit cart origin and copies allowlisted context", () => {
  const external = extractMagnitSessionFromHar(JSON.stringify({ log: { entries: [syntheticEntry({ url: "https://magnit.ru.attacker.example/webgate/v1/carts/lite", cookie: "sid=synthetic-secret" })] } }));
  assert.equal(external.code, "unsupported_har");
  const result = extractMagnitSessionFromHar(JSON.stringify({ log: { entries: [syntheticEntry({ cookie: "sid=synthetic-secret; other=fake-value" })] } }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.session.context, { service: "express", storeCode: "123456", bff: "synthetic-context", permissionsJwt: null });
  assert.equal(result.session.cookie, "sid=synthetic-secret; other=fake-value");
});

test("mixed HAR selects a later valid express cart request and rejects alternate ports", () => {
  const mixed = { log: { entries: [
    syntheticEntry({ cookie: "delivery-cookie=synthetic", service: "dostavka" }),
    syntheticEntry({ cookie: "express-cookie=synthetic", service: "express" }),
  ] } };
  const result = extractMagnitSessionFromHar(JSON.stringify(mixed));
  assert.equal(result.ok, true);
  assert.equal(result.session.context.service, "express");
  assert.equal(result.session.cookie, "express-cookie=synthetic");
  const alternatePort = extractMagnitSessionFromHar(JSON.stringify({ log: { entries: [syntheticEntry({ url: "https://magnit.ru:444/webgate/v1/carts/lite", cookie: "sid=synthetic" })] } }));
  assert.deepEqual(alternatePort, { ok: false, code: "unsupported_har" });
});

test("encrypted session is owner-secret-derived, persists only ciphertext, and clears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magnit-session-test-"));
  const file = join(dir, "session.enc");
  try {
    const session = { cookie: "sid=synthetic-secret", context: { service: "express", storeCode: "123456", bff: "synthetic" } };
    const store = createEncryptedSessionStore({ secret: "a synthetic owner secret with at least thirty two chars", filename: file });
    await store.save(session);
    const encrypted = await readFile(file, "utf8");
    assert.equal(encrypted.includes("synthetic-secret"), false);
    assert.deepEqual(await store.load(), session);
    assert.equal(await createEncryptedSessionStore({ secret: "a different synthetic secret with thirty two chars", filename: file }).load(), null);
    await store.clear();
    assert.equal(await store.load(), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("non-express session context cannot be imported for this cart adapter", () => {
  const result = extractMagnitSessionFromHar(JSON.stringify({ log: { entries: [syntheticEntry({ cookie: "sid=synthetic", service: "retail" })] } }));
  assert.deepEqual(result, { ok: false, code: "unsupported_context" });
});


test("search retains same-store browser cart context but invalidates verified flag for another store", () => {
  const session = { cookie: "synthetic", context: {
    service: "express", storeCode: "123456", bff: "synthetic", permissionsJwt: "null",
    observedInBrowser: true, deviceId: "synthetic-device", appVersion: "2026.11.3-14.45",
  } };
  const same = bindExpressSearchContext(session, "123456");
  assert.equal(same.context.observedInBrowser, true);
  assert.equal(same.context.deviceId, "synthetic-device");
  assert.equal(publicSessionState(same).cart_context_ready, true);
  const switched = bindExpressSearchContext(session, "654321");
  assert.equal(switched.context.observedInBrowser, false);
  assert.equal(switched.context.deviceId, "synthetic-device");
  assert.equal(switched.context.permissionsJwt, null);
  assert.equal(publicSessionState(switched).cart_context_ready, false);
});
