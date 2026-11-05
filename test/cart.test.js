import test from "node:test";
import assert from "node:assert/strict";
import { addMagnitCartItem, viewMagnitCart } from "../src/cart.js";

const session = { cookie: "sid=synthetic-cookie", context: { service: "express", storeCode: "123456", bff: "synthetic-bff", permissionsJwt: null } };
const cart = (items, formatCount = items.length) => ({ items, formats: [{ itemsCount: formatCount, service: "express", storeCode: "123456" }], totalBasePrice: 12345, totalFinalPrice: 11111, totalGoodsCount: items.length });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("missing or mismatched session rejects before any HTTP request", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(cart([])); };
  await assert.rejects(viewMagnitCart({ storeCode: "123456", mode: "express", fetchImpl }), (error) => error.code === "session_missing");
  await assert.rejects(viewMagnitCart({ session, storeCode: "123457", mode: "express", fetchImpl }), (error) => error.code === "context_mismatch");
  assert.equal(calls, 0);
});

test("cart GET is pinned and exposes no cookie/token in its result", async () => {
  let seen;
  const result = await viewMagnitCart({ session, storeCode: "123456", mode: "express", fetchImpl: async (url, init) => { seen = { url, init }; return response(cart([{ goodId: "old-good", offerId: "old-offer", qnty: 2 }])); } });
  assert.equal(seen.url, "https://magnit.ru/webgate/v1/carts/lite");
  assert.equal(seen.init.method, "GET");
  assert.equal(seen.init.redirect, "error");
  assert.equal(seen.init.headers.Cookie, session.cookie);
  assert.equal(seen.init.headers.Referer, "https://magnit.ru/");
  assert.equal(seen.init.headers["x-new-magnit"], "true");
  assert.equal(seen.init.headers["x-client-name"], "magnit");
  assert.equal(seen.init.headers["x-device-platform"], "Web");
  assert.equal(seen.init.headers.Origin, undefined, "GET must not send Origin");
  assert.equal(seen.init.headers.Authorization, undefined);
  assert.equal(JSON.stringify(result).includes(session.cookie), false);
  assert.equal(JSON.stringify(result).includes("synthetic-bff"), false);
  assert.equal(result.items[0].quantity, 2);
  assert.equal(result.totals_lite.is_checkout_quote, false);
});

