// Core bridge: Telegram long-polling ↔ DeepSeek Harness agents.

import { request } from "./proxy-fetch.js";
import { ProxyPool } from "./proxy-pool.js";
import { chunkText, splitMessage, splitRichWithFallback, toPlainText } from "./format.js";
import { Sender } from "./sender.js";
import { attachmentNote, detectMedia, extensionFor, extractDirectives, safeFileName } from "./media.js";
import { buildKeyboard, ButtonRegistry, parseButtonsDirective } from "./buttons.js";
import { transcribeFile, whisperHealth } from "./whisper.js";
import { inspect } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const POLL_ERR_CAP_MS = 30000;

export class TelegramBridge {
  constructor(ctx, config, state, log) {
    this.ctx = ctx;
    this.config = config;
    this.state = state;
    this.log = log;
    this.api = new TelegramApi(config, log);
    this.sender = new Sender(this.api, state, config, log);
    this.sender.onPermanent = (entry, outcome) => {
      if (entry.kind !== "draft") return;
      this.log(`telegram: sendMessageDraft rejected (${outcome.error}); falling back to edit streaming`);
      this.config.streaming = "edit";
      for (const live of this.bySession.values()) {
        if (live && !live.editMessageId && !live.editPending) this.beginEditStream(live);
      }
    };
    this.sessions = new Map(); // chatKey -> { sessionId, handle }
    this.bySession = new Map(); // sessionId -> { chatKey, draftId, streamText, lastAssistant, turn }
    this.replyTo = new Map(); // chatKey -> message_id of the turn being answered
    this.buttons = new ButtonRegistry();
    this.whisper = { state: "unknown", model: "", device: "", error: "", at: 0 };
    this.mediaDir = config.mediaDir || path.join(path.dirname(config.statePath || "."), "inbox");
    this.stopped = false;
    this.startedAt = Date.now();
    this.lastPollOk = null;
    this.consecutiveErrors = 0;
    this.pollTimer = null;
    this.offset = Number(state.offset || 0);
    this.botInfo = null;
  }

  start() {
    this.log("telegram: starting bridge");
    this.subscribeEvents();
    const run = () => {
      this.initOnce().catch((error) => this.log(`telegram: init error: ${error.message}`));
      this.pollLoop().catch((error) => {
        if (!this.stopped) this.log(`telegram: poll loop crashed: ${error.message}`);
      });
    };
    run();
    return () => this.stop();
  }

  async stop() {
    this.stopped = true;
    this.log("telegram: stopping bridge");
    const handles = [...this.sessions.values()].map((entry) => entry.handle);
    this.sessions.clear();
    this.bySession.clear();
    for (const handle of handles) {
      if (handle && typeof handle.dispose === "function") {
        await handle.dispose().catch(() => {});
      }
    }
  }

  async initOnce() {
    if (this.botInfo) return;
    const me = await this.api.call("getMe");
    if (me.ok) {
      this.botInfo = me.result;
      this.log(`telegram: authenticated as @${me.result.username}`);
      await this.installCommands();
      if (this.config.voiceTranscribe !== false) this.checkWhisper().catch(() => {});
      if (this.config.startupMessage !== false) this.sendStartupMessages();
    } else {
      this.log(`telegram: getMe failed: ${me.description}`);
    }
  }

  async installCommands() {
    const commands = [
      { command: "start", description: "开始使用" },
      { command: "new", description: "开新会话" },
      { command: "stop", description: "停止当前生成" },
      { command: "status", description: "运行状态" },
      { command: "help", description: "使用说明" },
    ];
    for (const language_code of [undefined, "zh-hans"]) {
      const payload = { commands };
      if (language_code) payload.language_code = language_code;
      await this.api.call("setMyCommands", payload).catch(() => {});
    }
  }

  sendStartupMessages() {
    for (const userId of this.config.allowedUserIds || []) {
      this.sender.enqueue(userId, {
        kind: "send",
        payload: { chatId: userId, text: "✅ Telegram 插件已上线（v0.2）。直接发消息开始；/help 查看命令。" },
      });
    }
  }

