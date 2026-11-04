import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { constantTimeEqual, createPhoneSessionCodec } from "./policy.js";
import { getMagnitCategories, getMagnitProductDetails, MagnitApiError, searchMagnit, validateStoreCode } from "./magnit-api.js";
import { addMagnitCartItem, applyMagnitCart, viewMagnitCart } from "./cart.js";
import { bindExpressSearchContext, createEncryptedSessionStore, extractMagnitSessionFromHar, publicSessionState } from "./session-store.js";
import { createCartOperationStore } from "./cart-operation-store.js";
import { getMagnitOrderHistory, getMagnitShoppingContext } from "./shopping-context.js";
import { createAndroidLogin, isMagnitAuthenticated } from "./android-login.js";
import { PHONE_HTML } from "./phone-page.js";
import { createCartEligibilityRegistry } from "./cart-eligibility.js";
import { isDirectLocalOwnerRequest, loadOrCreateOwnerSecret } from "./local-owner.js";

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN || "";
const LEGACY_PHONE_ACCESS_SECRET = process.env.PHONE_ACCESS_SECRET || "";
const OWNER_KEY_FILE = process.env.OWNER_KEY_FILE || "./data/owner-key";
const COOKIE_NAME = "magnit_phone_session";
const MAX_BODY_BYTES = 64_000;
const MAX_HAR_BYTES = 12 * 1024 * 1024;
const rateBuckets = new Map();
let androidLogin = null;
const eligibleCartItems = createCartEligibilityRegistry();

if (MCP_BEARER_TOKEN.length < 32) throw new Error("MCP_BEARER_TOKEN must be at least 32 characters.");
let publicUrl;
try { publicUrl = new URL(PUBLIC_BASE_URL); } catch { throw new Error("PUBLIC_BASE_URL must be an absolute URL."); }
if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== "/") throw new Error("PUBLIC_BASE_URL must be a clean origin without credentials, path, query, or fragment.");
const localOnly = publicUrl.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(publicUrl.hostname);
if (publicUrl.protocol !== "https:" && !localOnly) throw new Error("Plain HTTP is allowed only for loopback.");
if (!localOnly && LEGACY_PHONE_ACCESS_SECRET.length < 32) throw new Error("PHONE_ACCESS_SECRET must be at least 32 characters for remote HTTPS mode.");
const OWNER_SECRET = localOnly
  ? (LEGACY_PHONE_ACCESS_SECRET.length >= 32 ? LEGACY_PHONE_ACCESS_SECRET : await loadOrCreateOwnerSecret(OWNER_KEY_FILE))
  : LEGACY_PHONE_ACCESS_SECRET;
const phoneSessions = createPhoneSessionCodec(OWNER_SECRET);
const sessionStore = createEncryptedSessionStore({ secret: OWNER_SECRET, filename: process.env.SESSION_FILE || "./data/magnit-session.enc" });
const cartOperationStore = createCartOperationStore({ secret: OWNER_SECRET, filename: process.env.CART_OPERATIONS_FILE || "./data/cart-operations.enc" });
const HOST = process.env.HOST || (localOnly ? "127.0.0.1" : "0.0.0.0");
if (localOnly && !["127.0.0.1", "localhost", "[::1]"].includes(HOST)) throw new Error("Loopback HTTP must bind only to loopback.");
const LOCAL_OWNER_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const COOKIE_SECURE = process.env.COOKIE_SECURE === undefined ? !localOnly : process.env.COOKIE_SECURE === "1";
if (!COOKIE_SECURE && !localOnly) throw new Error("Insecure cookies are allowed only for loopback HTTP.");

