import test from "node:test";
import assert from "node:assert/strict";
import { createCartEligibilityRegistry } from "../src/cart-eligibility.js";

const eligible = { cart_addable: true, cart_add_rule: "fixture-v1", good_id: "g1", offer_id: "o1" };

test("only recent express search results authorize add and the registry is bounded", () => {
  const registry = createCartEligibilityRegistry({ maxEntries: 2 });
  registry.remember({ mode: "retail", store_code: "123456", products: [eligible] });
  assert.throws(() => registry.require("123456", "g1", "o1"), (error) => error.code === "cart_item_not_verified");
  registry.remember({ mode: "express", store_code: "123456", products: [eligible] });
  registry.require("123456", "g1", "o1");
  assert.throws(() => registry.require("123457", "g1", "o1"), (error) => error.code === "cart_item_not_verified");
  registry.remember({ mode: "express", store_code: "123456", products: [
    eligible, { ...eligible, good_id: "g2", offer_id: "o2" }, { ...eligible, good_id: "g3", offer_id: "o3" },
  ] });
  assert.equal(registry.size, 2);
  assert.throws(() => registry.require("123456", "g1", "o1"), (error) => error.code === "cart_item_not_verified");
});

test("search eligibility expires after ten minutes", () => {
  let now = 10;
  const registry = createCartEligibilityRegistry({ now: () => now, ttlMs: 100 });
  registry.remember({ mode: "express", store_code: "123456", products: [eligible] });
  registry.require("123456", "g1", "o1");
  now += 101;
  assert.throws(() => registry.require("123456", "g1", "o1"), (error) => error.code === "cart_item_not_verified");
});
