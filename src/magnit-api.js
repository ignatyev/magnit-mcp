export const MAGNIT_SEARCH_URL = "https://magnit.ru/webgate/v2/goods/search";
const PRODUCT_DETAIL_BASE = "https://magnit.ru/webgate/v2/goods";
const detailCache = new Map();
export function magnitCategoriesUrl(storeCode, mode) {
  const code = validateStoreCode(storeCode);
  const { storeType, catalogType } = catalogMode(mode);
  const url = new URL(`https://magnit.ru/webgate/v3/categories/store/${code}`);
  url.searchParams.set("storetype", storeType);
  url.searchParams.set("catalogtype", catalogType);
  return url.href;
}
const MAX_RESPONSE_BYTES = 2_000_000;

export class MagnitApiError extends Error {
  constructor(code, message) { super(message); this.name = "MagnitApiError"; this.code = code; }
}

export function validateStoreCode(value) {
  if (typeof value !== "string") throw new Error("storeCode must be a string.");
  const code = value.trim();
  if (!/^\d{4,8}$/.test(code)) throw new Error("MAGNIT_STORE_CODE must be 4–8 digits.");
  return code;
}

export function catalogMode(mode) {
  if (mode === "express") return { mode, storeType: "express", catalogType: "2" };
  // Official Chrome HAR (delivery, store 992332) uses catalogType 2; type 3 returns a different catalog.
  if (mode === "delivery") return { mode, storeType: "dostavka", catalogType: "2" };
  if (mode === "retail") return { mode, storeType: "1", catalogType: "1" };
  throw new Error("mode must be delivery or retail.");
}

export function makeSearchPayload(query, storeCode, limit = 20, mode = "delivery") {
  if (typeof query !== "string") throw new Error("query must be a string.");
  const term = query.trim();
  if (!term || term.length > 120) throw new Error("query must contain 1–120 characters.");
  const pageSize = Number(limit);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 30) throw new Error("limit must be an integer from 1 to 30.");
  const context = catalogMode(mode);
  return {
    term,
    pagination: { limit: pageSize, offset: 0 },
    sort: { order: "desc", type: "popularity" },
    includeAdultGoods: true,
    storeCode: validateStoreCode(storeCode),
    storeType: context.storeType,
    catalogType: context.catalogType,
  };
}

function cleanText(value, max = 180) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function parseProducts(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) throw new MagnitApiError("invalid_response", "Magnit returned an unexpected catalog response.");
  return payload.items.slice(0, 30).map((item) => {
    const price = Number.isSafeInteger(item?.price) && item.price >= 0 ? item.price : null;
    const oldPrice = Number.isSafeInteger(item?.promotion?.oldPrice) && item.promotion.oldPrice >= 0 ? item.promotion.oldPrice : null;
    const isPromotion = Boolean(price !== null && item?.promotion?.isPromotion && oldPrice !== null && oldPrice > price);
    const quantity = item?.quantity == null ? null : Number(item.quantity);
    const minOrder = Number.isSafeInteger(item?.orderProperties?.minOrderQuantity) && item.orderProperties.minOrderQuantity > 0 ? item.orderProperties.minOrderQuantity : null;
    const orderStep = Number.isSafeInteger(item?.orderProperties?.orderStepQuantity) && item.orderProperties.orderStepQuantity > 0 ? item.orderProperties.orderStepQuantity : null;
    const sourceId = typeof item?.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(item.id) ? item.id : "";
    const productId = typeof item?.productId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(item.productId) ? item.productId : "";
    const eligibleService = item?.service === "express" && item?.targetCart === "express"
      ? "express" : item?.service === "dostavka" && item?.targetCart === "dostavka" ? "delivery" : null;
    // Delivery product mapping still needs real-device verification. A product
    // is offered for writing only if it explicitly identifies its own service,
    // store and one-unit increment, with no age/biometry/weight restrictions.
    const addRule = eligibleService === "delivery" ? "constrained-delivery-catalog-v1" : "observed-express-fixture-v1";
    const cartAddBlockers = [];
    if (eligibleService === null || (payload.mode && eligibleService !== payload.mode)) cartAddBlockers.push("service_or_target_cart");
    if (typeof item?.storeCode !== "string" || item.storeCode !== String(payload.storeCode)) cartAddBlockers.push("store_mismatch");
    if (!sourceId || sourceId !== productId) cartAddBlockers.push("product_id_mismatch");
    if (item?.weighted?.isWeighted !== false) cartAddBlockers.push("weighted_or_unknown");
    if (minOrder !== 1 || orderStep !== 1) cartAddBlockers.push("non_unit_quantity");
    if (item?.isAdditionalActionRequired !== false || item?.isBiometryRequired !== false ||
      item?.isForAdults !== false || item?.needPassport !== false || item?.pickupOnly !== false)
      cartAddBlockers.push("special_restrictions");
    const cartAddable = cartAddBlockers.length === 0;
    return {
      id: cleanText(item?.productId ?? item?.id, 180),
      source_id: sourceId || null,
      product_id: productId || null,
      name: cleanText(item?.name, 180),
      price_kopecks: price,
      price_rubles: price === null ? null : price / 100,
      old_price_kopecks: isPromotion ? oldPrice : null,
      in_stock: quantity == null || !Number.isFinite(quantity) ? null : quantity > 0,
      quantity: quantity != null && Number.isFinite(quantity) ? quantity : null,
      min_order_quantity: minOrder,
      order_step_quantity: orderStep,
      weighted: item?.weighted && typeof item.weighted === "object" ? { is_weighted: typeof item.weighted.isWeighted === "boolean" ? item.weighted.isWeighted : null, shelf_weight: item.weighted.shelfWeight != null && Number.isFinite(Number(item.weighted.shelfWeight)) ? Number(item.weighted.shelfWeight) : null, unit_price_raw: Number.isSafeInteger(item.weighted.unitPrice) ? item.weighted.unitPrice : null } : null,
      increment: item?.increment && typeof item.increment === "object" ? { unit: cleanText(item.increment.unit, 40) || null, value: item.increment.value != null && Number.isFinite(Number(item.increment.value)) ? Number(item.increment.value) : null } : null,
      cart_addable: cartAddable,
      cart_add_blockers: cartAddBlockers,
      cart_add_rule: cartAddable ? addRule : null,
      good_id: cartAddable ? productId : null,
      offer_id: cartAddable ? sourceId : null,
      badges: Array.isArray(item?.badges) ? item.badges.slice(0, 8).map((badge) => cleanText(badge?.text, 64)).filter(Boolean) : [],
      product_url: item?.seoCode && (item?.productId || item?.id) ? `https://magnit.ru/product/${encodeURIComponent(cleanText(item.productId || item.id, 48))}-${encodeURIComponent(cleanText(item.seoCode, 80))}?shopCode=${encodeURIComponent(String(validateStoreCode(payload.storeCode)))}` : null,
    };
  }).filter((product) => product.id && product.name);
}

