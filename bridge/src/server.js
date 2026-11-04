import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  constantTimeEqual,
  createPhoneSessionCodec,
  isBlockedAction,
  isMagnitUrl,
  makeSearchUrl,
  safeMcpClick,
  sanitizeVisibleText,
  selectAndroidDevice,
} from "./policy.js";

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || (process.env.BROWSER_MODE === "android" ? "127.0.0.1" : "0.0.0.0");
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN || "";
const PHONE_ACCESS_SECRET = process.env.PHONE_ACCESS_SECRET || "";
const PROFILE_DIR = process.env.BROWSER_PROFILE || "/data/chromium-profile";
const COOKIE_SECURE = process.env.COOKIE_SECURE !== "0";
const BROWSER_MODE = process.env.BROWSER_MODE || "desktop";
const ANDROID_DEVICE_SERIAL = process.env.ANDROID_DEVICE_SERIAL || "";
const ANDROID_CHROME_PACKAGE = process.env.ANDROID_CHROME_PACKAGE || "com.android.chrome";
const COOKIE_NAME = "magnit_phone_session";
const MAX_BODY_BYTES = 16 * 1024;
const rateBuckets = new Map();
const pageReferences = new Map();
const sessionCodec = createPhoneSessionCodec(PHONE_ACCESS_SECRET);
let browserContext;
let androidDevice;
let page;
let manualNavigationUntil = 0;
let pageRevision = 0;
let browserQueue = Promise.resolve();

function serializeBrowser(action) {
  const task = browserQueue.then(action, action);
  browserQueue = task.catch(() => {});
  return task;
}

