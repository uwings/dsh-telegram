// Minimal fake Telegram Bot API server for end-to-end plugin tests.

import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.FAKE_PORT || 4767);

let pending = []; // queued updates
let waiters = []; // { offset, resolve }
let outbound = []; // recorded outgoing calls
let messageCounter = 100;

function pushUpdate(update) {
  console.log(`push id=${update.update_id} pending=${pending.length} waiters=${waiters.length}`);
  const waiter = waiters.find((w) => update.update_id >= w.offset);
  if (waiter) {
    waiters = waiters.filter((w) => w !== waiter);
    waiter.resolve([update]);
  } else {
    pending.push(update);
  }
}

function handleGetUpdates(query, res) {
  const offset = Number(query.get("offset") || 0);
  const timeout = Number(query.get("timeout") || 0);
  const ready = pending.filter((u) => u.update_id >= offset);
  pending = pending.filter((u) => u.update_id < offset);
  console.log(`getUpdates offset=${offset} ready=[${ready.map((u) => u.update_id).join(",")}] pending=${pending.length}`);
  if (ready.length > 0) {
    return json(res, { ok: true, result: ready });
  }
  if (timeout <= 0) {
    return json(res, { ok: true, result: [] });
  }
  const timer = setTimeout(() => {
    waiters = waiters.filter((w) => w.resolve !== settle);
    json(res, { ok: true, result: [] });
  }, Math.min(timeout, 30) * 1000);
  const settle = (updates) => {
    clearTimeout(timer);
    json(res, { ok: true, result: updates });
  };
  const waiter = { offset, resolve: settle };
  waiters.push(waiter);
  // A closed connection must not keep a waiter around: a later push would be
  // handed to the dead socket and silently lost (breaks restart tests).
  res.on("close", () => {
    clearTimeout(timer);
    waiters = waiters.filter((w) => w !== waiter);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (path === "/__push" && req.method === "POST") {
    readBody(req, (body) => {
      pushUpdate(JSON.parse(body));
      json(res, { ok: true });
    });
    return;
  }
  if (path === "/__reset" && req.method === "POST") {
    pending = [];
    outbound = [];
    waiters = [];
    json(res, { ok: true });
    return;
  }
  if (path === "/__out") {
    return json(res, { ok: true, result: outbound });
  }

  if (path.startsWith("/file/bot")) {
    const buffer = Buffer.from("fake-image-bytes");
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": buffer.length });
    res.end(buffer);
    return;
  }

  if (path.startsWith("/bot")) {
    const method = path.split("/").filter(Boolean)[1] || "";
    const isGet = req.method === "GET";
    if (method === "getUpdates" && isGet) return handleGetUpdates(url.searchParams, res);
    readBody(req, (raw) => {
      let payload = {};
      try {
        payload = raw ? JSON.parse(raw) : Object.fromEntries(url.searchParams);
      } catch {
        payload = {};
      }
      outbound.push({ method, payload, ts: Date.now() });
      if (method === "sendMessage" || method === "editMessageText" || method === "sendRichMessage") {
        return json(res, { ok: true, result: { message_id: ++messageCounter } });
      }
      if (method === "sendDocument" || method === "sendPhoto") {
        return json(res, { ok: true, result: { message_id: ++messageCounter, document: { file_id: "uploaded" } } });
      }
      if (method === "getFile") {
        return json(res, { ok: true, result: { file_id: payload.file_id, file_path: "photos/test.jpg", file_size: 16 } });
      }
      if (method === "setMessageReaction") {
        return json(res, { ok: true, result: true });
      }
      if (method === "sendMessageDraft" || method === "sendChatAction" || method === "setMyCommands") {
        return json(res, { ok: true, result: true });
      }
      if (method === "getMe") {
        return json(res, { ok: true, result: { id: 1, is_bot: true, first_name: "Test", username: "testbot" } });
      }
      json(res, { ok: false, description: `fake: unsupported method ${method}` });
    });
    return;
  }
  json(res, { ok: false, description: "not found" });
});

function json(res, body) {
  const text = JSON.stringify(body);
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req, done) {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => done(raw));
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake bot server on http://127.0.0.1:${PORT}`);
});