async function readBoundedJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Magnit returned an empty response.");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Magnit response exceeded the allowed size.");
    }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(data)); }
  catch { throw new MagnitApiError("invalid_response", "Magnit returned invalid JSON."); }
}

async function magnitRequest(url, options, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    if (cause?.name === "TimeoutError" || cause?.name === "AbortError") throw new MagnitApiError("timeout", "Magnit did not respond before the timeout.");
    throw new MagnitApiError("upstream_unavailable", "Magnit could not be reached.");
  }
  if (response.status === 403) { await response.body?.cancel().catch(() => {}); throw new MagnitApiError("access_restricted", "Magnit denied access to this catalog request."); }
  if (response.status === 429) { await response.body?.cancel().catch(() => {}); throw new MagnitApiError("rate_limited", "Magnit rate limited this request."); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new MagnitApiError("upstream_error", `Magnit catalog request failed with HTTP ${response.status}.`); }
  try { return await readBoundedJson(response); }
  catch (cause) {
    if (cause instanceof MagnitApiError) throw cause;
    if (cause?.name === "TimeoutError" || cause?.name === "AbortError") throw new MagnitApiError("timeout", "Magnit response timed out.");
    throw new MagnitApiError("invalid_response", "Magnit returned an invalid or oversized response.");
  }
}

export async function searchMagnit({ query, storeCode, limit = 20, mode = "delivery", fetchImpl = fetch, timeoutMs = 15_000 }) {
  const payload = makeSearchPayload(query, storeCode, limit, mode);
  const data = await magnitRequest(MAGNIT_SEARCH_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", Origin: "https://magnit.ru", Referer: "https://magnit.ru/" },
    body: JSON.stringify(payload),
  }, fetchImpl, timeoutMs);
  return { store_code: payload.storeCode, mode, store_type: payload.storeType, catalog_type: payload.catalogType, products: parseProducts({ ...data, storeCode: payload.storeCode, mode }) };
}