  async pollLoop() {
    let backoffMs = 1000;
    while (!this.stopped) {
      try {
        const params = { timeout: this.config.pollingTimeoutSec ?? 30, allowed_updates: JSON.stringify(["message", "callback_query", "stopped_message_generation"]) };
        if (this.offset > 0) params.offset = this.offset;
        const body = await this.api.call("getUpdates", params, { method: "GET" });
        if (!body.ok) {
          this.consecutiveErrors += 1;
          const description = String(body.description || "unknown error");
          if (/conflict/i.test(description)) {
            const now = Date.now();
            if (!this.conflictSince) this.conflictSince = now;
            if (!this.lastConflictNotice || now - this.lastConflictNotice > 60000) {
              this.lastConflictNotice = now;
              this.log(
                "telegram: 409 Conflict — another process is polling this bot token. " +
                  "Stop the Python bridge before switching; this host keeps retrying but will not receive updates while the other poller is active."
              );
            }
            backoffMs = Math.min(backoffMs * 2, POLL_ERR_CAP_MS);
            await sleep(backoffMs);
            continue;
          }
          this.log(`telegram: getUpdates failed: ${description}`);
          backoffMs = Math.min(backoffMs * 2, POLL_ERR_CAP_MS);
          await sleep(backoffMs);
          continue;
        }
        if (this.conflictSince) {
          this.log(`telegram: polling recovered after ${Math.round((Date.now() - this.conflictSince) / 1000)}s of 409 conflicts`);
          this.conflictSince = 0;
          this.lastConflictNotice = 0;
        }
        backoffMs = 1000;
        this.consecutiveErrors = 0;
        this.lastPollOk = Date.now();
        for (const update of body.result || []) {
          this.offset = update.update_id + 1;
          this.state.offset = this.offset;
          this.saveState();
          try {
            await this.handleUpdate(update);
          } catch (error) {
            this.log(`telegram: update handling failed: ${error.message}`);
          }
        }
        if (!body.result || body.result.length === 0) await sleep(50);
      } catch (error) {
        this.consecutiveErrors += 1;
        this.log(`telegram: poll error: ${error.message}`);
        // Network hiccups (TLS resets, timeouts) are transient: retry quickly
        // instead of growing the backoff, or a flaky proxy delays messages by
        // half a minute per retry.
        const transient = /timeout|disconnected|ECONNRESET|EPIPE|socket hang up/i.test(String(error.message));
        if (transient) {
          await sleep(1000);
        } else {
          await sleep(Math.min(backoffMs, POLL_ERR_CAP_MS));
          backoffMs = Math.min(backoffMs * 2, POLL_ERR_CAP_MS);
        }
      }
    }
  }

  saveState() {
    if (typeof this.stateSave === "function") this.stateSave();
  }

  async handleUpdate(update) {
    if (update.message) return this.handleMessage(update.message);
    if (update.callback_query) return this.handleCallbackQuery(update.callback_query);
    if (update.stopped_message_generation) return this.handleStop(update.stopped_message_generation);
  }

