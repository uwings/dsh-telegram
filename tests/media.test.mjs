import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectMedia, extractDirectives, attachmentNote, safeFileName, humanBytes } from "../packages/dsh-telegram/lib/media.js";
import { TelegramBridge } from "../packages/dsh-telegram/lib/bridge.js";

test("detectMedia picks the largest photo", () => {
  const media = detectMedia({
    message_id: 7,
    photo: [
      { file_id: "small", width: 90, height: 90, file_size: 1000 },
      { file_id: "large", width: 1280, height: 720, file_size: 90000 },
    ],
  });
  assert.equal(media.kind, "photo");
  assert.equal(media.fileId, "large");
  assert.equal(media.mime, "image/jpeg");
  assert.equal(media.size, 90000);
});

test("detectMedia handles documents, voice and video", () => {
  const doc = detectMedia({ message_id: 1, document: { file_id: "d", file_name: "报告 final.pdf", mime_type: "application/pdf", file_size: 10 } });
  assert.equal(doc.kind, "document");
  assert.equal(doc.name, "报告 final.pdf");

  const voice = detectMedia({ message_id: 2, voice: { file_id: "v", duration: 3, file_size: 20 } });
  assert.equal(voice.kind, "voice");
  assert.equal(voice.mime, "audio/ogg");

  const video = detectMedia({ message_id: 3, video: { file_id: "m", duration: 5, mime_type: "video/mp4", file_size: 30 } });
  assert.equal(video.kind, "video");
});

test("detectMedia returns null for plain text", () => {
  assert.equal(detectMedia({ message_id: 1, text: "你好" }), null);
});

test("safeFileName strips separators and control characters", () => {
  assert.equal(safeFileName("a/b\\c:d*?.txt"), "a_b_c_d__.txt");
  assert.equal(safeFileName(""), "file");
  assert.equal(safeFileName("../../etc/passwd"), "_.._etc_passwd");
});

test("humanBytes formats", () => {
  assert.equal(humanBytes(512), "512 B");
  assert.equal(humanBytes(2048), "2.0 KB");
  assert.equal(humanBytes(3 * 1024 * 1024), "3.0 MB");
});

test("attachmentNote names the kind and the saved path", () => {
  const note = attachmentNote({ kind: "photo", name: "a.jpg", mime: "image/jpeg", size: 2048 }, "C:/x/a.jpg");
  assert.ok(note.includes("图片"));
  assert.ok(note.includes("C:/x/a.jpg"));
  assert.ok(note.includes("read_image"));
});

test("extractDirectives pulls file and photo markers out", () => {
  const { text, attachments } = extractDirectives("结果如下\n[[file:/tmp/a.txt|日志]]\n[[photo:/tmp/b.png]]");
  assert.ok(!text.includes("[[file:"));
  assert.ok(text.includes("结果如下"));
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].kind, "document");
  assert.equal(attachments[0].path, "/tmp/a.txt");
  assert.equal(attachments[0].caption, "日志");
  assert.equal(attachments[1].kind, "photo");
});

test("saveIncomingMedia downloads to the inbox and describes the file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-media-"));
  const bridge = Object.create(TelegramBridge.prototype);
  bridge.mediaDir = dir;
  bridge.config = { maxDownloadBytes: 1024 };
  bridge.log = () => {};
  bridge.api = {
    call: async (method, payload) => {
      assert.equal(method, "getFile");
      assert.equal(payload.file_id, "file-1");
      return { ok: true, result: { file_path: "photos/file_1.jpg" } };
    },
    download: async (filePath) => {
      assert.equal(filePath, "photos/file_1.jpg");
      return Buffer.from("image-bytes");
    },
  };

  const saved = await bridge.saveIncomingMedia("42", {
    kind: "photo",
    fileId: "file-1",
    name: "photo-9.jpg",
    mime: "image/jpeg",
    size: 0,
  });

  assert.ok(saved.path.endsWith("photo-9.jpg"));
  assert.ok(saved.note.includes(path.join(dir, "42")));
  const files = fs.readdirSync(path.join(dir, "42"));
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith("photo-9.jpg"));
  assert.equal(fs.readFileSync(path.join(dir, "42", files[0]), "utf-8"), "image-bytes");
});

test("saveIncomingMedia reports a failed download instead of throwing", async () => {
  const bridge = Object.create(TelegramBridge.prototype);
  bridge.mediaDir = os.tmpdir();
  bridge.config = {};
  bridge.log = () => {};
  bridge.api = {
    call: async () => ({ ok: false, description: "file is too big" }),
  };
  const saved = await bridge.saveIncomingMedia("42", { kind: "document", fileId: "x", name: "a.zip", mime: "application/zip", size: 1 });
  assert.equal(saved.path, "");
  assert.ok(saved.note.includes("下载失败"));
  assert.ok(saved.note.includes("file is too big"));
});

test("enqueueFinal strips directives, attaches files and quotes the user message", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-out-"));
  const file = path.join(dir, "report.txt");
  fs.writeFileSync(file, "hello");

  const enqueued = [];
  const bridge = Object.create(TelegramBridge.prototype);
  bridge.config = { maxMessageLength: 4096, entityBudget: 90, richMessages: false };
  bridge.sender = { enqueue: (chatId, item) => enqueued.push(item) };
  bridge.replyTo = new Map([["42", 99]]);
  bridge.useRichMessages = () => false;

  bridge.enqueueFinal("42", `报告写好了\n[[file:${file}|结果]]`);

  const textItem = enqueued.find((item) => item.kind === "send");
  assert.ok(textItem);
  assert.ok(!textItem.payload.text.includes("[[file:"));
  assert.equal(textItem.payload.replyToMessageId, 99);

  const fileItem = enqueued.find((item) => item.kind === "document");
  assert.ok(fileItem);
  assert.equal(fileItem.payload.path, file);
  assert.equal(fileItem.payload.caption, "结果");
});

test("enqueueFinal reports a missing attachment path", () => {
  const enqueued = [];
  const bridge = Object.create(TelegramBridge.prototype);
  bridge.config = { maxMessageLength: 4096, entityBudget: 90, richMessages: false };
  bridge.sender = { enqueue: (chatId, item) => enqueued.push(item) };
  bridge.replyTo = new Map();
  bridge.useRichMessages = () => false;
  bridge.enqueueFinal("42", `这里\n[[file:${path.join(os.tmpdir(), "nope-does-not-exist-xyz.txt")}]]`);
  assert.ok(enqueued.some((item) => String(item.payload?.text || "").includes("附件不存在")));
});
