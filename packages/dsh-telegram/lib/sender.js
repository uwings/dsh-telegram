// Per-chat outbound queue with rate limiting, retries and a persisted ledger.

import { request } from "./proxy-fetch.js";
import fs from "node:fs";
import path from "node:path";

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};

function mimeFor(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

const REPLAYABLE = new Set(["send", "edit", "rich", "document", "photo"]);

export class Sender {
  constructor(api, state, config, log) {
    this.api = api; // { call(method, payload) }
    this.state = state; // { outbox: [...] } persisted by the bridge
    this.config = config;
    this.log = log;
    this.queues = new Map(); // chatId -> array of items
    this.working = new Set(); // chatIds currently draining
    this.lastSendAt = new Map();
    this.replaying = false;
  }

  /** Enqueue an outbound item. Returns a promise resolving when it settles. */
  enqueue(chatId, item) {
    return new Promise((resolve) => {
      const entry = {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        chatId,
        kind: item.kind, // send | edit | draft | action
        payload: item.payload,
        attempts: 0,
        nextTryAt: 0,
        resolve,
      };
      const list = this.queues.get(chatId) || [];
      // Draft/action items are replaceable: drop older drafts of the same turn.
      if (item.kind === "draft") {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].kind === "draft" && list[i].payload.draftId === item.payload.draftId) list.splice(i, 1);
        }
      }
      if (item.kind === "action") {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].kind === "action") list.splice(i, 1);
        }
      }
      const limit = this.config.maxQueuePerChat ?? 8;
      if (list.length >= limit && item.kind !== "draft" && item.kind !== "action") {
        this.log(`sender: queue overflow for chat ${chatId}, dropping ${item.kind}`);
        resolve({ dropped: true });
        return;
      }
      list.push(entry);
      this.queues.set(chatId, list);
      this.persist();
      this.drain(chatId);
    });
  }

  /** Replay persisted send/edit/rich/attachment items after restart. */
  replay() {
    if (this.replaying) return;
    this.replaying = true;
    for (const entry of this.state.outbox || []) {
      if (!REPLAYABLE.has(entry.kind)) continue;
      if ((entry.attempts || 0) >= (this.config.retryMax ?? 3)) continue;
      const list = this.queues.get(entry.chatId) || [];
      list.push({ ...entry, resolve: () => {} });
      this.queues.set(entry.chatId, list);
    }
    this.persist();
    for (const chatId of this.queues.keys()) this.drain(chatId);
  }

  persist() {
    const outbox = [];
    for (const list of this.queues.values()) {
      for (const entry of list) {
        if (REPLAYABLE.has(entry.kind)) {
          outbox.push({ id: entry.id, chatId: entry.chatId, kind: entry.kind, payload: entry.payload, attempts: entry.attempts, nextTryAt: entry.nextTryAt });
        }
      }
    }
    this.state.outbox = outbox;
  }

  async drain(chatId) {
    if (this.working.has(chatId)) return;
    this.working.add(chatId);
    try {
      const list = this.queues.get(chatId);
      while (list && list.length > 0) {
        const entry = list[0];
        const now = Date.now();
        if (entry.nextTryAt > now) {
          await sleep(Math.min(entry.nextTryAt - now, 5000));
          continue;
        }
        const sinceLast = now - (this.lastSendAt.get(chatId) || 0);
        const spacing = (this.config.sendSpacingMs ?? 1050) - sinceLast;
        if (spacing > 0) await sleep(spacing);
        const outcome = await this.sendOne(entry);
        if (outcome.ok || outcome.dropped) {
          list.shift();
          this.persist();
          entry.resolve(outcome);
        } else if (outcome.permanent) {
          list.shift();
          this.persist();
          entry.resolve({ dropped: true, error: outcome.error, permanent: true });
          this.log(`sender: ${entry.kind} rejected permanently for chat ${chatId}: ${outcome.error}`);
          try {
            this.onPermanent?.(entry, outcome);
          } catch {
            /* listener must not break the queue */
          }
        } else {
          entry.attempts += 1;
          entry.nextTryAt = Date.now() + outcome.waitMs;
          this.persist();
          if (entry.attempts >= (this.config.retryMax ?? 3)) {
            list.shift();
            this.persist();
            entry.resolve({ dropped: true, error: outcome.error });
            this.log(`sender: giving up on ${entry.kind} for chat ${chatId} after ${entry.attempts} attempts`);
          }
        }
        if (outcome.retryAfterMs) await sleep(Math.min(outcome.retryAfterMs, 15000));
      }
    } finally {
      this.working.delete(chatId);
    }
  }

  async sendOne(entry) {
    try {
      let method;
      let payload = {};
      if (entry.kind === "send") {
        method = "sendMessage";
        payload = { chat_id: entry.payload.chatId, text: entry.payload.text };
        if (entry.payload.parseMode) payload.parse_mode = entry.payload.parseMode;
        if (entry.payload.replyToMessageId) payload.reply_parameters = { message_id: entry.payload.replyToMessageId, allow_sending_without_reply: true };
        if (entry.payload.replyMarkup) payload.reply_markup = entry.payload.replyMarkup;
      } else if (entry.kind === "rich") {
        // Bot API 10.1+: structured text (headings, lists, tables, math).
        // If the server or chat rejects it we keep the caller's HTML fallback.
        method = "sendRichMessage";
        payload = {
          chat_id: entry.payload.chatId,
          rich_message: { markdown: entry.payload.markdown },
        };
        if (entry.payload.replyToMessageId) payload.reply_parameters = { message_id: entry.payload.replyToMessageId, allow_sending_without_reply: true };
        if (entry.payload.replyMarkup) payload.reply_markup = entry.payload.replyMarkup;
      } else if (entry.kind === "edit") {
        method = "editMessageText";
        payload = { chat_id: entry.payload.chatId, message_id: entry.payload.messageId, text: entry.payload.text };
        if (entry.payload.parseMode) payload.parse_mode = entry.payload.parseMode;
      } else if (entry.kind === "draft") {
        method = "sendMessageDraft";
        payload = {
          chat_id: entry.payload.chatId,
          draft_id: entry.payload.draftId,
          text: entry.payload.text ?? "",
          can_stop: entry.payload.canStop ?? false,
        };
        if (entry.payload.parseMode) payload.parse_mode = entry.payload.parseMode;
      } else if (entry.kind === "document" || entry.kind === "photo") {
        method = entry.kind === "photo" ? "sendPhoto" : "sendDocument";
        payload = null; // built by sendAttachment (multipart)
      } else if (entry.kind === "action") {
        method = "sendChatAction";
        payload = { chat_id: entry.payload.chatId, action: entry.payload.action ?? "typing" };
      } else {
        return { ok: true };
      }
      this.lastSendAt.set(entry.chatId, Date.now());
      const body = payload === null ? await this.sendAttachment(entry) : await this.api.call(method, payload);
      if (body.ok) return { ok: true, result: body.result };
      const desc = body.description || "unknown error";
      const params = body.parameters || {};
      if (body.error_code === 429 || params.retry_after !== undefined) {
        const waitMs = Number(params.retry_after || 5) * 1000;
        this.log(`sender: 429 on ${method}, retry_after=${params.retry_after ?? "n/a"}s`);
        return { ok: false, waitMs, retryAfterMs: waitMs, error: desc };
      }
      if (entry.kind === "rich" && (body.error_code === 400 || body.error_code === 404)) {
        // Unknown method / unsupported chat: stop trying rich for this process.
        if (/not found|unknown method|unsupported|invalid method|method not/i.test(desc)) {
          this.richDisabled = true;
          this.log(`sender: sendRichMessage unavailable (${desc}); switching to HTML`);
        }
        if (entry.payload.fallbackHtml) {
          this.log(`sender: rich message rejected (${desc}); sending HTML fallback`);
          const fallback = {
            ...entry,
            kind: "send",
            payload: {
              chatId: entry.payload.chatId,
              text: entry.payload.fallbackHtml,
              parseMode: "HTML",
              replyToMessageId: entry.payload.replyToMessageId,
              replyMarkup: entry.payload.replyMarkup,
            },
          };
          return this.sendOne(fallback);
        }
      }
      if (body.error_code === 400 && /parse|entities|can't parse/i.test(desc) && entry.payload.parseMode) {
        // Format rejected: retry once as plain text (never twice).
        if (!entry.payload.plainRetried) {
          entry.payload.plainRetried = true;
          const plain = { ...entry, payload: { ...entry.payload, parseMode: undefined } };
          return this.sendOne(plain);
        }
        return { ok: false, waitMs: this.backoff(entry.attempts), error: desc };
      }
      if (body.error_code === 400 || body.error_code === 404) {
        // Permanent rejection (unsupported method, bad payload): retrying cannot help.
        return { ok: false, permanent: true, waitMs: 0, error: desc };
      }
      return { ok: false, waitMs: this.backoff(entry.attempts), error: desc };
    } catch (error) {
      this.log(`sender: transport error: ${error.message}`);
      return { ok: false, waitMs: this.backoff(entry.attempts), error: error.message };
    }
  }

  /** Upload one local file as a photo/document message. */
  async sendAttachment(entry) {
    const payload = entry.payload;
    let bytes;
    try {
      bytes = fs.readFileSync(payload.path);
    } catch (error) {
      this.log(`sender: cannot read ${payload.path}: ${error.message}`);
      return { ok: false, description: `cannot read file ${payload.path}` };
    }
    const limit = this.config.maxUploadBytes ?? 50 * 1024 * 1024;
    if (bytes.length > limit) {
      this.log(`sender: ${payload.path} is ${bytes.length} bytes, over the ${limit} byte limit`);
      return { ok: false, description: "file too large" };
    }
    const fields = { chat_id: payload.chatId };
    if (payload.caption) fields.caption = String(payload.caption).slice(0, 1000);
    if (payload.replyToMessageId) {
      fields.reply_parameters = JSON.stringify({ message_id: payload.replyToMessageId, allow_sending_without_reply: true });
    }
    const method = entry.kind === "photo" ? "sendPhoto" : "sendDocument";
    return this.api.upload(method, fields, {
      field: entry.kind === "photo" ? "photo" : "document",
      bytes,
      filename: path.basename(payload.path),
      contentType: mimeFor(payload.path),
    });
  }

  backoff(attempts) {
    const table = this.config.backoffMs || [1000, 4000, 16000];
    return table[Math.min(attempts, table.length - 1)] || 16000;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