export async function getMagnitCategories({ storeCode, mode = "delivery", fetchImpl = fetch, timeoutMs = 15_000 }) {
  const url = magnitCategoriesUrl(storeCode, mode);
  const data = await magnitRequest(url, { method: "GET", headers: { Accept: "application/json", Referer: "https://magnit.ru/" } }, fetchImpl, timeoutMs);
  if (!Array.isArray(data?.items)) throw new MagnitApiError("invalid_response", "Magnit returned an unexpected categories response.");
  return { store_code: validateStoreCode(storeCode), mode, categories: data.items.slice(0, 100).map((item) => ({ id: String(item?.id ?? "").slice(0, 48), name: cleanText(item?.name, 120), children: Array.isArray(item?.children) ? item.children.slice(0, 50).map((child) => ({ id: String(child?.id ?? "").slice(0, 48), name: cleanText(child?.name, 120) })) : [] })).filter((item) => item.id && item.name) };
}

function cleanDetail(value, max = 180) { return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }

export async function getMagnitProductDetails({ productId, storeCode, mode = "express", fetchImpl = fetch, timeoutMs = 15_000 }) {
  if (typeof productId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(productId)) throw new MagnitApiError("invalid_arguments", "product_id должен быть явным идентификатором из каталога.");
  const code = validateStoreCode(storeCode);
  if (mode !== "express") throw new MagnitApiError("unsupported_mode", "Подробности товара поддерживаются только для режима express.");
  const cacheKey = `${code}\0${productId}`;
  const cached = detailCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return { ...cached.value, source: "magnit_http_cache", fetched_at: cached.fetchedAt };
  detailCache.delete(cacheKey);
  const url = new URL(`${PRODUCT_DETAIL_BASE}/${encodeURIComponent(productId)}/stores/${encodeURIComponent(code)}`);
  url.searchParams.set("storetype", "express");
  url.searchParams.set("catalogtype", "2");
  const item = await magnitRequest(url.href, { method: "GET", headers: { Accept: "application/json", Referer: "https://magnit.ru/" } }, fetchImpl, timeoutMs);
  if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || item.id !== productId) throw new MagnitApiError("invalid_response", "Магнит вернул несовпадающие сведения о товаре.");
  const price = Number.isSafeInteger(item.price) && item.price >= 0 ? item.price : null;
  const quantity = item.quantity == null ? null : Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : null;
  const detailList = Array.isArray(item.details) ? item.details.slice(0, 30).map((detail) => ({
    name: cleanDetail(detail?.name, 80),
    type: cleanDetail(detail?.type, 40),
    value: cleanDetail(detail?.value, 140),
    parameters: Array.isArray(detail?.parameters) ? detail.parameters.slice(0, 8).map((param) => ({ name: cleanDetail(param?.name, 60), value: cleanDetail(param?.value, 100) })).filter((param) => param.name || param.value) : [],
  })).filter((detail) => detail.name || detail.value || detail.parameters.length) : [];
  const weighted = item.weighted && typeof item.weighted === "object" ? {
    is_weighted: typeof item.weighted.isWeighted === "boolean" ? item.weighted.isWeighted : null,
    shelf_weight: item.weighted.shelfWeight != null && Number.isFinite(Number(item.weighted.shelfWeight)) ? Number(item.weighted.shelfWeight) : null,
    unit_price_raw: Number.isSafeInteger(item.weighted.unitPrice) ? item.weighted.unitPrice : null,
    unit: cleanDetail(item.weighted.unit, 40) || null,
  } : null;
  const result = {
    product_id: productId,
    store_code: code,
    mode: "express",
    name: cleanDetail(item.name, 180),
    price_kopecks: price,
    price_rubles: price === null ? null : price / 100,
    quantity: quantity,
    stock: quantity == null ? "unknown" : quantity > 0 ? "available" : "unavailable",
    weighted,
    increment: item.increment && typeof item.increment === "object" ? { unit: cleanDetail(item.increment.unit, 40) || null, value: item.increment.value != null && Number.isFinite(Number(item.increment.value)) ? Number(item.increment.value) : null } : null,
    order_properties: item.orderProperties && typeof item.orderProperties === "object" ? {
      min_order_quantity: Number.isSafeInteger(item.orderProperties.minOrderQuantity) ? item.orderProperties.minOrderQuantity : null,
      order_step_quantity: Number.isSafeInteger(item.orderProperties.orderStepQuantity) ? item.orderProperties.orderStepQuantity : null,
    } : { min_order_quantity: null, order_step_quantity: null },
    restrictions: Object.fromEntries(["isAdditionalActionRequired", "isBiometryRequired", "isForAdults", "needPassport", "pickupOnly"].map((key) => [key, typeof item[key] === "boolean" ? item[key] : null])),
    details: detailList,
    source: "magnit_http_unverified",
    fetched_at: new Date().toISOString(),
  };
  detailCache.set(cacheKey, { value: result, fetchedAt: result.fetched_at, expires: Date.now() + 5 * 60_000 });
  while (detailCache.size > 500) detailCache.delete(detailCache.keys().next().value);
  return result;
}