  /** A tapped inline button: acknowledge it, drop the keyboard, run the action. */
  async handleCallbackQuery(query) {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const data = String(query.data || "");

    this.api
      .call("answerCallbackQuery", { callback_query_id: query.id })
      .catch(() => {});

    if (!chatId) return;
    if (!this.authorized({ from: query.from })) return;

    const entry = this.buttons.take(data);
    if (!entry || entry.chatId !== String(chatId)) {
      this.log(`telegram: stale or unknown button data ${data.slice(0, 16)}`);
      this.api.call("answerCallbackQuery", { callback_query_id: query.id, text: "这个按钮已失效" }).catch(() => {});
      return;
    }

    // One-shot buttons: remove the keyboard once used.
    if (messageId !== undefined) {
      this.api
        .call("editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {});
    }

    const action = entry.action;
    this.log(`telegram: button action "${action.slice(0, 40)}" in chat ${chatId}`);
    if (action === "new" || action === "/new") {
      await this.newSession(chatId);
      this.sender.enqueue(chatId, { kind: "send", payload: { chatId, text: "已开新会话。" } });
      return;
    }
    if (action === "stop" || action === "/stop") {
      await this.stopTurn(chatId);
      return;
    }
    if (action === "status" || action === "/status") {
      this.sender.enqueue(chatId, { kind: "send", payload: { chatId, text: this.statusText() } });
      return;
    }
    if (action === "help" || action === "/help") {
      this.sender.enqueue(chatId, { kind: "send", payload: { chatId, text: helpText() } });
      return;
    }
    if (action.startsWith("/")) {
      const parts = action.split(/\s+/);
      await this.handleCommand(chatId, parts[0].toLowerCase(), parts.slice(1));
      return;
    }
    await this.dispatchText(chatId, action, messageId);
  }

  handleStop(info) {
    const chatId = info.chat?.id;
    const draftId = info.draft_id;
    for (const [sessionId, entry] of this.bySession) {
      if (entry.chatKey === chatId && entry.draftId === draftId) {
        const agent = this.ctx.agents.get(sessionId);
        if (agent && typeof agent.cancel === "function") {
          agent.cancel({ kind: "user" }).catch(() => {});
        }
        const partial = (entry.streamText || "").trim();
        entry.streamText = "";
        entry.draftId = undefined;
        entry.running = false;
        // The runtime still emits turn/end(aborted); do not send the final text twice.
        entry.suppressFinal = true;
        if (partial) {
          this.enqueueFinal(chatId, partial + "\n\n_（已停止生成）_");
        } else {
          this.sender.enqueue(chatId, { kind: "send", payload: { chatId, text: "已停止生成。" } });
        }
        return;
      }
    }
  }

  async handleMessage(message) {
    const chat = message.chat || {};
    const chatId = chat.id;
    if (!chatId) return;
    if (message.from?.is_bot) return;
    if (chat.type !== "private" && !this.config.allowGroups) return;
    if (!this.authorized(message)) {
      this.sender.enqueue(chatId, { kind: "send", payload: { chatId, text: "Access denied." } });
      return;
    }

    if (this.config.reactions !== false) this.reactToMessage(chatId, message.message_id);

    const text = (message.text || message.caption || "").trim();
    const media = detectMedia(message);
    if (text === "" && !media) return;

    const parts = text.split(/\s+/);
    const command = parts[0].split("@")[0].toLowerCase();
    if (!media && command.startsWith("/") && command.length > 1) {
      await this.handleCommand(chatId, command, parts.slice(1));
      return;
    }

    let body = text;
    if (media && this.config.media !== false) {
      const saved = await this.saveIncomingMedia(chatId, media);
      body = text === "" ? saved.note : `${saved.note}\n\n${text}`;
      if ((media.kind === "voice" || media.kind === "audio") && this.config.voiceTranscribe !== false) {
        const transcript = await this.transcribeMedia(saved.path, media);
        body = transcript
          ? `[语音转写] ${transcript}\n\n${saved.note}`
          : `${saved.note}\n\n（语音转写失败，请改文字或稍后重试。）`;
      }
    } else if (media) {
      body = text === "" ? "[附件] 收到一个文件，但媒体下载已关闭。" : text;
    }
    await this.dispatchText(chatId, body, message.message_id);
  }

  /** Transcribe a saved voice note through the local Whisper service. */
  async transcribeMedia(filePath, media) {
    if (!filePath) return "";
    try {
      const result = await transcribeFile(filePath, {
        url: this.config.whisperUrl,
        language: this.config.whisperLanguage || "zh",
        timeoutMs: this.config.whisperTimeoutMs ?? 120000,
        mime: media.mime || "audio/ogg",
      });
      this.log(`telegram: voice ${media.duration || "?"}s -> ${result.text.slice(0, 60) || "(empty)"}`);
      return result.text;
    } catch (error) {
      this.log(`telegram: voice transcribe failed: ${error.message}`);
      return "";
    }
  }

  /** Startup probe so an offline Whisper is visible in the log, not on first use. */
  async checkWhisper() {
    try {
      const health = await whisperHealth({ url: this.config.whisperUrl, timeoutMs: 3000 });
      this.whisper = { state: "ready", model: health.model || "", device: health.device || "", error: "", at: Date.now() };
      this.log(`telegram: whisper ready (${health.model || "?"} on ${health.device || "?"})`);
    } catch (error) {
      this.whisper = { state: "unavailable", model: "", device: "", error: error.message, at: Date.now() };
      this.log(`telegram: whisper unavailable (${error.message}); voice notes will fall back to attachment paths`);
    }
  }

  /** One-line Whisper status for /status, refreshed in the background. */
  whisperLabel() {
    if (this.config.voiceTranscribe === false) return "关闭";
    if (Date.now() - (this.whisper.at || 0) > 30000) this.checkWhisper().catch(() => {});
    if (this.whisper.state === "ready") {
      return `ready（${this.whisper.model || "?"}/${this.whisper.device || "?"}）`;
    }
    if (this.whisper.state === "unavailable") {
      return `unavailable（${String(this.whisper.error || "连接失败").slice(0, 60)}）`;
    }
    return "检测中";
  }

  /** Show a "seen it" reaction without blocking the turn. */
  reactToMessage(chatId, messageId) {
    const emoji = typeof this.config.reactions === "string" ? this.config.reactions : "👀";
    Promise.resolve()
      .then(() =>
        this.api.call("setMessageReaction", {
          chat_id: chatId,
          message_id: messageId,
          reaction: [{ type: "emoji", emoji }],
        })
      )
      .catch(() => {});
  }

  /** Download an incoming attachment into the workspace and describe it. */
  async saveIncomingMedia(chatId, media) {
    const maxBytes = this.config.maxDownloadBytes ?? 20 * 1024 * 1024;
    if (media.size && media.size > maxBytes) {
      this.log(`telegram: ${media.name} is ${media.size} bytes, over the ${maxBytes} byte limit`);
      return { note: `[附件] 收到${media.name}（${media.size} 字节），超过下载上限 ${maxBytes} 字节，未下载。`, path: "" };
    }
    try {
      const info = await this.api.call("getFile", { file_id: media.fileId });
      if (!info.ok || !info.result?.file_path) {
        throw new Error(info.description || "getFile returned no file_path");
      }
      const bytes = await this.api.download(info.result.file_path, { maxBytes });
      const dir = path.join(this.mediaDir, String(chatId));
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const name = `${stamp}-${safeFileName(media.name, `file${extensionFor(media.mime, media.name)}`)}`;
      const full = path.join(dir, name);
      fs.writeFileSync(full, bytes);
      media.size = bytes.length;
      this.log(`telegram: saved ${media.kind} ${bytes.length}b -> ${full}`);
      return { note: attachmentNote(media, full), path: full };
    } catch (error) {
      this.log(`telegram: media download failed: ${error.message}`);
      return { note: `[附件] 收到${media.name}，但下载失败：${error.message}`, path: "" };
    }
  }

  authorized(message) {
    if (this.config.allowAllUsers) return true;
    const userId = message.from?.id;
    if (userId === undefined) return false;
    const allowed = this.config.allowedUserIds || [];
    return allowed.length === 0 ? false : allowed.includes(userId);
  }

  async handleCommand(chatId, command, args) {
    switch (command) {
      case "/start":
        await this.ensureChat(chatId);
        this.sender.enqueue(chatId, { kind: "send", payload: { chatId, text: helpText() } });
        break;
      case "/new":
        await this.newSession(chatId);
        this.sender.enqueue(chatId, { kind: "send", payload: { chatId, text: "已开新会话。" } });
        break;
      case "/status":
        this.sender.enqueue(chatId, { kind: "send", payload: { chatId, text: this.statusText() } });
        break;
      case "/stop":
        await this.stopTurn(chatId);
        break;
      case "/help":
        this.sender.enqueue(chatId, { kind: "send", payload: { chatId, text: helpText() } });
        break;
      default:
        this.sender.enqueue(chatId, { kind: "send", payload: { chatId, text: `未知命令：${command}。发送 /help 查看可用命令。` } });
    }
  }

  async stopTurn(chatId) {
    const entry = this.sessions.get(chatId);
    const live = entry ? this.bySession.get(entry.sessionId) : undefined;
    const agent = entry ? this.ctx.agents?.get?.(entry.sessionId) || entry.agent : undefined;
    if (!entry || !live?.running || typeof agent?.cancel !== "function") {
      this.sender.enqueue(chatId, { kind: "send", payload: { chatId, text: "当前没有进行中的任务。" } });
      return;
    }
    try {
      await agent.cancel({ kind: "user" });
    } catch (error) {
      this.log(`telegram: cancel failed: ${error.message}`);
    }
    const partial = (live.streamText || "").trim();
    live.streamText = "";
    live.draftId = undefined;
    live.running = false;
    live.suppressFinal = true;
    this.sender.enqueue(chatId, {
      kind: "send",
      payload: { chatId, text: partial ? `${toPlainText(partial)}\n\n（已停止生成）` : "已停止生成。" },
    });
  }

  statusText() {
    const uptime = Math.floor((Date.now() - this.startedAt) / 1000);
    const lastOk = this.lastPollOk ? `${Math.floor((Date.now() - this.lastPollOk) / 1000)}s 前` : "无";
    return [
      "Telegram 桥：在线",
      `运行：${Math.floor(uptime / 60)} 分钟`,
      `会话数：${this.sessions.size}`,
      `最近轮询成功：${lastOk}`,
      `连续失败：${this.consecutiveErrors}`,
      `模型：${this.config.provider}/${this.config.model}`,
      `流式：${this.config.streaming}`,
      `渲染：${this.useRichMessages() ? "rich（富文本）" : "HTML"}`,
      `语音：${this.whisperLabel()}`,
      `轮询冲突：${this.conflictSince ? `进行中（${Math.round((Date.now() - this.conflictSince) / 1000)}s）` : "无"}`,
    ].join("\n");
  }

  async dispatchText(chatId, text, replyToMessageId = undefined) {
    const entry = await this.ensureChat(chatId);
    if (!entry) return;
    const sessionId = entry.sessionId;
    const agent = entry.agent || entry.handle?.agent;
    if (!agent) return;
    if (replyToMessageId !== undefined && this.config.replyToUser !== false) {
      this.replyTo.set(String(chatId), replyToMessageId);
    }
    const live = this.bySession.get(sessionId);
    if (live) {
      live.streamText = "";
      live.lastAssistant = "";
      live.running = true;
      live.suppressFinal = false;
      live.editMessageId = undefined;
      live.editPending = false;
    }
    // The inbox expects a complete UserMessage (role + stable id); a bare
    // {content, source} object fails later at request serialization.
    agent.followup({
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "user" },
    });
    if (this.config.typing !== false) {
      this.sender.enqueue(chatId, { kind: "action", payload: { chatId, action: "typing" } });
    }
  }

