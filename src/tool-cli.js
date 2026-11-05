import {runTool} from "./toolkit.js";
const [name,...values]=process.argv.slice(2);
const fields={
  status:[],search_products:["query","store_code","mode","limit"],list_categories:["store_code","mode"],
  product_details:["product_id","store_code"],shopping_context:[],order_history:["page","limit"],
  view_cart:["store_code","mode"],add_to_cart:["query","store_code","good_id","offer_id","quantity","request_id"],
  apply_cart:["store_code","operations","request_id"]
};
try{
  if(!Object.hasOwn(fields,name))throw Error("Unknown tool.");
  const args=Object.fromEntries(fields[name].map((field,i)=>{
    const v=values[i];
    return [field,field==="operations"?JSON.parse(v):["limit","page","quantity"].includes(field)?Number(v):v];
  }).filter(([,v])=>v!==undefined));
  console.log(JSON.stringify({ok:true,result:await runTool(name,args)}));
}catch(e){
  console.log(JSON.stringify({ok:false,error:{code:e.code||"tool_error",message:e.message||"Tool failed"}}));
  process.exitCode=1;
}
