import test from "node:test";
import assert from "node:assert/strict";

import { TelegramBridge } from "../packages/dsh-telegram/lib/bridge.js";

function stubBridge(overrides = {}) {
  const bridge = Object.create(TelegramBridge.prototype);
  bridge.config = { model: "deepseek-flash", provider: "deepseek-account", streaming: "draft", richMessages: false, ...overrides.config };
  bridge.sender = { richDisabled: false };
  bridge.sessions = new Map([["42", {}]]);
  bridge.startedAt = Date.now() - 65_000;
  bridge.lastPollOk = Date.now() - 1_000;
  bridge.consecutiveErrors = 0;
  bridge.conflictSince = undefined;
  bridge.useRichMessages = () => false;
  bridge.log = () => {};
  bridge.whisper = { state: "unknown", model: "", device: "", error: "", at: 0 };
  bridge.checkWhisper = async () => {};
  return bridge;
}

test("status shows a ready whisper with model and device", () => {
  const bridge = stubBridge();
  bridge.whisper = { state: "ready", model: "large-v3", device: "cuda", error: "", at: Date.now() };
  const text = bridge.statusText();
  assert.ok(text.includes("语音：ready（large-v3/cuda）"), text);
});

test("status shows why whisper is unavailable", () => {
  const bridge = stubBridge();
  bridge.whisper = { state: "unavailable", model: "", device: "", error: "connect ECONNREFUSED", at: Date.now() };
  const text = bridge.statusText();
  assert.ok(text.includes("语音：unavailable（connect ECONNREFUSED）"), text);
});

test("status reports a disabled transcriber", () => {
  const bridge = stubBridge({ config: { voiceTranscribe: false } });
  assert.ok(bridge.statusText().includes("语音：关闭"));
});

test("a stale probe is refreshed in the background without blocking", () => {
  const bridge = stubBridge();
  let refreshed = 0;
  bridge.checkWhisper = async () => {
    refreshed += 1;
  };
  bridge.whisper = { state: "ready", model: "large-v3", device: "cuda", error: "", at: Date.now() - 60_000 };
  const text = bridge.statusText();
  assert.ok(text.includes("语音：ready"));
  assert.equal(refreshed, 1);
});
