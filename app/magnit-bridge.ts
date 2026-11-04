import { env } from "cloudflare:workers";

export const siteTools = [
  {
    name: "magnit_status",
    description: "Показать поддерживаемые возможности HTTP-сервера Магнит. Доступность upstream не проверяется.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "magnit_search_products",
    description: "Поиск в каталоге Магнит. Передавайте код магазина и режим: delivery или retail. Вход, корзина и заказ не поддерживаются.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 120 },
        store_code: { type: "string", pattern: "^[0-9]{4,8}$" },
        mode: { type: "string", enum: ["delivery", "retail"] },
        limit: { type: "integer", minimum: 1, maximum: 30, default: 20 },
      },
      required: ["query", "store_code", "mode"],
      additionalProperties: false,
    },
  },
  {
    name: "magnit_list_categories",
    description: "Список категорий каталога для кода магазина и режима delivery или retail.",
    inputSchema: {
      type: "object",
      properties: { store_code: { type: "string", pattern: "^[0-9]{4,8}$" }, mode: { type: "string", enum: ["delivery", "retail"] } },
      required: ["store_code", "mode"],
      additionalProperties: false,
    },
  },
] as const;

const supportedMethods = new Set(["server/discover", "initialize", "notifications/initialized", "ping", "tools/list", "tools/call"]);
const supportedTools: Set<string> = new Set(siteTools.map((tool) => tool.name));

export function getBridgeSetupStatus() {
  const rawUrl = env.MCP_BRIDGE_URL?.trim() || "";
  const tokenReady = Boolean(env.MCP_BRIDGE_TOKEN?.trim());
  let phoneUrl: string | null = null;
  let urlReady = false;
  try {
    const parsed = new URL(rawUrl);
    urlReady = parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname.endsWith("/mcp");
    if (urlReady) phoneUrl = `${parsed.origin}/`;
  } catch { urlReady = false; }
  return { configured: urlReady && tokenReady, urlReady, tokenReady, phoneUrl };
}

export function setupRequiredResult(id: string | number | null, message: string) {
  return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: `setup_required: ${message}` }] } };
}

export function toolsListResult(id: string | number | null) {
  return { jsonrpc: "2.0", id, result: { tools: siteTools } };
}

export async function forwardMcp(body: unknown, signal?: AbortSignal): Promise<Response> {
  const cfg = getBridgeSetupStatus();
  const token = env.MCP_BRIDGE_TOKEN?.trim();
  const rawUrl = env.MCP_BRIDGE_URL?.trim();
  if (!cfg.configured || !token || !rawUrl) return Response.json(setupRequiredResult(null, "HTTP-сервер MCP ещё не настроен."));
  const request = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const id = typeof request?.id === "string" || typeof request?.id === "number" ? request.id : null;
  if (request?.jsonrpc !== "2.0" || request.method !== "tools/call" || !request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
    return Response.json({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });
  }
  if (typeof request.params.name !== "string" || !supportedTools.has(request.params.name)) {
    return Response.json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "Инструмент не поддерживается." }] } });
  }
  const args = request.params.arguments ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return Response.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } });

  let upstream: Response;
  try {
    upstream = await fetch(rawUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal, redirect: "error" });
  } catch {
    return Response.json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "Не удалось подключиться к HTTP-серверу MCP." }] } });
  }
  if (!upstream.ok || !upstream.body) return Response.json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "HTTP-сервер MCP отклонил запрос." }] } });
  try {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let text = "", total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 256_000) { await reader.cancel(); throw new Error("oversized response"); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return Response.json(JSON.parse(text), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "HTTP-сервер вернул некорректный ответ." }] } });
  }
}