test("add reads the cart, preserves all items, merges exact IDs, and issues one PUT", async () => {
  const calls = [];
  const before = cart([{ goodId: "old-good", offerId: "old-offer", qnty: 2 }, { goodId: "new-good", offerId: "new-offer", qnty: 1 }]);
  const after = cart([{ goodId: "old-good", offerId: "old-offer", qnty: 2 }, { goodId: "new-good", offerId: "new-offer", qnty: 4 }], 1);
  const result = await addMagnitCartItem({ session, storeCode: "123456", mode: "express", goodId: "new-good", offerId: "new-offer", quantity: 3, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? response(before) : response(after);
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(calls[1].init.headers.Origin, "https://magnit.ru");
  assert.equal(calls[1].init.headers.Referer, "https://magnit.ru/");
  assert.equal(calls[1].init.headers["x-new-magnit"], "true");
  assert.deepEqual(JSON.parse(calls[1].init.body), { items: [
    { goodId: "old-good", offerId: "old-offer", qnty: 2 },
    { goodId: "new-good", offerId: "new-offer", qnty: 4 },
  ] });
  assert.equal(result.mutation, "added_and_verified");
  assert.equal(result.verified_quantity, 4);
});

test("empty cart with no formats is readable and can receive its first item", async () => {
  const calls = [];
  const empty = { items: [], formats: [], totalBasePrice: 0, totalFinalPrice: 0, totalGoodsCount: 0 };
  const after = { items: [{ goodId: "first", offerId: "first-offer", qnty: 1 }], formats: [{ itemsCount: 0, service: "express", storeCode: "654321" }], totalBasePrice: 100, totalFinalPrice: 100, totalGoodsCount: 1 };
  const read = await viewMagnitCart({ session, storeCode: "123456", mode: "express", fetchImpl: async () => response(empty) });
  assert.deepEqual(read.items, []);
  assert.equal(read.cart_store_code, null);
  const result = await addMagnitCartItem({ session, storeCode: "123456", mode: "express", goodId: "first", offerId: "first-offer", quantity: 1, fetchImpl: async (url, init) => {
    calls.push(init.method);
    return calls.length === 1 ? response(empty) : response(after);
  } });
  assert.deepEqual(calls, ["GET", "PUT"]);
  assert.equal(result.items[0].quantity, 1);
  assert.equal(result.cart_store_code, "654321");
});

test("unsafe existing items, duplicate IDs and multi-format carts abort before PUT", async () => {
  for (const body of [
    cart([{ goodId: "x", offerId: "y", qnty: null }]),
    cart([{ goodId: "x", offerId: "y", qnty: 1 }, { goodId: "x", offerId: "y", qnty: 2 }]),
    { ...cart([]), formats: [{}, {}] },
    cart([{ goodId: "x", offerId: "y", qnty: 1, goodStoreCode: "654321" }]),
  ]) {
    let calls = 0;
    await assert.rejects(addMagnitCartItem({ session, storeCode: "123456", mode: "express", goodId: "n", offerId: "m", quantity: 1, fetchImpl: async () => { calls++; return response(body); } }));
    assert.equal(calls, 1);
  }
});

test("401 does not retry and ambiguous PUT is never replayed", async () => {
  let authCalls = 0;
  await assert.rejects(viewMagnitCart({ session, storeCode: "123456", mode: "express", fetchImpl: async () => { authCalls++; return response({}, 401); } }), (error) => error.code === "session_rejected");
  assert.equal(authCalls, 1);
  let calls = 0;
  let persisted;
  await assert.rejects(addMagnitCartItem({ session, storeCode: "123456", mode: "express", goodId: "new", offerId: "new", quantity: 1, saveSession: async (value) => { persisted = value; }, fetchImpl: async () => {
    calls++;
    if (calls === 1) return response(cart([]));
    throw new TypeError("synthetic connection reset");
  } }), (error) => error.code === "ambiguous_result");
  assert.equal(calls, 2);
  assert.equal(persisted.cartReconciliationRequired, true);
  await assert.rejects(addMagnitCartItem({ session: persisted, storeCode: "123456", mode: "express", goodId: "new", offerId: "new", quantity: 1, fetchImpl: async () => { calls++; return response(cart([])); } }), (error) => error.code === "cart_reconciliation_required");
  assert.equal(calls, 2, "add's pre-read must not clear the ambiguity lock");
  await viewMagnitCart({ session: persisted, storeCode: "123456", mode: "express", saveSession: async (value) => { persisted = value; }, fetchImpl: async () => response(cart([])) });
  assert.equal(persisted.cartReconciliationRequired, false);
});

test("store/service mismatch and invalid quantity are rejected before fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(cart([])); };
  await assert.rejects(addMagnitCartItem({ session, storeCode: "123456", mode: "delivery", goodId: "x", offerId: "y", quantity: 1, fetchImpl }), /режим не совпадает/);
  await assert.rejects(addMagnitCartItem({ session, storeCode: "123456", mode: "express", goodId: "x", offerId: "y", quantity: 0, fetchImpl }));
  assert.equal(calls, 0);
});


test("HTTP 400 surfaces only safe upstream machine code, not server secrets or free-form messages", async () => {
  await assert.rejects(viewMagnitCart({
    session, storeCode: "123456", mode: "express",
    fetchImpl: async () => Response.json({ code: "INVALID_CONTEXT", message: "private-session-value" }, { status: 400 }),
  }), (error) => error.code === "upstream_error" && /HTTP 400, код: INVALID_CONTEXT/.test(error.message) && !error.message.includes("private-session-value"));
  await assert.rejects(viewMagnitCart({
    session, storeCode: "123456", mode: "express",
    fetchImpl: async () => Response.json({ code: "this-is-a-very-very-long-token:01234567890123456789012345678901234567890" }, { status: 400 }),
  }), (error) => error.code === "upstream_error" && error.message === "Запрос корзины отклонён (HTTP 400).");
});


test("browser-observed cart device headers and null permission marker are replayed", async () => {
  const observedSession = {
    cookie: session.cookie,
    context: { ...session.context, observedInBrowser: true, permissionsJwt: "null",
      deviceId: "synthetic-id", deviceTag: "synthetic-tag", appVersion: "2026.11.3-14.45",
      platformVersion: "Android Chrome 156", userAgent: "synthetic-user-agent" },
  };
  let headers;
  await viewMagnitCart({session: observedSession, storeCode: "123456", mode: "express", fetchImpl: async (_url, options) => {
    headers = options.headers;
    return response(cart([]));
  }});
  assert.equal(headers["x-device-id"], "synthetic-id");
  assert.equal(headers["x-device-tag"], "synthetic-tag");
  assert.equal(headers["x-app-version"], "2026.11.3-14.45");
  assert.equal(headers["x-platform-version"], "Android Chrome 156");
  assert.equal(headers["User-Agent"], "synthetic-user-agent");
  assert.equal(headers["x-permissions-jwt"], "null");
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers.Origin, undefined);
});
