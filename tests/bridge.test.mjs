// Bridge-level tests: real TelegramBridge + fake Bot API + fake agent context.
// Runs without the DSH runtime, so it is fast and works under the file sandbox.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { TelegramBridge } from "../packages/dsh-telegram/lib/bridge.js";

const BOT_TOKEN = "123456:TESTTOKEN";

function startFakeApi({ failDraft = false, conflictPolls = 0 } = {}) {
  const state = {
    updates: [],
    waiters: [],
    out: [],
    nextMessageId: 500,
    failDraft,
    draftFailures: 0,
    conflictPolls,
  };

  const json = (res, body, status = 200) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const method = url.pathname.split("/").filter(Boolean)[1] || "";
    const isGet = req.method === "GET";

    if (method === "getUpdates" && isGet) {
      if (state.conflictPolls > 0) {
        state.conflictPolls -= 1;
        return json(res, {
          ok: false,
          error_code: 409,
          description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
        });
      }
      const offset = Number(url.searchParams.get("offset") || 0);
      const ready = state.updates.filter((u) => u.update_id >= offset);
      state.updates = state.updates.filter((u) => u.update_id < offset);
      if (ready.length > 0) return json(res, { ok: true, result: ready });
      const waiter = {
        offset,
        res,
        timer: setTimeout(() => {
          state.waiters = state.waiters.filter((w) => w !== waiter);
          json(res, { ok: true, result: [] });
        }, 300),
      };
      state.waiters.push(waiter);
      return;
    }

    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let payload = {};
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        payload = {};
      }
      state.out.push({ method, payload, ts: Date.now() });

      if (method === "getMe") {
        return json(res, { ok: true, result: { id: 1, is_bot: true, first_name: "Test", username: "testbot" } });
      }
      if (method === "sendMessageDraft") {
        if (state.failDraft) {
          state.draftFailures += 1;
          return json(res, { ok: false, error_code: 400, description: "Bad Request: method not found" });
        }
        return json(res, { ok: true, result: true });
      }
      if (method === "sendMessage" || method === "editMessageText") {
        return json(res, { ok: true, result: { message_id: ++state.nextMessageId } });
      }
      if (method === "setMyCommands" || method === "sendChatAction") {
        return json(res, { ok: true, result: true });
      }
      return json(res, { ok: false, error_code: 400, description: `unsupported ${method}` });
    });
  });

  state.push = (update) => {
    state.updates.push(update);
    const waiter = state.waiters.find((w) => update.update_id >= w.offset);
    if (!waiter) return;
    state.waiters = state.waiters.filter((w) => w !== waiter);
    clearTimeout(waiter.timer);
    const offset = waiter.offset;
    const ready = state.updates.filter((u) => u.update_id >= offset);
    state.updates = state.updates.filter((u) => u.update_id < offset);
    json(waiter.res, { ok: true, result: ready });
  };

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      state.port = server.address().port;
      state.close = () => new Promise((done) => server.close(done));
      resolve(state);
    });
  });
}

function makeFakeCtx({ resumable = new Set() } = {}) {
  const agents = new Map();
  const handlers = new Map();
  const makeAgent = (sessionId) => ({
    sessionId,
    followups: [],
    cancelCalls: [],
    followup(message) {
      this.followups.push(message);
    },
    cancel(reason) {
      this.cancelCalls.push(reason);
      return Promise.resolve({ ok: true });
    },
  });
  const ctx = {
    agents: {
      async create({ sessionId }) {
        const agent = makeAgent(sessionId);
        agents.set(sessionId, agent);
        return { agent, dispose: async () => {} };
      },
      async resume({ resumeSessionId, sessionId } = {}) {
        const id = resumeSessionId ?? sessionId;
        if (resumable.has(id)) {
          const agent = makeAgent(id);
          agents.set(id, agent);
          return { agent, dispose: async () => {} };
        }
        throw new Error("no persisted session");
      },
      get(sessionId) {
        return agents.get(sessionId);
      },
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    emit(event, ...args) {
      for (const handler of handlers.get(event) || []) handler(...args);
    },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    },
  };
  return { ctx, agents };
}

