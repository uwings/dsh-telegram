import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PKG = path.join(process.cwd(), "packages", "dsh-telegram");

function pluginSources() {
  const files = [path.join(PKG, "index.js")];
  for (const name of fs.readdirSync(path.join(PKG, "lib"))) {
    if (name.endsWith(".js")) files.push(path.join(PKG, "lib", name));
  }
  return files;
}

test("plugin sources contain no Windows-only paths or shells", () => {
  const drivePath = /(?:^|[\s"'(=,])[A-Za-z]:[\\/]/;
  for (const file of pluginSources()) {
    const raw = fs.readFileSync(file, "utf8");
    // Comments may document Windows deployment paths; only code matters here.
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const name = path.basename(file);
    assert.ok(!drivePath.test(text), `${name} hardcodes a drive path`);
    assert.ok(!/powershell|\.ps1\b|\.cmd\b/i.test(text), `${name} references a Windows shell`);
    assert.ok(!/USERPROFILE|LOCALAPPDATA/.test(text), `${name} reads a Windows-only env var`);
    assert.ok(!/process\.platform\s*===\s*["']win32["']/.test(text), `${name} branches on win32`);
  }
});

test("filesystem modules also import node:path", () => {
  for (const file of pluginSources()) {
    const text = fs.readFileSync(file, "utf8");
    const name = path.basename(file);
    if (!/from ["']node:fs["']/.test(text)) continue;
    assert.ok(/from ["']node:path["']/.test(text), `${name} touches fs without node:path`);
  }
});
