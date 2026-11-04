import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { constantTimeEqual, createPhoneSessionCodec } from "./policy.js";
import { getMagnitCategories, MagnitApiError, searchMagnit, validateStoreCode } from "./magnit-api.js";

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN || "";
const PHONE_ACCESS_SECRET = process.env.PHONE_ACCESS_SECRET || "";
const COOKIE_NAME = "magnit_phone_session";
const MAX_BODY_BYTES = 16_384;
const phoneSessions = createPhoneSessionCodec(PHONE_ACCESS_SECRET);
const rateBuckets = new Map();

if (MCP_BEARER_TOKEN.length < 32) throw new Error("MCP_BEARER_TOKEN must be at least 32 characters.");
if (PHONE_ACCESS_SECRET.length < 32) throw new Error("PHONE_ACCESS_SECRET must be at least 32 characters.");
let publicUrl;
try { publicUrl = new URL(PUBLIC_BASE_URL); } catch { throw new Error("PUBLIC_BASE_URL must be an absolute URL."); }
const localOnly = publicUrl.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(publicUrl.hostname);
if (publicUrl.protocol !== "https:" && !localOnly) throw new Error("Plain HTTP is allowed only for loopback.");
const HOST = process.env.HOST || (localOnly ? "127.0.0.1" : "0.0.0.0");
if (localOnly && !["127.0.0.1", "localhost", "[::1]"].includes(HOST)) throw new Error("Loopback HTTP must bind only to loopback.");
const COOKIE_SECURE = process.env.COOKIE_SECURE === undefined ? !localOnly : process.env.COOKIE_SECURE === "1";
if (!COOKIE_SECURE && !localOnly) throw new Error("Insecure cookies are allowed only for loopback HTTP.");

const TOOLS = [{
  name: "magnit_status",
  description: "Показать доступные HTTP-возможности и ограничения. Не проверяет живую доступность Магнит.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}, {
  name: "magnit_search_products",
  description: "Ищет продукты в выбранном магазине Магнит через публичный webgate JSON endpoint. Нужны код магазина и режим (доставка/магазин). Вход, корзина и оформление заказа не поддерживаются этим MCP.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 120, description: "Название товара для поиска." },
      store_code: { type: "string", pattern: "^[0-9]{4,8}$" },
      mode: { type: "string", enum: ["delivery", "retail"], description: "delivery использует storeType=dostavka/catalogType=3; retail использует 1/1." },
      limit: { type: "integer", minimum: 1, maximum: 30, default: 20 },
    },
    required: ["query", "store_code", "mode"],
    additionalProperties: false,
  },
}, {
  name: "magnit_list_categories",
  description: "Получить категории каталога для выбранного магазина и режима.",
  inputSchema: { type: "object", properties: { store_code: { type: "string", pattern: "^[0-9]{4,8}$" }, mode: { type: "string", enum: ["delivery", "retail"] } }, required: ["store_code", "mode"], additionalProperties: false },
}];