  async ensureChat(chatId) {
    let entry = this.sessions.get(chatId);
    if (entry) return entry;

    const agentOptions = { provider: this.config.provider, model: this.config.model };
    if (this.config.reasoningEffort) agentOptions.reasoningEffort = this.config.reasoningEffort;
    if (this.config.maxTokens) agentOptions.maxTokens = this.config.maxTokens;

    const persisted = this.state.chats?.[chatId];
    if (persisted?.sessionId) {
      const existing = this.ctx.agents.get(persisted.sessionId);
      if (existing) {
        entry = { sessionId: persisted.sessionId, handle: null, agent: existing };
        this.sessions.set(chatId, entry);
        this.bySession.set(persisted.sessionId, { chatKey: chatId, draftId: undefined, streamText: "", lastAssistant: "", turn: 0 });
        return entry;
      }
      try {
        const timeoutMs = this.config.resumeTimeoutMs ?? 15000;
        // The agent factory keys resume on `resumeSessionId`; passing only
        // `sessionId` leaves the id undefined and the load never settles.
        const resumePromise = Promise.resolve()
          .then(() => this.ctx.agents.resume({ resumeSessionId: persisted.sessionId, agentOptions }))
          .catch((error) => {
            this.log(`telegram: resume ${persisted.sessionId} failed: ${error.message}`);
            return null;
          });
        const handle = await Promise.race([resumePromise, sleep(timeoutMs).then(() => null)]);
        if (!handle) {
          this.log(`telegram: resume ${persisted.sessionId} did not complete within ${timeoutMs}ms; starting a new session`);
        } else {
          entry = { sessionId: persisted.sessionId, handle: handle.agent ? handle : null, agent: handle.agent || handle };
          this.sessions.set(chatId, entry);
          this.bySession.set(persisted.sessionId, { chatKey: chatId, draftId: undefined, streamText: "", lastAssistant: "", turn: 0 });
          this.log(`telegram: resumed session ${persisted.sessionId} for chat ${chatId}`);
          return entry;
        }
      } catch (error) {
        this.log(`telegram: resume ${persisted.sessionId} failed: ${error.message}`);
      }
    }

    const sessionId = `tg-${chatId}-${Date.now().toString(36)}`;
    let handle;
    handle = await this.ctx.agents.create({ sessionId, agentOptions });
    entry = { sessionId, handle, agent: handle.agent };
    this.sessions.set(chatId, entry);
    this.bySession.set(sessionId, { chatKey: chatId, draftId: undefined, streamText: "", lastAssistant: "", turn: 0 });
    this.state.chats = this.state.chats || {};
    this.state.chats[chatId] = { sessionId };
    this.saveState();
    this.log(`telegram: created session ${sessionId} for chat ${chatId}`);
    return entry;
  }

