import { MagnitApiError, validateStoreCode } from "./magnit-api.js";

const ADDRESS_URL = "https://magnit.ru/webgate/customer_addresses/v1/address_book";
const STORE_URL = "https://magnit.ru/webgate/v1/stores-facade/store";
const MAX_BYTES = 512_000;

function clean(value, max = 180) { return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : null; }

async function readJson(response) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) throw new MagnitApiError("session_rejected", "Магнит отклонил сохранённый вход.");
    if (response.status === 403) throw new MagnitApiError("access_restricted", "Магнит ограничил чтение контекста аккаунта.");
    throw new MagnitApiError("upstream_error", `Запрос контекста Магнит отклонён (HTTP ${response.status}).`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new MagnitApiError("invalid_response", "Магнит вернул пустой ответ контекста.");
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw new MagnitApiError("invalid_response", "Ответ контекста Магнит слишком велик."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new MagnitApiError("invalid_response", "Магнит вернул неизвестную структуру контекста."); }
}

async function request(url, options, fetchImpl) {
  let response;
  try { response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
  catch (cause) { throw new MagnitApiError(cause?.name === "TimeoutError" ? "timeout" : "upstream_unavailable", "Не удалось прочитать контекст Магнит."); }
  return readJson(response);
}

function addressView(data) {
  if (!Array.isArray(data?.data)) throw new MagnitApiError("invalid_response", "Магнит вернул неизвестную структуру адресов.");
  const active = data.data.filter((item) => item?.attributes?.isActive === true).slice(0, 5).map((item) => {
    const a = item.attributes;
    const parts = [a.province, a.locality, a.street, a.house].map((part) => clean(part, 100)).filter(Boolean);
    return { type: clean(item.type, 40), display: parts.length ? parts.join(", ") : null };
  });
  return active;
}

function storeView(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || data.status !== "STATUS_ACTIVE") throw new MagnitApiError("invalid_response", "Магнит не подтвердил выбранный магазин.");
  const address = data.address;
  const storeAddress = typeof address === "string" ? clean(address, 220) : address && typeof address === "object"
    ? [address.province, address.locality, address.street, address.house].map((part) => clean(part, 100)).filter(Boolean).join(", ") || null
    : null;
  return { store_address: storeAddress, store_type: clean(data.storeType, 40), store_type_v2: clean(data.storeTypeV2, 40), delivery_types: Array.isArray(data.deliveryTypeList) ? data.deliveryTypeList.slice(0, 8).map((item) => clean(item, 48)).filter(Boolean) : [] };
}

export async function getMagnitShoppingContext({ session, fetchImpl = fetch }) {
  if (typeof session?.cookie !== "string" || !session.cookie) throw new MagnitApiError("session_missing", "Сначала войдите в Магнит на телефоне и сохраните сессию.");
  const headers = { Accept: "application/json", Cookie: session.cookie, Referer: "https://magnit.ru/", "x-magnit-bff": "1", "x-new-magnit": "true" };
  const addressData = await request(ADDRESS_URL, { method: "GET", headers }, fetchImpl);
  const selected = ["express", "dostavka"].includes(session.context?.service) && session.context?.storeCode ? validateStoreCode(session.context.storeCode) : null;
  let store = null;
  if (selected) {
    const storeData = await request(STORE_URL, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ externalId: { owner: "OWNER_MAGNIT", storeCode: selected } }) }, fetchImpl);
    if (storeData?.externalId?.owner !== "OWNER_MAGNIT" || String(storeData.externalId.storeCode ?? "") !== selected) throw new MagnitApiError("invalid_response", "Магнит вернул данные другого магазина.");
    store = storeView(storeData);
  }
  return { auth_saved: true, address_source: "magnit_address_book_http_unverified", active_addresses: addressView(addressData), selected_store: selected ? { store_code: selected, service: session.context.service, source: "saved_search_context", address_store_association: "unverified", ...store } : null, store_selection_note: selected ? "Магазин сохранён из поиска; связь с активным адресом не подтверждена." : "Код магазина не выбран. Активный адрес не определяет код магазина.", fetched_at: new Date().toISOString() };
}

export async function getMagnitOrderHistory({ session, page = 1, limit = 10, fetchImpl = fetch }) {
  if (typeof session?.cookie !== "string" || !session.cookie) throw new MagnitApiError("session_missing", "Сначала войдите в Магнит на телефоне и сохраните сессию.");
  if (!Number.isSafeInteger(page) || page < 1 || page > 100 || !Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw new MagnitApiError("invalid_arguments", "page должен быть 1–100, limit — 1–30.");
  const url = new URL("https://magnit.ru/webgate/v2/orders/history/list");
  url.searchParams.set("page", String(page)); url.searchParams.set("limit", String(limit));
  const data = await request(url.href, { method: "GET", headers: { Accept: "application/json", Cookie: session.cookie, Referer: "https://magnit.ru/", "x-magnit-bff": "1", "x-new-magnit": "true" } }, fetchImpl);
  if (!data || typeof data !== "object" || !Array.isArray(data.items) || !Number.isSafeInteger(data.count) || data.items.length > limit) throw new MagnitApiError("invalid_response", "Магнит вернул неизвестную структуру истории заказов.");
  let productsRemaining = 200;
  const orders = data.items.slice(0, limit).map((order) => {
    const rawProducts = Array.isArray(order?.cart) ? order.cart : [];
    const products = rawProducts.slice(0, Math.min(30, productsRemaining)).map((item) => ({ article_reference: clean(item?.article, 100), name: clean(item?.name, 120) })).filter((item) => item.article_reference || item.name);
    productsRemaining -= products.length;
    return ({
    order_id: clean(order?.orderId, 100),
    created_at: clean(order?.createdAt, 64),
    service: clean(order?.service, 40),
    receive_type: clean(order?.receiveType, 48),
    status: order?.status && typeof order.status === "object" ? { code: clean(order.status.code, 48), name: clean(order.status.name, 100), subtitle: clean(order.status.subtitle, 180), text: clean(order.status.text, 180), updated_at: clean(order.status.updatedAt, 64) } : null,
    store_name: clean(order?.store?.name, 120),
    shop_reference: order?.shop && typeof order.shop === "object" ? { id: clean(order.shop.id, 80), owner: clean(order.shop.owner, 64), format: clean(order.shop.format, 64), pickup_work: clean(order.shop.pickUpWork, 48) } : null,
    total_price_raw: Number.isSafeInteger(order?.totalPrice) ? order.totalPrice : null,
    total_display: clean(order?.summary?.header?.formattedValue, 48),
    products,
    products_total: rawProducts.length,
    products_truncated: products.length < rawProducts.length,
    products_reference_only: true,
    });
  });
  return { page, limit, count: data.count, pages_count: Number.isSafeInteger(data.pagesCount) ? data.pagesCount : null, orders, source: "magnit_order_history_http_unverified", fetched_at: new Date().toISOString(), note: "Артикулы в истории — справочные данные, не good_id/offer_id. Для изменения корзины найдите товар в каталоге." };
}
