import test from "node:test";
import assert from "node:assert/strict";
import { addMagnitCartItem, applyMagnitCart, viewMagnitCart } from "../src/cart.js";

const session = { cookie: "sid=synthetic-cookie", context: { service: "express", storeCode: "123456", bff: "synthetic-bff", permissionsJwt: null } };
const cart = (items, formatCount = items.length) => ({ items, formats: [{ itemsCount: formatCount, service: "express", storeCode: "123456" }], totalBasePrice: 12345, totalFinalPrice: 11111, totalGoodsCount: items.length });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("missing or mismatched session rejects before any HTTP request", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(cart([])); };
  await assert.rejects(viewMagnitCart({ storeCode: "123456", mode: "express", fetchImpl }), (error) => error.code === "session_missing");
  await assert.rejects(viewMagnitCart({ session, storeCode: "123457", mode: "express", fetchImpl }), (error) => error.code === "context_mismatch");
  assert.equal(calls, 0);
});

test("cart GET is pinned and exposes no cookie/token in its result", async () => {
  let seen;
  const result = await viewMagnitCart({ session, storeCode: "123456", mode: "express", fetchImpl: async (url, init) => { seen = { url, init }; return response(cart([{ goodId: "old-good", offerId: "old-offer", qnty: 2 }])); } });
  assert.equal(seen.url, "https://magnit.ru/webgate/v1/carts/lite");
  assert.equal(seen.init.method, "GET");
  assert.equal(seen.init.redirect, "error");
  assert.equal(seen.init.headers.Cookie, session.cookie);
  assert.equal(seen.init.headers.Referer, "https://magnit.ru/");
  assert.equal(seen.init.headers["x-new-magnit"], "true");
  assert.equal(seen.init.headers["x-client-name"], "magnit");
  assert.equal(seen.init.headers["x-device-platform"], "Web");
  assert.equal(seen.init.headers.Origin, undefined, "GET must not send Origin");
  assert.equal(seen.init.headers.Authorization, undefined);
  assert.equal(JSON.stringify(result).includes(session.cookie), false);
  assert.equal(JSON.stringify(result).includes("synthetic-bff"), false);
  assert.equal(result.items[0].quantity, 2);
  assert.equal(result.totals_lite.is_checkout_quote, false);
});

