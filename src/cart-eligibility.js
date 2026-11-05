import { MagnitApiError } from "./magnit-api.js";

export function createCartEligibilityRegistry({ now = () => Date.now(), ttlMs = 10 * 60_000, maxEntries = 500 } = {}) {
  const eligible = new Map();
  const metadata = new Map();
  function prune() {
    const timestamp = now();
    for (const [key, value] of eligible) if (value.expires <= timestamp) eligible.delete(key);
    for (const [key, value] of metadata) if (value.expires <= timestamp) metadata.delete(key);
  }
  return {
    remember(searchResult) {
      if (searchResult?.mode !== "express" || !Array.isArray(searchResult.products)) return;
      prune();
      const timestamp = now();
      for (const product of searchResult.products) {
        if (product?.id && product?.name) {
          const metadataKey = `${searchResult.store_code}\0${product.good_id || ""}\0${product.offer_id || ""}`;
          metadata.delete(metadataKey);
          metadata.set(metadataKey, { expires: timestamp + ttlMs, name: product.name, price_kopecks: product.price_kopecks ?? null, price_rubles: product.price_rubles ?? null, quantity: product.quantity ?? null, in_stock: product.in_stock ?? null, min_order_quantity: product.min_order_quantity ?? null, order_step_quantity: product.order_step_quantity ?? null, weighted: product.weighted ?? null, increment: product.increment ?? null, fetched_at: new Date(timestamp).toISOString() });
        }
        if (product.cart_addable !== true || !product.good_id || !product.offer_id) continue;
        const key = `${searchResult.store_code}\0${product.good_id}\0${product.offer_id}`;
        eligible.delete(key);
        eligible.set(key, { expires: timestamp + ttlMs, rule: product.cart_add_rule });
      }
      while (eligible.size > maxEntries) eligible.delete(eligible.keys().next().value);
      while (metadata.size > maxEntries) metadata.delete(metadata.keys().next().value);
    },
    require(storeCode, goodId, offerId) {
      prune();
      if (!eligible.has(`${storeCode}\0${goodId}\0${offerId}`)) throw new MagnitApiError("cart_item_not_verified", "Сначала найдите этот товар в express-каталоге; его ID не подтверждён для добавления.");
    },
    cartMappingFor(storeCode, productId) {
      prune();
      const key = `${storeCode}\0${productId}\0${productId}`;
      const rule = eligible.get(key);
      return rule ? { good_id: productId, offer_id: productId, cart_addable: true, cart_add_rule: rule.rule } : null;
    },
    metadataFor(storeCode, goodId, offerId) {
      prune();
      const value = metadata.get(`${storeCode}\0${goodId}\0${offerId}`);
      if (!value) return null;
      const { expires, ...safe } = value;
      return safe;
    },
    clear() { eligible.clear(); },
    get size() { prune(); return eligible.size; },
  };
}
