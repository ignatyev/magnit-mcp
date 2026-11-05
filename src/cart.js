import { MagnitApiError, validateStoreCode } from "./magnit-api.js";
import { createHash } from "node:crypto";

const CART_URL = "https://magnit.ru/webgate/v1/carts/lite";
const MAX_CART_BYTES = 1_000_000;
let writeQueue = Promise.resolve();
let reconciliationRequired = false;

function requireSession(session, storeCode, mode) {
  if (!session?.cookie) throw new MagnitApiError("session_missing", "Сначала войдите в Магнит на телефоне и сохраните сессию.");
  if (!["express", "dostavka"].includes(session?.context?.service) || !session?.context?.storeCode || !session?.context?.bff)
    throw new MagnitApiError("store_context_required", "Сначала выберите магазин и сервис доставки.");
  const selectedStoreCode = validateStoreCode(storeCode);
  validateStoreCode(session.context.storeCode);
  const service = mode === "delivery" ? "dostavka" : mode === "express" ? "express" : null;
  if (!service || service !== session.context.service || selectedStoreCode !== session.context.storeCode)
    throw new MagnitApiError("context_mismatch", "Код магазина или режим не совпадает с выбранным магазином корзины.");
  return session;
}

function cartHeaders(session) {
  const context = session.context;
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Cookie: session.cookie,
    Referer: "https://magnit.ru/",
    "x-new-magnit": "true",
    "x-client-name": "magnit",
    "x-device-platform": "Web",
    "x-service": context.service,
    "x-store-code": context.storeCode,
    "x-magnit-bff": context.bff,
  };
  // The official web client sends the literal string "null" when no permissions JWT exists.
  headers["x-permissions-jwt"] = context.permissionsJwt || "null";
  for (const [key, field, limit] of [
    ["x-device-id", "deviceId", 128],
    ["x-device-tag", "deviceTag", 128],
    ["x-app-version", "appVersion", 64],
    ["x-platform-version", "platformVersion", 96],
    ["User-Agent", "userAgent", 512],
  ]) {
    const value = context[field];
    if (typeof value === "string" && value.length > 0 && value.length <= limit && !/[\r\n\0]/.test(value)) headers[key] = value;
  }
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

// Only a short machine-readable error code may leave the upstream error response.
// Never echo arbitrary upstream text: it may contain identifiers or tokens.
async function safeCartErrorCode(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); return null; }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    const code = body?.code ?? body?.errorCode ?? (typeof body?.error === "object" ? body.error?.code : body?.error);
    return typeof code === "string" && /^[a-z][a-z0-9._:-]{1,63}$/i.test(code) ? code : null;
  } catch { return null; }
}