const PHONE_HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#fffaf4"><title>Магнит — каталог</title><style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#28241f;background:#f7f4ef}*{box-sizing:border-box}body{margin:0}.shell{max-width:680px;margin:auto;padding:18px 14px 40px}.brand{font-weight:850;font-size:22px;letter-spacing:-.03em}.accent{color:#d7352f}.muted{color:#746e65;font-size:13px;line-height:1.5}.card{background:#fff;border:1px solid #e9e2d9;border-radius:20px;padding:16px;margin-top:14px;box-shadow:0 5px 18px #473c2c0d}.gate{max-width:440px;margin:14vh auto}.row{display:flex;gap:8px}.field{min-width:0;flex:1;border:1px solid #ddd5ca;border-radius:13px;padding:13px;font:inherit;background:#fff}button,select{border:0;border-radius:13px;padding:12px 16px;min-height:46px;font:inherit}button{background:#d7352f;color:white;font-weight:750}button.soft{background:#f1eee9;color:#312d28}h1{font-size:30px;line-height:1.08;margin:22px 0 8px;letter-spacing:-.04em}.status{min-height:20px;font-size:13px;color:#665f57;margin-top:8px}.products{display:grid;gap:10px}.product{border:1px solid #eee8df;border-radius:16px;padding:14px}.product h3{font-size:15px;margin:0 0 7px}.price{font-weight:800;font-size:17px}.sub{font-size:12px;color:#746e65;margin-top:5px}.hidden{display:none!important}.bar{display:flex;justify-content:space-between;align-items:center;gap:10px}.badge{border-radius:999px;background:#f6eee9;color:#9b342c;padding:5px 9px;font-size:11px;font-weight:700}
</style></head><body><main class="shell"><section id="gate" class="card gate"><div class="brand">Магнит <span class="accent">каталог</span></div><p class="muted">Введите пароль доступа сервера. Пароль Магнит и СМС-код здесь не нужны.</p><form id="loginForm"><div class="row"><input id="passphrase" class="field" type="password" autocomplete="current-password" placeholder="Пароль доступа" required><button>Войти</button></div><div id="loginError" class="status"></div></form></section><section id="app" class="hidden"><header class="bar"><div><div class="brand">Магнит <span class="accent">каталог</span></div><div class="muted">Мобильный HTTP-поиск · MCP доступен на телефоне</div></div><button id="logout" class="soft">Выход</button></header><h1>Найдите продукты</h1><p class="muted">Выберите код магазина и режим каталога. Цены и наличие отображаются из ответа Магнит. Корзина и заказ не меняются.</p><form id="searchForm"><div class="row"><input id="storeCode" class="field" inputmode="numeric" maxlength="8" placeholder="Код магазина (4–8 цифр)" required><select id="mode" class="field"><option value="delivery">Доставка</option><option value="retail">Магазин</option></select></div><div class="row" style="margin-top:8px"><input id="query" class="field" type="search" maxlength="120" placeholder="Например, молоко 2,5%" required><button>Найти</button></div></form><div id="status" class="status" role="status"></div><section id="products" class="products"></section><footer class="card muted">Неофициальный HTTP-каталог. Режимы соответствуют двум публичным реализациям API и могут различаться по ассортименту. Совместимость с текущим сервером Магнит не проверялась.</footer></section></main><script>
(()=>{let csrf='';const gate=document.querySelector('#gate'),app=document.querySelector('#app'),status=document.querySelector('#status'),products=document.querySelector('#products');async function req(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin'});if(!r.ok)throw new Error((await r.json().catch(()=>({error:'Ошибка'}))).error||'Ошибка');return r.status===204?{}:r.json()}async function init(){try{const s=await req('/api/state');csrf=s.csrf;gate.classList.add('hidden');app.classList.remove('hidden')}catch{gate.classList.remove('hidden');app.classList.add('hidden')}}document.querySelector('#loginForm').onsubmit=async e=>{e.preventDefault();try{const p=document.querySelector('#passphrase');const x=await req('/api/phone/session',{passphrase:p.value});csrf=x.csrf;p.value='';document.querySelector('#loginError').textContent='';await init()}catch{document.querySelector('#loginError').textContent='Пароль не принят.'}};document.querySelector('#searchForm').onsubmit=async e=>{e.preventDefault();status.textContent='Ищем…';products.replaceChildren();try{const r=await req('/api/search',{query:document.querySelector('#query').value,store_code:document.querySelector('#storeCode').value,mode:document.querySelector('#mode').value});status.textContent=r.products.length?'Найдено: '+r.products.length:'Ничего не найдено';for(const p of r.products){const card=document.createElement('article');card.className='product';const title=document.createElement('h3');title.textContent=p.name;const price=document.createElement('div');price.className='price';price.textContent=p.price_rubles==null?'Цена не указана':new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'}).format(p.price_rubles);const sub=document.createElement('div');sub.className='sub';sub.textContent=[p.in_stock===null?'Наличие неизвестно':p.in_stock?'В наличии':'Нет в наличии',p.old_price_kopecks?'Старая цена '+new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'}).format(p.old_price_kopecks/100):'',p.badges.join(', ')].filter(Boolean).join(' · ');card.append(title,price,sub);products.append(card)}}catch(err){status.textContent=err.message||'Не удалось выполнить поиск'}};document.querySelector('#logout').onclick=async()=>{await req('/api/phone/logout',{csrf});location.reload()};init()})();
</script></body></html>`;

function originMatches(req) { return req.headers.origin === new URL(PUBLIC_BASE_URL).origin && (!req.headers["sec-fetch-site"] || req.headers["sec-fetch-site"] === "same-origin"); }
function writeJson(res, status, body, extra = {}) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra }); res.end(JSON.stringify(body)); }
function error(res, status = 400, message = "Не удалось выполнить запрос.") { writeJson(res, status, { error: message }); }
async function readJson(req) { let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY_BYTES)throw Error("large");chunks.push(chunk)}return chunks.length?JSON.parse(Buffer.concat(chunks).toString("utf8")):{}; }
function rateLimit(key, max, windowMs) { const now=Date.now();if(rateBuckets.size>2000){for(const [k,v] of rateBuckets)if(v.until<now)rateBuckets.delete(k);while(rateBuckets.size>2000)rateBuckets.delete(rateBuckets.keys().next().value)}const hit=rateBuckets.get(key);if(!hit||hit.until<now){rateBuckets.set(key,{count:1,until:now+windowMs});return true}return ++hit.count<=max; }
function peer(req) { return process.env.TRUST_PROXY==="1"?String(req.headers["x-forwarded-for"]||"").split(",")[0].trim()||req.socket.remoteAddress:req.socket.remoteAddress; }
function readSession(req) { const raw=(req.headers.cookie||"").split(";").map((s)=>s.trim()).find((s)=>s.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length+1);return raw?phoneSessions.verify(raw):null; }
function cookie(res,value,maxAge) {const parts=[`${COOKIE_NAME}=${value}`,"Path=/","HttpOnly","SameSite=Strict",`Max-Age=${maxAge}`];if(COOKIE_SECURE)parts.push("Secure");res.setHeader("Set-Cookie",parts.join("; "));}
function requirePhone(req,res){if(!originMatches(req)){error(res,403,"Обновите страницу и попробуйте ещё раз.");return null}const session=readSession(req);if(!session){error(res,401,"Введите пароль доступа.");return null}if(!constantTimeEqual(req.headers["x-csrf-token"],session.csrf)){error(res,403,"Обновите страницу и попробуйте ещё раз.");return null}return session}
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
  if(body.method==="initialize")return writeJson(res,200,rpc(id,{protocolVersion:"2026-07-28",capabilities:{tools:{}},serverInfo:{name:"magnit-http-mcp",version:"0.2.0"}}));
  if(body.method==="tools/list")return writeJson(res,200,rpc(id,{tools:TOOLS}));
  if(body.method==="ping")return writeJson(res,200,rpc(id,{}));
  if(body.method!=="tools/call")return writeJson(res,200,rpcError(id,-32601,"Method not found"));
  if(params.name==="magnit_status")return writeJson(res,200,rpc(id,{content:[{type:"text",text:JSON.stringify({service:"ready",capabilities:["magnit_search_products","magnit_list_categories"],live_compatibility:"unverified",unsupported:["login","cart","checkout","order","payment"]})}]}));
  if(params.name!=="magnit_search_products"&&params.name!=="magnit_list_categories")return writeJson(res,200,rpc(id,{isError:true,content:[{type:"text",text:"Инструмент не поддерживается."}]}));
  const args=params.arguments??{};if(!args||typeof args!=="object"||Array.isArray(args))return writeJson(res,200,rpcError(id,-32602,"Invalid params"));
  try{
    const result=params.name==="magnit_search_products"
      ? await searchMagnit({query:args.query,storeCode:args.store_code,mode:args.mode,limit:args.limit??20})
      : await getMagnitCategories({storeCode:args.store_code,mode:args.mode});
    return writeJson(res,200,rpc(id,{content:[{type:"text",text:JSON.stringify(result)}]}));
  }catch(cause){
    const code=cause instanceof MagnitApiError?cause.code:"invalid_arguments";
    const message=cause instanceof MagnitApiError?cause.message:(cause instanceof Error?cause.message:"Invalid arguments.");
    return writeJson(res,200,rpc(id,{isError:true,content:[{type:"text",text:JSON.stringify({error:code,message,compatibility:"unverified"})}]}));
  }
}

async function handlePhone(req,res,url){
  if(req.method==="GET"&&url.pathname==="/"){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","X-Frame-Options":"DENY"});return res.end(PHONE_HTML)}
  if(req.method==="POST"&&url.pathname==="/api/phone/session"){if(!originMatches(req))return error(res,403,"Откройте страницу сервера напрямую.");if(!rateLimit(`login:${peer(req)}`,8,60_000))return error(res,429,"Слишком много попыток.");let b;try{b=await readJson(req)}catch{return error(res,400)}if(!constantTimeEqual(b.passphrase,PHONE_ACCESS_SECRET))return error(res,401,"Пароль не принят.");const csrf=randomBytes(24).toString("base64url");cookie(res,phoneSessions.issue(csrf),7*24*60*60);return writeJson(res,200,{csrf})}
  if(req.method==="GET"&&url.pathname==="/api/state"){const s=readSession(req);if(!s)return error(res,401,"Введите пароль доступа.");return writeJson(res,200,{csrf:s.csrf})}
  if(req.method==="POST"&&url.pathname==="/api/search"){
    if(!requirePhone(req,res))return;
    if(!rateLimit(`search:${peer(req)}`,30,60_000))return error(res,429,"Подождите перед новым поиском.");
    let b;try{b=await readJson(req)}catch{return error(res,400)}
    try{return writeJson(res,200,await searchMagnit({query:b.query,storeCode:b.store_code,mode:b.mode,limit:b.limit??20}))}
    catch(cause){const status=cause instanceof MagnitApiError?cause.code:"invalid_arguments";const message=cause instanceof MagnitApiError?cause.message:(cause instanceof Error?cause.message:"Проверьте запрос, код магазина и режим.");return writeJson(res,400,{error:message,code:status})}
  }
  if(req.method==="POST"&&url.pathname==="/api/phone/logout"){if(!requirePhone(req,res))return;cookie(res,"",0);return res.writeHead(204,{"Cache-Control":"no-store"}).end()}
  return error(res,404,"Страница не найдена.");
}

const server=createServer(async(req,res)=>{if(process.env.TRUST_PROXY==="1"&&req.headers["x-forwarded-proto"]!=="https")return error(res,400,"Нужен HTTPS.");try{const url=new URL(req.url||"/",PUBLIC_BASE_URL);if(req.method==="POST"&&url.pathname==="/mcp")return await handleMcp(req,res);await handlePhone(req,res,url)}catch{if(!res.headersSent)error(res,500,"Не удалось выполнить запрос.");else res.destroy()}});
server.listen(PORT,HOST);
process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
process.on("SIGINT",()=>server.close(()=>process.exit(0)));