  async newSession(chatId) {
    const old = this.sessions.get(chatId);
    if (old?.handle && typeof old.handle.dispose === "function") await old.handle.dispose().catch(() => {});
    if (old?.sessionId) this.bySession.delete(old.sessionId);
    this.sessions.delete(chatId);
    if (this.state.chats) delete this.state.chats[chatId];
    this.saveState();
    await this.ensureChat(chatId);
  }

  subscribed = false;
  debugCounts = {};
  subscribeEvents() {
    if (this.subscribed) return;
    this.subscribed = true;
    this.ctx.on("session/event", (session, event) => {
      try {
        const sessionId = session?.id ?? session?.sessionId;
        if (this.config.debug) {
          let extra = "";
          if (event?.type === "llm/retry" || event?.type === "turn/end") {
            try {
              extra = ` data=${JSON.stringify(event.data).slice(0, 1500)}`;
            } catch {
              extra = " data=<unserializable>";
            }
          }
          this.log(`debug sev type=${event?.type || "?"} sid=${sessionId}${extra}`);
        }
        if (!sessionId || !event) return;
        this.handleSessionEvent({ sessionId, event });
      } catch (error) {
        this.log(`telegram: session event error: ${error.message}`);
      }
    });
    this.ctx.on("agent/assistant-stream", (payload) => {
      try {
        if (this.config.debug) {
          const frame = payload?.frame || payload;
          const keys = Object.keys(frame || {}).join(",");
          this.log(`debug frame keys=[${keys}] type=${frame?.type || "?"}`);
        }
        this.handleStreamFrame(payload?.frame || payload);
      } catch (error) {
        this.log(`telegram: stream frame error: ${error.message}`);
      }
    });
    if (this.config.debug) {
      this.ctx.on("agent/request-error", (payload) => {
        try {
          const error = payload?.error || payload?.failure;
          const pick = (obj, key) => {
            try {
              return obj?.[key];
            } catch {
              return undefined;
            }
          };
          const inner = pick(error, "failure") || pick(error, "cause");
          const inner2 = pick(inner, "cause") || pick(inner, "failure");
          const fields = [
            `keys=${Object.keys(payload || {}).join(",")}`,
            `msg=${pick(error, "message")}`,
            `code=${pick(error, "code")}`,
            `innerMsg=${pick(inner, "message")}`,
            `innerKeys=${Object.keys(inner || {}).join(",")}`,
            `inner2Msg=${pick(inner2, "message")}`,
            `inner2Code=${pick(inner2, "code")}`,
          ];
          this.log(`debug request-error ${fields.join(" ; ")}`);
          this.log(`debug request-error inspect ${inspect(payload, { depth: 5, breakLength: 200 }).slice(0, 2500)}`);
        } catch {
          /* ignore */
        }
      });
    }
  }