if (!MCP_BEARER_TOKEN || MCP_BEARER_TOKEN.length < 32) throw new Error("MCP_BEARER_TOKEN must be at least 32 characters.");
if (!PHONE_ACCESS_SECRET || PHONE_ACCESS_SECRET.length < 32) throw new Error("PHONE_ACCESS_SECRET must be at least 32 characters.");
if (!/^https:\/\//.test(PUBLIC_BASE_URL)) throw new Error("PUBLIC_BASE_URL must use HTTPS.");

const DEFAULT_TOOLS = [
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
    description: "Открыть поиск товаров Магнит по официальной веб-странице. Возвращаемые товары извлекаются только из видимых карточек страницы.",
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
    description: "Прочитать краткую безопасную сводку текущей страницы и список видимых кнопок/ссылок, доступных для безопасного клика.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "magnit_click_reference",
    description: "Нажать видимую кнопку или ссылку на странице Магнит по её свежей ссылке и точному тексту. Финальную отправку заказа и оплату инструмент блокирует; подтверждать покупку можно только вручную на телефоне.",
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
];

const PHONE_HTML = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#fffaf4"><title>Магнит на телефоне</title>
<style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#222;background:#f7f4ef}*{box-sizing:border-box}body{margin:0;min-height:100dvh}.shell{max-width:680px;margin:auto;padding:16px 14px calc(28px + env(safe-area-inset-bottom))}.top{display:flex;justify-content:space-between;align-items:center;margin:4px 0 12px}.brand{font-size:20px;font-weight:800;letter-spacing:-.03em}.mark{color:#d63630}.sub{font-size:13px;color:#716c66}.panel{background:white;border:1px solid #e8e2d9;border-radius:18px;padding:14px;margin:10px 0;box-shadow:0 4px 18px #423a3010}.row{display:flex;gap:8px;align-items:center}.row.wrap{flex-wrap:wrap}button,input{font:inherit}button{border:0;border-radius:12px;background:#e3342f;color:white;font-weight:700;padding:12px 14px;min-height:44px;cursor:pointer}button.secondary{background:#f2eee8;color:#34312e}button.warn{background:#fff0ef;color:#a91e1a;border:1px solid #f3cac8}input{min-width:0;flex:1;border:1px solid #ddd5ca;border-radius:12px;padding:12px;background:#fff}#screen{display:block;width:100%;height:auto;border-radius:12px;background:#f1ede7;touch-action:manipulation}#screenBox{position:relative;overflow:hidden;border-radius:12px;min-height:240px}.hint{font-size:12px;line-height:1.45;color:#706a63}.status{font-size:13px;color:#57514b;min-height:18px}.gate{max-width:420px;margin:12vh auto}.hidden{display:none!important}.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.actions button{width:100%}.busy{opacity:.65;pointer-events:none}
</style></head><body><main class="shell"><div id="gate" class="panel gate"><div class="brand">Магнит <span class="mark">в телефоне</span></div><p class="sub">Введите пароль доступа, который вы задали при развёртывании сервиса.</p><form id="loginForm"><div class="row"><input id="phonePassword" type="password" autocomplete="current-password" placeholder="Пароль доступа" required><button>Войти</button></div><p id="loginError" class="status" role="status"></p></form><p class="hint">Этот пароль открывает только удалённый браузер. СМС-код и пароль от Магнит ID вводятся на официальной странице Магнит в следующем окне.</p></div>
<section id="app" class="hidden"><div class="top"><div><div class="brand">Магнит <span class="mark">на телефоне</span></div><div class="sub">Управляйте своим официальным браузером</div></div><button class="secondary" id="logout">Выход</button></div>
<div class="panel"><div class="actions"><button id="home">Открыть Магнит</button><button class="secondary" id="reload">Обновить страницу</button></div><div class="row" style="margin-top:8px"><input id="query" type="search" maxlength="120" placeholder="Найти товары"><button id="search">Найти</button></div><div id="status" class="status" role="status"></div></div>
<div class="panel"><div class="row wrap" style="justify-content:space-between;margin-bottom:10px"><strong>Официальная страница</strong><span class="sub" id="address">magnit.ru</span></div><div id="screenBox"><img id="screen" alt="Экран официального сайта Магнит"></div><p class="hint">Коснитесь элемента на экране, чтобы нажать его. Введите текст только в выбранное поле; коды входа вводите здесь же в официальной форме. Кнопки оформления и оплаты можно нажать только вручную на этой странице.</p><div class="row"><input id="typing" type="password" autocomplete="new-password" placeholder="Текст для выбранного поля"><button id="type">Ввести</button></div><div class="row wrap" style="margin-top:8px"><button class="secondary" id="back">Назад</button><button class="secondary" id="up">Прокрутить вверх</button><button class="secondary" id="down">Вниз</button><button class="secondary" id="selectAll">Выбрать всё</button><button class="secondary" id="enter">↵ Ввод</button><button class="warn" id="forget">Забыть вход</button></div></div>
<div id="androidNote" class="panel hint hidden">Режим Android использует профиль выбранного Chrome. Выйдите из аккаунта Магнит вручную на официальной странице; сервис не удаляет и не очищает общий профиль браузера.</div><div class="panel hint">Экран виден только после ввода пароля доступа и передаётся по HTTPS. СМС-коды и данные оплаты не отправляются MCP-инструментам.</div></section></main>
<script>
(() => {
  const gate=document.querySelector('#gate'), app=document.querySelector('#app'), status=document.querySelector('#status'), screen=document.querySelector('#screen'), address=document.querySelector('#address');
  let csrf=''; let busy=false;
  async function request(url,body){const r=await fetch(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin'});if(!r.ok)throw new Error((await r.json().catch(()=>({error:'Ошибка запроса'}))).error||'Ошибка запроса');return r.status===204?{}:r.json()}
  async function refresh(){try{const x=await request('/api/state');csrf=x.csrf;address.textContent=x.address;if(x.browserMode==='android'){document.querySelector('#forget').hidden=true;document.querySelector('#androidNote').classList.remove('hidden')}screen.src='/api/screenshot?t='+Date.now();gate.classList.add('hidden');app.classList.remove('hidden')}catch{app.classList.add('hidden');gate.classList.remove('hidden')}}
  document.querySelector('#loginForm').addEventListener('submit',async e=>{e.preventDefault();const p=document.querySelector('#phonePassword').value;try{const x=await request('/api/phone/session',{passphrase:p});csrf=x.csrf;document.querySelector('#phonePassword').value='';await refresh()}catch{document.querySelector('#loginError').textContent='Пароль не принят. Попробуйте ещё раз.'}});
  async function act(action){if(busy)return;busy=true;app.classList.add('busy');try{await request('/api/browser/action',action);status.textContent=''}catch(e){status.textContent=e.message||'Действие не выполнено'}finally{busy=false;app.classList.remove('busy');await refresh()}}
  document.querySelector('#home').onclick=()=>act({action:'home'});document.querySelector('#reload').onclick=()=>act({action:'reload'});document.querySelector('#back').onclick=()=>act({action:'back'});document.querySelector('#enter').onclick=()=>act({action:'press',key:'Enter'});document.querySelector('#up').onclick=()=>act({action:'scroll',delta:-600});document.querySelector('#down').onclick=()=>act({action:'scroll',delta:600});document.querySelector('#selectAll').onclick=()=>act({action:'press',key:'Control+A'});
  document.querySelector('#search').onclick=()=>{const query=document.querySelector('#query').value.trim();if(query)act({action:'search',query})};document.querySelector('#query').addEventListener('keydown',e=>{if(e.key==='Enter')document.querySelector('#search').click()});
  document.querySelector('#type').onclick=()=>{const field=document.querySelector('#typing');const text=field.value;if(text){field.value='';act({action:'type',text})}};
  screen.addEventListener('click',e=>{const r=screen.getBoundingClientRect();const x=Math.round((e.clientX-r.left)*screen.naturalWidth/r.width);const y=Math.round((e.clientY-r.top)*screen.naturalHeight/r.height);act({action:'click',x,y})});
  screen.addEventListener('wheel',e=>{e.preventDefault();act({action:'scroll',delta:Math.max(-600,Math.min(600,e.deltaY))})},{passive:false});
  document.querySelector('#forget').onclick=()=>{if(confirm('Выйти из аккаунта Магнит в этом браузере?'))act({action:'forget'})};
  document.querySelector('#logout').onclick=async()=>{await request('/api/phone/logout',{csrf});location.reload()};
  setInterval(()=>{if(!app.classList.contains('hidden')&&!busy){screen.src='/api/screenshot?t='+Date.now()}},2200);refresh();
})();
</script></body></html>`;

function originMatches(req) {
  const expected = new URL(PUBLIC_BASE_URL).origin;
  const origin = req.headers.origin;
  if (origin !== expected) return false;
  const fetchSite = req.headers["sec-fetch-site"];
  return !fetchSite || fetchSite === "same-origin";
}

function readSession(req) {
  const raw = (req.headers.cookie || "").split(";").map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  return raw ? sessionCodec.verify(raw) : null;
}

function appendSessionCookie(res, value, maxAge) {
  const flags = [`${COOKIE_NAME}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (COOKIE_SECURE) flags.push("Secure");
  res.setHeader("Set-Cookie", flags.join("; "));
}

function writeJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(JSON.stringify(body));
}

function genericError(res, status = 400, message = "Не удалось выполнить действие.") {
  writeJson(res, status, { error: message });
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function limited(key, max, intervalMs) {
  const now = Date.now();
  if (rateBuckets.size > 2000) {
    for (const [bucket, value] of rateBuckets) if (value.until < now) rateBuckets.delete(bucket);
    while (rateBuckets.size > 2000) rateBuckets.delete(rateBuckets.keys().next().value);
  }
  const item = rateBuckets.get(key);
  if (!item || item.until < now) {
    rateBuckets.set(key, { count: 1, until: now + intervalMs });
    return true;
  }
  item.count += 1;
  return item.count <= max;
}

function peerKey(req) {
  // Do not trust forwarded IPs unless the deployment explicitly sits behind a proxy.
  const forwarded = process.env.TRUST_PROXY === "1" ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
  return forwarded || req.socket.remoteAddress || "unknown";
}

function requirePhone(req, res) {
  if (!originMatches(req)) { genericError(res, 403, "Запрос должен идти с этой страницы."); return null; }
  const session = readSession(req);
  if (!session) { genericError(res, 401, "Введите пароль доступа."); return null; }
  if (!constantTimeEqual(req.headers["x-csrf-token"], session.csrf)) { genericError(res, 403, "Обновите страницу и попробуйте ещё раз."); return null; }
  return session;
}

function safeAddress() {
  const url = new URL(page.url());
  if (!isMagnitUrl(url.href)) return "Официальный сайт открыл защищённую страницу";
  if (url.hostname === "magnit.ru" && url.pathname === "/search") return "magnit.ru/search";
  return url.hostname;
}

function isSensitivePage() {
  if (/^https:\/\/(?:id\.)?magnit\.ru/i.test(page.url())) return page.url().includes("id.magnit.ru");
  return false;
}

async function pageSnapshot() {
  if (!isMagnitUrl(page.url())) {
    pageReferences.clear();
    return { url: "external_page", page_type: "external_user_action", products: [], references: [], note: "Открыта внешняя страница. Просматривайте и завершайте её только вручную на телефоне." };
  }
  const current = new URL(page.url());
  const isSearch = current.hostname === "magnit.ru" && current.pathname === "/search";
  const pageChallenge = await page.locator("body").innerText().then((text) => /access denied|forbidden|not a bot|captcha|проверка безопасности/i.test(text.slice(0, 2500))).catch(() => false);
  const hasSensitiveField = await page.locator("input").evaluateAll((inputs) => inputs.some((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || style.display === "none") return false;
    const attrs = { type: el.type, name: el.name, autocomplete: el.autocomplete, placeholder: el.placeholder, label: el.labels?.[0]?.innerText || "" };
    return [attrs.type, attrs.name, attrs.autocomplete, attrs.placeholder, attrs.label].some((v) => /password|passcode|otp|one.?time|sms|code|парол|код/i.test(String(v || "")));
  })).catch(() => false);

  const refs = await page.evaluate(() => {
    const allowed = /^(в корзину|добавить в корзину|добавить|корзина|войти|назад|закрыть|поиск|−|\+|\-|\+)$/i;
    const nodes = Array.from(document.querySelectorAll("button, a[role=button], a[href]"));
    const visible = (el) => { const r=el.getBoundingClientRect(), s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none"; };
    const compact = (s, max=80) => String(s||"").replace(/\s+/g," ").trim().slice(0,max);
    const cards = Array.from(document.querySelectorAll("article.unit-catalog-product-preview"));
    const inCard = (el) => cards.find((card)=>card.contains(el));
    return nodes.filter(visible).map((el, index) => {
      const label=compact(el.innerText||el.getAttribute("aria-label")||el.title);
      if (!label || !allowed.test(label)) return null;
      const href=el instanceof HTMLAnchorElement ? el.href : "";
      const card=inCard(el);
      const context=card ? compact(card.innerText,220) : "";
      const form=el.closest("form");
      const sensitiveForm=Boolean(form && Array.from(form.querySelectorAll("input")).some((input)=>/password|passcode|otp|one.?time|sms|code|парол|код/i.test([input.type,input.name,input.autocomplete,input.placeholder].join(" "))));
      el.setAttribute("data-magnit-bridge-ref",`r${index+1}`);
      return { reference:`r${index+1}`, label, href, context, sensitiveForm, tag:el.tagName.toLowerCase(), action:el.getAttribute("type")||"" };
    }).filter(Boolean).slice(0,80);
  }).catch(() => []);

  pageReferences.clear();
  for (const item of refs) pageReferences.set(item.reference, { ...item, context: sanitizeVisibleText(item.context, 220), revision: pageRevision });
  let products = [];
  if (isSearch && !hasSensitiveField) {
    products = await page.locator("article.unit-catalog-product-preview").evaluateAll((cards) => cards.slice(0, 12).map((card) => String(card.innerText || "").replace(/\s+/g, " ").trim().slice(0, 240))).then((items) => items.map((item) => sanitizeVisibleText(item, 240))).catch(() => []);
  }
  const authFlow = hasSensitiveField || isSensitivePage();
  const restricted = pageChallenge;
  const visibleReferences = (authFlow ? refs.filter((item) => ["войти", "назад", "закрыть"].includes(item.label.toLowerCase())) : refs)
    .map(({ reference, label, context }) => ({ reference, label, context: sanitizeVisibleText(context, 220) }));
  return {
    url: safeAddress(),
    page_type: restricted ? "access_restricted" : authFlow ? "login" : isSearch ? "catalog_search" : "magnit_page",
    products: authFlow || restricted ? [] : products,
    references: restricted ? [] : visibleReferences,
    note: restricted ? "Официальный сайт ограничил доступ или запросил проверку. Продолжите вручную; обход защиты не выполняется." : authFlow ? "Страница входа распознана. Текст формы и поля скрыты; завершите вход в окне телефона." : "Содержимое ограничено видимыми элементами официального сайта. СМС-коды, поля входа и платёжные данные не возвращаются.",
  };
}

function isFinalSubmit(label, attrs) {
  return isBlockedAction(label, attrs);
}

async function clickReference(reference, expectedText) {
  if (!isMagnitUrl(page.url())) throw new Error("MCP-действия доступны только на страницах Магнит.");
  const item = pageReferences.get(reference);
  if (!item || item.revision !== pageRevision) throw new Error("Ссылки устарели. Сначала обновите сводку страницы.");
  if (item.label !== String(expectedText).trim()) throw new Error("Текст ссылки изменился. Обновите сводку страницы.");
  if (!safeMcpClick({ label: item.label, href: item.href, attributes: { action: item.action, sensitiveForm: item.sensitiveForm } }) || isFinalSubmit(item.label, item)) {
    throw new Error("Этот шаг нельзя выполнить инструментом. Продолжите вручную на экране телефона.");
  }
  if (item.tag === "a" && item.href && !isMagnitUrl(item.href)) throw new Error("Инструмент может открывать только страницы Магнит.");
  const locator = page.locator(`[data-magnit-bridge-ref="${reference}"]`);
  const count = await locator.count();
  if (count !== 1 || !(await locator.isVisible())) throw new Error("Кнопка больше не видна. Обновите сводку страницы.");
  const actualText = (await locator.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0,80);
  if (actualText !== item.label) throw new Error("Кнопка изменилась. Обновите сводку страницы.");
  const currentAttrs = await locator.evaluate((el) => {
    const form = el.closest("form");
    const sensitiveForm = Boolean(form && Array.from(form.querySelectorAll("input")).some((input)=>/password|passcode|otp|one.?time|sms|code|парол|код/i.test([input.type,input.name,input.autocomplete,input.placeholder].join(" "))));
    return { href: el instanceof HTMLAnchorElement ? el.href : "", tag: el.tagName.toLowerCase(), action: el.getAttribute("type") || "", sensitiveForm };
  });
  if (currentAttrs.href !== item.href || currentAttrs.tag !== item.tag || currentAttrs.action !== item.action || currentAttrs.sensitiveForm !== item.sensitiveForm || !safeMcpClick({ label: actualText, href: currentAttrs.href, attributes: currentAttrs })) {
    throw new Error("Элемент изменился или требует ручного действия. Обновите сводку страницы.");
  }
  if (item.context) {
    const actualContext = await locator.evaluate((el) => String(el.closest("article.unit-catalog-product-preview")?.innerText || "").replace(/\s+/g, " ").trim().slice(0,220)).catch(() => "");
    if (sanitizeVisibleText(actualContext, 220) !== item.context) throw new Error("Карточка товара изменилась. Обновите сводку страницы.");
  }
  await locator.click({ timeout: 8000 });
  pageRevision += 1;
  await page.waitForTimeout(500);
}

async function callTool(name, args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Некорректные аргументы.");
  if (name === "magnit_status") {
    return { content: [{ type: "text", text: JSON.stringify({ ready: Boolean(page && !page.isClosed()), url: safeAddress(), page_type: await pageSnapshot().then((s) => s.page_type), phone_view: PUBLIC_BASE_URL }) }] };
  }
  if (name === "magnit_open_home") {
    await page.goto("https://magnit.ru/", { waitUntil: "domcontentloaded", timeout: 45000 });
    pageRevision += 1;
    await page.waitForTimeout(600);
    return { content: [{ type: "text", text: JSON.stringify(await pageSnapshot()) }] };
  }
  if (name === "magnit_search_products") {
    const url = makeSearchUrl(args.query, args.shop_code || "", args.shop_type || "dostavka");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    pageRevision += 1;
    await page.waitForTimeout(900);
    return { content: [{ type: "text", text: JSON.stringify(await pageSnapshot()) }] };
  }
  if (name === "magnit_page_summary") return { content: [{ type: "text", text: JSON.stringify(await pageSnapshot()) }] };
  if (name === "magnit_click_reference") {
    if (typeof args.reference !== "string" || typeof args.expected_text !== "string") throw new Error("Нужно указать ссылку и точный текст.");
    await clickReference(args.reference, args.expected_text);
    return { content: [{ type: "text", text: JSON.stringify(await pageSnapshot()) }] };
  }
  throw new Error("Неизвестный инструмент.");
}

function protocolResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function protocolError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function handleMcp(req, res) {
  if (!constantTimeEqual((req.headers.authorization || "").replace(/^Bearer\s+/i, ""), MCP_BEARER_TOKEN)) {
    return writeJson(res, 401, { error: "Unauthorized" }, { "WWW-Authenticate": "Bearer" });
  }
  if (!limited(`mcp:${peerKey(req)}`, 120, 60_000)) return writeJson(res, 429, { error: "Rate limit exceeded" });
  try {
    let body;
    try { body = await readJson(req); } catch { return genericError(res, 400, "Некорректный запрос."); }
    if (!body || typeof body !== "object" || Array.isArray(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") return writeJson(res, 400, protocolError(body?.id ?? null, -32600, "Invalid Request"));
    const id = body.id ?? null;
    const method = body.method;
    const params = body.params ?? {};
    if (params === null || typeof params !== "object" || Array.isArray(params)) return writeJson(res, 400, protocolError(id, -32602, "Invalid params"));
    if (method === "notifications/initialized") return res.writeHead(202, { "Cache-Control": "no-store" }).end();
    if (method === "server/discover") return writeJson(res, 200, protocolResult(id, { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }));
    if (method === "initialize") return writeJson(res, 200, protocolResult(id, { protocolVersion: "2026-07-28", capabilities: { tools: {} }, serverInfo: { name: "magnit-pocket-bridge", version: "0.1.0" } }));
    if (method === "tools/list") return writeJson(res, 200, protocolResult(id, { tools: DEFAULT_TOOLS }));
    if (method === "tools/call") {
      if (typeof params.name !== "string" || !DEFAULT_TOOLS.some((tool) => tool.name === params.name)) return writeJson(res, 200, protocolResult(id, { isError: true, content: [{ type: "text", text: "Инструмент не поддерживается." }] }));
      const args = params.arguments ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args)) return writeJson(res, 200, protocolResult(id, { isError: true, content: [{ type: "text", text: "Некорректные аргументы инструмента." }] }));
      const result = await serializeBrowser(() => callTool(params.name, args));
      return writeJson(res, 200, protocolResult(id, result));
    }
    return writeJson(res, 200, protocolError(id, -32601, "Method not found"));
  } catch {
    if (!res.headersSent) return writeJson(res, 200, protocolError(null, -32603, "Internal error"));
    res.destroy();
  }
}

async function handlePhone(req, res, url) {
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    return res.end(PHONE_HTML);
  }
  if (req.method === "POST" && url.pathname === "/api/phone/session") {
    if (!originMatches(req)) return genericError(res, 403, "Запрос должен идти с этой страницы.");
    if (!limited(`phone-login:${peerKey(req)}`, 8, 60_000)) return genericError(res, 429, "Слишком много попыток. Подождите минуту.");
    let body; try { body = await readJson(req); } catch { return genericError(res, 400, "Некорректный запрос."); }
    if (!constantTimeEqual(body.passphrase, PHONE_ACCESS_SECRET)) return genericError(res, 401, "Пароль не принят.");
    const csrf = randomBytes(24).toString("base64url");
    const session = sessionCodec.issue(csrf);
    appendSessionCookie(res, session, 7 * 24 * 60 * 60);
    return writeJson(res, 200, { csrf });
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    const session = readSession(req);
    if (!session) return genericError(res, 401, "Введите пароль доступа.");
    return writeJson(res, 200, { csrf: session.csrf, address: safeAddress(), browserMode: BROWSER_MODE });
  }
  if (req.method === "GET" && url.pathname === "/api/screenshot") {
    if (!readSession(req)) return genericError(res, 401, "Введите пароль доступа.");
    if (!limited(`phone-shot:${peerKey(req)}`, 30, 60_000)) return genericError(res, 429, "Подождите перед обновлением экрана.");
    const image = await serializeBrowser(() => page.screenshot({ type: "jpeg", quality: 70, animations: "disabled" }));
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    return res.end(image);
  }
  if (req.method === "POST" && url.pathname === "/api/phone/logout") {
    if (!requirePhone(req, res)) return;
    appendSessionCookie(res, "", 0);
    return res.writeHead(204, { "Cache-Control": "no-store" }).end();
  }
  if (req.method === "POST" && url.pathname === "/api/browser/action") {
    if (!requirePhone(req, res)) return;
    if (!limited(`phone-action:${peerKey(req)}`, 180, 60_000)) return genericError(res, 429, "Слишком много действий.");
    let body; try { body = await readJson(req); } catch { return genericError(res, 400, "Некорректный запрос."); }
    try {
      await serializeBrowser(() => runPhoneAction(body));
      return writeJson(res, 200, { ok: true });
    } catch (error) {
      const message = error?.message === "search_validation" ? "Введите запрос длиной не более 120 символов." : "Действие не выполнено. Проверьте страницу и попробуйте ещё раз.";
      return genericError(res, 400, message);
    }
  }
  return genericError(res, 404, "Страница не найдена.");
}

async function runPhoneAction(body) {
  switch (body?.action) {
    case "home":
      await page.goto("https://magnit.ru/", { waitUntil: "domcontentloaded", timeout: 45000 }); pageRevision += 1; return;
    case "search": {
      const url = makeSearchUrl(body.query, "", "dostavka");
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }); pageRevision += 1; return;
    }
    case "reload": await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }); pageRevision += 1; return;
    case "back": await page.goBack({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {}); pageRevision += 1; return;
    case "click": {
      const x=Number(body.x), y=Number(body.y);
      if (!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>390||y>844) throw new Error("coordinates");
      manualNavigationUntil = Date.now() + 2000;
      await page.mouse.click(x,y); pageRevision += 1; return;
    }
    case "type": {
      if (typeof body.text !== "string" || body.text.length > 500) throw new Error("text");
      await page.keyboard.insertText(body.text); return;
    }
    case "press": {
      if (!new Set(["Enter","Tab","Backspace","ArrowUp","ArrowDown","Escape","Control+A","Meta+A"]).has(body.key)) throw new Error("key");
      manualNavigationUntil = Date.now() + 2000;
      await page.keyboard.press(body.key); pageRevision += 1; return;
    }
    case "scroll": {
      const delta = Number(body.delta);
      if (!Number.isFinite(delta) || delta < -600 || delta > 600) throw new Error("scroll");
      await page.mouse.wheel(0, delta); return;
    }
    case "forget": {
      if (BROWSER_MODE === "android") {
        throw new Error("В режиме Android профиль Chrome общий. Выйдите из Магнит вручную.");
      } else {
        await browserContext?.close();
        browserContext = undefined;
        page = undefined;
        pageReferences.clear();
        try { await rm(PROFILE_DIR, { recursive: true, force: true }); }
        finally { await startBrowser(); }
      }
      pageRevision += 1;
      return;
    }
    default: throw new Error("unknown_action");
  }
}