const TOOLS = [{
  name: "magnit_status",
  description: "Показать доступные HTTP-возможности и ограничения. Не проверяет живую доступность Магнит.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}, {
  name: "magnit_search_products",
  description: "Ищет продукты в выбранном магазине Магнит через webgate JSON endpoint. Для express возвращает cart IDs только при совпадении ограниченного недавнего search-eligibility правила. Вход/оформление не вызываются этим инструментом.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 120, description: "Название товара для поиска." },
      store_code: { type: "string", pattern: "^[0-9]{4,8}$" },
      mode: { type: "string", enum: ["delivery", "retail", "express"], description: "delivery=dostavka/3; retail=1/1; express=express/2." },
      limit: { type: "integer", minimum: 1, maximum: 30, default: 20 },
    },
    required: ["query", "store_code", "mode"],
    additionalProperties: false,
  },
}, {
  name: "magnit_list_categories",
  description: "Получить категории каталога для выбранного магазина и режима.",
  inputSchema: { type: "object", properties: { store_code: { type: "string", pattern: "^[0-9]{4,8}$" }, mode: { type: "string", enum: ["delivery", "retail", "express"] } }, required: ["store_code", "mode"], additionalProperties: false },
}, {
  name: "magnit_view_cart",
  description: "Прочитать текущую lite-корзину express для явно указанного магазина. Требует активной owner-сессии; lite-суммы не являются итогом заказа.",
  inputSchema: { type: "object", properties: { store_code: { type: "string", pattern: "^[0-9]{4,8}$" }, mode: { type: "string", enum: ["express"] } }, required: ["store_code", "mode"], additionalProperties: false },
}, {
  name: "magnit_add_to_cart",
  description: "Добавить товар только по good_id/offer_id, выданным недавним поиском и прошедшим ограниченную express-проверку. Сохраняет остальные позиции; автоматических повторов нет.",
  inputSchema: { type: "object", properties: { store_code: { type: "string", pattern: "^[0-9]{4,8}$" }, mode: { type: "string", enum: ["express"] }, good_id: { type: "string", minLength: 1, maxLength: 128 }, offer_id: { type: "string", minLength: 1, maxLength: 128 }, quantity: { type: "integer", minimum: 1, maximum: 99 } }, required: ["store_code", "mode", "good_id", "offer_id", "quantity"], additionalProperties: false },
}, {
  name: "magnit_get_shopping_context",
  description: "Получить активный адрес аккаунта (без квартиры/домофона/подъезда/этажа) и сохранённый код магазина. Активный адрес не сопоставляется магазину; источник HTTP не проверен live.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}, {
  name: "magnit_get_product_details",
  description: "Прочитать сведения о товаре по точному product_id и коду магазина; цены, остатки, вес, шаг и ограничения возвращаются как данные источника, неизвестные единицы не пересчитываются.",
  inputSchema: { type: "object", properties: { product_id: { type: "string", minLength: 1, maxLength: 128 }, store_code: { type: "string", pattern: "^[0-9]{4,8}$" }, mode: { type: "string", enum: ["express"] } }, required: ["product_id", "store_code", "mode"], additionalProperties: false },
}, {
  name: "magnit_apply_cart",
  description: "Одним запросом применить 1–50 add/set/remove к express-корзине. Каждый ID должен быть из недавнего проверенного поиска; нужен уникальный request_id для идемпотентности. Сохраняет неуказанные позиции, сверяет весь ответ; после неопределённого результата сначала явно перечитайте корзину. Checkout не выполняется.",
  inputSchema: { type: "object", properties: { store_code: { type: "string", pattern: "^[0-9]{4,8}$" }, mode: { type: "string", enum: ["express"] }, request_id: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" }, operations: { type: "array", minItems: 1, maxItems: 50, items: { type: "object", properties: { action: { type: "string", enum: ["add", "set", "remove"] }, good_id: { type: "string", minLength: 1, maxLength: 128 }, offer_id: { type: "string", minLength: 1, maxLength: 128 }, quantity: { type: "integer", minimum: 1, maximum: 99 } }, required: ["action", "good_id", "offer_id"], additionalProperties: false } } }, required: ["store_code", "mode", "request_id", "operations"], additionalProperties: false },
}, {
  name: "magnit_get_order_history",
  description: "Прочитать историю заказов. Адреса и платежные ссылки исключены; артикулы товара в заказе справочные и не являются cart ID.",
  inputSchema: { type: "object", properties: { page: { type: "integer", minimum: 1, maximum: 100, default: 1 }, limit: { type: "integer", minimum: 1, maximum: 30, default: 10 } }, additionalProperties: false },
}];

function originMatches(req) {
  if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") return false;
  if (!localOnly) return req.headers.origin === publicUrl.origin;
  const host = String(req.headers.host || "").toLowerCase();
  if (!LOCAL_OWNER_HOSTS.has(host)) return false;
  try { const origin = new URL(req.headers.origin); return origin.origin === `http://${host}` && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash; }
  catch { return false; }
}
function writeJson(res, status, body, extra = {}) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra }); res.end(JSON.stringify(body)); }
function error(res, status = 400, message = "Не удалось выполнить запрос.") { writeJson(res, status, { error: message }); }
async function readJson(req, maxBytes = MAX_BODY_BYTES) { let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw Error("large");chunks.push(chunk)}return chunks.length?JSON.parse(Buffer.concat(chunks).toString("utf8")):{}; }
function rateLimit(key, max, windowMs) { const now=Date.now();if(rateBuckets.size>2000){for(const [k,v] of rateBuckets)if(v.until<now)rateBuckets.delete(k);while(rateBuckets.size>2000)rateBuckets.delete(rateBuckets.keys().next().value)}const hit=rateBuckets.get(key);if(!hit||hit.until<now){rateBuckets.set(key,{count:1,until:now+windowMs});return true}return ++hit.count<=max; }
function peer(req) { return process.env.TRUST_PROXY==="1"&&!localOnly?String(req.headers["x-forwarded-for"]||"").split(",")[0].trim()||req.socket.remoteAddress:req.socket.remoteAddress; }
function readSession(req) { const raw=(req.headers.cookie||"").split(";").map((s)=>s.trim()).find((s)=>s.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length+1);return raw?phoneSessions.verify(raw):null; }
function cookie(res,value,maxAge) {const parts=[`${COOKIE_NAME}=${value}`,"Path=/","HttpOnly","SameSite=Strict",`Max-Age=${maxAge}`];if(COOKIE_SECURE)parts.push("Secure");res.setHeader("Set-Cookie",parts.join("; "));}
function requirePhone(req,res){if(!originMatches(req)){error(res,403,"Обновите страницу и попробуйте ещё раз.");return null}const session=readSession(req);if(!session){error(res,401,localOnly?"Обновите страницу для локального входа.":"Введите пароль доступа.");return null}if(!constantTimeEqual(req.headers["x-csrf-token"],session.csrf)){error(res,403,"Обновите страницу и попробуйте ещё раз.");return null}return session}
function phonePage(){return localOnly?PHONE_HTML.replace(/<section id="gate"[\s\S]*?<\/section>/," ").replace('<button id="logout" class="soft">Выход</button>',"").replace("<body>","<body class=\"local-owner\">"):PHONE_HTML}
async function bindSearchStore(storeCode){const saved=await sessionStore.load();if(!saved?.cookie)return;if(saved.context?.service==="express"&&saved.context.storeCode===storeCode&&saved.context.bff==="1")return;await sessionStore.save(bindExpressSearchContext(saved,storeCode))}
async function productDetailsWithCartRule(productId,storeCode,mode){const detail=await getMagnitProductDetails({productId,storeCode,mode});const mapping=eligibleCartItems.cartMappingFor(storeCode,productId);const restricted=detail.weighted?.is_weighted===true||Object.values(detail.restrictions||{}).some((value)=>value===true);const allowed=!!mapping&&!restricted;return {...detail,good_id:allowed?mapping.good_id:null,offer_id:allowed?mapping.offer_id:null,cart_addable:allowed,cart_add_rule:allowed?mapping.cart_add_rule:null,cart_add_reason:allowed?null:restricted?"details_show_restriction":"needs_recent_verified_search"}}
async function enrichCart(view){
  const details=new Map();let denied=false;const candidates=view.items.filter((item)=>item.good_id&&!eligibleCartItems.metadataFor(view.request_store_code,item.good_id,item.offer_id)).slice(0,10);let index=0;
  async function worker(){while(index<candidates.length&&!denied){const item=candidates[index++];try{const detail=await getMagnitProductDetails({productId:item.good_id,storeCode:view.cart_store_code||view.request_store_code,mode:"express",timeoutMs:5_000});details.set(item.good_id,detail)}catch(cause){const code=cause instanceof MagnitApiError?cause.code:"details_unavailable";details.set(item.good_id,{error:code});if(code==="access_restricted")denied=true}}}
  await Promise.all([worker(),worker()]);
  return {...view,items:view.items.map((item)=>{const cached=eligibleCartItems.metadataFor(view.request_store_code,item.good_id,item.offer_id);const detail=details.get(item.good_id);const metadata=cached||detail;return {...item,name:metadata?.name||null,catalog_price_kopecks:metadata?.price_kopecks??null,catalog_price_rubles:metadata?.price_rubles??null,stock_quantity:metadata?.quantity??null,availability:metadata?.in_stock==null?(detail?.stock||"unknown"):metadata.in_stock?"available":"unavailable",minimum_quantity:metadata?.min_order_quantity??metadata?.order_properties?.min_order_quantity??null,order_step_quantity:metadata?.order_step_quantity??metadata?.order_properties?.order_step_quantity??null,catalog_increment:metadata?.increment??null,catalog_weighted:metadata?.weighted??null,metadata_store_code:cached?view.request_store_code:(detail&&!detail.error?(view.cart_store_code||view.request_store_code):null),metadata_source:cached?"recent_express_search_cache":detail&&!detail.error?"product_details_http":"unavailable",metadata_error:detail?.error||null,metadata_fetched_at:metadata?.fetched_at??null,quantity_unit_note:item.quantity_increment?.unit?"source increment; compare with item quantity":"unit unknown"}}),source:"magnit_cart_http_unverified",fetched_at:new Date().toISOString()}}