test("add reads the cart, preserves all items, merges exact IDs, and issues one PUT", async () => {
  const calls = [];
  const before = cart([{ goodId: "old-good", offerId: "old-offer", qnty: 2 }, { goodId: "new-good", offerId: "new-offer", qnty: 1 }]);
  const after = cart([{ goodId: "old-good", offerId: "old-offer", qnty: 2 }, { goodId: "new-good", offerId: "new-offer", qnty: 4 }], 1);
  const result = await addMagnitCartItem({ session, storeCode: "123456", mode: "express", goodId: "new-good", offerId: "new-offer", quantity: 3, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? response(before) : response(after);
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(calls[1].init.headers.Origin, "https://magnit.ru");
  assert.equal(calls[1].init.headers.Referer, "https://magnit.ru/");
  assert.equal(calls[1].init.headers["x-new-magnit"], "true");
  assert.deepEqual(JSON.parse(calls[1].init.body), { items: [
    { goodId: "old-good", offerId: "old-offer", qnty: 2 },
    { goodId: "new-good", offerId: "new-offer", qnty: 4 },
  ] });
  assert.equal(result.mutation, "added_and_verified");
  assert.equal(result.verified_quantity, 4);
});

test("empty cart with no formats is readable and can receive its first item", async () => {
  const calls = [];
  const empty = { items: [], formats: [], totalBasePrice: 0, totalFinalPrice: 0, totalGoodsCount: 0 };
  const after = { items: [{ goodId: "first", offerId: "first-offer", qnty: 1 }], formats: [{ itemsCount: 0, service: "express", storeCode: "654321" }], totalBasePrice: 100, totalFinalPrice: 100, totalGoodsCount: 1 };
  const read = await viewMagnitCart({ session, storeCode: "123456", mode: "express", fetchImpl: async () => response(empty) });
  assert.deepEqual(read.items, []);
  assert.equal(read.cart_store_code, null);
  const result = await addMagnitCartItem({ session, storeCode: "123456", mode: "express", goodId: "first", offerId: "first-offer", quantity: 1, fetchImpl: async (url, init) => {
    calls.push(init.method);
    return calls.length === 1 ? response(empty) : response(after);
  } });
  assert.deepEqual(calls, ["GET", "PUT"]);
  assert.equal(result.items[0].quantity, 1);
  assert.equal(result.cart_store_code, "654321");
});

test("unsafe existing items, duplicate IDs and multi-format carts abort before PUT", async () => {
  for (const body of [
    cart([{ goodId: "x", offerId: "y", qnty: null }]),
    cart([{ goodId: "x", offerId: "y", qnty: 1 }, { goodId: "x", offerId: "y", qnty: 2 }]),
    { ...cart([]), formats: [{}, {}] },
    cart([{ goodId: "x", offerId: "y", qnty: 1, goodStoreCode: "654321" }]),
  ]) {
    let calls = 0;
    await assert.rejects(addMagnitCartItem({ session, storeCode: "123456", mode: "express", goodId: "n", offerId: "m", quantity: 1, fetchImpl: async () => { calls++; return response(body); } }));
    assert.equal(calls, 1);
  }
});

test("401 does not retry and ambiguous PUT is never replayed", async () => {
  let authCalls = 0;
  await assert.rejects(viewMagnitCart({ session, storeCode: "123456", mode: "express", fetchImpl: async () => { authCalls++; return response({}, 401); } }), (error) => error.code === "session_rejected");
  assert.equal(authCalls, 1);
  let calls = 0;
  let persisted;
  await assert.rejects(addMagnitCartItem({ session, storeCode: "123456", mode: "express", goodId: "new", offerId: "new", quantity: 1, saveSession: async (value) => { persisted = value; }, fetchImpl: async () => {
    calls++;
    if (calls === 1) return response(cart([]));
    throw new TypeError("synthetic connection reset");
  } }), (error) => error.code === "ambiguous_result");
  assert.equal(calls, 2);
  assert.equal(persisted.cartReconciliationRequired, true);
  await assert.rejects(addMagnitCartItem({ session: persisted, storeCode: "123456", mode: "express", goodId: "new", offerId: "new", quantity: 1, fetchImpl: async () => { calls++; return response(cart([])); } }), (error) => error.code === "cart_reconciliation_required");
  assert.equal(calls, 2, "add's pre-read must not clear the ambiguity lock");
  await viewMagnitCart({ session: persisted, storeCode: "123456", mode: "express", saveSession: async (value) => { persisted = value; }, fetchImpl: async () => response(cart([])) });
  assert.equal(persisted.cartReconciliationRequired, false);
});

test("store/service mismatch and invalid quantity are rejected before fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(cart([])); };
  await assert.rejects(addMagnitCartItem({ session, storeCode: "123456", mode: "delivery", goodId: "x", offerId: "y", quantity: 1, fetchImpl }), /режим не совпадает/);
  await assert.rejects(addMagnitCartItem({ session, storeCode: "123456", mode: "express", goodId: "x", offerId: "y", quantity: 0, fetchImpl }));
  assert.equal(calls, 0);
});


test("HTTP 400 surfaces only safe upstream machine code, not server secrets or free-form messages", async () => {
  await assert.rejects(viewMagnitCart({
    session, storeCode: "123456", mode: "express",
    fetchImpl: async () => Response.json({ code: "INVALID_CONTEXT", message: "private-session-value" }, { status: 400 }),
  }), (error) => error.code === "upstream_error" && /HTTP 400, код: INVALID_CONTEXT/.test(error.message) && !error.message.includes("private-session-value"));
  await assert.rejects(viewMagnitCart({
    session, storeCode: "123456", mode: "express",
    fetchImpl: async () => Response.json({ code: "this-is-a-very-very-long-token:01234567890123456789012345678901234567890" }, { status: 400 }),
  }), (error) => error.code === "upstream_error" && error.message === "Запрос корзины отклонён (HTTP 400).");
});


test("browser-observed cart device headers and null permission marker are replayed", async () => {
  const observedSession = {
    cookie: session.cookie,
    context: { ...session.context, observedInBrowser: true, permissionsJwt: "null",
      deviceId: "synthetic-id", deviceTag: "synthetic-tag", appVersion: "2026.11.3-14.45",
      platformVersion: "Android Chrome 156", userAgent: "synthetic-user-agent" },
  };
  let headers;
  await viewMagnitCart({session: observedSession, storeCode: "123456", mode: "express", fetchImpl: async (_url, options) => {
    headers = options.headers;
    return response(cart([]));
  }});
  assert.equal(headers["x-device-id"], "synthetic-id");
  assert.equal(headers["x-device-tag"], "synthetic-tag");
  assert.equal(headers["x-app-version"], "2026.11.3-14.45");
  assert.equal(headers["x-platform-version"], "Android Chrome 156");
  assert.equal(headers["User-Agent"], "synthetic-user-agent");
  assert.equal(headers["x-permissions-jwt"], "null");
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers.Origin, undefined);
});


