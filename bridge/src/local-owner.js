import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  return LOOPBACK.has(normalized) || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function isDirectLocalOwnerRequest(req, expectedHost) {
  const host = String(req.headers.host || "").toLowerCase();
  if (host !== String(expectedHost || "").toLowerCase() || !isLoopbackAddress(req.socket?.remoteAddress)) return false;
  if (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"])) return false;
  return !["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"].some((name) => req.headers[name] !== undefined);
}

export async function loadOrCreateOwnerSecret(filename) {
  const path = resolve(filename);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{64}$/.test(existing)) throw new Error("Owner key file is invalid.");
    await chmod(path, 0o600);
    return existing;
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
  }
  const generated = randomBytes(48).toString("base64url");
  try {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(`${generated}\n`, "utf8"); await file.sync(); }
    finally { await file.close(); }
    await chmod(path, 0o600);
    return generated;
  } catch (cause) {
    if (cause?.code !== "EEXIST") throw cause;
    const raced = (await readFile(path, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{64}$/.test(raced)) throw new Error("Owner key file is invalid.");
    await chmod(path, 0o600);
    return raced;
  }
}
