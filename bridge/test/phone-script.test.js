import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("embedded phone client script parses independently", async () => {
  const source = await readFile(new URL("../src/phone-page.js", import.meta.url), "utf8");
  const script = source.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, "phone client script is present");
  assert.doesNotThrow(() => new vm.Script(script[1], { filename: "phone-client.js" }));
  assert.doesNotMatch(script[1], /\.innerHTML\s*=/, "untrusted catalog text must not enter innerHTML");
});
