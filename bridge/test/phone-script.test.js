import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("embedded phone client script parses independently", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const html = source.match(/const PHONE_HTML = `([\s\S]*?)`;\n\nfunction originMatches/);
  assert.ok(html, "phone HTML template is present");
  const script = html[1].match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, "phone client script is present");
  assert.doesNotThrow(() => new vm.Script(script[1], { filename: "phone-client.js" }));
  assert.doesNotMatch(script[1], /\.innerHTML\s*=/, "untrusted catalog text must not enter innerHTML");
});