  handleSessionEvent(payload) {
    const sessionId = payload?.sessionId;
    const event = payload?.event;
    if (!sessionId || !event) return;
    const entry = this.bySession.get(sessionId);
    if (!entry) return;
    if (event.type === "assistant/message") {
      entry.lastAssistant = textOfAssistantMessage(event);
    } else if (event.type === "request/header" && this.config.debug) {
      try {
        this.log(`debug request-header ${JSON.stringify(event.data).slice(0, 2000)}`);
      } catch {
        /* ignore */
      }
    } else if (event.type === "turn/end") {
      const kind = event.data?.reason?.kind;
      if (this.config.debug && kind === "error") {
        const error = event.data?.reason?.error;
        const seen = new Set();
        let node = error;
        const chain = [];
        while (node && typeof node === "object" && !seen.has(node) && chain.length < 5) {
          seen.add(node);
          chain.push(`${node.name || "Error"}: ${node.message} code=${node.code || ""}`);
          node = node.cause || node.failure;
        }
        this.log(`debug error chain: ${chain.join(" -> ")}`);
      }
      this.finalizeTurn(sessionId, entry, kind);
    }
  }

  handleStreamFrame(frame) {
    if (!frame || typeof frame !== "object") return;
    const sessionId = frame.attemptId ? String(frame.attemptId).split(":")[0] : undefined;
    const entry = sessionId ? this.bySession.get(sessionId) : undefined;
    if (!entry) return;
    if (frame.type === "start") {
      entry.streamText = "";
      entry.turn = frame.turn ?? entry.turn;
      entry.draftId = uniqueDraftId();
      entry.lastDraftAt = 0;
      entry.running = true;
      entry.suppressFinal = false;
      entry.editMessageId = undefined;
      entry.editPending = false;
      if (this.config.typing !== false) {
        this.sender.enqueue(entry.chatKey, { kind: "action", payload: { chatId: entry.chatKey, action: "typing" } });
      }
      if (this.config.streaming === "draft") {
        this.sender.enqueue(entry.chatKey, {
          kind: "draft",
          payload: { chatId: entry.chatKey, draftId: entry.draftId, text: "", canStop: true },
        });
      } else if (this.config.streaming === "edit") {
        this.beginEditStream(entry);
      }
    } else if (frame.type === "chunk") {
      const piece = chunkText(frame.chunk);
      if (this.config.debug && this.debuggedChunk === undefined) {
        this.debuggedChunk = true;
        let sample = "";
        try {
          sample = JSON.stringify(frame.chunk).slice(0, 800);
        } catch {
          sample = "<unserializable>";
        }
        this.log(`debug chunk sample=${JSON.stringify(piece).slice(0, 200)} chunkKeys=${Object.keys(frame.chunk || {}).join(",")} chunk=${sample}`);
      }
      entry.streamText = (entry.streamText + piece).slice(0, 200000);
      if (this.config.streaming === "draft" && entry.draftId) {
        const now = Date.now();
        const throttle = this.config.draftThrottleMs ?? 300;
        if (now - (entry.lastDraftAt || 0) >= throttle) {
          entry.lastDraftAt = now;
          // Drafts are a transient preview: send readable plain text so the user
          // never sees raw "**" markers while the answer streams.
          this.sender.enqueue(entry.chatKey, {
            kind: "draft",
            payload: {
              chatId: entry.chatKey,
              draftId: entry.draftId,
              text: toPlainText(entry.streamText).slice(0, 4000),
              canStop: true,
            },
          });
        }
      } else if (this.config.streaming === "edit") {
        this.updateEditStream(entry);
      }
    } else if (frame.type === "end") {
      // Final send is driven by the durable turn/end event.
      if (this.config.debug) {
        this.log(`debug end outcome=${JSON.stringify(frame.outcome || {})}`);
      }
    }
  }

  beginEditStream(entry) {
    if (entry.editPending || entry.editMessageId) return;
    entry.editPending = true;
    this.sender
      .enqueue(entry.chatKey, { kind: "send", payload: { chatId: entry.chatKey, text: "⏳" } })
      .then((outcome) => {
        entry.editPending = false;
        entry.editMessageId = outcome?.result?.message_id;
        if (entry.editMessageId) this.updateEditStream(entry, { force: true });
      })
      .catch(() => {
        entry.editPending = false;
      });
  }

