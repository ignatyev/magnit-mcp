import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getMagnitCategories, getMagnitProductDetails, searchMagnit, validateStoreCode, MagnitApiError } from "./magnit-api.js";
import { applyMagnitCart, viewMagnitCart, diagnoseMagnitCartHeaders, describeMagnitCartRequest, diagnoseMagnitTransportMatrix } from "./cart.js";
import { createEncryptedSessionStore, publicSessionState, bindSearchContext } from "./session-store.js";
import { createCartOperationStore } from "./cart-operation-store.js";
import { createCartEligibilityRegistry } from "./cart-eligibility.js";
import { getMagnitOrderHistory, getMagnitShoppingContext } from "./shopping-context.js";
import { loadOrCreateOwnerSecret } from "./local-owner.js";
import { withMagnitChrome } from "./chrome-transport.js";
import { browserAction } from "./browser-agent.js";

// This runs on the user's own device; shopping calls use authenticated Android Chrome via local ADB/CDP.
let promise;
async function state() {
  if (!promise) promise=(async()=>{
    const secret=await loadOrCreateOwnerSecret(process.env.OWNER_KEY_FILE||"./data/owner-key");
    return {
      sessions:createEncryptedSessionStore({secret,filename:process.env.SESSION_FILE||"./data/magnit-session.enc"}),
      journal:createCartOperationStore({secret,filename:process.env.CART_OPERATIONS_FILE||"./data/cart-operations.enc"})
    };
  })();
  return promise;
}
const idRegex=/^[A-Za-z0-9._:-]{1,128}$/;
function safeId(x,n) {
  if(typeof x!=="string"||!idRegex.test(x)) throw new MagnitApiError("invalid_arguments","Invalid "+n);
  return x;
}
function integer(x, fallback, upper) {
  const n=x===undefined?fallback:Number(x);
  if(!Number.isSafeInteger(n)||n<1||n>upper) throw new MagnitApiError("invalid_arguments","Invalid integer");
  return n;
}
function store(args, write = false) {
  const mode = args.mode || "express";
  if(!["express","delivery"].includes(mode))
    throw new MagnitApiError("unsupported_mode", "Only delivery or express cart is supported");
  return { code: validateStoreCode(args.store_code), mode };
}
// Cross-process protection. A crash leaves a lock that must be inspected manually.
async function locked(fn) {
  const p=resolve(process.env.CART_LOCK_FILE||"./data/cart.lock");
  await mkdir(dirname(p),{recursive:true,mode:0o700});
  let fd;
  try{fd=await open(p,"wx",0o600);}
  catch(e){if(e.code==="EEXIST")throw new MagnitApiError("cart_busy","Cart operation already in progress. Inspect cart before clearing a stale lock.");throw e;}
  try{return await fn();}finally{await fd.close();await unlink(p);}
}
export async function getLocalSessionStore(){return (await state()).sessions;}
// A search or read of another store must not overwrite the verified Chrome
// cart context. The request x-store-code can differ from formats.storeCode.
export function sessionForSelectedStore(session, storeCode, mode) {
  if (!session?.cookie) return session;
  const service = mode === "delivery" ? "dostavka" : mode === "express" ? "express" : null;
  if (!service) throw new MagnitApiError("unsupported_mode", "Only delivery or express cart is supported");
  if (session.context?.storeCode === storeCode && session.context?.service === service) return session;
  return bindSearchContext(session, storeCode, mode);
}
export async function runTool(name,args={}) {
  if(!args||typeof args!=="object"||Array.isArray(args))throw new MagnitApiError("invalid_arguments","Expected JSON object.");
  const {sessions,journal}=await state();
  if(name.startsWith("browser_"))return locked(()=>browserAction(name,args));
  if(name==="status")return {transport:"utcp-chrome-cdp",session:publicSessionState(await sessions.load()),login_method:"termux_cli_sync",live_compatibility:"unverified",checkout_supported:false};
  if(name==="search_products")return locked(async()=>{
    const {code,mode}=store(args);
    const session=sessionForSelectedStore(await sessions.load(),code,mode);
    return withMagnitChrome({session,operation:fetchImpl=>searchMagnit({
      query:args.query,storeCode:code,mode,limit:integer(args.limit,20,30),fetchImpl,
    })});
  });
  if(name==="list_categories")return locked(async()=>{
    const {code,mode}=store(args);
    const session=sessionForSelectedStore(await sessions.load(),code,mode);
    return withMagnitChrome({session,operation:fetchImpl=>getMagnitCategories({
      storeCode:code,mode,fetchImpl,
    })});
  });
  if(name==="product_details")return locked(async()=>{
    const code=validateStoreCode(args.store_code);
    const session=sessionForSelectedStore(await sessions.load(),code,"express");
    return withMagnitChrome({session,operation:fetchImpl=>getMagnitProductDetails({
      productId:safeId(args.product_id,"product_id"),storeCode:code,mode:"express",fetchImpl,
    })});
  });
  if(name==="shopping_context"||name==="order_history")return locked(async()=>{
    const session=await sessions.load();
    return withMagnitChrome({session,operation:fetchImpl=>name==="shopping_context"
      ?getMagnitShoppingContext({session,fetchImpl})
      :getMagnitOrderHistory({session,page:integer(args.page,1,100),
        limit:integer(args.limit,10,30),fetchImpl})});
  });
  if(name==="collect_debug_report")return locked(async()=>{
    const {code,mode}=store(args);
    const saved=await sessions.load();
    const selected=sessionForSelectedStore(saved,code,mode);
    const publicState=publicSessionState(saved);
    const local=describeMagnitCartRequest(selected);
    const snapshot=publicState.browser_cart_snapshot;
    const observedHeaders=Array.isArray(snapshot?.request_header_names) ? snapshot.request_header_names : null;
    const localHeaders=local?.header_names || [];
    const diff=observedHeaders?{
      chrome_only:observedHeaders.filter(x=>!localHeaders.includes(x)),
      utcp_only:localHeaders.filter(x=>!observedHeaders.includes(x)),
      present_in_both:observedHeaders.filter(x=>localHeaders.includes(x)),
    }:null;
    const report={
      format:"magnit-utcp-debug-v1",
      created_at:new Date().toISOString(),
      safe_to_share:true,
      writes_performed:0,
      mode,request_store_code:code,
      environment:{node:process.version,platform:process.platform,arch:process.arch},
      session:{
        authenticated:publicState.auth_saved,
        verified_browser_context:publicState.cart_context_ready,
        browser_service:publicState.service,
        browser_request_store_code:publicState.store_code,
        exact_context_match:publicState.cart_context_ready &&
          publicState.service===(mode==="delivery"?"dostavka":"express") &&
          publicState.store_code===code,
        reconciliation_required:publicState.cart_reconciliation_required,
        cookie_source:publicState.cookie_source,
      },
      official_android_chrome:snapshot,
      adapter_request_metadata:local,
      header_name_comparison:diff,
      chrome_cookie_count:snapshot?.browser_cookie_count ?? null,
      utcp_cookie_count:local?.cookie_count ?? null,
      header_coverage_available:observedHeaders!==null,
      note:"Только чтение: HTTP GET корзины и POST поиска. Нет PUT, cookies, токенов, товаров, цен и адресов.",
    };
    function safeError(cause) {
      const code=cause?.code;
      return typeof code==="string" && /^[a-z][a-z0-9._:-]{1,63}$/i.test(code)?code:"diagnostic_failed";
    }
    if(!selected?.cookie){
      report.cart_get={ok:false,error_code:"session_missing"};
      report.catalog={ok:false,error_code:"session_missing"};
      report.journal={ok:false,error_code:"session_missing"};
      return report;
    }
    try {
      report.cart_get=await diagnoseMagnitCartHeaders({session:selected,storeCode:code,mode});
    } catch(cause) {
      report.cart_get={ok:false,error_code:safeError(cause)};
    }
    try {
      report.transport_matrix=await diagnoseMagnitTransportMatrix({session:selected,storeCode:code,mode});
    } catch(cause) {
      report.transport_matrix={ok:false,error_code:safeError(cause)};
    }
    try {
      report.chrome_runtime=await withMagnitChrome({session:selected,operation:fetchImpl=>
        diagnoseMagnitCartHeaders({session:selected,storeCode:code,mode,fetchImpl})});
    } catch(cause) {
      report.chrome_runtime={ok:false,error_code:safeError(cause)};
    }
    try {
      const catalog=await searchMagnit({query:"молоко",storeCode:code,mode,limit:20});
      const blockers=Object.create(null);
      for(const p of catalog.products) {
        for(const blocker of p.cart_add_blockers || []) {
          if(/^[a-z_]{1,40}$/.test(blocker)) blockers[blocker]=(blockers[blocker]||0)+1;
        }
      }
      report.catalog={ok:true,query_category:"milk",product_count:catalog.products.length,
        eligible_count:catalog.products.filter(p=>p.cart_addable).length,blocker_counts:blockers};
    } catch(cause) {
      report.catalog={ok:false,error_code:safeError(cause)};
    }
    try {
      report.journal=await journal.summary({
        sessionFingerprint:journal.fingerprint(selected.cookie),
        storeCode:mode==="delivery"?"dostavka:"+code:code,
      });
    } catch(cause) {
      report.journal={ok:false,error_code:safeError(cause)};
    }
    return report;
  });
  if(name==="compare_cart_headers")return locked(async()=>{
    const {code,mode}=store(args);
    const selected=sessionForSelectedStore(await sessions.load(),code,mode);
    return diagnoseMagnitCartHeaders({session:selected,storeCode:code,mode});
  });
  if(name==="view_cart")return locked(async()=>{
    const {code,mode}=store(args);
    const saved = await sessions.load();
    const selected = sessionForSelectedStore(saved, code, mode);
    // Reads of a different context must not persist the temporary context.
    return withMagnitChrome({session:selected,operation:fetchImpl=>viewMagnitCart({
      session:selected,storeCode:code,mode,fetchImpl,operationStore:journal,
      saveSession:s=>selected===saved?sessions.save(s):Promise.resolve(),
    })});
  });
  if(name==="add_to_cart"||name==="apply_cart")return locked(async()=>{
    const {code,mode}=store(args,true);
    const session=sessionForSelectedStore(await sessions.load(),code,mode);
    if(!session?.cookie)throw new MagnitApiError("session_missing","Sign in via local phone UI first.");
    const operations=name==="add_to_cart"
      ?[{action:"add",good_id:args.good_id,offer_id:args.offer_id,quantity:args.quantity,query:args.query}]
      :args.operations;
    if(!Array.isArray(operations)||operations.length<1||operations.length>20)
      throw new MagnitApiError("invalid_arguments","1–20 operations required.");
    return withMagnitChrome({session,operation:async fetchImpl=>{
      const registry=createCartEligibilityRegistry();
      const checked=[];
      for(const op of operations) {
        if(!op||!["add","set","remove"].includes(op.action))
          throw new MagnitApiError("invalid_arguments","Invalid action.");
        const good_id=safeId(op.good_id,"good_id"),offer_id=safeId(op.offer_id,"offer_id");
        if(op.action!=="remove"){
          if(typeof op.query!=="string"||!op.query.trim())
            throw new MagnitApiError("cart_item_not_verified","Query required to verify product now.");
          const r=await searchMagnit({query:op.query,storeCode:code,mode,limit:30,fetchImpl});
          registry.remember(r);
          registry.require(code,good_id,offer_id,mode);
          checked.push({action:op.action,good_id,offer_id,quantity:integer(op.quantity,1,99)});
        } else checked.push({action:"remove",good_id,offer_id});
      }
      return applyMagnitCart({session,storeCode:code,mode,requestId:safeId(args.request_id,"request_id"),
        operations:checked,fetchImpl,operationStore:journal,saveSession:s=>sessions.save(s),
        requireEligible:(s,g,o)=>registry.require(s,g,o,mode)});
    }});
  });
  throw new MagnitApiError("unknown_tool","Unknown tool");
}
