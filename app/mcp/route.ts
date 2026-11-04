import { getChatGPTUser } from "../chatgpt-auth";
import { forwardMcp, getBridgeSetupStatus, setupRequiredResult, toolsListResult } from "../magnit-bridge";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 16_384;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: "Sign in with ChatGPT is required." }, 401);

  const raw = await request.text();
  if (raw.length > MAX_REQUEST_BYTES) return json({ error: "Request too large." }, 413);
  let body: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32600, message: "Invalid Request" } }, 400);
  }
  if (body.method === "notifications/initialized") return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });

  if (body.method === "server/discover") {
    return json({ jsonrpc: "2.0", id: body.id ?? null, result: { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } });
  }
  if (body.method === "initialize") {
    return json({ jsonrpc: "2.0", id: body.id ?? null, result: { protocolVersion: "2026-07-28", capabilities: { tools: {} }, serverInfo: { name: "magnit-http-mcp", version: "0.2.0" } } });
  }
  if (body.method === "tools/list") {
    return json(toolsListResult(body.id ?? null));
  }
  if (body.method === "ping") {
    return json({ jsonrpc: "2.0", id: body.id ?? null, result: {} });
  }
  if (body.method === "tools/call") {
    const setup = getBridgeSetupStatus();
    if (!setup.urlReady) return json(setupRequiredResult(body.id ?? null, "HTTP MCP-сервис ещё не настроен. Запустите bridge и задайте MCP_BRIDGE_URL в runtime secrets Site."));
    if (!setup.tokenReady) return json(setupRequiredResult(body.id ?? null, "Не задан секрет MCP_BRIDGE_TOKEN в runtime secrets Site."));
    const params = body.params || {};
    if (typeof params.name !== "string" || !["magnit_status", "magnit_search_products", "magnit_list_categories"].includes(params.name)) {
      return json({ jsonrpc: "2.0", id: body.id ?? null, result: { isError: true, content: [{ type: "text", text: "Инструмент не поддерживается." }] } });
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      try { return await forwardMcp(body, controller.signal); }
      finally { clearTimeout(timeout); }
    } catch {
      return json({ jsonrpc: "2.0", id: body.id ?? null, result: { isError: true, content: [{ type: "text", text: "Не удалось связаться с HTTP MCP-сервисом. Проверьте его URL и доступность." }] } });
    }
  }
  return json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "Method not found" } }, 404);
}
