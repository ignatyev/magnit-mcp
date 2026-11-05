import { runTool } from "./toolkit.js";

const API = "https://api.github.com";
const CLAIM = "<!-- chrome-queue:claimed:v1 -->";
const RESULT = "<!-- chrome-queue:result:v1 -->";
const TOOLS = new Set(["browser_list_tabs","browser_open_tab","browser_navigate",
  "browser_inspect","browser_get_page_state","browser_click","browser_type",
  "browser_scroll","browser_wait_for"]);
const token = process.env.GITHUB_QUEUE_TOKEN || "";
const repo = process.env.GITHUB_QUEUE_REPO || "";
const hosts = String(process.env.BROWSER_QUEUE_ALLOWED_HOSTS || "").toLowerCase()
  .split(",").map(x=>x.trim()).filter(Boolean);
const once = process.argv.includes("--once");
let stopped = false;

function settings() {
  if (!/^[\w.-]{1,80}\/[\w.-]{1,100}$/.test(repo))
    throw Error("Set GITHUB_QUEUE_REPO=owner/private-repo in Termux .env.");
  if (token.length < 20) throw Error("Set GITHUB_QUEUE_TOKEN in local .env, not chat.");
  if (!hosts.length || hosts.length > 20 || hosts.some(h=>
    !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(h)))
    throw Error("Set BROWSER_QUEUE_ALLOWED_HOSTS (for example magnit.ru,vkusvill.ru,5ka.ru).");
}
async function github(method, path, data) {
  const r = await fetch(API + path, {
    method, redirect:"error",signal:AbortSignal.timeout(15000),
    headers:{Accept:"application/vnd.github+json",
      "X-GitHub-Api-Version":"2022-11-28",
      "User-Agent":"android-chrome-queue",
      Authorization:"Bearer "+token,
      ...(data===undefined?{}:{"Content-Type":"application/json"})},
    ...(data===undefined?{}:{body:JSON.stringify(data)}),
  });
  if (!r.ok) throw Error("GitHub HTTP "+r.status);
  if (r.status===204) return null;
  const body=await r.text();
  if (body.length>400000) throw Error("GitHub response too large.");
  return JSON.parse(body);
}
function onAllowlist(raw) {
  if (typeof raw!=="string" || raw.length>2048) return false;
  try {
    const u=new URL(raw),host=u.hostname.toLowerCase();
    return u.protocol==="https:" && !u.port && !u.username && !u.password &&
      hosts.some(h=>host===h || host.endsWith("."+h));
  } catch { return false; }
}
function redact(value) {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,"[email]")
    .replace(/(?:\+?7|8)[- ()]*\d{3}[- ()]*\d{3}[- ]*\d{2}[- ]*\d{2}\b/g,"[phone]")
    .replace(/\b(?:\d[ -]?){14,19}\b/g,"[number]");
}
function clean(value,depth=0) {
  if(depth>12)return null;
  if(typeof value==="string")return redact(value.slice(0,2200));
  if(value===null||typeof value==="boolean"||typeof value==="number")return value;
  if(Array.isArray(value))return value.slice(0,65).map(x=>clean(x,depth+1));
  if(value&&typeof value==="object")return Object.fromEntries(
    Object.entries(value).slice(0,70)
      .filter(([k])=>!/cookie|token|secret|password|authorization|credential|payment|card.number/i.test(k))
      .map(([k,v])=>[k,clean(v,depth+1)]));
  return null;
}
function parseTask(issue) {
  if(typeof issue.body!=="string"||issue.body.length>8000)return null;
  let task;try{task=JSON.parse(issue.body);}catch{return null;}
  if(task?.version!==1||!TOOLS.has(task.tool)||!task.args||
    typeof task.args!=="object"||Array.isArray(task.args))return null;
  return task;
}
async function perform(task) {
  if(["browser_open_tab","browser_navigate"].includes(task.tool)&&
    !onAllowlist(task.args.url))throw Error("Destination is not on shop allowlist.");
  if(task.tool==="browser_list_tabs") {
    const r=await runTool(task.tool,{});
    return {tabs:(r.tabs||[]).filter(t=>onAllowlist(t.url))};
  }
  if(task.tool!=="browser_open_tab"){
    const r=await runTool("browser_list_tabs",{});
    const tab=(r.tabs||[]).find(t=>t.tab_id===task.args.tab_id);
    if(!tab||!onAllowlist(tab.url))throw Error("Tab is not on shop allowlist.");
  }
  return runTool(task.tool,task.args);
}
async function comment(n,body) {
  await github("POST","/repos/"+repo+"/issues/"+n+"/comments",{body});
}
async function finish(n) {
  await github("PATCH","/repos/"+repo+"/issues/"+n,{state:"closed"});
}
async function handle(issue) {
  const n=issue.number;
  const comments=await github("GET","/repos/"+repo+"/issues/"+n+"/comments?per_page=100");
  if(comments.length >= 100) return false; // Too many comments: never risk replay.
  if(comments.some(c=>c.body?.includes(CLAIM))){
    if(comments.some(c=>c.body?.includes(RESULT)))await finish(n);
    return false; // Do not block later issues with an abandoned claimed job.
  }
  if(Date.now()-Date.parse(issue.created_at)>10*60_000){
    await comment(n,RESULT+"\nExpired without execution.");
    await finish(n);return true;
  }
  const task=parseTask(issue);
  if(!task){
    await comment(n,RESULT+"\nInvalid job JSON. Expected version/tool/args.");
    await finish(n);return true;
  }
  // Durable claim BEFORE any browser interaction prevents duplicate cart adds.
  await comment(n,CLAIM+"\nPhone accepted job; no automatic retries.");
  let out;
  try{out={ok:true,tool:task.tool,data:clean(await perform(task))};}
  catch(e){out={ok:false,tool:task.tool,error_code:
    typeof e?.code==="string"&&/^[\w-]{1,80}$/.test(e.code)?
      e.code:"browser_operation_failed",
    message:redact(String(e?.message||"Failed").slice(0,220))};}
  let payload=JSON.stringify(out);
  if(Buffer.byteLength(payload,"utf8")>10000)
    payload=JSON.stringify({ok:out.ok,tool:task.tool,truncated:true});
  await comment(n,RESULT+"\nJSON result:\n"+payload);
  await finish(n);
  console.log("Job #"+n+" processed: "+(out.ok?"ok":out.error_code));
  return true;
}
async function poll() {
  const issues=await github("GET","/repos/"+repo+
    "/issues?state=open&sort=created&direction=asc&per_page=20");
  for(const issue of issues){
    if(stopped)break;
    if(issue.pull_request || !issue.title?.startsWith("[browser-job]"))continue;
    if(await handle(issue)) break;
  }
}
async function main(){
  settings();
  const r=await github("GET","/repos/"+repo);
  if(r?.private!==true)throw Error("Queue repository must be PRIVATE. Refusing to start.");
  console.log("Connected to private queue "+repo+". Allowed shops: "+hosts.join(", "));
  console.log("Polling browser jobs; Ctrl+C to stop.");
  process.on("SIGINT",()=>{stopped=true;});
  process.on("SIGTERM",()=>{stopped=true;});
  do{
    try{await poll();}catch(e){console.error("Queue error: "+String(e.message||e).slice(0,160));}
    if(once||stopped)break;
    await new Promise(resolve=>setTimeout(resolve,6500));
  }while(!stopped);
}
main().catch(e=>{console.error(String(e.message||e).slice(0,220));process.exitCode=1;});
