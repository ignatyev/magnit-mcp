import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getMagnitCategories, getMagnitProductDetails, searchMagnit, validateStoreCode, MagnitApiError } from "./magnit-api.js";
import { applyMagnitCart, viewMagnitCart } from "./cart.js";
import { createEncryptedSessionStore, publicSessionState, bindSearchContext } from "./session-store.js";
import { createCartOperationStore } from "./cart-operation-store.js";
import { createCartEligibilityRegistry } from "./cart-eligibility.js";
import { getMagnitOrderHistory, getMagnitShoppingContext } from "./shopping-context.js";
import { loadOrCreateOwnerSecret } from "./local-owner.js";

// This runs on the user's own device; all Magnit calls are native HTTPS requests.
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
  if(!["express","delivery"].includes(mode) || (write && mode !== "express"))
    throw new MagnitApiError("unsupported_mode", write ? "Delivery cart write is disabled" : "Only delivery or express cart is supported");
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
async function selectStore(sessions,storeCode,mode) {
  const s=await sessions.load();
  const service=mode==="delivery"?"dostavka":"express";
  if(s?.cookie&&(s.context?.storeCode!==storeCode||s.context?.service!==service))
    await sessions.save(bindSearchContext(s,storeCode,mode));
}
export async function runTool(name,args={}) {
  if(!args||typeof args!=="object"||Array.isArray(args))throw new MagnitApiError("invalid_arguments","Expected JSON object.");
  const {sessions,journal}=await state();
  if(name==="status")return {transport:"utcp-cli",session:publicSessionState(await sessions.load()),login_url:"http://127.0.0.1:"+(process.env.PORT||8080),live_compatibility:"unverified",checkout_supported:false};
  if(name==="search_products"){
    const r=await searchMagnit({query:args.query,storeCode:validateStoreCode(args.store_code),mode:args.mode||"express",limit:integer(args.limit,20,30)});
    if(["express","delivery"].includes(r.mode))await selectStore(sessions,r.store_code,r.mode);
    return r;
  }
  if(name==="list_categories")return getMagnitCategories({storeCode:validateStoreCode(args.store_code),mode:args.mode||"express"});
  if(name==="product_details")return getMagnitProductDetails({productId:safeId(args.product_id,"product_id"),storeCode:validateStoreCode(args.store_code),mode:"express"});
  if(name==="shopping_context")return getMagnitShoppingContext({session:await sessions.load()});
  if(name==="order_history")return getMagnitOrderHistory({session:await sessions.load(),page:integer(args.page,1,100),limit:integer(args.limit,10,30)});
  if(name==="view_cart")return locked(async()=>{
    const {code,mode}=store(args);
    await selectStore(sessions,code,mode);
    return viewMagnitCart({session:await sessions.load(),storeCode:code,mode,operationStore:journal,saveSession:s=>sessions.save(s)});
  });
  if(name==="add_to_cart"||name==="apply_cart")return locked(async()=>{
    const {code}=store(args,true);
    const registry=createCartEligibilityRegistry();
    const operations=name==="add_to_cart"?[{action:"add",good_id:args.good_id,offer_id:args.offer_id,quantity:args.quantity,query:args.query}]:args.operations;
    if(!Array.isArray(operations)||operations.length<1||operations.length>20)throw new MagnitApiError("invalid_arguments","1–20 operations required.");
    const checked=[];
    for(const op of operations) {
      if(!op||!["add","set","remove"].includes(op.action))throw new MagnitApiError("invalid_arguments","Invalid action.");
      const good_id=safeId(op.good_id,"good_id"),offer_id=safeId(op.offer_id,"offer_id");
      if(op.action!=="remove") {
        if(typeof op.query!=="string"||!op.query.trim())throw new MagnitApiError("cart_item_not_verified","Query required to verify product now.");
        const r=await searchMagnit({query:op.query,storeCode:code,mode:"express",limit:30});
        registry.remember(r);
        registry.require(code,good_id,offer_id);
        checked.push({action:op.action,good_id,offer_id,quantity:integer(op.quantity,1,99)});
      } else checked.push({action:"remove",good_id,offer_id});
    }
    await selectStore(sessions,code,"express");
    const session=await sessions.load();
    if(!session?.cookie)throw new MagnitApiError("session_missing","Sign in via local phone UI first.");
    return applyMagnitCart({session,storeCode:code,mode:"express",requestId:safeId(args.request_id,"request_id"),operations:checked,operationStore:journal,saveSession:s=>sessions.save(s),requireEligible:(s,g,o)=>registry.require(s,g,o)});
  });
  throw new MagnitApiError("unknown_tool","Unknown tool");
}
