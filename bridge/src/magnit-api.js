export const MAGNIT_SEARCH_URL = "https://magnit.ru/webgate/v2/goods/search";
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
  if (mode === "delivery") return { mode, storeType: "dostavka", catalogType: "3" };
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
    return {
      id: cleanText(item?.productId ?? item?.id, 48),
      name: cleanText(item?.name, 180),
      price_kopecks: price,
      price_rubles: price === null ? null : price / 100,
      old_price_kopecks: isPromotion ? oldPrice : null,
      in_stock: quantity == null || !Number.isFinite(quantity) ? null : quantity > 0,
      quantity: quantity != null && Number.isFinite(quantity) ? quantity : null,
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
  return { store_code: payload.storeCode, mode, store_type: payload.storeType, catalog_type: payload.catalogType, products: parseProducts({ ...data, storeCode: payload.storeCode }) };
}

export async function getMagnitCategories({ storeCode, mode = "delivery", fetchImpl = fetch, timeoutMs = 15_000 }) {
  const url = magnitCategoriesUrl(storeCode, mode);
  const data = await magnitRequest(url, { method: "GET", headers: { Accept: "application/json", Referer: "https://magnit.ru/" } }, fetchImpl, timeoutMs);
  if (!Array.isArray(data?.items)) throw new MagnitApiError("invalid_response", "Magnit returned an unexpected categories response.");
  return { store_code: validateStoreCode(storeCode), mode, categories: data.items.slice(0, 100).map((item) => ({ id: String(item?.id ?? "").slice(0, 48), name: cleanText(item?.name, 120), children: Array.isArray(item?.children) ? item.children.slice(0, 50).map((child) => ({ id: String(child?.id ?? "").slice(0, 48), name: cleanText(child?.name, 120) })) : [] })).filter((item) => item.id && item.name) };
}