function rpc(id,result){return {jsonrpc:"2.0",id,result}}
function rpcError(id,code,message){return {jsonrpc:"2.0",id,error:{code,message}}}
async function handleMcp(req,res){
  if(!constantTimeEqual((req.headers.authorization||"").replace(/^Bearer\s+/i,""),MCP_BEARER_TOKEN))return writeJson(res,401,{error:"Unauthorized"},{"WWW-Authenticate":"Bearer"});
  if(!rateLimit(`mcp:${peer(req)}`,100,60_000))return error(res,429,"Слишком много запросов.");
  let body;try{body=await readJson(req)}catch{return error(res,400,"Некорректный запрос.")}
  if(!body||typeof body!=="object"||Array.isArray(body)||body.jsonrpc!=="2.0"||typeof body.method!=="string")return writeJson(res,400,rpcError(body?.id??null,-32600,"Invalid Request"));
  const id=body.id??null,params=body.params??{};
  if(!params||typeof params!=="object"||Array.isArray(params))return writeJson(res,400,rpcError(id,-32602,"Invalid params"));
  if(body.method==="notifications/initialized")return res.writeHead(202,{"Cache-Control":"no-store"}).end();
  if(body.method==="server/discover")return writeJson(res,200,rpc(id,{supportedVersions:["2026-07-28"],capabilities:{tools:{}}}));
  if(body.method==="initialize")return writeJson(res,200,rpc(id,{protocolVersion:"2026-07-28",capabilities:{tools:{}},serverInfo:{name:"magnit-http-mcp",version:"0.4.0"}}));
  if(body.method==="tools/list")return writeJson(res,200,rpc(id,{tools:TOOLS}));
  if(body.method==="ping")return writeJson(res,200,rpc(id,{}));
  if(body.method!=="tools/call")return writeJson(res,200,rpcError(id,-32601,"Method not found"));
  if(params.name==="magnit_status"){
    const saved = await sessionStore.load();
    return writeJson(res,200,rpc(id,{content:[{type:"text",text:JSON.stringify({service:"ready",capabilities:["magnit_search_products","magnit_list_categories","magnit_view_cart","magnit_add_to_cart","magnit_get_shopping_context","magnit_get_product_details","magnit_apply_cart","magnit_get_order_history"],login_capability:"owner_android_chrome_manual",phone_login_url:PUBLIC_BASE_URL,auth_session:publicSessionState(saved),live_compatibility:"unverified",unsupported:["automated_login","sms_entry","captcha_solving","checkout","payment"]})}]}));
  }
  if(!["magnit_search_products","magnit_list_categories","magnit_view_cart","magnit_add_to_cart","magnit_get_shopping_context","magnit_get_product_details","magnit_apply_cart","magnit_get_order_history"].includes(params.name))return writeJson(res,200,rpc(id,{isError:true,content:[{type:"text",text:"Инструмент не поддерживается."}]}));
  const args=params.arguments??{};if(!args||typeof args!=="object"||Array.isArray(args))return writeJson(res,200,rpcError(id,-32602,"Invalid params"));
  try{
    let result;
    if(params.name==="magnit_search_products") {result=await searchMagnit({query:args.query,storeCode:args.store_code,mode:args.mode,limit:args.limit??20});eligibleCartItems.remember(result);if(args.mode==="express")await bindSearchStore(args.store_code)}
    else if(params.name==="magnit_list_categories") result=await getMagnitCategories({storeCode:args.store_code,mode:args.mode});
    else if(params.name==="magnit_get_shopping_context") result=await getMagnitShoppingContext({session:await sessionStore.load()});
    else if(params.name==="magnit_get_order_history") result=await getMagnitOrderHistory({session:await sessionStore.load(),page:args.page??1,limit:args.limit??10});
    else if(params.name==="magnit_get_product_details") result=await productDetailsWithCartRule(args.product_id,args.store_code,args.mode);
    else {
      const saved=await sessionStore.load();
      result=params.name==="magnit_view_cart"
        ? await enrichCart(await viewMagnitCart({session:saved,storeCode:args.store_code,mode:args.mode,saveSession:(session)=>sessionStore.save(session),operationStore:cartOperationStore}))
        : params.name==="magnit_add_to_cart"
          ? await (async()=>{eligibleCartItems.require(args.store_code,args.good_id,args.offer_id);return addMagnitCartItem({session:saved,storeCode:args.store_code,mode:args.mode,goodId:args.good_id,offerId:args.offer_id,quantity:args.quantity,saveSession:(session)=>sessionStore.save(session),operationStore:cartOperationStore})})()
          : await applyMagnitCart({session:saved,storeCode:args.store_code,mode:args.mode,requestId:args.request_id,operations:args.operations,saveSession:(session)=>sessionStore.save(session),operationStore:cartOperationStore,requireEligible:(storeCode,goodId,offerId)=>eligibleCartItems.require(storeCode,goodId,offerId)});
    }
    return writeJson(res,200,rpc(id,{content:[{type:"text",text:JSON.stringify(result)}]}));
  }catch(cause){
    const code=cause instanceof MagnitApiError?cause.code:"invalid_arguments";
    const message=cause instanceof MagnitApiError?cause.message:(cause instanceof Error?cause.message:"Invalid arguments.");
    return writeJson(res,200,rpc(id,{isError:true,content:[{type:"text",text:JSON.stringify({error:code,message,compatibility:"unverified"})}]}));
  }
}