  updateEditStream(entry, { force = false } = {}) {
    if (!entry.editMessageId) {
      if (!entry.editPending) this.beginEditStream(entry);
      return;
    }
    const now = Date.now();
    const throttle = this.config.draftThrottleMs ?? 300;
    if (!force && now - (entry.lastEditAt || 0) < throttle) return;
    entry.lastEditAt = now;
    const text = toPlainText(entry.streamText || "").slice(0, 3900) || "⏳";
    this.sender.enqueue(entry.chatKey, {
      kind: "edit",
      payload: { chatId: entry.chatKey, messageId: entry.editMessageId, text },
    });
  }

  finalizeTurn(sessionId, entry, kind) {
    const text = (entry.lastAssistant || "").trim();
    entry.lastAssistant = "";
    entry.draftId = undefined;
    entry.running = false;
    entry.streamText = "";
    if (entry.suppressFinal) {
      entry.suppressFinal = false;
      return;
    }
    if (kind === "error") {
      this.sender.enqueue(entry.chatKey, { kind: "send", payload: { chatId: entry.chatKey, text: "本轮出错了，请重试或 /new 重开。" } });
      return;
    }
    if (this.config.streaming === "edit" && entry.editMessageId) {
      const messageId = entry.editMessageId;
      entry.editMessageId = undefined;
      this.enqueueFinalEdit(entry.chatKey, messageId, text);
      return;
    }
    this.enqueueFinal(entry.chatKey, text);
  }

  enqueueFinalEdit(chatId, messageId, text) {
    const chunks = splitMessage(text, {
      maxLength: this.config.maxMessageLength ?? 4096,
      entityBudget: this.config.entityBudget ?? 90,
      markdown: true,
    });
    if (chunks.length === 0) {
      this.sender.enqueue(chatId, { kind: "edit", payload: { chatId, messageId, text: "（本轮没有文本回复）" } });
      return;
    }
    chunks.forEach((chunk, index) => {
      const label = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : "";
      const body = {
        text: chunk.kind === "html" ? chunk.text + label : chunk.text,
        parseMode: chunk.kind === "html" ? "HTML" : undefined,
      };
      if (index === 0) this.sender.enqueue(chatId, { kind: "edit", payload: { chatId, messageId, ...body } });
      else this.sender.enqueue(chatId, { kind: "send", payload: { chatId, ...body } });
    });
  }

  useRichMessages() {
    const mode = this.config.richMessages;
    if (mode === false || mode === "off") return false;
    if (this.sender.richDisabled) return false;
    return true;
  }

  enqueueFinal(chatId, text) {
    const extracted = extractDirectives(text ?? "");
    const replyToMessageId = this.replyTo.get(String(chatId));
    this.replyTo.delete(String(chatId));
    this.queueAttachments(chatId, extracted.attachments, replyToMessageId);

    const withButtons = parseButtonsDirective(extracted.text);
    const keyboard = withButtons.buttons.length > 0 ? buildKeyboard(withButtons.buttons, this.buttons, chatId) : null;

    text = withButtons.text;
    if (!text) return;
    const maxLength = this.config.maxMessageLength ?? 4096;
    const entityBudget = this.config.entityBudget ?? 90;

    // Preferred: Bot API 10.1 rich messages — headings, lists, tables, math and
    // code render natively. Each chunk carries an HTML fallback in case the
    // server or chat rejects the method.
    if (this.useRichMessages()) {
      const items = splitRichWithFallback(text, { maxLength, entityBudget });
      items.forEach((item, index) => {
        const label = items.length > 1 ? `\n\n（${index + 1}/${items.length}）` : "";
        this.sender.enqueue(chatId, {
          kind: "rich",
          payload: {
            chatId,
            markdown: item.text + label,
            fallbackHtml: item.fallbackHtml + (label ? `<i>${label.trim()}</i>` : ""),
            replyToMessageId: index === 0 ? replyToMessageId : undefined,
            replyMarkup: index === items.length - 1 ? keyboard : undefined,
          },
        });
      });
      return;
    }

    const chunks = splitMessage(text, { maxLength, entityBudget, markdown: true });
    let index = 0;
    for (const chunk of chunks) {
      const label = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : "";
      this.sender.enqueue(chatId, {
        kind: "send",
        payload: {
          chatId,
          text: chunk.kind === "html" ? chunk.text + label : chunk.text,
          parseMode: chunk.kind === "html" ? "HTML" : undefined,
          replyToMessageId: index === 0 ? replyToMessageId : undefined,
          replyMarkup: index === chunks.length - 1 ? keyboard : undefined,
        },
      });
      index += 1;
    }
  }

