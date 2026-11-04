import { MagnitApiError } from "./magnit-api.js";

export function createCartEligibilityRegistry({ now = () => Date.now(), ttlMs = 10 * 60_000, maxEntries = 500 } = {}) {
  const eligible = new Map();
  function prune() {
    const timestamp = now();
    for (const [key, value] of eligible) if (value.expires <= timestamp) eligible.delete(key);
  }
  return {
    remember(searchResult) {
      if (searchResult?.mode !== "express" || !Array.isArray(searchResult.products)) return;
      prune();
      const timestamp = now();
      for (const product of searchResult.products) {
        if (product.cart_addable !== true || !product.good_id || !product.offer_id) continue;
        const key = `${searchResult.store_code}\0${product.good_id}\0${product.offer_id}`;
        eligible.delete(key);
        eligible.set(key, { expires: timestamp + ttlMs, rule: product.cart_add_rule });
      }
      while (eligible.size > maxEntries) eligible.delete(eligible.keys().next().value);
    },
    require(storeCode, goodId, offerId) {
      prune();
      if (!eligible.has(`${storeCode}\0${goodId}\0${offerId}`)) throw new MagnitApiError("cart_item_not_verified", "Сначала найдите этот товар в express-каталоге; его ID не подтверждён для добавления.");
    },
    clear() { eligible.clear(); },
    get size() { prune(); return eligible.size; },
  };
}
