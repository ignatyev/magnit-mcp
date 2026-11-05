import {runTool} from "./toolkit.js";
const [name,...values]=process.argv.slice(2);
const fields={
  status:[],search_products:["query","store_code","mode","limit"],list_categories:["store_code","mode"],
  product_details:["product_id","store_code"],shopping_context:[],order_history:["page","limit"],
  view_cart:["store_code","mode"],add_to_cart:["query","store_code","good_id","offer_id","quantity","request_id","mode"],
  apply_cart:["store_code","operations","request_id","mode"],
  browser_list_tabs:[],browser_open_tab:["url"],browser_navigate:["tab_id","url"],
  browser_inspect:["tab_id","limit"],browser_get_page_state:["tab_id"],
  browser_click:["tab_id","selector"],browser_type:["tab_id","selector","text","replace"],
  browser_scroll:["tab_id","x","y"],browser_wait_for:["tab_id","selector","timeout_ms"],
  browser_screenshot:["tab_id"]
};
try{
  if(!Object.hasOwn(fields,name))throw Error("Unknown tool.");
  const args=Object.fromEntries(fields[name].map((field,i)=>{
    const v=values[i];
    return [field,field==="operations"?JSON.parse(v):["limit","page","quantity","x","y","timeout_ms"].includes(field)?Number(v):field==="replace"?v!=="false":v];
  }).filter(([,v])=>v!==undefined));
  console.log(JSON.stringify({ok:true,result:await runTool(name,args)}));
}catch(e){
  console.log(JSON.stringify({ok:false,error:{code:e.code||"tool_error",message:e.message||"Tool failed"}}));
  process.exitCode=1;
}