test("delivery cart uses dostavka headers and reads a different returned store safely", async () => {
  const sessionDelivery = { cookie: session.cookie, context: { ...session.context, service: "dostavka", storeCode: "992301" } };
  const delivery = {
    formats: [{ itemsCount: 2, service: "dostavka", storeCode: "992332" }],
    items: [
      { goodId: "milk", offerId: "milk-offer", goodService: "dostavka", qnty: 1, increment: { unit: "apiece", value: 1 } },
      { goodId: "bread", offerId: "bread-offer", goodService: "dostavka", goodStoreCode: "992332", qnty: 1 },
    ],
    totalBasePrice: 50000, totalFinalPrice: 48000, totalGoodsCount: 2,
  };
  let captured;
  const result = await viewMagnitCart({session:sessionDelivery,storeCode:"992301",mode:"delivery",fetchImpl:async (url,init)=>{
    captured={url,init}; return response(delivery);
  }});
  assert.equal(captured.init.method, "GET");
  assert.equal(captured.init.headers["x-service"], "dostavka");
  assert.equal(captured.init.headers["x-store-code"], "992301");
  assert.equal(result.cart_store_code, "992332");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].good_service, "dostavka");
  assert.equal(result.read_only, true);
  assert.equal(result.totals_lite.applies_to_selected_service, true);
});

test("mixed carts display only delivery items and cannot clear pending reconciliation", async () => {
  const sessionDelivery = { cookie: session.cookie, context: { ...session.context, service: "dostavka", storeCode: "992301" }, cartReconciliationRequired: true };
  const mixed = {
    formats: [
      { itemsCount: 2, service: "dostavka", storeCode: "992332" },
      { itemsCount: 1, service: "express", storeCode: "233826" },
    ],
    items: [
      { goodId: "delivery-one", offerId: "o1", goodService: "dostavka", qnty: 1 },
      { goodId: "express-one", offerId: "o2", goodService: "express", qnty: 1 },
      { goodId: "unknown", offerId: "o3", qnty: 1 },
    ], totalBasePrice: 1000, totalFinalPrice: 1000, totalGoodsCount: 3,
  };
  let reconciled=false, saved=false;
  const result=await viewMagnitCart({session:sessionDelivery,storeCode:"992301",mode:"delivery",
    fetchImpl:async()=>response(mixed), saveSession:async()=>{saved=true},
    operationStore:{ fingerprint:()=> "fake", reconcile:async()=>{reconciled=true} }});
  assert.deepEqual(result.items.map(x=>x.good_id), ["delivery-one"]);
  assert.equal(result.unattributed_items_count, 1);
  assert.equal(result.cart_context_status, "multiple_formats");
  assert.equal(result.read_only, true);
  assert.equal(result.totals_lite.applies_to_selected_service, false);
  assert.equal(reconciled,false);
  assert.equal(saved,false);
});

test("legacy unjournaled delivery add remains disabled before network access", async () => {
  const sessionDelivery = { cookie: session.cookie, context: { ...session.context, service: "dostavka", storeCode: "992301" } };
  let calls=0;
  await assert.rejects(addMagnitCartItem({session:sessionDelivery,storeCode:"992301",mode:"delivery",
    goodId:"milk",offerId:"milk",quantity:1,fetchImpl:async()=>{calls++;return response(cart([]))}}),
  (error)=>error.code==="unsupported_mode");
  assert.equal(calls,0);
});


