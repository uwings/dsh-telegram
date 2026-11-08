import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Sender } from "../packages/dsh-telegram/lib/sender.js";

function makeSender(handler) {
  const calls = [];
  const api = {
    call: async (method, payload) => {
      calls.push({ method, payload });
      return handler(method, payload);
    },
  };
  const state = { outbox: [] };
  const logs = [];
  const sender = new Sender(api, state, { retryMax: 1, backoffMs: [1], sendSpacingMs: 0 }, (line) => logs.push(line));
  return { sender, calls, state, logs };
}

test("rich messages are sent through sendRichMessage", async () => {
  const { sender, calls } = makeSender(() => ({ ok: true, result: { message_id: 1 } }));
  const outcome = await sender.enqueue("42", { kind: "rich", payload: { chatId: "42", markdown: "## hi", fallbackHtml: "<b>hi</b>" } });
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendRichMessage");
  assert.deepEqual(calls[0].payload.rich_message, { markdown: "## hi" });
});

test("a rejected rich message falls back to the HTML payload once", async () => {
  const { sender, calls, logs } = makeSender((method) =>
    method === "sendRichMessage"
      ? { ok: false, error_code: 400, description: "Bad Request: can't parse rich message" }
      : { ok: true, result: { message_id: 2 } }
  );
  const outcome = await sender.enqueue("42", {
    kind: "rich",
    payload: { chatId: "42", markdown: "## hi", fallbackHtml: "<b>hi</b>" },
  });
  assert.equal(outcome.ok, true);
  const methods = calls.map((call) => call.method);
  assert.deepEqual(methods, ["sendRichMessage", "sendMessage"]);
  assert.equal(calls[1].payload.parse_mode, "HTML");
  assert.equal(calls[1].payload.text, "<b>hi</b>");
  assert.ok(logs.some((line) => line.includes("HTML fallback")));
});

test("an unknown sendRichMessage method disables rich for the process", async () => {
  const { sender, calls } = makeSender((method) =>
    method === "sendRichMessage"
      ? { ok: false, error_code: 404, description: "Not Found: method not found" }
      : { ok: true, result: { message_id: 3 } }
  );
  await sender.enqueue("42", { kind: "rich", payload: { chatId: "42", markdown: "x", fallbackHtml: "x" } });
  assert.equal(sender.richDisabled, true);
  assert.equal(calls.at(-1).method, "sendMessage");
});

test("drafts carry plain text and can ask for a stop button", async () => {
  const { sender, calls } = makeSender(() => ({ ok: true, result: true }));
  await sender.enqueue("42", { kind: "draft", payload: { chatId: "42", draftId: 7, text: "普通文本", canStop: true } });
  assert.equal(calls[0].method, "sendMessageDraft");
  assert.equal(calls[0].payload.text, "普通文本");
  assert.equal(calls[0].payload.can_stop, true);
});

test("reply_to is forwarded for plain sends", async () => {
  const { sender, calls } = makeSender(() => ({ ok: true, result: { message_id: 4 } }));
  await sender.enqueue("42", { kind: "send", payload: { chatId: "42", text: "hi", replyToMessageId: 99 } });
  assert.deepEqual(calls[0].payload.reply_parameters, { message_id: 99, allow_sending_without_reply: true });
});

test("documents go through multipart upload", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-send-"));
  const file = path.join(dir, "report.txt");
  fs.writeFileSync(file, "hello");

  const uploads = [];
  const api = {
    call: async () => ({ ok: true, result: { message_id: 1 } }),
    upload: async (method, fields, fileInfo) => {
      uploads.push({ method, fields, fileInfo });
      return { ok: true, result: { message_id: 2 } };
    },
  };
  const sender = new Sender(api, { outbox: [] }, { retryMax: 1, backoffMs: [1], sendSpacingMs: 0 }, () => {});
  const outcome = await sender.enqueue("42", {
    kind: "document",
    payload: { chatId: "42", path: file, caption: "报告", replyToMessageId: 7 },
  });

  assert.equal(outcome.ok, true);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].method, "sendDocument");
  assert.equal(uploads[0].fields.chat_id, "42");
  assert.equal(uploads[0].fields.caption, "报告");
  assert.equal(uploads[0].fileInfo.field, "document");
  assert.equal(uploads[0].fileInfo.filename, "report.txt");
  assert.ok(String(uploads[0].fields.reply_parameters).includes("\"message_id\":7"));
});

test("photos go through sendPhoto", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-send-"));
  const file = path.join(dir, "shot.png");
  fs.writeFileSync(file, "png");

  let method = "";
  const api = {
    call: async () => ({ ok: true }),
    upload: async (name) => {
      method = name;
      return { ok: true, result: { message_id: 3 } };
    },
  };
  const sender = new Sender(api, { outbox: [] }, { retryMax: 1, backoffMs: [1], sendSpacingMs: 0 }, () => {});
  await sender.enqueue("42", { kind: "photo", payload: { chatId: "42", path: file } });
  assert.equal(method, "sendPhoto");
});

test("a missing attachment is dropped without uploading", async () => {
  let uploads = 0;
  const api = {
    call: async () => ({ ok: true }),
    upload: async () => {
      uploads += 1;
      return { ok: true };
    },
  };
  const sender = new Sender(api, { outbox: [] }, { retryMax: 1, backoffMs: [1], sendSpacingMs: 0 }, () => {});
  const outcome = await sender.enqueue("42", {
    kind: "document",
    payload: { chatId: "42", path: path.join(os.tmpdir(), "definitely-missing-xyz.bin") },
  });
  assert.equal(outcome.dropped, true);
  assert.equal(uploads, 0);
});

test("attachments are persisted for replay", () => {
  const state = { outbox: [] };
  const sender = new Sender({ call: async () => ({ ok: true }) }, state, {}, () => {});
  sender.queues.set("42", [
    { id: "1", chatId: "42", kind: "document", payload: { chatId: "42", path: "C:/x.pdf" }, attempts: 0, nextTryAt: 0, resolve: () => {} },
  ]);
  sender.persist();
  assert.equal(state.outbox.length, 1);
  assert.equal(state.outbox[0].kind, "document");
});
