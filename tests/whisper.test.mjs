import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { transcribeFile, whisperHealth } from "../packages/dsh-telegram/lib/whisper.js";
import { TelegramBridge } from "../packages/dsh-telegram/lib/bridge.js";

function startFake({ status = 200, body = {} } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.push({ url: req.url, contentType: req.headers["content-type"] || "", body: raw });
      const payload = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen }));
  });
}

test("transcribeFile posts multipart and returns the transcript", async () => {
  const { server, port, seen } = await startFake({ body: { text: "你好世界", language: "zh", duration: 3.2 } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));
  const file = path.join(dir, "voice.ogg");
  fs.writeFileSync(file, "ogg-bytes");

  try {
    const result = await transcribeFile(file, { url: `http://127.0.0.1:${port}`, language: "zh" });
    assert.equal(result.text, "你好世界");
    assert.equal(result.duration, 3.2);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/transcribe");
    assert.ok(seen[0].contentType.startsWith("multipart/form-data"));
    assert.ok(seen[0].body.includes('name="audio"'));
    assert.ok(seen[0].body.includes('name="language"'));
  } finally {
    server.close();
  }
});

test("transcribeFile surfaces the service error", async () => {
  const { server, port } = await startFake({ status: 500, body: { error: "boom" } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));
  const file = path.join(dir, "voice.ogg");
  fs.writeFileSync(file, "x");
  try {
    await assert.rejects(() => transcribeFile(file, { url: `http://127.0.0.1:${port}` }), /boom/);
  } finally {
    server.close();
  }
});

test("whisperHealth reports the model", async () => {
  const { server, port } = await startFake({ body: { status: "ok", model: "large-v3", device: "cuda" } });
  try {
    const health = await whisperHealth({ url: `http://127.0.0.1:${port}` });
    assert.equal(health.model, "large-v3");
  } finally {
    server.close();
  }
});

test("bridge.transcribeMedia returns the text and falls back to empty on failure", async () => {
  const { server, port } = await startFake({ body: { text: "测试语音", language: "zh", duration: 1 } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));
  const file = path.join(dir, "voice.ogg");
  fs.writeFileSync(file, "x");

  const bridge = Object.create(TelegramBridge.prototype);
  bridge.config = { whisperUrl: `http://127.0.0.1:${port}`, whisperLanguage: "zh" };
  bridge.log = () => {};

  try {
    assert.equal(await bridge.transcribeMedia(file, { mime: "audio/ogg", duration: 1 }), "测试语音");
  } finally {
    server.close();
  }

  const down = Object.create(TelegramBridge.prototype);
  down.config = { whisperUrl: "http://127.0.0.1:9", whisperTimeoutMs: 500 };
  down.log = () => {};
  assert.equal(await down.transcribeMedia(file, { mime: "audio/ogg" }), "");
});
