import {randomBytes} from "node:crypto";
import {createServer} from "node:http";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {runTool,getLocalSessionStore} from "./toolkit.js";
import {createAndroidLogin} from "./android-login.js";
import {publicSessionState} from "./session-store.js";
import {isDirectLocalOwnerRequest} from "./local-owner.js";
const PORT=Number(process.env.PORT||8080);
if(!Number.isSafeInteger(PORT)||PORT<1||PORT>65535)throw Error("Invalid port.");
if(process.env.HOST&&process.env.HOST!=="127.0.0.1")throw Error("Local UI must only bind to loopback.");
const host="127.0.0.1",hosts=new Set(["127.0.0.1:"+PORT,"localhost:"+PORT]);
const csrf=randomBytes(32).toString("base64url");
let login=null;
const run=promisify(execFile);
const headers={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","X-Frame-Options":"DENY"};
function json(res,status,value){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8",...headers});res.end(JSON.stringify(value));}
async function read(req){let total=0,parts=[];for await(const p of req){total+=p.length;if(total>12000)throw Error("Request too large");parts.push(p)}return JSON.parse(Buffer.concat(parts).toString("utf8")||"{}");}
const page="<!doctype html><html lang=\"ru\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Магнит UTCP</title><style>\nbody{font-family:system-ui;margin:0;background:#f8f6f2;color:#272422}main{max-width:700px;margin:auto;padding:18px}\nheader{background:#c8342e;color:white;padding:24px;border-radius:22px}\nsection{background:white;border:1px solid #eee;border-radius:20px;padding:18px;margin-top:14px}\ninput,textarea{box-sizing:border-box;width:100%;font:inherit;border:1px solid #ddd;padding:12px;border-radius:12px;margin:8px 0}\nbutton{border:0;border-radius:12px;background:#c8342e;color:white;padding:12px;font:inherit;font-weight:bold;margin:4px}\narticle{border-bottom:1px solid #eee;padding:10px 0}pre{white-space:pre-wrap}small{color:#666}\n</style><main><header><h1>Магнит · UTCP</h1>HTTP-каталог и корзина без MCP</header>\n<section><h2>1. Вход</h2><p id=\"state\"></p><button id=\"login\">Войти в Магнит</button><button id=\"sync\">Синхронизировать корзину</button><button id=\"logout\">Удалить сессию</button><p id=\"loginState\"></p><small>Для синхронизации откройте корзину в запущенной официальной вкладке Магнита, выбрав там режим «Экспресс» и нужный магазин. Нужна беспроводная отладка/ADB.</small></section>\n<section><h2>2. Товары</h2><label>Код магазина<input id=\"store\" inputmode=\"numeric\" placeholder=\"4–8 цифр\"></label><label>Поиск<input id=\"query\" placeholder=\"Например, молоко\"></label><button id=\"search\">Найти</button><button id=\"cart\">Показать корзину</button><p id=\"notice\"></p><div id=\"products\"></div></section>\n<section><h2>3. ИИ-агент</h2><small>Необязательно; потребуется отдельный оплачиваемый OpenAI API ключ.</small><textarea id=\"prompt\" rows=\"3\" placeholder=\"Собери корзину для завтрака\"></textarea><button id=\"ask\">Отправить</button><pre id=\"answer\"></pre></section></main>\n<script>\nconst csrf=\"__CSRF__\",el=id=>document.getElementById(id);\nasync function req(path,body){\n const r=await fetch(path,body===undefined?{}:{method:\"POST\",headers:{\"Content-Type\":\"application/json\",\"X-CSRF-Token\":csrf},body:JSON.stringify(body)});\n const d=await r.json();if(!r.ok)throw Error(d.error||\"Ошибка\");return d;\n}\nasync function status(){const d=await req(\"/api/status\");el(\"state\").textContent=d.session.ready?(d.session.cart_context_ready?\"Вход сохранён · корзина синхронизирована с Chrome\":\"Вход сохранён · корзина не синхронизирована\"):\"Вход не выполнен\";if(d.session.store_code)el(\"store\").value=d.session.store_code;}\nfunction store(){const s=el(\"store\").value.trim();if(!/^[0-9]{4,8}$/.test(s))throw Error(\"Нужен код магазина (4–8 цифр)\");return s;}\nasync function captureBrowser(sync_cart){try{const d=await req(\"/api/login/start\",{sync_cart});el(\"loginState\").textContent=d.message;const timer=setInterval(async()=>{try{const x=await req(\"/api/login/status\");el(\"loginState\").textContent=x.message||x.status;if(![\"opening\",\"waiting\",\"verifying\"].includes(x.status)){clearInterval(timer);await status();}}catch(e){clearInterval(timer);el(\"loginState\").textContent=e.message}},2000)}catch(e){el(\"loginState\").textContent=e.message}}\nel(\"login\").onclick=()=>captureBrowser(false);\nel(\"sync\").onclick=()=>captureBrowser(true);\nel(\"logout\").onclick=async()=>{try{await req(\"/api/logout\",{});await status()}catch(e){el(\"state\").textContent=e.message}};\nel(\"search\").onclick=async()=>{el(\"notice\").textContent=\"Ищем…\";el(\"products\").replaceChildren();\ntry{const code=store(),query=el(\"query\").value,r=await req(\"/api/search\",{store_code:code,query,mode:\"express\",limit:20});el(\"notice\").textContent=\"Найдено: \"+r.products.length;\nfor(const p of r.products){const a=document.createElement(\"article\"),b=document.createElement(\"strong\");b.textContent=p.name;a.append(b);const n=document.createElement(\"p\");n.textContent=(p.price_rubles??\"?\")+\" ₽\";a.append(n);if(p.cart_addable){const add=document.createElement(\"button\");add.textContent=\"Добавить 1\";add.onclick=async()=>{try{const x=await req(\"/api/add\",{query,store_code:code,good_id:p.good_id,offer_id:p.offer_id,quantity:1,request_id:crypto.randomUUID()});el(\"notice\").textContent=\"Добавлено и подтверждено: \"+x.item_count+\" позиций\"}catch(e){el(\"notice\").textContent=e.message}};a.append(add)}el(\"products\").append(a)}await status()}catch(e){el(\"notice\").textContent=e.message}};\nel(\"cart\").onclick=async()=>{try{const r=await req(\"/api/cart?store_code=\"+encodeURIComponent(store()));el(\"notice\").textContent=\"В корзине \"+r.items.length+\" позиций. Сумма не итоговая.\";el(\"products\").replaceChildren();for(const p of r.items){const a=document.createElement(\"article\");a.textContent=(p.good_id||\"?\")+\" · \"+(p.quantity??\"?\")+\" шт.\";el(\"products\").append(a)}}catch(e){el(\"notice\").textContent=e.message}};\nel(\"ask\").onclick=async()=>{el(\"answer\").textContent=\"Работа агента…\";try{const r=await req(\"/api/agent\",{prompt:el(\"prompt\").value});el(\"answer\").textContent=r.answer}catch(e){el(\"answer\").textContent=e.message}};\nstatus().catch(e=>el(\"state\").textContent=e.message);\n</script></html>".replace("__CSRF__",csrf);
const server=createServer(async(req,res)=>{
 try{
   if(!isDirectLocalOwnerRequest(req,hosts))return json(res,403,{error:"Local owner only"});
   const url=new URL(req.url||"/","http://127.0.0.1:"+PORT);
   if(req.method==="GET"&&url.pathname==="/"){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",...headers});return res.end(page);}
   if(req.method==="GET"&&url.pathname==="/api/status")return json(res,200,{session:publicSessionState(await(await getLocalSessionStore()).load())});
   if(req.method==="GET"&&url.pathname==="/api/login/status")return json(res,200,login?.snapshot()||{status:"idle"});
   if(req.method==="GET"&&url.pathname==="/api/cart")return json(res,200,await runTool("view_cart",{store_code:url.searchParams.get("store_code")}));
   if(req.method!=="POST"||req.headers.origin!=="http://"+req.headers.host||req.headers["x-csrf-token"]!==csrf)return json(res,403,{error:"Origin/CSRF rejected"});
   const b=await read(req);
   if(url.pathname==="/api/login/start"){
     if(!login||!["opening","waiting","verifying"].includes(login.snapshot().status)){
       login=createAndroidLogin({saveSession:async s=>(await getLocalSessionStore()).save(s),requireCartContext:b.sync_cart===true,requestedSerial:process.env.ANDROID_DEVICE_SERIAL||""});
       return json(res,200,await login.start());
     }
     return json(res,200,login.snapshot());
   }
   if(url.pathname==="/api/logout"){await login?.cancel();login=null;await(await getLocalSessionStore()).clear();return json(res,200,{ok:true});}
   if(url.pathname==="/api/search")return json(res,200,await runTool("search_products",b));
   if(url.pathname==="/api/add")return json(res,200,await runTool("add_to_cart",b));
   if(url.pathname==="/api/agent"){
     if(!process.env.OPENAI_API_KEY)return json(res,503,{error:"OPENAI_API_KEY не задан"});
     if(typeof b.prompt!=="string"||b.prompt.length<1||b.prompt.length>2500)return json(res,400,{error:"Текст 1–2500 символов"});
     const {stdout}=await run("python3",["agent.py",b.prompt],{timeout:180000,maxBuffer:256000,cwd:process.cwd(),env:process.env});
     return json(res,200,{answer:stdout.trim()});
   }
   return json(res,404,{error:"Not found"});
 }catch(e){return json(res,400,{error:String(e.code||"error")+": "+String(e.message||"Unknown error")});}
});
server.listen(PORT,host,()=>console.log("Magnit UTCP: http://127.0.0.1:"+PORT));
process.on("SIGINT",async()=>{await login?.cancel();server.close()});
process.on("SIGTERM",async()=>{await login?.cancel();server.close()});