  /** Send the files an assistant reply asked for via [[file:...]]. */
  queueAttachments(chatId, attachments, replyToMessageId) {
    for (const attachment of attachments || []) {
      if (!fs.existsSync(attachment.path)) {
        this.sender.enqueue(chatId, {
          kind: "send",
          payload: { chatId, text: `附件不存在：${attachment.path}` },
        });
        continue;
      }
      const stat = fs.statSync(attachment.path);
      if (stat.isDirectory()) {
        this.sender.enqueue(chatId, { kind: "send", payload: { chatId, text: `不能发送目录：${attachment.path}` } });
        continue;
      }
      this.sender.enqueue(chatId, {
        kind: attachment.kind,
        payload: {
          chatId,
          path: attachment.path,
          caption: attachment.caption,
          replyToMessageId,
        },
      });
    }
  }
}

export class TelegramApi {
  constructor(config, log) {
    this.baseUrl = (config.baseUrl || "https://api.telegram.org").replace(/\/+$/, "");
    this.token = config.token;
    this.proxy = config.proxy || "";
    const candidates =
      Array.isArray(config.proxies) && config.proxies.length > 0
        ? config.proxies
        : (config.proxy ? [config.proxy] : []);
    this.pool = new ProxyPool(candidates, {
      log: typeof log === "function" ? log : () => {},
      probeUrl: `${this.baseUrl}/bot${this.token}/getMe`,
      probeIntervalMs: config.proxyProbeIntervalMs,
      probeTimeoutMs: config.proxyProbeTimeoutMs,
    });
    this.pool.start();
    this.pollTimeoutMs = ((config.pollingTimeoutSec ?? 30) + 15) * 1000;
  }

  async call(method, payload = {}, { timeoutMs } = {}) {    const params = { ...payload };
    let url = `${this.baseUrl}/bot${this.token}/${method}`;
    const isGet = method === "getUpdates" || method === "getMe";
    if (isGet) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) query.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
      const qs = query.toString();
      if (qs) url += `?${qs}`;
    }
    await this.pool.ensureProbed();
    const response = await request(url, {
      method: isGet ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: isGet ? undefined : JSON.stringify(params),
      proxies: this.pool.order(),
      timeoutMs: timeoutMs || this.pollTimeoutMs,
      connectTimeoutMs: 15000,
      onProxyUsed: (candidate) => this.pool.markOk(candidate),
      onProxyFailed: (candidate, error) => this.pool.markFail(candidate, error),
    });
    if (response.status === 0) return { ok: false, description: "connection closed" };
    return response.json();
  }

  /** Download a file from https://api.telegram.org/file/bot<token>/<path>. */
  async download(filePath, { maxBytes = 20 * 1024 * 1024 } = {}) {
    const url = `${this.baseUrl}/file/bot${this.token}/${String(filePath).replace(/^\/+/, "")}`;
    await this.pool.ensureProbed();
    const response = await request(url, {
      proxies: this.pool.order(),
      timeoutMs: 120000,
      connectTimeoutMs: 15000,
      onProxyUsed: (candidate) => this.pool.markOk(candidate),
      onProxyFailed: (candidate, error) => this.pool.markFail(candidate, error),
    });
    const bytes = response.bytes();
    if (maxBytes && bytes.length > maxBytes) {
      throw new Error(`file is ${bytes.length} bytes, over the ${maxBytes} byte limit`);
    }
    return bytes;
  }

  /** Upload one file as multipart/form-data (Bot API accepts no local paths). */
  async upload(method, fields, file, { timeoutMs = 180000 } = {}) {
    const boundary = `----dshtg${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
    const chunks = [];
    const push = (value) => chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf-8"));
    for (const [key, value] of Object.entries(fields || {})) {
      if (value === undefined || value === null) continue;
      push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n`);
      push(value);
      push("\r\n");
    }
    const filename = safeFileName(file.filename || "file");
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${filename}"\r\n` +
        `Content-Type: ${file.contentType || "application/octet-stream"}\r\n\r\n`
    );
    push(file.bytes);
    push(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat(chunks);

    await this.pool.ensureProbed();
    const response = await request(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
      proxies: this.pool.order(),
      timeoutMs,
      connectTimeoutMs: 15000,
      onProxyUsed: (candidate) => this.pool.markOk(candidate),
      onProxyFailed: (candidate, error) => this.pool.markFail(candidate, error),
    });
    if (response.status === 0) return { ok: false, description: "connection closed" };
    return response.json();
  }
}

function textOfAssistantMessage(event) {
  const data = event.data || {};
  const message = data.message || data;
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
}

function uniqueDraftId() {
  return (Date.now() % 99999999) + 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function helpText() {
  return [
    "DeepSeek Hermes · Telegram 桥",
    "",
    "/start 开始 · /new 新会话 · /status 状态 · /help 帮助",
    "直接发消息即可对话；长回答会以草稿流式显示，生成中可点 Stop。",
  ].join("\n");
}