async function cartRequest(session, method, body, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(CART_URL, {
      method,
      headers: { ...cartHeaders(session), ...(method === "PUT" ? { Origin: "https://magnit.ru" } : {}) },
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
    const upstreamCode = response.status === 400 ? await safeCartErrorCode(response) : null;
    if (response.status !== 400) await response.body?.cancel().catch(() => {});
    if (response.status === 403) throw new MagnitApiError("access_denied", "Магнит ограничил доступ к корзине.");
    if (response.status === 401) throw new MagnitApiError("session_rejected", "Магнит отклонил сессию. Завершите вход и перечитайте корзину.");
    if (method === "PUT") throw new MagnitApiError("ambiguous_result", `Ответ Магнит на изменение корзины: HTTP ${response.status}. Перечитайте корзину перед любым повторным добавлением.`);
    throw new MagnitApiError("upstream_error", `Запрос корзины отклонён (HTTP ${response.status}${upstreamCode ? `, код: ${upstreamCode}` : ""}).`);
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
  if (!data || typeof data !== "object" || !Array.isArray(data.items) || data.items.length > 250)
    throw new MagnitApiError("invalid_response", "Магнит вернул неизвестную структуру корзины.");
  if (!Array.isArray(data.formats) || data.formats.length > 20)
    throw new MagnitApiError("invalid_response", "Магнит вернул неизвестную структуру форматов корзины.");

  const formats = data.formats.map((format) => {
    let storeCode = null;
    try { storeCode = validateStoreCode(String(format?.storeCode ?? "")); } catch {}
    return {
      service: typeof format?.service === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(format.service) ? format.service : null,
      store_code: storeCode,
      items_count: Number.isSafeInteger(format?.itemsCount) && format.itemsCount >= 0 && format.itemsCount <= 250 ? format.itemsCount : null,
    };
  });
  const selectedFormats = formats.filter((format) => format.service === context.service);
  const singleFormat = data.formats.length === 1 && selectedFormats.length === 1;
  let unattributed = 0;
  const items = [];
  for (const item of data.items) {
    const service = typeof item?.goodService === "string" ? item.goodService : null;
    // Do not silently ascribe an unlabelled item to delivery when multiple
    // services share the account cart. Such items remain unknown.
    if (service !== context.service && !(service == null && singleFormat)) {
      if (service == null) unattributed++;
      continue;
    }
    let itemStore = null;
    if (item?.goodStoreCode != null) {
      try { itemStore = validateStoreCode(String(item.goodStoreCode)); } catch {}
    }
    items.push({
      good_id: typeof item?.goodId === "string" ? item.goodId.slice(0, 128) : null,
      offer_id: typeof item?.offerId === "string" ? item.offerId.slice(0, 128) : null,
      quantity: Number.isSafeInteger(item?.qnty) ? item.qnty : null,
      good_store_code: itemStore,
      good_service: service,
      quantity_increment: item?.increment && typeof item.increment === "object"
        ? { unit: typeof item.increment.unit === "string" ? item.increment.unit.slice(0, 40) : null, value: Number.isFinite(item.increment.value) ? item.increment.value : null }
        : null,
      catalog_price_raw: Number.isSafeInteger(item?.catalogPrice) ? item.catalogPrice : null,
    });
  }
  const multi = data.formats.length > 1;
  const totals_lite = {
    base_price_raw: typeof data.totalBasePrice === "number" ? data.totalBasePrice : null,
    final_price_raw: typeof data.totalFinalPrice === "number" ? data.totalFinalPrice : null,
    goods_count: Number.isSafeInteger(data.totalGoodsCount) ? data.totalGoodsCount : null,
    is_checkout_quote: false,
    applies_to_selected_service: !multi && singleFormat,
    note: multi
      ? "Общая сумма всех форматов корзины; не является стоимостью выбранной доставки."
      : "Сводка lite-корзины; не является итогом оформления заказа.",
  };
  const common = {
    store_code: context.storeCode,
    request_store_code: context.storeCode,
    service: context.service,
    formats,
    selected_formats: selectedFormats,
    items,
    // Redacted shape diagnostics: counts and store codes only, no cart IDs,
    // cookies, delivery address or private upstream response text.
    raw_item_count: data.items.length,
    raw_format_count: data.formats.length,
    excluded_other_service_count: data.items.length - items.length - unattributed,
    browser_context_verified: context.observedInBrowser === true,
    unattributed_items_count: unattributed,
    totals_lite,
  };
  if (data.formats.length === 0 && data.items.length === 0) {
    const locked = context.service === "dostavka" && context.observedInBrowser !== true;
    return { ...common, cart_store_code: null, read_only: locked,
      cart_context_status: "empty", warning: locked
        ? "Для изменения пустой корзины доставки синхронизируйте её в официальном Chrome и проверьте магазин."
        : null };
  }
  if (selectedFormats.length === 0) {
    return { ...common, cart_store_code: null, read_only: true, cart_context_status: "selected_format_missing",
      warning: data.formats.length === 0 && data.items.length > 0
        ? "API вернул позиции без указания формата корзины. Предыдущее добавление могло сработать; проверьте корзину в официальном Магните. Повторная запись запрещена до однозначного подтверждения."
        : "В ответе нет корзины выбранного сервиса. Показываем только позиции, явно относящиеся к нему; изменение запрещено." };
  }
  if (multi || selectedFormats.length !== 1) {
    return { ...common, cart_store_code: selectedFormats.length === 1 ? selectedFormats[0].store_code : null,
      read_only: true, cart_context_status: "multiple_formats",
      warning: "Магнит вернул несколько форматов. Показаны только позиции выбранного сервиса; неоднозначные позиции не включены. Изменение корзины запрещено." };
  }
  const format = data.formats[0], cartStoreCode = selectedFormats[0].store_code;
  if (!cartStoreCode) throw new MagnitApiError("cart_context_ambiguous", "Формат корзины не содержит допустимый код магазина.");
  if (!Number.isSafeInteger(format?.itemsCount) || format.itemsCount < 0 || format.itemsCount > 250)
    throw new MagnitApiError("cart_context_ambiguous", "Формат корзины не содержит допустимое количество товаров.");
  for (const item of data.items) {
    if ((item?.goodStoreCode != null && String(item.goodStoreCode) !== cartStoreCode) ||
        (item?.goodService != null && String(item.goodService) !== context.service))
      throw new MagnitApiError("cart_context_ambiguous", "В корзине обнаружен другой магазин или сервис.");
  }
  const readOnly = context.service === "dostavka" && context.observedInBrowser !== true;
  return { ...common, cart_store_code: cartStoreCode, read_only: readOnly,
    cart_context_status: "single_format",
    warning: readOnly ? "Для изменения корзины доставки синхронизируйте её в официальном Chrome." : null };
}

export async function viewMagnitCart({ session, storeCode, mode, fetchImpl = fetch, timeoutMs = 15_000, saveSession = async () => {}, operationStore = null }) {
  const active = requireSession(session, storeCode, mode);
  return serializeCartOperation(async () => {
    const data = await cartRequest(active, "GET", null, fetchImpl, timeoutMs);
    const view = cartView(data, active.context);
    // An ambiguous GET only proves the HTTP call succeeded. It cannot resolve
    // pending writes against a particular store or format.
    if (view.read_only) return view;
    reconciliationRequired = false;
    if (operationStore) await operationStore.reconcile({ sessionFingerprint: operationStore.fingerprint(active.cookie), storeCode: active.context.service === "dostavka" ? `dostavka:${active.context.storeCode}` : active.context.storeCode, cartSummary: { item_count: view.items.length, request_store_code: view.request_store_code } });
    if (active.cartReconciliationRequired) await saveSession({ ...active, cartReconciliationRequired: false });
    return view;
  });
}

export async function addMagnitCartItem({ session, storeCode, mode, goodId, offerId, quantity, fetchImpl = fetch, timeoutMs = 15_000, saveSession = async () => {}, operationStore = null }) {
  const active = requireSession(session, storeCode, mode);
  if (mode !== "express") throw new MagnitApiError("unsupported_mode", "Добавление в корзину доставки пока не поддерживается.");
  if (typeof goodId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(goodId)) throw new Error("good_id должен быть явным идентификатором товара.");
  if (typeof offerId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(offerId)) throw new Error("offer_id должен быть явным идентификатором предложения.");
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) throw new Error("quantity должен быть целым числом от 1 до 99.");
  const operation = async () => {
    if (operationStore) await operationStore.assertWritable({ sessionFingerprint: operationStore.fingerprint(active.cookie), storeCode: active.context.storeCode });
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

function normalizeCartOperations(operations) {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 50) throw new MagnitApiError("invalid_arguments", "operations должен содержать от 1 до 50 изменений.");
  const seen = new Set();
  return operations.map((op) => {
    if (!op || typeof op !== "object" || Array.isArray(op) || !["add", "set", "remove"].includes(op.action)) throw new MagnitApiError("invalid_arguments", "У каждого изменения должно быть action add, set или remove.");
    if (typeof op.good_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(op.good_id) || typeof op.offer_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(op.offer_id)) throw new MagnitApiError("invalid_arguments", "Для каждого изменения нужны точные good_id и offer_id.");
    const key = `${op.good_id}\0${op.offer_id}`;
    if (seen.has(key)) throw new MagnitApiError("invalid_arguments", "В одном пакете нельзя повторять одну позицию.");
    seen.add(key);
    if (op.action === "remove") {
      if (op.quantity !== undefined) throw new MagnitApiError("invalid_arguments", "Для remove не передавайте quantity.");
      return { action: op.action, good_id: op.good_id, offer_id: op.offer_id };
    }
    if (!Number.isSafeInteger(op.quantity) || op.quantity < 1 || op.quantity > 99) throw new MagnitApiError("invalid_arguments", "Количество для add/set должно быть целым числом от 1 до 99.");
    return { action: op.action, good_id: op.good_id, offer_id: op.offer_id, quantity: op.quantity };
  });
}

export async function applyMagnitCart({ session, storeCode, mode, requestId, operations, fetchImpl = fetch, timeoutMs = 15_000, saveSession = async () => {}, operationStore, requireEligible = async () => {} }) {
  const active = requireSession(session, storeCode, mode);
  if (mode === "delivery" && active.context.observedInBrowser !== true)
    throw new MagnitApiError("delivery_context_unverified", "Для изменения корзины доставки сначала синхронизируйте реальную корзину в официальном Chrome.");
  if (!operationStore) throw new MagnitApiError("idempotency_unavailable", "Защищённое состояние пакетной операции не настроено.");
  if (typeof requestId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) throw new MagnitApiError("invalid_arguments", "request_id должен содержать 8–128 допустимых символов.");
  const normalized = normalizeCartOperations(operations);
  const fingerprint = operationStore.fingerprint(active.cookie);
  const journalStoreCode = mode === "delivery" ? `dostavka:${active.context.storeCode}` : active.context.storeCode;
  const payloadHash = createHash("sha256").update(JSON.stringify({ store_code: validateStoreCode(storeCode), mode, operations: normalized })).digest("hex");
  return serializeCartOperation(async () => {
    const previous = await operationStore.inspect({ requestId, sessionFingerprint: fingerprint, payloadHash });
    if (previous.replay) return { request_id: requestId, replayed: true, replay_status: previous.status, historical_result: previous.result, verified_at: previous.verifiedAt, current_cart: false };
    await operationStore.assertWritable({ sessionFingerprint: fingerprint, storeCode: journalStoreCode });
    if (reconciliationRequired || active.cartReconciliationRequired) throw new MagnitApiError("cart_reconciliation_required", "После неопределённого изменения сначала явно перечитайте корзину.");
    for (const op of normalized) if (op.action !== "remove") await requireEligible(storeCode, op.good_id, op.offer_id, op.action);
    const before = await cartRequest(active, "GET", null, fetchImpl, timeoutMs);
    const beforeView = cartView(before, active.context);
    if (beforeView.read_only)
      throw new MagnitApiError("cart_format_ambiguous", "Магнит вернул несколько форматов или товары без формата; изменение заблокировано до однозначного состава корзины.");
    if (!Array.isArray(before.items) || before.items.length > 250) throw new MagnitApiError("invalid_response", "Невозможно безопасно сохранить состав корзины.");
    let formatStoreCode = null;
    if (before.formats.length === 1) {
      try { formatStoreCode = validateStoreCode(String(before.formats[0]?.storeCode ?? "")); } catch { throw new MagnitApiError("cart_context_ambiguous", "Формат корзины не содержит допустимый код магазина."); }
    } else if (!(before.items.length === 0 && before.formats.length === 0)) throw new MagnitApiError("cart_format_ambiguous", "Корзина содержит неизвестное число форматов.");
    const items = new Map();
    for (const item of before.items) {
      if (typeof item?.goodId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(item.goodId) || typeof item?.offerId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(item.offerId) || !Number.isSafeInteger(item?.qnty) || item.qnty < 0) throw new MagnitApiError("cart_item_shape_unverified", "В корзине есть позиция с неизвестным ID или количеством; пакет остановлен.");
      if ((item.goodStoreCode != null && String(item.goodStoreCode) !== formatStoreCode) || (item.goodService != null && String(item.goodService) !== active.context.service)) throw new MagnitApiError("cart_context_ambiguous", "В корзине обнаружен другой магазин или сервис.");
      const key = keyFor(item.goodId, item.offerId);
      if (items.has(key)) throw new MagnitApiError("cart_duplicate_item_ambiguous", "В корзине есть повторяющиеся ID; пакет остановлен.");
      // Observed GET may contain zero-quantity deleted lines; successful PUT
      // from Chrome excludes them. Keep every positive-weight/quantity line.
      if (item.qnty > 0) items.set(key, { goodId: item.goodId, offerId: item.offerId, qnty: item.qnty });
    }
    for (const op of normalized) {
      const key = keyFor(op.good_id, op.offer_id), current = items.get(key);
      if (op.action === "add") {
        const qnty = (current?.qnty || 0) + op.quantity;
        if (!Number.isSafeInteger(qnty) || qnty > 999) throw new MagnitApiError("invalid_arguments", "Итоговое количество позиции превышает допустимый предел.");
        items.set(key, { goodId: op.good_id, offerId: op.offer_id, qnty });
      } else if (op.action === "set") {
        if (!current) throw new MagnitApiError("cart_item_not_found", "Нельзя задать количество: такой позиции нет в текущей корзине.");
        items.set(key, { ...current, qnty: op.quantity });
      } else {
        if (!current) throw new MagnitApiError("cart_item_not_found", "Нельзя удалить: такой позиции нет в текущей корзине.");
        items.delete(key);
      }
    }
    const expectedItems = [...items.values()];
    if (expectedItems.length > 250) throw new MagnitApiError("cart_limit_exceeded", "Пакет превысит безопасный предел позиций корзины.");
    await operationStore.begin({ requestId, sessionFingerprint: fingerprint, payloadHash, storeCode: journalStoreCode });
    let after;
    try { after = await cartRequest(active, "PUT", { items: expectedItems }, fetchImpl, timeoutMs); }
    catch (cause) { await operationStore.finish({ requestId, sessionFingerprint: fingerprint, status: "ambiguous" }); throw cause; }
    // Magnit's successful delivery PUT may return extra unattributed cart lines
    // (observed in the official Chrome HAR), even when formats.itemsCount refers
    // only to the selected service. Treat this write response as advisory: only
    // a fresh, independently verified GET can confirm a delivery mutation.
    const matchesExpected = (view) => {
      if (view.read_only) return false;
      const reportedItems = view.items;
      if (reportedItems.some((item) => !item.good_id || !item.offer_id ||
        !Number.isSafeInteger(item.quantity) || item.quantity < 0)) return false;
      const checkedItems = mode === "delivery"
        ? reportedItems.filter((item) => item.quantity > 0)
        : reportedItems;
      // An ordinary delivery GET can retain zero-quantity tombstones. They are
      // not active cart lines, but any unexpected positive line is a mismatch.
      if (mode === "delivery" && view.selected_formats.length === 1 &&
        view.selected_formats[0].items_count !== checkedItems.length) return false;
      const actual = new Map(checkedItems.map((item) => [keyFor(item.good_id, item.offer_id), item.quantity]));
      return actual.size === expectedItems.length && checkedItems.length === expectedItems.length &&
        expectedItems.every((item) => actual.get(keyFor(item.goodId, item.offerId)) === item.qnty) &&
        (!formatStoreCode || checkedItems.length === 0 || view.cart_store_code === formatStoreCode);
    };
    let result;
    if (mode === "delivery") {
      try {
        result = cartView(await cartRequest(active, "GET", null, fetchImpl, timeoutMs), active.context);
        if (!matchesExpected(result))
          throw new MagnitApiError("cart_readback_mismatch", "Повторное чтение не подтвердило товары.");
      } catch {
        await operationStore.finish({ requestId, sessionFingerprint: fingerprint, status: "ambiguous" });
        throw new MagnitApiError("ambiguous_result", "После изменения доставки не удалось подтвердить её состав повторным чтением. Не повторяйте запрос; проверьте корзину в официальном Магните.");
      }
    } else {
      try { result = cartView(after, active.context); }
      catch { await operationStore.finish({ requestId, sessionFingerprint: fingerprint, status: "ambiguous" }); throw new MagnitApiError("ambiguous_result", "Ответ не подтвердил контекст корзины. Перечитайте корзину перед следующим изменением."); }
      if (!matchesExpected(result)) {
        await operationStore.finish({ requestId, sessionFingerprint: fingerprint, status: "ambiguous" });
        throw new MagnitApiError("ambiguous_result", "Магнит не подтвердил все позиции; перечитайте корзину перед следующим изменением.");
      }
    }
    const summary = { store_code: result.request_store_code, cart_store_code: result.cart_store_code, item_count: result.items.length, verified_actions: normalized.map((op) => ({ action: op.action, good_id: op.good_id, offer_id: op.offer_id, quantity: op.action === "remove" ? null : items.get(keyFor(op.good_id, op.offer_id))?.qnty ?? null })), mutation: "applied_and_verified", verified_at: new Date().toISOString() };
    try { await operationStore.finish({ requestId, sessionFingerprint: fingerprint, status: "complete", result: summary }); }
    catch { throw new MagnitApiError("cart_reconciliation_required", "Корзина обновилась, но квитанцию операции сохранить не удалось. Перечитайте корзину; тот же request_id повторно не применится."); }
    return { ...result, request_id: requestId, replayed: false, ...summary };
  });
}

function keyFor(goodId, offerId) { return `${goodId}\0${offerId}`; }
