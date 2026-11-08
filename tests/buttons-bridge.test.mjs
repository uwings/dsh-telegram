import test from "node:test";
import assert from "node:assert/strict";

import { TelegramBridge } from "../packages/dsh-telegram/lib/bridge.js";
import { ButtonRegistry } from "../packages/dsh-telegram/lib/buttons.js";

function stubBridge() {
  const bridge = Object.create(TelegramBridge.prototype);
  bridge.config = { maxMessageLength: 4096, entityBudget: 90, richMessages: false, allowAllUsers: true };
  bridge.log = () => {};
  bridge.sender = { enqueue: () => {} };
  bridge.replyTo = new Map();
  bridge.buttons = new ButtonRegistry();
  bridge.useRichMessages = () => false;
  return bridge;
}

test("enqueueFinal attaches a keyboard to the last chunk and strips the directive", () => {
  const bridge = stubBridge();
  const enqueued = [];
  bridge.sender.enqueue = (_chatId, item) => enqueued.push(item);

  bridge.enqueueFinal("42", "选一个\n[[buttons:继续=继续|状态=status]]");

  assert.equal(enqueued.length, 1);
  const payload = enqueued[0].payload;
  assert.ok(!payload.text.includes("[[buttons:"));
  assert.equal(payload.replyMarkup.inline_keyboard.length, 1);
  assert.equal(payload.replyMarkup.inline_keyboard[0].length, 2);
});

test("a tapped text button dispatches that text as the next user message", async () => {
  const bridge = stubBridge();
  const calls = [];
  const dispatched = [];
  bridge.api = {
    call: async (method, payload) => {
      calls.push({ method, payload });
      return { ok: true };
    },
  };
  bridge.dispatchText = async (chatId, text, replyTo) => dispatched.push({ chatId, text, replyTo });

  const data = bridge.buttons.put("42", "继续写");
  await bridge.handleCallbackQuery({
    id: "cb-1",
    data,
    from: { id: 7 },
    message: { message_id: 99, chat: { id: 42, type: "private" } },
  });

  assert.ok(calls.some((call) => call.method === "answerCallbackQuery"));
  assert.ok(calls.some((call) => call.method === "editMessageReplyMarkup"));
  assert.deepEqual(dispatched, [{ chatId: 42, text: "继续写", replyTo: 99 }]);
});

test("a built-in button action runs the command instead of a prompt", async () => {
  const bridge = stubBridge();
  let created = 0;
  const sent = [];
  bridge.api = { call: async () => ({ ok: true }) };
  bridge.newSession = async () => {
    created += 1;
  };
  bridge.sender.enqueue = (_chatId, item) => sent.push(item);

  const data = bridge.buttons.put("42", "new");
  await bridge.handleCallbackQuery({
    id: "cb-2",
    data,
    from: { id: 7 },
    message: { message_id: 100, chat: { id: 42, type: "private" } },
  });

  assert.equal(created, 1);
  assert.ok(sent.some((item) => item.payload.text.includes("已开新会话")));
});

test("a stale token answers with an explanation and does nothing", async () => {
  const bridge = stubBridge();
  const calls = [];
  bridge.api = {
    call: async (method, payload) => {
      calls.push({ method, payload });
      return { ok: true };
    },
  };
  bridge.dispatchText = async () => {
    throw new Error("should not dispatch");
  };

  await bridge.handleCallbackQuery({
    id: "cb-3",
    data: "b:doesnotexist",
    from: { id: 7 },
    message: { message_id: 101, chat: { id: 42, type: "private" } },
  });

  const answers = calls.filter((call) => call.method === "answerCallbackQuery");
  assert.ok(answers.some((call) => call.payload.text === "这个按钮已失效"));
});