async function until(predicate, { timeout = 8000, label = "condition" } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function sentTexts(state) {
  return state.out.filter((item) => item.method === "sendMessage").map((item) => String(item.payload.text || ""));
}

test("telegram bridge behaviors", async (t) => {
  const api = await startFakeApi();
  const { ctx, agents } = makeFakeCtx();
  const state = { schemaVersion: 1, chats: {}, offset: 0, outbox: [] };
  const logs = [];
  const bridge = new TelegramBridge(
    ctx,
    {
      token: BOT_TOKEN,
      baseUrl: `http://127.0.0.1:${api.port}`,
      allowedUserIds: [7],
      provider: "deepseek-account",
      model: "deepseek-flash",
      streaming: "draft",
      pollingTimeoutSec: 1,
      sendSpacingMs: 1,
      startupMessage: false,
      backoffMs: [10, 20, 40],
    },
    state,
    (line) => logs.push(line)
  );

  const stop = bridge.start();
  t.after(async () => {
    await bridge.stop();
    if (typeof stop === "function") await stop();
    await api.close();
  });

  await until(() => api.out.some((item) => item.method === "getMe"), { label: "getMe" });

  await t.test("denies a chat that is not allowlisted", async () => {
    api.push({
      update_id: 1,
      message: { message_id: 1, chat: { id: 99, type: "private" }, from: { id: 99, is_bot: false }, text: "hi" },
    });
    await until(() => sentTexts(api).some((text) => text.includes("Access denied")), { label: "denial" });
  });

  await t.test("runs a turn and sends the final assistant text", async () => {
    api.push({
      update_id: 2,
      message: { message_id: 2, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "在吗" },
    });

    await until(() => [...agents.values()].some((agent) => agent.followups.length === 1), { label: "followup" });
    const [sessionId, agent] = [...agents.entries()][0];
    assert.equal(agent.followups[0].content[0].text, "在吗");

    const attemptId = `${sessionId}:0`;
    ctx.emit("agent/assistant-stream", { frame: { type: "start", attemptId, turn: 1 } });
    ctx.emit("agent/assistant-stream", { frame: { type: "chunk", attemptId, chunk: "pong 通过" } });
    ctx.emit("agent/assistant-stream", { frame: { type: "end", attemptId, outcome: { kind: "committed" } } });
    ctx.emit(
      "session/event",
      { sessionId },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "pong 通过" }] } } }
    );
    ctx.emit("session/event", { sessionId }, { type: "turn/end", data: { reason: { kind: "completed" } } });

    await until(() => sentTexts(api).some((text) => text.includes("pong 通过")), { label: "final reply" });
    assert.ok(api.out.some((item) => item.method === "sendMessageDraft"), "expected at least one draft frame");
  });

  await t.test("/stop cancels the live turn", async () => {
    api.push({
      update_id: 3,
      message: { message_id: 3, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "接着说" },
    });
    await until(() => [...agents.values()][0].followups.length === 2, { label: "second followup" });

    const [sessionId, agent] = [...agents.entries()][0];
    const attemptId = `${sessionId}:1`;
    ctx.emit("agent/assistant-stream", { frame: { type: "start", attemptId, turn: 2 } });
    ctx.emit("agent/assistant-stream", { frame: { type: "chunk", attemptId, chunk: "说到一半" } });
    await until(() => api.out.some((item) => item.method === "sendMessageDraft" && String(item.payload.text).includes("说到一半")), {
      label: "live draft",
    });

    api.push({
      update_id: 4,
      message: { message_id: 4, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "/stop" },
    });
    await until(() => agent.cancelCalls.length > 0, { label: "cancel" });
    assert.equal(agent.cancelCalls.length, 1);
    await until(() => sentTexts(api).some((text) => text.includes("已停止")), { label: "stop notice" });

    ctx.emit("session/event", { sessionId }, { type: "turn/end", data: { reason: { kind: "cancelled" } } });
  });

  await t.test("/status reports liveness", async () => {
    api.push({
      update_id: 5,
      message: { message_id: 5, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "/status" },
    });
    await until(() => sentTexts(api).some((text) => text.includes("在线")), { label: "status" });
  });

  await t.test("turn errors surface a user-facing message", async () => {
    api.push({
      update_id: 6,
      message: { message_id: 6, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "再来" },
    });
    await until(() => [...agents.values()][0].followups.length === 3, { label: "third followup" });
    const [sessionId] = [...agents.entries()][0];
    ctx.emit("session/event", { sessionId }, { type: "turn/end", data: { reason: { kind: "error", error: { message: "boom" } } } });
    await until(() => sentTexts(api).some((text) => text.includes("本轮出错")), { label: "error notice" });
  });
});

