// @deepseek-hermes/dsh-telegram — Host plugin entry.
// A Telegram Bot API bridge for DeepSeek Harness agents.

import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

import { TelegramBridge } from "./lib/bridge.js";

export const inject = ["agents", "systemPrompt"];
export const name = "telegram";

const DEFAULTS = {
  token: "",
  proxy: "",
  proxies: [],
  proxyProbeIntervalMs: 60000,
  proxyProbeTimeoutMs: 5000,
  baseUrl: "https://api.telegram.org",
  allowedUserIds: [],
  allowAllUsers: false,
  allowGroups: false,
  provider: "deepseek-account",
  model: "deepseek-flash",
  reasoningEffort: "high",
  maxTokens: null,
  pollingTimeoutSec: 30,
  streaming: "draft", // draft | edit | off
  draftThrottleMs: 300,
  maxMessageLength: 4096,
  entityBudget: 90,
  richMessages: true, // sendRichMessage (Bot API 10.1+), auto-falls back to HTML
  promptSection: true, // teach the model how this surface renders
  media: true, // download incoming photo/document/voice and hand the path to the agent
  mediaDir: "", // default: <state dir>/inbox
  maxDownloadBytes: 20 * 1024 * 1024,
  maxUploadBytes: 50 * 1024 * 1024,
  voiceTranscribe: true, // send voice notes to the local Whisper service
  whisperUrl: "http://127.0.0.1:8777",
  whisperLanguage: "zh",
  whisperTimeoutMs: 120000,
  reactions: "👀", // ack reaction on receive; false disables
  replyToUser: true, // reply_parameters on the first chunk of each answer
  typing: true,
  retryMax: 3,
  backoffMs: [1000, 4000, 16000],
  sendSpacingMs: 1050,
  maxQueuePerChat: 8,
  startupMessage: true,
  statePath: "",
  logPath: "",
};

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (!cfg.token) cfg.token = process.env.DSH_TELEGRAM_TOKEN || "";
  if (!cfg.token) throw new Error("telegram: missing bot token (config.token or DSH_TELEGRAM_TOKEN)");
  if (!Array.isArray(cfg.allowedUserIds)) cfg.allowedUserIds = [];
  if (cfg.allowedUserIds.length === 0 && !cfg.allowAllUsers) {
    throw new Error("telegram: fail-closed — set allowedUserIds or allowAllUsers");
  }

  const home = process.env.DSH_HOME || path.join(homedir(), ".dsh");
  const statePath = cfg.statePath || path.join(home, "storages", "dsh-telegram-state.json");
  const logPath = cfg.logPath || path.join(path.dirname(statePath), "dsh-telegram.log");
  cfg.statePath = statePath;
  cfg.logPath = logPath;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  const state = loadState(statePath);
  const log = makeLogger(logPath);
  log(`telegram: state loaded from ${statePath} chats=${Object.keys(state.chats).length} offset=${state.offset}`);
  if (cfg.debug && !globalThis.__tgFetchWrapped) {
    globalThis.__tgFetchWrapped = true;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const startedAt = Date.now();
      const label = typeof input === "string" ? input : input?.url || String(input).slice(0, 120);
      try {
        const response = await origFetch(input, init);
        log(`debug fetch ${response.status} ${Date.now() - startedAt}ms ${String(label).slice(0, 120)}`);
        return response;
      } catch (error) {
        const url = typeof input === "string" ? input : input?.url || String(input).slice(0, 100);
        const cause = error?.cause;
        log(`debug fetch fail ${String(url).slice(0, 100)} :: ${error?.message} | cause=${cause?.message} code=${cause?.code || ""}`);
        throw error;
      }
    };
  }
  const bridge = new TelegramBridge(ctx, cfg, state, log);
  bridge.stateSave = () => saveState(statePath, state);

  if (cfg.promptSection !== false && ctx.systemPrompt?.section) {
    try {
      ctx.systemPrompt.section({ name: "telegram-surface", order: 9000, text: surfacePrompt(cfg), interpolate: false });
      log("telegram: surface prompt section registered");
    } catch (error) {
      log(`telegram: prompt section failed: ${error.message}`);
    }
  }

  ctx.effect(() => {
    bridge.start();
    return () => void bridge.stop();
  });
}

/**
 * Tell the model what this surface is and how its Markdown is rendered.
 * Registered through the runtime's system-prompt service so it applies to
 * every session this runtime hosts.
 */
export function surfacePrompt(config) {
  const rich = config.richMessages !== false && config.richMessages !== "off";
  const renderLine = rich
    ? "The host renders your Markdown as a Telegram rich message: headings, bullet/ordered/task lists, tables, blockquotes, fenced code and math are native."
    : "The host renders your Markdown into Telegram HTML: headings become bold lines, lists become " +
      "bullets, and tables become monospace blocks or key/value rows.";

  return [
    "## Telegram surface",
    "",
    "You are replying inside a Telegram private chat. Messages are chat bubbles on a phone, not documents.",
    renderLine,
    "Supported inline: **bold**, *italic*, ~~strikethrough~~, ||spoiler||, `inline code`, [links](https://example.com), and fenced code blocks with a language tag.",
    "Raw HTML tags are escaped and appear literally — never emit them.",
    "",
    "Writing rules for this surface:",
    "- Answer in the first sentence. Drop preambles such as \"Sure\", \"Here is\", or a restatement of the question.",
    "- Keep paragraphs to 1-3 sentences, separated by a blank line.",
    "- Use short bullet lists for steps and options; use a table only for a small comparison (4 columns or fewer, short values).",
    "- Always fence code with a language tag; keep identifiers and paths inline as `code`.",
    "- Stay under ~3500 characters per reply. If the task genuinely needs more, give the conclusion and the immediate next step, then offer to continue.",
    "- Never wrap the whole answer in a single code block; never use emoji as list bullets.",
    "",
    "Attachments:",
    "- Incoming photos and files are saved to disk and announced in the user message with an absolute path; use `read_image` or `read` on that path.",
    "- Voice notes are transcribed automatically and arrive as `[语音转写] …`; treat that text as what the user said.",
    "- To send a file or screenshot back, emit `[[file:/absolute/path|caption]]` or `[[photo:/absolute/path|caption]]` on its own line. The host uploads it and removes the marker; never invent paths.",
    "- To offer tappable choices, emit `[[buttons:label=action|label2=/new]]` on its own line (max 8). An action is either text to send as the next user message or a built-in `/new`, `/stop`, `/status`, `/help`.",
  ].join("\n");
}

export function makeLogger(logPath) {
  const write = (line) => {
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // logging must never break the bridge
    }
  };
  return (message) => {
    try {
      console.error(`[dsh-telegram] ${message}`);
    } catch {
      /* ignore */
    }
    write(message);
  };
}

export function loadState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    if (parsed && typeof parsed === "object") {
      return {
        schemaVersion: 1,
        chats: parsed.chats || {},
        offset: Number(parsed.offset || 0),
        outbox: Array.isArray(parsed.outbox) ? parsed.outbox : [],
      };
    }
  } catch {
    // first run or corrupt file
  }
  return { schemaVersion: 1, chats: {}, offset: 0, outbox: [] };
}

export function saveState(statePath, state) {
  try {
    const tmp = `${statePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, statePath);
  } catch (error) {
    // best-effort persistence
    try {
      console.error(`[dsh-telegram] state save failed: ${error.message}`);
    } catch {
      /* ignore */
    }
  }
}