test("guarded delivery add preserves existing items and verifies PUT with independent GET", async () => {
  const sessionDelivery={cookie:session.cookie,context:{...session.context,service:"dostavka",storeCode:"992301",observedInBrowser:true}};
  const format=(count)=>[{itemsCount:count,service:"dostavka",storeCode:"992332"}];
  const existing={goodId:"existing",offerId:"existing",qnty:2,goodService:"dostavka",increment:{unit:"apiece",value:1}};
  const added={goodId:"milk",offerId:"milk",qnty:1,goodService:"dostavka",goodStoreCode:"992332",increment:{unit:"apiece",value:1}};
  const before={items:[existing],formats:format(1)};
  const after={items:[existing,added],formats:format(2)};
  const calls=[];
  const receipt=[];
  const operationStore={
    fingerprint:()=> "fingerprint",
    inspect:async()=>({replay:false}),
    assertWritable:async ({storeCode})=>assert.equal(storeCode,"dostavka:992301"),
    begin:async ({storeCode})=>{assert.equal(storeCode,"dostavka:992301");receipt.push("begin")},
    finish:async ({status})=>receipt.push(status),
  };
  const result=await applyMagnitCart({session:sessionDelivery,storeCode:"992301",mode:"delivery",requestId:"request-delivery-001",
    operations:[{action:"add",good_id:"milk",offer_id:"milk",quantity:1}],
    operationStore,requireEligible:async()=>{},
    fetchImpl:async(_url,init)=>{
      calls.push(init);
      if(calls.length===1)return response(before);
      if(calls.length===2)return response(after);
      return response(after);
    }});
  assert.deepEqual(calls.map(x=>x.method),["GET","PUT","GET"]);
  assert.equal(calls[1].headers["x-service"],"dostavka");
  assert.deepEqual(JSON.parse(calls[1].body),{items:[{goodId:"existing",offerId:"existing",qnty:2},{goodId:"milk",offerId:"milk",qnty:1}]});
  assert.deepEqual(receipt,["begin","complete"]);
  assert.equal(result.mutation,"applied_and_verified");
  assert.equal(result.cart_store_code,"992332");
  assert.equal(result.read_only,false);
  assert.equal(result.items.length,2);
});

test("delivery response mismatch fails closed and leaves a journal marker", async () => {
  const delivery={cookie:session.cookie,context:{...session.context,service:"dostavka",storeCode:"992301",observedInBrowser:true}};
  const empty={items:[],formats:[{itemsCount:0,service:"dostavka",storeCode:"992332"}]};
  const after={items:[{goodId:"milk",offerId:"milk",qnty:1,goodService:"dostavka"}],formats:[{itemsCount:1,service:"dostavka",storeCode:"992332"}]};
  const statuses=[];let n=0;
  const operationStore={fingerprint:()=> "fake",inspect:async()=>({replay:false}),assertWritable:async()=>{},begin:async()=>{},finish:async ({status})=>statuses.push(status)};
  await assert.rejects(applyMagnitCart({session:delivery,storeCode:"992301",mode:"delivery",requestId:"request-delivery-002",
    operations:[{action:"add",good_id:"milk",offer_id:"milk",quantity:1}],operationStore,requireEligible:async()=>{},
    fetchImpl:async()=>{n++;return response(n===1?empty:n===2?after:empty)},
  }),(err)=>err.code==="ambiguous_result");
  assert.equal(n,3);
  assert.deepEqual(statuses,["ambiguous"]);
});

test("mixed-service delivery cart never sends PUT even if session is synchronized", async () => {
  const delivery={cookie:session.cookie,context:{...session.context,service:"dostavka",storeCode:"992301",observedInBrowser:true}};
  const mixed={items:[{goodId:"a",offerId:"a",qnty:1,goodService:"dostavka"},{goodId:"b",offerId:"b",qnty:1,goodService:"express"}],
    formats:[{service:"dostavka",storeCode:"992332",itemsCount:1},{service:"express",storeCode:"233826",itemsCount:1}]};
  let calls=0,started=false;
  await assert.rejects(applyMagnitCart({session:delivery,storeCode:"992301",mode:"delivery",requestId:"request-delivery-003",
    operations:[{action:"remove",good_id:"a",offer_id:"a"}],
    operationStore:{fingerprint:()=> "fake",inspect:async()=>({replay:false}),assertWritable:async()=>{},begin:async()=>{started=true}},
    fetchImpl:async()=>{calls++;return response(mixed)},
  }),(err)=>err.code==="cart_format_ambiguous");
  assert.equal(calls,1);
  assert.equal(started,false);
});


