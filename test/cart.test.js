import test from "node:test";
import assert from "node:assert/strict";
import { addMagnitCartItem, applyMagnitCart, viewMagnitCart, diagnoseMagnitCartHeaders, describeMagnitCartRequest } from "../src/cart.js";

const session = { cookie: "sid=synthetic-cookie", context: { service: "express", storeCode: "123456", bff: "synthetic-bff", permissionsJwt: null, observedInBrowser: true } };
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
  assert.equal(seen.init.headers["x-new-magnit"], undefined);
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
  assert.equal(calls[1].init.headers["x-new-magnit"], undefined);
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
  const sessionDelivery = { cookie: session.cookie, context: { ...session.context, service: "dostavka", storeCode: "992301", observedInBrowser: false } };
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
  const sessionDelivery = { cookie: session.cookie, context: { ...session.context, service: "dostavka", storeCode: "992301", observedInBrowser: false } };
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
  const delivery={cookie:session.cookie,context:{...session.context,service:"dostavka",storeCode:"992301",observedInBrowser:false}};
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


test("delivery HAR: preserve grams and omit zero-quantity ghost lines on PUT", async () => {
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


test("cart diagnostic distinguishes server-empty from filtered service and never returns raw secrets", async () => {
  const delivery={cookie:session.cookie,context:{...session.context,service:"dostavka",storeCode:"992301",observedInBrowser:false}};
  const empty=await viewMagnitCart({session:delivery,storeCode:"992301",mode:"delivery",fetchImpl:async()=>response({items:[],formats:[]})});
  assert.equal(empty.raw_item_count,0);
  assert.equal(empty.raw_format_count,0);
  assert.equal(empty.browser_context_verified,false);
  const mixed=await viewMagnitCart({session:delivery,storeCode:"992301",mode:"delivery",fetchImpl:async()=>response({
    formats:[{service:"express",storeCode:"233826",itemsCount:1}],
    items:[{goodId:"e1",offerId:"o1",qnty:1,goodService:"express"}],
  })});
  assert.equal(mixed.raw_item_count,1);
  assert.equal(mixed.items.length,0);
  assert.equal(mixed.excluded_other_service_count,1);
  assert.equal(mixed.cart_context_status,"selected_format_missing");
  assert.equal(JSON.stringify(mixed).includes(session.cookie),false);
});

test("delivery accepts successful GET despite extra unattributed lines in PUT response", async () => {
  const delivery = { cookie: session.cookie, context: { ...session.context, service: "dostavka", storeCode: "992332", observedInBrowser: true } };
  const item = { goodId: "milk", offerId: "milk", qnty: 1, goodService: "dostavka" };
  const formats = [{ service: "dostavka", storeCode: "992332", itemsCount: 1 }];
  const putResponse = {
    items: [item, { goodId: "unattributed", offerId: "unattributed", qnty: 1 }],
    formats,
  };
  const readback = { items: [item], formats };
  const calls = [], statuses = [];
  const result = await applyMagnitCart({
    session: delivery, storeCode: "992332", mode: "delivery", requestId: "delivery-put-extra-item",
    operations: [{ action: "add", good_id: "milk", offer_id: "milk", quantity: 1 }],
    operationStore: {
      fingerprint: () => "fingerprint", inspect: async () => ({ replay: false }),
      assertWritable: async () => {}, begin: async () => {}, finish: async ({ status }) => statuses.push(status),
    },
    requireEligible: async () => {},
    fetchImpl: async (_url, init) => {
      calls.push(init.method);
      return response(calls.length === 1 ? { items: [], formats: [] } :
        calls.length === 2 ? putResponse : readback);
    },
  });
  assert.deepEqual(calls, ["GET", "PUT", "GET"]);
  assert.deepEqual(statuses, ["complete"]);
  assert.equal(result.mutation, "applied_and_verified");
  assert.equal(result.items.length, 1);
});

test("delivery readback ignores only zero-quantity tombstones, never extra positive items", async () => {
  const delivery = { cookie: session.cookie, context: { ...session.context, service: "dostavka", storeCode: "992332", observedInBrowser: true } };
  const item = { goodId: "milk", offerId: "milk", qnty: 1, goodService: "dostavka" };
  const ghost = { goodId: "old-item", offerId: "old-item", qnty: 0, goodService: "dostavka" };
  const extra = { ...ghost, qnty: 1 };
  for (const scenario of [
    { name: "zero ghost", extra: ghost, expectedStatus: "complete" },
    { name: "positive unexpected item", extra, expectedStatus: "ambiguous" },
  ]) {
    let n = 0;
    const statuses = [];
    const resultOrError = applyMagnitCart({
      session: delivery, storeCode: "992332", mode: "delivery", requestId: "delivery-readback-" + scenario.name.replaceAll(" ", "-"),
      operations: [{ action: "add", good_id: "milk", offer_id: "milk", quantity: 1 }],
      operationStore: {
        fingerprint: () => "fingerprint", inspect: async () => ({ replay: false }),
        assertWritable: async () => {}, begin: async () => {}, finish: async ({ status }) => statuses.push(status),
      },
      requireEligible: async () => {},
      fetchImpl: async () => {
        n++;
        if (n === 1) return response({ items: [], formats: [] });
        if (n === 2) return response({ items: [item], formats: [{ service: "dostavka", storeCode: "992332", itemsCount: 1 }] });
        return response({ items: [item, scenario.extra], formats: [{ service: "dostavka", storeCode: "992332", itemsCount: scenario.expectedStatus === "complete" ? 1 : 2 }] });
      },
    });
    if (scenario.expectedStatus === "complete") {
      const result = await resultOrError;
      assert.equal(result.mutation, "applied_and_verified");
    } else {
      await assert.rejects(resultOrError, (error) => error.code === "ambiguous_result");
    }
    assert.equal(n, 3);
    assert.deepEqual(statuses, [scenario.expectedStatus], scenario.name);
  }
});


test("Express mutation requires a browser-verified exact request store", async () => {
  const unsynced = { cookie: session.cookie, context: { ...session.context, observedInBrowser: false } };
  let calls = 0;
  await assert.rejects(applyMagnitCart({
    session: unsynced, storeCode: "123456", mode: "express", requestId: "express-not-synced-001",
    operations: [{ action: "add", good_id: "milk", offer_id: "milk", quantity: 1 }],
    fetchImpl: async () => { calls++; return response(cart([])); },
  }), err => err.code === "express_context_unverified");
  assert.equal(calls, 0);
});

test("Express HAR: request store differs from format store, existing unlabeled line is retained, independent GET verifies", async () => {
  const express = { cookie: session.cookie, context: { ...session.context, storeCode: "233472", observedInBrowser: true } };
  const formats = [{ service: "express", storeCode: "230668", itemsCount: 2 }];
  const beforeItems = [
    { goodId: "3414400005", offerId: "3414400005", qnty: 800, goodService: "express" },
    { goodId: "1444500129", offerId: "1444500129", qnty: 1200, goodService: "express" },
    { goodId: "9039215501", offerId: "9039215501", qnty: 800 },
  ];
  const afterItems = [...beforeItems, { goodId: "milk", offerId: "milk", qnty: 1, goodService: "express" }];
  const calls = [], journal = [];
  const result = await applyMagnitCart({
    session: express, storeCode: "233472", mode: "express", requestId: "express-har-store-difference",
    operations: [{ action: "add", good_id: "milk", offer_id: "milk", quantity: 1 }],
    requireEligible: async () => {},
    operationStore: {
      fingerprint: () => "fake", inspect: async () => ({ replay: false }),
      assertWritable: async () => {}, begin: async () => {},
      finish: async ({ status }) => journal.push(status),
    },
    fetchImpl: async (_url, init) => {
      calls.push(init);
      assert.equal(init.headers["x-store-code"], "233472");
      assert.equal(init.headers["x-service"], "express");
      if (calls.length === 1) return response({ items: beforeItems, formats });
      if (calls.length === 2) {
        assert.deepEqual(JSON.parse(init.body), { items: [
          { goodId: "3414400005", offerId: "3414400005", qnty: 800 },
          { goodId: "1444500129", offerId: "1444500129", qnty: 1200 },
          { goodId: "9039215501", offerId: "9039215501", qnty: 800 },
          { goodId: "milk", offerId: "milk", qnty: 1 },
        ] });
        // A successful Express PUT can return a transient or incomplete shape.
        return response({ items: [...beforeItems], formats });
      }
      return response({ items: afterItems, formats: [{ ...formats[0], itemsCount: 3 }] });
    },
  });
  assert.deepEqual(calls.map(x => x.method), ["GET", "PUT", "GET"]);
  assert.deepEqual(journal, ["complete"]);
  assert.equal(result.mutation, "applied_and_verified");
  assert.equal(result.cart_store_code, "230668");
  assert.equal(result.request_store_code, "233472");
  assert.equal(result.items.length, 4);
});

test("Express readback mismatch remains ambiguous after PUT, never retries write", async () => {
  const formats = [{ service: "express", storeCode: "123456", itemsCount: 0 }];
  const calls = [], states = [];
  await assert.rejects(applyMagnitCart({
    session, storeCode: "123456", mode: "express", requestId: "express-no-readback-001",
    operations: [{ action: "add", good_id: "milk", offer_id: "milk", quantity: 1 }],
    requireEligible: async () => {},
    operationStore: {
      fingerprint: () => "fake", inspect: async () => ({ replay: false }),
      assertWritable: async () => {}, begin: async () => {},
      finish: async ({ status }) => states.push(status),
    },
    fetchImpl: async (_url, init) => { calls.push(init.method); return response({ items: [], formats }); },
  }), err => err.code === "ambiguous_result");
  assert.deepEqual(calls, ["GET", "PUT", "GET"]);
  assert.deepEqual(states, ["ambiguous"]);
});


test("GET header comparison is read-only and does not leak cookies or change cart", async () => {
  const calls = [];
  const data = {
    items: [{ goodId: "a", offerId: "a", qnty: 1 }],
    formats: [{ service: "express", storeCode: "230668", itemsCount: 1 }],
  };
  const out = await diagnoseMagnitCartHeaders({
    session: { cookie: "sid=synthetic", context: { service: "express", storeCode: "233472", bff: "1", observedInBrowser: true } },
    storeCode: "233472", mode: "express",
    fetchImpl: async (_url, options) => {
      calls.push(options);
      assert.equal(options.method, "GET");
      return response(calls.length === 1 ? { items: [{ goodId: "orphan", offerId: "orphan", qnty: 1 }], formats: [] } : data);
    },
  });
  assert.deepEqual(calls.map(x => x.method), ["GET", "GET"]);
  assert.equal(calls[0].headers["x-new-magnit"], "true");
  assert.equal(calls[1].headers["x-new-magnit"], undefined);
  assert.equal(calls[0].headers["x-service"], "express");
  assert.equal(calls[1].headers["x-store-code"], "233472");
  assert.equal(out.legacy.raw_item_count, 1);
  assert.equal(out.legacy.raw_format_count, 0);
  assert.equal(out.chrome_headers.raw_item_count, 1);
  assert.equal(out.chrome_headers.raw_format_count, 1);
  assert.equal(out.changes_written, false);
  assert.equal(JSON.stringify(out).includes("sid=synthetic"), false);
  assert.equal(JSON.stringify(out).includes("orphan"), false);
});

test("diagnostic GET errors do not throw, write or expose upstream content", async () => {
  let count = 0;
  const out = await diagnoseMagnitCartHeaders({
    session, storeCode: "123456", mode: "express",
    fetchImpl: async () => { count++; return response({ code: "serverError", message: "secret" }, 400); },
  });
  assert.equal(count, 2);
  assert.equal(out.legacy.ok, false);
  assert.equal(out.chrome_headers.ok, false);
  assert.equal(JSON.stringify(out).includes("secret"), false);
});


test("official Express HAR shape: 2 attributed and 3 unlabelled active lines remain visible", async () => {
  const observed={ cookie:"sid=synthetic", context:{service:"express",storeCode:"233472",bff:"synthetic",observedInBrowser:true}};
  const raw={
    formats:[{service:"express",storeCode:"233472",itemsCount:2}],
    items:[
      {goodId:"known-one",offerId:"known-one",qnty:800,goodService:"express",increment:{unit:"weight",value:100}},
      {goodId:"known-two",offerId:"known-two",qnty:1200,goodService:"express",increment:{unit:"weight",value:100}},
      {goodId:"unknown-one",offerId:"unknown-one",qnty:800},
      {goodId:"unknown-two",offerId:"unknown-two",qnty:1},
      {goodId:"unknown-three",offerId:"unknown-three",qnty:1},
    ],
  };
  let req;
  const view=await viewMagnitCart({session:observed,storeCode:"233472",mode:"express",
    fetchImpl:async (_url,init)=>{req=init;return response(raw);}});
  assert.equal(req.method,"GET");
  assert.equal(req.headers["x-new-magnit"],undefined);
  assert.equal(req.headers["x-service"],"express");
  assert.equal(req.headers["x-store-code"],"233472");
  assert.equal(view.raw_item_count,5);
  assert.equal(view.raw_format_count,1);
  assert.equal(view.selected_formats[0].items_count,2);
  assert.equal(view.items.length,5);
  assert.equal(view.items.filter(i=>i.good_service===null).length,3);
  assert.equal(view.read_only,false);
});


test("cart metadata never leaks cookies, token strings, bff or full user agent",()=>{
  const observed={cookie:"sid=very-private-cookie; other=very-secret",
    context:{service:"express",storeCode:"233472",bff:"must-not-appear",
      observedInBrowser:true,permissionsJwt:"TOKEN_MUST_NOT_APPEAR",
      deviceId:"secret-device-id",userAgent:"Android private-user-agent"}};
  const report=describeMagnitCartRequest(observed);
  assert.equal(report.cookie_count,2);
  assert.equal(report.user_agent_family,"android");
  assert.equal(report.permissions_kind,"token");
  assert.equal(report.header_names.includes("cookie"),true);
  for(const secret of ["very-private-cookie","very-secret","TOKEN_MUST_NOT_APPEAR","must-not-appear","secret-device-id","private-user-agent"]) {
    assert.equal(JSON.stringify(report).includes(secret),false);
  }
});