async function handlePhone(req,res,url){
  if(req.method==="GET"&&url.pathname==="/"){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","X-Frame-Options":"DENY"});return res.end(phonePage())}
  if(req.method==="POST"&&url.pathname==="/api/phone/session"){if(localOnly)return error(res,404,"Страница входа не используется в локальном режиме.");if(!originMatches(req))return error(res,403,"Откройте страницу сервера напрямую.");if(!rateLimit(`login:${peer(req)}`,8,60_000))return error(res,429,"Слишком много попыток.");let b;try{b=await readJson(req)}catch{return error(res,400)}if(!constantTimeEqual(b.passphrase,LEGACY_PHONE_ACCESS_SECRET))return error(res,401,"Пароль не принят.");const csrf=randomBytes(24).toString("base64url");cookie(res,phoneSessions.issue(csrf),7*24*60*60);return writeJson(res,200,{csrf})}
  if(req.method==="GET"&&url.pathname==="/api/state"){
    if(localOnly){if(!isDirectLocalOwnerRequest(req,LOCAL_OWNER_HOSTS)||(req.headers.origin&&!originMatches(req)))return error(res,403,"Локальный доступ разрешён только с этого телефона.");const existing=readSession(req);if(existing)return writeJson(res,200,{csrf:existing.csrf});const csrf=randomBytes(24).toString("base64url");cookie(res,phoneSessions.issue(csrf),7*24*60*60);return writeJson(res,200,{csrf})}
    const s=readSession(req);if(!s)return error(res,401,"Введите пароль доступа.");return writeJson(res,200,{csrf:s.csrf})
  }
  if(req.method==="GET"&&url.pathname==="/api/session-status"){if((req.headers.origin&&!originMatches(req))||!readSession(req))return error(res,401,"Введите пароль доступа.");return writeJson(res,200,publicSessionState(await sessionStore.load()))}
  if(req.method==="GET"&&url.pathname==="/api/phone/shopping-context"){
    if((req.headers.origin&&!originMatches(req))||!readSession(req))return error(res,401,"Обновите страницу и попробуйте ещё раз.");
    try{return writeJson(res,200,await getMagnitShoppingContext({session:await sessionStore.load()}))}
    catch(cause){return writeJson(res,400,{error:cause instanceof MagnitApiError?cause.message:"Не удалось прочитать контекст аккаунта.",code:cause instanceof MagnitApiError?cause.code:"upstream_error"})}
  }
  if(req.method==="GET"&&url.pathname==="/api/phone/order-history"){
    if((req.headers.origin&&!originMatches(req))||!readSession(req))return error(res,401,"Обновите страницу и попробуйте ещё раз.");
    try{return writeJson(res,200,await getMagnitOrderHistory({session:await sessionStore.load(),page:Number(url.searchParams.get("page")||1),limit:Number(url.searchParams.get("limit")||10)}))}
    catch(cause){return writeJson(res,400,{error:cause instanceof MagnitApiError?cause.message:"Не удалось прочитать историю заказов.",code:cause instanceof MagnitApiError?cause.code:"upstream_error"})}
  }
  if(req.method==="GET"&&url.pathname==="/api/phone/product-details"){
    if((req.headers.origin&&!originMatches(req))||!readSession(req))return error(res,401,"Обновите страницу и попробуйте ещё раз.");
    try{return writeJson(res,200,await productDetailsWithCartRule(url.searchParams.get("product_id"),url.searchParams.get("store_code"),url.searchParams.get("mode")||"express"))}
    catch(cause){return writeJson(res,400,{error:cause instanceof MagnitApiError?cause.message:"Не удалось прочитать сведения о товаре.",code:cause instanceof MagnitApiError?cause.code:"upstream_error"})}
  }
  if(req.method==="POST"&&url.pathname==="/api/phone/magnit-login/start"){
    if(!requirePhone(req,res))return;
    if(androidLogin&&["opening","waiting","verifying"].includes(androidLogin.snapshot().status))return writeJson(res,200,androidLogin.snapshot());
    androidLogin=createAndroidLogin({saveSession:(session)=>sessionStore.save(session),requestedSerial:process.env.ANDROID_DEVICE_SERIAL||""});
    return writeJson(res,200,await androidLogin.start());
  }
  if(req.method==="GET"&&url.pathname==="/api/phone/magnit-login/status"){
    if((req.headers.origin&&!originMatches(req))||!readSession(req))return error(res,401,"Введите пароль доступа.");
    return writeJson(res,200,androidLogin?.snapshot()||{status:"idle",message:"Вход не запущен."});
  }
  if(req.method==="POST"&&url.pathname==="/api/phone/magnit-login/cancel"){
    if(!requirePhone(req,res))return;
    const result=androidLogin?await androidLogin.cancel():{status:"idle",message:"Вход не запущен."};
    return writeJson(res,200,result);
  }
  if(req.method==="POST"&&url.pathname==="/api/phone/import-session"){
    if(!requirePhone(req,res))return;
    if(!rateLimit(`session-import:${peer(req)}`,5,60_000))return error(res,429,"Подождите перед повторным импортом.");
    let b;try{b=await readJson(req,MAX_HAR_BYTES+32_768)}catch{return error(res,400,"Не удалось прочитать HAR. Проверьте формат и размер файла.")}
    if(typeof b.har!=="string"||Buffer.byteLength(b.har,"utf8")>MAX_HAR_BYTES)return error(res,413,"HAR должен быть не больше 12 МБ.");
    const parsed=extractMagnitSessionFromHar(b.har);
    if(!parsed.ok){
      const messages={sanitized_export:"В HAR отсутствует Cookie: Chrome удалил его при обычном экспорте. Нужен локальный экспорт HAR с чувствительными данными; не отправляйте такой файл в чат или репозиторий.",unsupported_context:"HAR относится не к express-корзине, которая поддерживается сейчас.",incomplete_session:"В HAR не хватает контекста express-корзины.",unsupported_har:"В HAR не найдены запросы GET/PUT корзины Магнит.",invalid_har:"Файл не распознан как HAR."};
      return writeJson(res,400,{error:messages[parsed.code]||"Сессию не удалось импортировать.",code:parsed.code,reason:parsed.reason||null});
    }
    try {
      if(!await isMagnitAuthenticated(parsed.session))return writeJson(res,400,{error:"HAR содержит Cookie, но Магнит не подтвердил активную сессию.",code:"session_rejected"});
      await viewMagnitCart({session:parsed.session,storeCode:parsed.session.context.storeCode,mode:"express"});
    } catch(cause) {
      return writeJson(res,400,{error:cause instanceof MagnitApiError?cause.message:"Не удалось проверить сессию из HAR.",code:cause instanceof MagnitApiError?cause.code:"session_validation_failed"});
    }
    await sessionStore.save(parsed.session);
    return writeJson(res,200,publicSessionState(parsed.session));
  }
  if(req.method==="POST"&&url.pathname==="/api/phone/clear-session"){
    if(!requirePhone(req,res))return;
    if(!rateLimit(`session-clear:${peer(req)}`,20,60_000))return error(res,429,"Слишком много запросов.");
    if(androidLogin&&["opening","waiting","verifying"].includes(androidLogin.snapshot().status))await androidLogin.cancel();
    androidLogin=null;
    await sessionStore.clear();return writeJson(res,200,{ready:false});
  }
  if(req.method==="GET"&&url.pathname==="/api/phone/cart"){
    if((req.headers.origin&&!originMatches(req))||!readSession(req))return error(res,401,"Введите пароль доступа.");
    try{return writeJson(res,200,await enrichCart(await viewMagnitCart({session:await sessionStore.load(),storeCode:url.searchParams.get("store_code"),mode:url.searchParams.get("mode"),saveSession:(session)=>sessionStore.save(session),operationStore:cartOperationStore})))}
    catch(cause){return writeJson(res,400,{error:cause instanceof Error?cause.message:"Не удалось прочитать корзину.",code:cause instanceof MagnitApiError?cause.code:"invalid_arguments"})}
  }
  if(req.method==="POST"&&url.pathname==="/api/phone/cart/add"){
    if(!requirePhone(req,res))return;
    let b;try{b=await readJson(req)}catch{return error(res,400)}
    try{eligibleCartItems.require(b.store_code,b.good_id,b.offer_id);return writeJson(res,200,await addMagnitCartItem({session:await sessionStore.load(),storeCode:b.store_code,mode:b.mode,goodId:b.good_id,offerId:b.offer_id,quantity:b.quantity,saveSession:(session)=>sessionStore.save(session),operationStore:cartOperationStore}))}
    catch(cause){return writeJson(res,400,{error:cause instanceof Error?cause.message:"Не удалось изменить корзину.",code:cause instanceof MagnitApiError?cause.code:"invalid_arguments"})}
  }
  if(req.method==="POST"&&url.pathname==="/api/search"){
    if(!requirePhone(req,res))return;
    if(!rateLimit(`search:${peer(req)}`,30,60_000))return error(res,429,"Подождите перед новым поиском.");
    let b;try{b=await readJson(req)}catch{return error(res,400)}
    try{const result=await searchMagnit({query:b.query,storeCode:b.store_code,mode:b.mode,limit:b.limit??20});eligibleCartItems.remember(result);if(b.mode==="express")await bindSearchStore(b.store_code);return writeJson(res,200,result)}
    catch(cause){const status=cause instanceof MagnitApiError?cause.code:"invalid_arguments";const message=cause instanceof MagnitApiError?cause.message:(cause instanceof Error?cause.message:"Проверьте запрос, код магазина и режим.");return writeJson(res,400,{error:message,code:status})}
  }
  if(req.method==="POST"&&url.pathname==="/api/phone/logout"){if(!requirePhone(req,res))return;if(androidLogin&&["opening","waiting","verifying"].includes(androidLogin.snapshot().status))await androidLogin.cancel();cookie(res,"",0);return res.writeHead(204,{"Cache-Control":"no-store"}).end()}
  return error(res,404,"Страница не найдена.");
}

const server=createServer(async(req,res)=>{try{const url=new URL(req.url||"/",PUBLIC_BASE_URL);const isMcpPost=req.method==="POST"&&url.pathname==="/mcp";if(!localOnly&&String(req.headers.host||"").toLowerCase()!==publicUrl.host.toLowerCase())return error(res,403,"Недопустимый Host.");if(localOnly&&!isMcpPost&&!isDirectLocalOwnerRequest(req,LOCAL_OWNER_HOSTS))return error(res,403,"Локальный доступ разрешён только с этого устройства.");if(process.env.TRUST_PROXY==="1"&&req.headers["x-forwarded-proto"]!=="https")return error(res,400,"Нужен HTTPS.");if(isMcpPost)return await handleMcp(req,res);await handlePhone(req,res,url)}catch{if(!res.headersSent)error(res,500,"Не удалось выполнить запрос.");else res.destroy()}});
server.listen(PORT,HOST);
let shuttingDown=false;
async function shutdown(){if(shuttingDown)return;shuttingDown=true;try{await androidLogin?.cancel()}finally{server.close(()=>process.exit(0))}}
process.on("SIGTERM",()=>void shutdown());
process.on("SIGINT",()=>void shutdown());