test("delivery apply rejects unsynced context before journal or network", async () => {
  const delivery={cookie:session.cookie,context:{...session.context,service:"dostavka",storeCode:"992301"}};
  let calls=0;
  await assert.rejects(applyMagnitCart({
    session:delivery,storeCode:"992301",mode:"delivery",requestId:"request-delivery-004",
    operations:[{action:"remove",good_id:"milk",offer_id:"milk"}],
    operationStore:{fingerprint:()=> "fake", inspect:async()=>{calls++;return {replay:false}}},
    fetchImpl:async()=>{calls++;return response(cart([]))}
  }),err=>err.code==="delivery_context_unverified");
  assert.equal(calls,0);
});

test("delivery remove preserves remaining items and verifies GET readback", async () => {
  const delivery={cookie:session.cookie,context:{...session.context,service:"dostavka",storeCode:"992301",observedInBrowser:true}};
  const base=(items)=>({items:items.map((i)=>({...i,goodService:"dostavka"})),
    formats:[{service:"dostavka",storeCode:"992332",itemsCount:items.length}]});
  const keep={goodId:"keep",offerId:"keep",qnty:1};
  const remove={goodId:"remove",offerId:"remove",qnty:2};
  const calls=[],statuses=[];
  const result=await applyMagnitCart({
    session:delivery,storeCode:"992301",mode:"delivery",requestId:"request-delivery-005",
    operations:[{action:"remove",good_id:"remove",offer_id:"remove"}],
    operationStore:{
      fingerprint:()=> "fake",inspect:async()=>({replay:false}),assertWritable:async()=>{},
      begin:async()=>{},finish:async({status})=>statuses.push(status)},
    fetchImpl:async(_url,init)=>{
      calls.push(init);
      return response(calls.length===1?base([keep,remove]):base([keep]));
    },
  });
  assert.deepEqual(calls.map(x=>x.method),["GET","PUT","GET"]);
  assert.deepEqual(JSON.parse(calls[1].body),{items:[{goodId:"keep",offerId:"keep",qnty:1}]});
  assert.equal(result.items.length,1);
  assert.deepEqual(statuses,["complete"]);
});


test("captured delivery behavior: omit zero lines while retaining gram-based weights in PUT", async () => {
  const delivery={cookie:session.cookie,context:{...session.context,service:"dostavka",storeCode:"992332",observedInBrowser:true}};
  const format=[{service:"dostavka",storeCode:"992332",itemsCount:3}];
  const milk={goodId:"milk",offerId:"milk",qnty:1,goodService:"dostavka",increment:{unit:"apiece",value:1}};
  const meat={goodId:"meat",offerId:"meat",qnty:600,goodService:"dostavka",increment:{unit:"weight",value:300}};
  const ghost={goodId:"ghost",offerId:"ghost",qnty:0,goodService:"dostavka",increment:{unit:"apiece",value:1}};
  const added={goodId:"new",offerId:"new",qnty:1,increment:{unit:"apiece",value:1}};
  const before={formats:format,items:[milk,meat,ghost]};
  const after={formats:format,items:[milk,meat,added]};
  const calls=[],statuses=[];
  const result=await applyMagnitCart({
    session:delivery,storeCode:"992332",mode:"delivery",requestId:"delivery-zero-ghost-test",
    operations:[{action:"add",good_id:"new",offer_id:"new",quantity:1}],
    requireEligible:async()=>{},
    operationStore:{fingerprint:()=> "fingerprint",inspect:async()=>({replay:false}),
      assertWritable:async()=>{},begin:async()=>{},finish:async({status})=>statuses.push(status)},
    fetchImpl:async(_url,init)=>{
      calls.push(init);return response(calls.length===1?before:after);
    },
  });
  assert.deepEqual(calls.map(x=>x.method),["GET","PUT","GET"]);
  assert.deepEqual(JSON.parse(calls[1].body),{items:[
    {goodId:"milk",offerId:"milk",qnty:1},
    {goodId:"meat",offerId:"meat",qnty:600},
    {goodId:"new",offerId:"new",qnty:1},
  ]});
  assert.deepEqual(statuses,["complete"]);
  assert.equal(result.cart_context_status,"single_format");
  assert.equal(result.read_only,false);
});
