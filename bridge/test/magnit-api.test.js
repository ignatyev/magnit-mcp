import test from "node:test";
import assert from "node:assert/strict";
import {
  catalogMode,
  getMagnitCategories,
  magnitCategoriesUrl,
  makeSearchPayload,
  parseProducts,
  searchMagnit,
  validateStoreCode,
} from "../src/magnit-api.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const rawProducts = { items: [
  { id: "800", productId: "801", seoCode: "milk", name: "Молоко 2,5% 900 мл", price: 16999, quantity: 7, promotion: { isPromotion: true, oldPrice: 19999 }, badges: [{ text: "По карте" }] },
  { id: "802", name: "Товар без цены", price: null, quantity: null, promotion: { isPromotion: true, oldPrice: 1000 } },
  { id: "803", name: "Неверная цена", price: 1.25, quantity: "unknown" },
] };

test("search issues the fixed Magnit POST and explicit delivery payload", async () => {
  let seen;
  const result = await searchMagnit({ query: "молоко", storeCode: "123456", mode: "delivery", limit: 5, fetchImpl: async (url, init) => { seen = { url, init }; return jsonResponse(rawProducts); } });
  assert.equal(seen.url, "https://magnit.ru/webgate/v2/goods/search");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.redirect, "error");
  assert.equal(seen.init.headers.Origin, "https://magnit.ru");
  assert.deepEqual(JSON.parse(seen.init.body), {
    term: "молоко", pagination: { limit: 5, offset: 0 }, sort: { order: "desc", type: "popularity" },
    includeAdultGoods: true, storeCode: "123456", storeType: "dostavka", catalogType: "3",
  });
  assert.equal(result.products[0].price_kopecks, 16999);
  assert.equal(result.products[0].price_rubles, 169.99);
  assert.equal(result.products[0].old_price_kopecks, 19999);
  assert.equal(result.products[0].product_url, "https://magnit.ru/product/801-milk?shopCode=123456");
  assert.equal(result.products[1].price_kopecks, null);
  assert.equal(result.products[1].price_rubles, null);
  assert.equal(result.products[1].old_price_kopecks, null);
  assert.equal(result.products[1].in_stock, null);
  assert.equal(result.products[2].price_rubles, null);
  assert.equal(result.products[2].in_stock, null);
});

test("retail catalog mode is explicit and not silently mapped to delivery", () => {
  assert.deepEqual(catalogMode("retail"), { mode: "retail", storeType: "1", catalogType: "1" });
  assert.deepEqual(makeSearchPayload("сыр", "1234", 30, "retail"), {
    term: "сыр", pagination: { limit: 30, offset: 0 }, sort: { order: "desc", type: "popularity" },
    includeAdultGoods: true, storeCode: "1234", storeType: "1", catalogType: "1",
  });
  assert.throws(() => catalogMode("unknown"));
});

test("input validation bounds store code, query, and page size before fetch", async () => {
  assert.equal(validateStoreCode("1234"), "1234");
  assert.throws(() => validateStoreCode("123"));
  assert.throws(() => validateStoreCode(123456));
  assert.throws(() => makeSearchPayload("", "1234"));
  assert.throws(() => makeSearchPayload({ term: "milk" }, "1234"));
  assert.throws(() => makeSearchPayload("x".repeat(121), "1234"));
  assert.throws(() => makeSearchPayload("milk", "1234", 33));
});

test("categories use the fixed path and mode-specific query names", async () => {
  assert.equal(magnitCategoriesUrl("123456", "delivery"), "https://magnit.ru/webgate/v3/categories/store/123456?storetype=dostavka&catalogtype=3");
  assert.equal(magnitCategoriesUrl("123456", "retail"), "https://magnit.ru/webgate/v3/categories/store/123456?storetype=1&catalogtype=1");
  let seen;
  const result = await getMagnitCategories({ storeCode: "123456", mode: "retail", fetchImpl: async (url, init) => { seen = { url, init }; return jsonResponse({ items: [{ id: 1, name: "Молочные", children: [{ id: 2, name: "Сыр" }] }] }); } });
  assert.equal(seen.init.method, "GET");
  assert.equal(result.categories[0].children[0].name, "Сыр");
});

test("403 is access_restricted and is never retried", async () => {
  let calls = 0;
  await assert.rejects(searchMagnit({ query: "молоко", storeCode: "123456", fetchImpl: async () => { calls++; return new Response("blocked", { status: 403 }); } }), (error) => error.code === "access_restricted");
  assert.equal(calls, 1);
});

test("upstream 429, 500 and redirects fail without following redirects", async () => {
  await assert.rejects(searchMagnit({ query: "x", storeCode: "123456", fetchImpl: async () => new Response("", { status: 429 }) }), (error) => error.code === "rate_limited");
  await assert.rejects(searchMagnit({ query: "x", storeCode: "123456", fetchImpl: async () => new Response("", { status: 503 }) }), /HTTP 503/);
  let redirectPolicy;
  await assert.rejects(searchMagnit({ query: "x", storeCode: "123456", fetchImpl: async (_url, init) => { redirectPolicy = init.redirect; throw new TypeError("redirect blocked"); } }), (error) => error.code === "upstream_unavailable");
  assert.equal(redirectPolicy, "error");
});

test("network timeouts and oversized responses return bounded errors", async () => {
  await assert.rejects(searchMagnit({ query: "x", storeCode: "123456", fetchImpl: async () => { const e = new Error("timeout"); e.name = "TimeoutError"; throw e; } }), (error) => error.code === "timeout");
  const large = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2_000_001)); controller.close(); } }));
  await assert.rejects(searchMagnit({ query: "x", storeCode: "123456", fetchImpl: async () => large }), (error) => error.code === "invalid_response");
});

test("unexpected product response shape is an upstream schema error", async () => {
  await assert.rejects(searchMagnit({ query: "x", storeCode: "123456", fetchImpl: async () => jsonResponse({ products: [] }) }), (error) => error.code === "invalid_response");
});
