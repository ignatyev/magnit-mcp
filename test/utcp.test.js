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
