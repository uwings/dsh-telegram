#!/usr/bin/env node
// Regenerate market/index.json for the current package version at HEAD.
//
// Release flow:
//   1. bump packages/dsh-telegram/package.json version
//   2. commit that bump (the commit is pinned by the index)
//   3. node scripts/build-index.mjs
//   4. commit market/index.json and push; GitHub Pages serves it.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "packages", "dsh-telegram", "package.json"), "utf8"));

// GIT_COMMIT is an escape hatch for environments where spawning git is blocked.
const commit = process.env.GIT_COMMIT || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
const dirty = process.env.GIT_COMMIT
  ? ""
  : execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString().trim();

if (dirty) {
  console.warn("warning: working tree has uncommitted changes; the index still pins HEAD, commit first.");
}

const index = {
  format: 1,
  title: { en: "dsh-telegram", zh: "dsh-telegram" },
  description: {
    en: "Telegram channel plugin for DeepSeek Harness",
    zh: "DeepSeek Harness 的 Telegram 通道插件",
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: "dsh-telegram-channel", zh: "dsh-telegram-channel" },
      description: {
        en: "Rich messages, media in and out, voice transcription, inline buttons, per-chat sessions.",
        zh: "富文本、媒体收发、语音转写、行内按钮、按会话隔离。",
      },
      icon: `https://raw.githubusercontent.com/uwings/dsh-telegram/${commit}/packages/dsh-telegram/icon.svg`,
      author: "uwings",
      homepage: "https://github.com/uwings/dsh-telegram#readme",
      repository: { url: "https://github.com/uwings/dsh-telegram", directory: "packages/dsh-telegram" },
      metadata: { keywords: ["telegram", "telegram-bot", "channel", "deepseek-harness", "chatbot"] },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: { type: "git", url: "https://github.com/uwings/dsh-telegram", commit, path: "packages/dsh-telegram" },
          engines: { dsh: pkg.engines?.dsh ?? ">=0.2.1 <0.3.0" },
        },
      ],
    },
  ],
};

fs.writeFileSync(path.join(root, "market", "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
console.log(`market/index.json -> ${pkg.name}@${pkg.version} (${commit.slice(0, 8)})`);
