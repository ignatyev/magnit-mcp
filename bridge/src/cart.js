import { MagnitApiError, validateStoreCode } from "./magnit-api.js";

const CART_URL = "https://magnit.ru/webgate/v1/carts/lite";
const MAX_CART_BYTES = 1_000_000;
let writeQueue = Promise.resolve();
let reconciliationRequired = false;

function requireSession(session, storeCode, mode) {
  if (!session?.cookie || session?.context?.service !== "express") throw new MagnitApiError("session_missing", "Импортируйте актуальную сессию корзины Магнит для режима express.");
  const selectedStoreCode = validateStoreCode(storeCode);
  validateStoreCode(session.context.storeCode);
  if (mode !== "express" || selectedStoreCode !== session.context.storeCode) throw new MagnitApiError("context_mismatch", "Код магазина или режим не совпадает с импортированной сессией корзины.");
  return session;
}

function cartHeaders(session) {
  const context = session.context;
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Cookie: session.cookie,
    "x-service": context.service,
    "x-store-code": context.storeCode,
    "x-magnit-bff": context.bff,
  };
  if (context.permissionsJwt) headers["x-permissions-jwt"] = context.permissionsJwt;
  return headers;
}

async function boundedJson(response) {
  if (!response.body) throw new MagnitApiError("invalid_response", "Магнит вернул пустой ответ корзины.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_CART_BYTES) { await reader.cancel(); throw new MagnitApiError("invalid_response", "Ответ корзины слишком велик."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new MagnitApiError("invalid_response", "Магнит вернул некорректный JSON корзины."); }
}

async function cartRequest(session, method, body, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(CART_URL, {
      method,
      headers: cartHeaders(session),
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const code = method === "PUT" ? "ambiguous_result" : cause?.name === "TimeoutError" || cause?.name === "AbortError" ? "timeout" : "upstream_unavailable";
    const message = code === "ambiguous_result" ? "Не удалось подтвердить изменение корзины. Сначала перечитайте корзину; повторно добавлять товар автоматически нельзя." : code === "timeout" ? "Истекло время ожидания ответа корзины." : "Не удалось связаться с API Магнит.";
    throw new MagnitApiError(code, message);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 403) throw new MagnitApiError("access_denied", "Магнит ограничил доступ к корзине.");
    if (response.status === 401) throw new MagnitApiError("session_rejected", "Магнит отклонил сессию. Завершите вход и перечитайте корзину.");
    if (method === "PUT") throw new MagnitApiError("ambiguous_result", `Ответ Магнит на изменение корзины: HTTP ${response.status}. Перечитайте корзину перед любым повторным добавлением.`);
    throw new MagnitApiError("upstream_error", `Запрос корзины отклонён (HTTP ${response.status}).`);
  }
  try { return await boundedJson(response); }
  catch (cause) {
    if (method === "PUT") throw new MagnitApiError("ambiguous_result", "Магнит ответил на изменение корзины, но результат не удалось прочитать. Перечитайте корзину перед повторным добавлением.");
    throw cause;
  }
}

function serializeCartOperation(operation) {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

function cartView(data, context) {
  if (!data || typeof data !== "object" || !Array.isArray(data.items) || data.items.length > 250) throw new MagnitApiError("invalid_response", "Магнит вернул неизвестную структуру корзины.");
  if (!Array.isArray(data.formats)) throw new MagnitApiError("cart_format_ambiguous", "Корзина не содержит список форматов.");
  if (data.items.length === 0 && data.formats.length === 0) return {
    store_code: context.storeCode,
    request_store_code: context.storeCode,
    cart_store_code: null,
    service: context.service,
    items: [],
    totals_lite: { base_price_raw: typeof data.totalBasePrice === "number" ? data.totalBasePrice : null, final_price_raw: typeof data.totalFinalPrice === "number" ? data.totalFinalPrice : null, goods_count: Number.isSafeInteger(data.totalGoodsCount) ? data.totalGoodsCount : null, is_checkout_quote: false, note: "Сводка lite-корзины; не является итогом оформления заказа." },
  };
  if (data.formats.length !== 1) throw new MagnitApiError("cart_format_ambiguous", "Корзина содержит неизвестное число форматов.");
  const format = data.formats[0];
  let cartStoreCode;
  try { cartStoreCode = validateStoreCode(String(format?.storeCode ?? "")); } catch { throw new MagnitApiError("cart_context_ambiguous", "Формат корзины не содержит допустимый код магазина."); }
  if (format?.service !== context.service || !Number.isSafeInteger(format?.itemsCount) || format.itemsCount < 0 || format.itemsCount > 250) throw new MagnitApiError("cart_context_ambiguous", "Формат корзины не совпадает с express-контекстом.");
  for (const item of data.items) {
    if ((item?.goodStoreCode != null && String(item.goodStoreCode) !== cartStoreCode) || (item?.goodService != null && String(item.goodService) !== context.service)) throw new MagnitApiError("cart_context_ambiguous", "В корзине обнаружен другой магазин или сервис.");
  }
  const items = data.items.map((item) => ({
    good_id: typeof item?.goodId === "string" ? item.goodId.slice(0, 128) : null,
    offer_id: typeof item?.offerId === "string" ? item.offerId.slice(0, 128) : null,
    quantity: Number.isSafeInteger(item?.qnty) ? item.qnty : null,
  }));
  return {
    store_code: context.storeCode,
    request_store_code: context.storeCode,
    cart_store_code: cartStoreCode,
    service: context.service,
    items,
    totals_lite: {
      base_price_raw: typeof data.totalBasePrice === "number" ? data.totalBasePrice : null,
      final_price_raw: typeof data.totalFinalPrice === "number" ? data.totalFinalPrice : null,
      goods_count: Number.isSafeInteger(data.totalGoodsCount) ? data.totalGoodsCount : null,
      is_checkout_quote: false,
      note: "Сводка lite-корзины; не является итогом оформления заказа.",
    },
  };
}

export async function viewMagnitCart({ session, storeCode, mode, fetchImpl = fetch, timeoutMs = 15_000, saveSession = async () => {} }) {
  const active = requireSession(session, storeCode, mode);
  return serializeCartOperation(async () => {
    const data = await cartRequest(active, "GET", null, fetchImpl, timeoutMs);
    const view = cartView(data, active.context);
    reconciliationRequired = false;
    if (active.cartReconciliationRequired) await saveSession({ ...active, cartReconciliationRequired: false });
    return view;
  });
}

export async function addMagnitCartItem({ session, storeCode, mode, goodId, offerId, quantity, fetchImpl = fetch, timeoutMs = 15_000, saveSession = async () => {} }) {
  const active = requireSession(session, storeCode, mode);
  if (typeof goodId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(goodId)) throw new Error("good_id должен быть явным идентификатором товара.");
  if (typeof offerId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(offerId)) throw new Error("offer_id должен быть явным идентификатором предложения.");
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) throw new Error("quantity должен быть целым числом от 1 до 99.");
  const operation = async () => {
    if (reconciliationRequired || active.cartReconciliationRequired) throw new MagnitApiError("cart_reconciliation_required", "После неопределённого изменения сначала вызовите magnit_view_cart; добавление остановлено.");
    const before = await cartRequest(active, "GET", null, fetchImpl, timeoutMs);
    if (!Array.isArray(before?.items) || before.items.length > 250) throw new MagnitApiError("invalid_response", "Невозможно безопасно сохранить состав корзины.");
    if (!Array.isArray(before.formats)) throw new MagnitApiError("cart_format_ambiguous", "Корзина не содержит список форматов.");
    let format = null;
    let formatStoreCode = null;
    if (before.items.length === 0 && before.formats.length === 0) {
      format = null;
    } else {
      if (before.formats.length !== 1) throw new MagnitApiError("cart_format_ambiguous", "Корзина содержит неизвестное число форматов; изменение остановлено, чтобы ничего не потерять.");
      format = before.formats[0];
      try { formatStoreCode = validateStoreCode(String(format?.storeCode ?? "")); } catch { throw new MagnitApiError("cart_context_ambiguous", "Формат корзины не содержит допустимый код магазина."); }
      if (format?.service !== active.context.service || !Number.isSafeInteger(format?.itemsCount) || format.itemsCount < 0 || format.itemsCount > 250) throw new MagnitApiError("cart_context_ambiguous", "Контекст корзины не совпадает с express-сервисом.");
    }
    const merged = new Map();
    for (const item of before.items) {
      if (typeof item?.goodId !== "string" || typeof item?.offerId !== "string" || !Number.isSafeInteger(item?.qnty) || item.qnty < 1) {
        throw new MagnitApiError("cart_item_shape_unverified", "В корзине есть товар с неизвестными идентификаторами или количеством; изменение остановлено, чтобы не удалить его.");
      }
      if ((item.goodStoreCode != null && String(item.goodStoreCode) !== formatStoreCode) || (item.goodService != null && String(item.goodService) !== active.context.service)) {
        throw new MagnitApiError("cart_context_ambiguous", "В корзине обнаружен другой магазин или сервис; изменение остановлено.");
      }
      const key = `${item.goodId}\0${item.offerId}`;
      if (merged.has(key)) throw new MagnitApiError("cart_duplicate_item_ambiguous", "В корзине уже есть повторяющиеся идентификаторы товара. Изменение остановлено; состав можно только перечитать.");
      merged.set(key, { goodId: item.goodId, offerId: item.offerId, qnty: item.qnty });
    }
    const key = `${goodId}\0${offerId}`;
    const previous = merged.get(key);
    const nextQuantity = quantity + (previous?.qnty ?? 0);
    if (!Number.isSafeInteger(nextQuantity) || nextQuantity > 999) throw new Error("Количество товара в корзине превышает допустимый предел.");
    merged.set(key, { goodId, offerId, qnty: nextQuantity });
    const items = [...merged.values()];
    let after;
    try { after = await cartRequest(active, "PUT", { items }, fetchImpl, timeoutMs); }
    catch (cause) {
      if (cause?.code === "ambiguous_result") {
        reconciliationRequired = true;
        await saveSession({ ...active, cartReconciliationRequired: true });
      }
      throw cause;
    }
    let result;
    try { result = cartView(after, active.context); }
    catch {
      reconciliationRequired = true;
      await saveSession({ ...active, cartReconciliationRequired: true });
      throw new MagnitApiError("ambiguous_result", "Магнит ответил, но результат не подтвердил контекст корзины. Перечитайте корзину перед любым повтором.");
    }
    if ((formatStoreCode && result.cart_store_code !== formatStoreCode) || result.service !== active.context.service) {
      reconciliationRequired = true;
      await saveSession({ ...active, cartReconciliationRequired: true });
      throw new MagnitApiError("ambiguous_result", "Магнит ответил с другим форматом или магазином корзины. Перечитайте корзину перед повтором.");
    }
    const expected = new Map(items.map((item) => [`${item.goodId}\0${item.offerId}`, item.qnty]));
    const actual = new Map(result.items.filter((item) => item.good_id && item.offer_id && item.quantity !== null).map((item) => [`${item.good_id}\0${item.offer_id}`, item.quantity]));
    const verified = actual.size === expected.size && [...expected].every(([key, qnty]) => actual.get(key) === qnty) && result.items.length === expected.size && actual.get(keyFor(goodId, offerId)) === nextQuantity;
    if (!verified) {
      reconciliationRequired = true;
      await saveSession({ ...active, cartReconciliationRequired: true });
      throw new MagnitApiError("ambiguous_result", "Магнит ответил, но не подтвердил все позиции и количества. Перечитайте корзину; товар автоматически повторно не добавлялся.");
    }
    return { ...result, mutation: "added_and_verified", verified_quantity: nextQuantity };
  };
  return serializeCartOperation(operation);
}

function keyFor(goodId, offerId) { return `${goodId}\0${offerId}`; }