async function startBrowser() {
  if (BROWSER_MODE === "android") {
    if (!new Set(["com.android.chrome", "com.chrome.beta"]).has(ANDROID_CHROME_PACKAGE)) throw new Error("ANDROID_CHROME_PACKAGE must be Chrome or Chrome Beta.");
    const { _android } = await import("playwright");
    if (!_android) throw new Error("This Playwright package does not include the experimental Android API.");
    const devices = await _android.devices({ host: "127.0.0.1", port: 5037 });
    if (!devices.length) throw new Error("No Android device is available through the loopback ADB daemon.");
    androidDevice = await selectAndroidDevice(devices, ANDROID_DEVICE_SERIAL);
    if (!androidDevice) throw new Error("Set ANDROID_DEVICE_SERIAL to one of the connected device serials.");
    browserContext = await androidDevice.launchBrowser({ pkg: ANDROID_CHROME_PACKAGE, viewport: { width: 390, height: 844 }, acceptDownloads: false });
  } else if (BROWSER_MODE === "desktop") {
    const { chromium } = await import("playwright");
    await mkdir(path.dirname(PROFILE_DIR), { recursive: true });
    browserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      locale: "ru-RU",
      timezoneId: "Europe/Moscow",
      acceptDownloads: false,
      serviceWorkers: "block",
    });
  } else throw new Error("BROWSER_MODE must be desktop or android.");
  page = BROWSER_MODE === "android" ? await browserContext.newPage() : browserContext.pages()[0] || await browserContext.newPage();
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && !isMagnitUrl(request.url()) && Date.now() > manualNavigationUntil) {
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  page.on("framenavigated", () => { pageRevision += 1; pageReferences.clear(); });
  page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });
  if (!isMagnitUrl(page.url())) await page.goto("https://magnit.ru/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
}

const server = createServer(async (req, res) => {
  if (process.env.TRUST_PROXY === "1" && req.headers["x-forwarded-proto"] !== "https") {
    return genericError(res, 400, "Нужен защищённый HTTPS-адрес.");
  }
  const url = new URL(req.url || "/", PUBLIC_BASE_URL);
  try {
    if (req.method === "POST" && url.pathname === "/mcp") return await handleMcp(req, res);
    await handlePhone(req, res, url);
  }
  catch { if (!res.headersSent) genericError(res, 500, "Не удалось выполнить запрос."); else res.destroy(); }
});

await startBrowser();
server.listen(PORT, HOST);
process.on("SIGTERM", async () => { server.close(); await browserContext?.close(); process.exit(0); });
process.on("SIGINT", async () => { server.close(); await browserContext?.close(); process.exit(0); });
