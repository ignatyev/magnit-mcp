import { env } from "cloudflare:workers";

export const siteTools = [
  {
    name: "magnit_status",
    description: "Проверить, открыт ли официальный сайт Магнит в удалённом браузере. Не возвращает личные данные аккаунта.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "magnit_open_home",
    description: "Открыть официальный сайт magnit.ru в удалённом браузере. Вход выполняется пользователем на телефоне.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "magnit_search_products",
    description: "Открыть поиск товаров на официальной странице Магнит.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 120 },
        shop_code: { type: "string", pattern: "^[0-9]{4,8}$" },
        shop_type: { type: "string", enum: ["dostavka", "supermarket", "hypermarket"] },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "magnit_page_summary",
    description: "Прочитать краткую сводку видимых карточек и безопасных кнопок страницы Магнит.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "magnit_click_reference",
    description: "Нажать видимую ссылку или кнопку по её свежей ссылке и точному тексту. Финальную отправку заказа и оплату нужно подтвердить вручную в телефоне.",
    inputSchema: {
      type: "object",
      properties: {
        reference: { type: "string", minLength: 1, maxLength: 12 },
        expected_text: { type: "string", minLength: 1, maxLength: 80 },
      },
      required: ["reference", "expected_text"],
      additionalProperties: false,
    },
  },
] as const;

const supportedMethods = new Set([
  "server/discover",
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
]);
const supportedTools: Set<string> = new Set(siteTools.map((tool) => tool.name));

export type BridgeConfig = { url: string; token: string } | null;

export function getBridgeSetupStatus() {
  const rawUrl = env.MCP_BRIDGE_URL?.trim() || "";
  const tokenReady = Boolean(env.MCP_BRIDGE_TOKEN?.trim());
  let phoneUrl: string | null = null;
  let urlReady = false;
  try {
    const parsed = new URL(rawUrl);
    urlReady = parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname.endsWith("/mcp");
    if (urlReady) phoneUrl = `${parsed.origin}/`;
  } catch {
    urlReady = false;
  }
  return { configured: urlReady && tokenReady, urlReady, tokenReady, phoneUrl };
}

export function getBridgeConfig(): BridgeConfig {
  const rawUrl = env.MCP_BRIDGE_URL?.trim();
  const token = env.MCP_BRIDGE_TOKEN?.trim();
  if (!rawUrl || !token) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/mcp")) return null;
    return { url: url.href, token };
  } catch {
    return null;
  }
}

export function setupRequiredResult(id: string | number | null, message: string) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      isError: true,
      content: [{ type: "text", text: `setup_required: ${message}` }],
    },
  };
}

export async function forwardMcp(body: unknown, signal?: AbortSignal): Promise<Response> {
  const config = getBridgeConfig();
  if (!config) return Response.json(setupRequiredResult(null, "Сервер браузера Магнит ещё не настроен."), { status: 200 });
  const request = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const id = typeof request?.id === "string" || typeof request?.id === "number" ? request.id : null;
  if (request?.jsonrpc !== "2.0" || typeof request.method !== "string" || !supportedMethods.has(request.method)) {
    return Response.json({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } }, { status: 200 });
  }
  if (request.method === "tools/call") {
    const params = request.params || {};
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      return Response.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } }, { status: 200 });
    }
    if (typeof params.name !== "string" || !supportedTools.has(params.name)) {
      return Response.json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "Инструмент не поддерживается." }] } }, { status: 200 });
    }
    const args = params.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return Response.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } }, { status: 200 });
    }
  }
  const upstream = await fetch(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(body),
    signal,
    redirect: "error",
  }).catch(() => null);
  if (!upstream) {
    return Response.json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "Сервер браузера не отвечает. Проверьте его развёртывание и HTTPS-адрес." }] } }, { status: 200 });
  }
  if (!upstream.ok) {
    return Response.json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "Сервер браузера отклонил запрос. Проверьте его настройки доступа." }] } }, { status: 200 });
  }
  let text = "";
  try {
    const reader = upstream.body?.getReader();
    if (!reader) throw new Error("empty response");
    const decoder = new TextDecoder();
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256_000) { await reader.cancel(); throw new Error("response too large"); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return Response.json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "Сервер вернул некорректный или слишком большой ответ." }] } }, { status: 502 });
  }
  try {
    return Response.json(JSON.parse(text), { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "Сервер браузера вернул некорректный ответ." }] } }, { status: 502 });
  }
}

export function toolsListResult(id: string | number | null) {
  return { jsonrpc: "2.0", id, result: { tools: siteTools } };
}
