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

import { Script } from "node:vm";

test("Express is the default mobile mode and embedded UI JavaScript parses", () => {
  // The inline HTML is a JSON-compatible quoted string in src/ui.js.
  const source = readFileSync(new URL("../src/ui.js", import.meta.url), "utf8");
  const match = source.match(/const page=("(?:\\.|[^"\\])*")\.replace\("__CSRF__",csrf\);/s);
  assert.ok(match, "inline page string must be present");
  const html = JSON.parse(match[1]);
  assert.match(html, /<option value="express" selected>Экспресс<\/option>/);
  assert.match(html, /<option value="delivery">Доставка<\/option>/);
  const js = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(js, "client script must be present");
  assert.doesNotThrow(() => new Script(js[1]));
  assert.match(js[1], /mode:selectedMode/);
});
