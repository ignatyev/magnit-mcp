import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const manual=JSON.parse(readFileSync(new URL("../utcp-manual.json",import.meta.url)));
test("UTCP manual only uses CLI tools",()=>{
  assert.equal(manual.utcp_version,"1.0.0");
  assert(manual.tools.length>=7);
  for(const tool of manual.tools){
    assert.equal(tool.tool_call_template.call_template_type,"cli");
    assert.match(tool.tool_call_template.commands[0].command,/^node --env-file-if-exists=\.env src\/tool-cli\.js /);
  }
});
test("Tool names are unique",()=>{
  const names=manual.tools.map(x=>x.name);
  assert.equal(new Set(names).size,names.length);
});

test("one-click diagnostic journal summary is read-only and contains no request identifiers",async()=>{
  const {createCartOperationStore}=await import("../src/cart-operation-store.js");
  const {mkdtemp,rm}=await import("node:fs/promises");
  const {join}=await import("node:path");
  const {tmpdir}=await import("node:os");
  const folder=await mkdtemp(join(tmpdir(),"utcp-debug-test-"));
  try {
    const journal=createCartOperationStore({secret:"a synthetic test encryption secret 1234567890",
      filename:join(folder,"cart-operations.enc")});
    await journal.begin({requestId:"private-request-id",sessionFingerprint:"fingerprint",payloadHash:"hash",storeCode:"233472"});
    const out=await journal.summary({sessionFingerprint:"fingerprint",storeCode:"233472"});
    assert.deepEqual(out,{pending:1,ambiguous:0,complete:0,reconciled:0,write_blocked:true});
    assert.equal(JSON.stringify(out).includes("private-request-id"),false);
    const other=await journal.summary({sessionFingerprint:"fingerprint",storeCode:"230668"});
    assert.equal(other.pending,0);
    await journal.finish({requestId:"private-request-id",sessionFingerprint:"fingerprint",status:"ambiguous"});
    assert.equal((await journal.summary({sessionFingerprint:"fingerprint",storeCode:"233472"})).ambiguous,1);
  } finally {await rm(folder,{recursive:true,force:true})}
});
