import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MagnitApiError } from "./magnit-api.js";

const MAX_RECORDS = 500;
const TTL_MS = 30 * 24 * 60 * 60_000;
const UNRESOLVED = new Set(["pending", "ambiguous"]);

export function createCartOperationStore({ secret, filename = "./data/cart-operations.enc" }) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("Cart-operation encryption secret is unavailable.");
  const path = resolve(filename);
  const key = scryptSync(secret, "magnit-cart-operations-v1", 32);
  let queue = Promise.resolve();
  async function load() {
    let packedText;
    try {
      packedText = await readFile(path, "utf8");
    } catch (cause) {
      if (cause?.code === "ENOENT") return { records: [] };
      throw new MagnitApiError("idempotency_state_unavailable", "Защищённый журнал изменений недоступен; запись в корзину остановлена.");
    }
    try {
      const packed = JSON.parse(packedText);
      if (packed?.v !== 1 || typeof packed.iv !== "string" || typeof packed.tag !== "string" || typeof packed.data !== "string") throw new Error("invalid");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(packed.iv, "base64url"));
      decipher.setAuthTag(Buffer.from(packed.tag, "base64url"));
      const data = Buffer.concat([decipher.update(Buffer.from(packed.data, "base64url")), decipher.final()]);
      const doc = JSON.parse(data.toString("utf8"));
      if (!Array.isArray(doc?.records) || doc.records.length > MAX_RECORDS || doc.records.some((r) => !r || typeof r.requestId !== "string" || typeof r.sessionFingerprint !== "string" || typeof r.payloadHash !== "string" || typeof r.storeCode !== "string" || !["pending", "ambiguous", "complete", "reconciled"].includes(r.status) || !Number.isFinite(r.createdAt))) throw new Error("invalid");
      const records = doc.records.filter((r) => UNRESOLVED.has(r.status) || Date.now() - (Number.isFinite(r.settledAt) ? r.settledAt : r.createdAt) <= TTL_MS);
      if (records.length > MAX_RECORDS) throw new Error("capacity");
      if (records.length !== doc.records.length) { await save({ records }); }
      return { records };
    } catch { throw new MagnitApiError("idempotency_state_unavailable", "Защищённый журнал изменений повреждён; запись в корзину остановлена."); }
  }
  async function save(doc) {
    if (!Array.isArray(doc.records) || doc.records.length > MAX_RECORDS) throw new MagnitApiError("idempotency_ledger_full", "Журнал идемпотентности заполнен; корзина заблокирована ради безопасности.");
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify({ records: doc.records })), cipher.final()]);
    const packed = JSON.stringify({ v: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), data: data.toString("base64url") });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, packed, { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, path);
  }
  function serialized(operation) { const result = queue.then(operation, operation); queue = result.then(() => undefined, () => undefined); return result; }
  const fingerprint = (cookie) => createHash("sha256").update(cookie).digest("hex");
  return {
    fingerprint,
    inspect({ requestId, sessionFingerprint, payloadHash }) { return serialized(async () => {
      const doc = await load(), prior = doc.records.find((r) => r.requestId === requestId && r.sessionFingerprint === sessionFingerprint);
      if (!prior) return { replay: false };
      if (prior.payloadHash !== payloadHash) throw new MagnitApiError("idempotency_conflict", "request_id уже использован с другими изменениями.");
      if (prior.status === "complete" || prior.status === "reconciled") return { replay: true, status: prior.status, result: prior.result || null, verifiedAt: prior.verifiedAt || null };
      throw new MagnitApiError("cart_reconciliation_required", "Для этого request_id результат неизвестен. Сначала явно перечитайте корзину; повторять изменение нельзя.");
    }); },
    assertWritable({ sessionFingerprint, storeCode }) { return serialized(async () => {
      const doc = await load();
      if (doc.records.some((r) => r.sessionFingerprint === sessionFingerprint && r.storeCode === storeCode && UNRESOLVED.has(r.status))) throw new MagnitApiError("cart_reconciliation_required", "После неопределённого изменения сначала явно перечитайте эту корзину.");
    }); },
    begin(record) { return serialized(async () => {
      const doc = await load();
      if (doc.records.some((r) => r.sessionFingerprint === record.sessionFingerprint && r.storeCode === record.storeCode && UNRESOLVED.has(r.status))) throw new MagnitApiError("cart_reconciliation_required", "После неопределённого изменения сначала явно перечитайте эту корзину.");
      if (doc.records.some((r) => r.requestId === record.requestId && r.sessionFingerprint === record.sessionFingerprint)) throw new MagnitApiError("idempotency_conflict", "request_id уже использован.");
      if (doc.records.length >= MAX_RECORDS) throw new MagnitApiError("idempotency_ledger_full", "Журнал идемпотентности заполнен; не меняйте корзину до обслуживания журнала.");
      doc.records.push({ ...record, status: "pending", createdAt: Date.now() });
      await save(doc);
    }); },
    finish({ requestId, sessionFingerprint, status, result = null }) { return serialized(async () => {
      const doc = await load();
      const record = doc.records.find((r) => r.requestId === requestId && r.sessionFingerprint === sessionFingerprint);
      if (!record) throw new MagnitApiError("idempotency_state_lost", "Не удалось сохранить состояние операции; сначала перечитайте корзину.");
      record.status = status; record.result = result; record.verifiedAt = status === "complete" ? new Date().toISOString() : null; record.settledAt = ["complete", "reconciled"].includes(status) ? Date.now() : null;
      await save(doc);
    }); },
    reconcile({ sessionFingerprint, storeCode, cartSummary }) { return serialized(async () => {
      const doc = await load(); let changed = false;
      for (const record of doc.records) if (record.sessionFingerprint === sessionFingerprint && record.storeCode === storeCode && UNRESOLVED.has(record.status)) {
        record.status = "reconciled"; record.result = { reconciled_by_cart_read: true, request_id: record.requestId, cart_summary: cartSummary }; record.verifiedAt = new Date().toISOString(); record.settledAt = Date.now(); changed = true;
      }
      if (changed) await save(doc);
    }); },
  };
}