test("draft rejection falls back to editing a real message", async (t) => {
  const api = await startFakeApi({ failDraft: true });
  const { ctx, agents } = makeFakeCtx();
  const state = { schemaVersion: 1, chats: {}, offset: 0, outbox: [] };
  const bridge = new TelegramBridge(
    ctx,
    {
      token: BOT_TOKEN,
      baseUrl: `http://127.0.0.1:${api.port}`,
      allowedUserIds: [7],
      provider: "deepseek-account",
      model: "deepseek-flash",
      streaming: "draft",
      pollingTimeoutSec: 1,
      sendSpacingMs: 1,
      startupMessage: false,
      backoffMs: [10, 20, 40],
    },
    state,
    () => {}
  );

  const stop = bridge.start();
  t.after(async () => {
    await bridge.stop();
    if (typeof stop === "function") await stop();
    await api.close();
  });

  await until(() => api.out.some((item) => item.method === "getMe"), { label: "getMe" });

  api.push({
    update_id: 1,
    message: { message_id: 1, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "画个图" },
  });
  await until(() => [...agents.values()].some((agent) => agent.followups.length === 1), { label: "followup" });

  const [sessionId] = [...agents.entries()][0];
  const attemptId = `${sessionId}:0`;
  ctx.emit("agent/assistant-stream", { frame: { type: "start", attemptId, turn: 1 } });
  ctx.emit("agent/assistant-stream", { frame: { type: "chunk", attemptId, chunk: "第一段" } });

  await until(() => api.draftFailures > 0, { label: "draft rejection" });
  await until(
    () => api.out.some((item) => item.method === "editMessageText" && String(item.payload.text || "").includes("第一段")),
    { label: "edit fallback update" }
  );

  ctx.emit(
    "session/event",
    { sessionId },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "第一段 第二段" }] } } }
  );
  ctx.emit("session/event", { sessionId }, { type: "turn/end", data: { reason: { kind: "completed" } } });

  await until(
    () => api.out.some((item) => item.method === "editMessageText" && String(item.payload.text).includes("第二段")),
    { label: "final edit" }
  );
});

test("409 conflict is reported and polling recovers", async (t) => {
  const api = await startFakeApi({ conflictPolls: 2 });
  const { ctx } = makeFakeCtx();
  const state = { schemaVersion: 1, chats: {}, offset: 0, outbox: [] };
  const logs = [];
  const bridge = new TelegramBridge(
    ctx,
    {
      token: BOT_TOKEN,
      baseUrl: `http://127.0.0.1:${api.port}`,
      allowedUserIds: [7],
      provider: "deepseek-account",
      model: "deepseek-flash",
      streaming: "draft",
      pollingTimeoutSec: 1,
      sendSpacingMs: 1,
      startupMessage: false,
      backoffMs: [50, 100, 200],
    },
    state,
    (line) => logs.push(line)
  );

  const stop = bridge.start();
  t.after(async () => {
    await bridge.stop();
    if (typeof stop === "function") await stop();
    await api.close();
  });

  await until(() => logs.some((line) => line.includes("409 Conflict")), { label: "conflict notice", timeout: 8000 });
  await until(() => logs.some((line) => line.includes("polling recovered")), { label: "recovery notice", timeout: 10000 });

  api.push({
    update_id: 1,
    message: { message_id: 1, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "/status" },
  });
  await until(() => sentTexts(api).some((text) => text.includes("在线")), { label: "status after recovery", timeout: 8000 });
});

test("native Stop (stopped_message_generation) cancels without a duplicate final message", async (t) => {
  const api = await startFakeApi();
  const { ctx, agents } = makeFakeCtx();
  const state = { schemaVersion: 1, chats: {}, offset: 0, outbox: [] };
  const bridge = new TelegramBridge(
    ctx,
    {
      token: BOT_TOKEN,
      baseUrl: `http://127.0.0.1:${api.port}`,
      allowedUserIds: [7],
      provider: "deepseek-account",
      model: "deepseek-flash",
      streaming: "draft",
      pollingTimeoutSec: 1,
      sendSpacingMs: 1,
      startupMessage: false,
      backoffMs: [50, 100, 200],
    },
    state,
    () => {}
  );

  const stop = bridge.start();
  t.after(async () => {
    await bridge.stop();
    if (typeof stop === "function") await stop();
    await api.close();
  });

  await until(() => api.out.some((item) => item.method === "getMe"), { label: "getMe" });

  api.push({
    update_id: 1,
    message: { message_id: 1, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "写长文" },
  });
  await until(() => [...agents.values()].some((agent) => agent.followups.length === 1), { label: "followup" });

  const [sessionId, agent] = [...agents.entries()][0];
  const attemptId = `${sessionId}:0`;
  ctx.emit("agent/assistant-stream", { frame: { type: "start", attemptId, turn: 1 } });

  await until(() => api.out.some((item) => item.method === "sendMessageDraft"), { label: "draft frame" });
  const draft = api.out.filter((item) => item.method === "sendMessageDraft").at(-1);
  const draftId = draft.payload.draft_id;

  ctx.emit("agent/assistant-stream", { frame: { type: "chunk", attemptId, chunk: { type: "text-delta", index: 0, text: "已经写了一半" } } });

  api.push({ update_id: 2, stopped_message_generation: { chat: { id: 7, type: "private" }, draft_id: draftId } });

  await until(() => agent.cancelCalls.length === 1, { label: "cancel" });
  await until(
    () => sentTexts(api).some((text) => text.includes("已停止") && text.includes("已经写了一半")),
    { label: "stop partial" }
  );

  const countAfterStop = sentTexts(api).length;
  ctx.emit(
    "session/event",
    { sessionId },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "已经写了一半，完整版应该更长" }] } } }
  );
  ctx.emit("session/event", { sessionId }, { type: "turn/end", data: { reason: { kind: "aborted", reason: { kind: "user" } } } });

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(sentTexts(api).length, countAfterStop, "no duplicate final message after cancel");
});

test("resumes a persisted session instead of creating a new one", async (t) => {
  const api = await startFakeApi();
  const { ctx, agents } = makeFakeCtx({ resumable: new Set(["tg-7-old"]) });
  const state = { schemaVersion: 1, chats: { 7: { sessionId: "tg-7-old" } }, offset: 0, outbox: [] };
  const bridge = new TelegramBridge(
    ctx,
    {
      token: BOT_TOKEN,
      baseUrl: `http://127.0.0.1:${api.port}`,
      allowedUserIds: [7],
      provider: "deepseek-account",
      model: "deepseek-flash",
      streaming: "draft",
      pollingTimeoutSec: 1,
      sendSpacingMs: 1,
      startupMessage: false,
      backoffMs: [50, 100, 200],
    },
    state,
    () => {}
  );

  const stop = bridge.start();
  t.after(async () => {
    await bridge.stop();
    if (typeof stop === "function") await stop();
    await api.close();
  });

  await until(() => api.out.some((item) => item.method === "getMe"), { label: "getMe" });

  api.push({
    update_id: 1,
    message: { message_id: 1, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "继续" },
  });

  await until(() => agents.get("tg-7-old")?.followups.length === 1, { label: "resumed followup" });
  assert.deepEqual([...agents.keys()], ["tg-7-old"], "no new session should be created");
  assert.equal(state.chats[7].sessionId, "tg-7-old");
});
