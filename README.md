# dsh-telegram-channel

Telegram 通道插件，npm 包名 `dsh-telegram-channel`。仓库名沿用 `dsh-telegram`——这个 npm 名字已被另一个同类项目占用，所以包名加了 `-channel` 后缀。

[![tests](https://github.com/uwings/dsh-telegram/actions/workflows/tests.yml/badge.svg)](https://github.com/uwings/dsh-telegram/actions/workflows/tests.yml)

把 Telegram 接成 **DeepSeek Harness (DSH)** 的一条对话渠道。长轮询收发、按 chat 保会话、富文本渲染、图片/文件/语音双向、行内按钮、发送重试账本。

> A Telegram Bot API channel plugin for DeepSeek Harness: rich messages, media in/out, voice transcription, inline buttons, per-chat sessions.

## 特性

| 能力 | 说明 |
|---|---|
| 富文本 | 标题、列表、任务列表、表格、引用、代码块、公式走 `sendRichMessage`；被服务器拒绝时自动用 HTML 重发 |
| 会话 | `chat_id` 映射到 DSH session，持久化；重启后 `resume` 接上下文 |
| 流式 | `sendMessageDraft` 草稿预览，可带原生「停止」按钮 |
| 媒体 | 收 `photo`/`document`/`voice`/`audio`/`video`，落盘后把路径交给 agent；出站 `sendPhoto`/`sendDocument` multipart 上传 |
| 语音 | 语音落盘后 POST 到本机 Whisper，转写文本作为用户消息 |
| 按钮 | `[[buttons:…]]` 生成行内键盘；`callback_query` 一次性消费，点完自动移除 |
| 交互 | 引用回复触发消息、收到消息回 👀、`setMyCommands` 命令菜单 |
| 稳定性 | 代理健康池、瞬时错误快重试、429 退避、outbox 重启重放、409 冲突检测 |

## 架构

```
Telegram ──getUpdates(long poll)──▶ Bridge ──agents.create/resume──▶ DSH runtime
                                     ├── Sender      发送队列 / 限流 / 重试账本
                                     ├── format.js   Markdown → rich / HTML / plain
                                     ├── media.js    附件识别、落盘、指令解析
                                     ├── whisper.js  本机语音转写客户端
                                     └── state.json  offset、chat→session、outbox
```

插件以 DSH Host Plugin 形式加载：`inject: ["agents", "systemPrompt"]`，通过 `ctx.systemPrompt.section()` 向模型注入当前界面的渲染规则。

## 安装

要求：DSH runtime（Node 20+）、一个 Telegram bot token。

### 从插件市场安装

DSH 的 Discover 读取的是用户配置的 index URL。本仓库自带一个：

```
https://uwings.github.io/dsh-telegram/market/index.json
```

在 Settings → Plugins 里加入这个 URL，然后搜索 `dsh-telegram-channel` 安装即可（source 是 npm，`dsh-telegram-channel@0.5.1`）。

也可以直接在 profile 目录 `pnpm add dsh-telegram-channel@0.5.1`。

### 手动安装

1. 把 `packages/dsh-telegram` 放进你的工作区，并在 profile 的 `package.json` 里用 `link:` 指向它。
2. 在 profile 的 `cordis.patch.yml` 加一段：

```yaml
- id: telegram
  name: 'dsh-telegram-channel'
  config:
    token: ''                      # 留空则读 DSH_TELEGRAM_TOKEN
    allowedUserIds: [123456789]    # 必填或显式 allowAllUsers: true
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: high
    proxies: ['http://127.0.0.1:7890', '']   # 代理 + 直连候选
    statePath: C:/path/to/state/telegram/plugin-state.json
    logPath: C:/path/to/state/telegram/plugin.log
```

3. 启动 runtime。日志出现 `authenticated as @your_bot` 即接通。

> 同一个 bot token 同时只能有一个 `getUpdates` 轮询者，两个会互相踢出（409）。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `token` | 空 | Bot token；也可用 `DSH_TELEGRAM_TOKEN` |
| `baseUrl` | `https://api.telegram.org` | 测试时指向假服务器 |
| `proxies` | `[]` | HTTP CONNECT 代理候选，`''` 表示直连；按健康度轮转 |
| `allowedUserIds` | `[]` | 白名单，空且未开 `allowAllUsers` 时启动即报错 |
| `allowGroups` | `false` | 是否响应群聊 |
| `provider` / `model` / `reasoningEffort` | `deepseek-account` / `deepseek-flash` / `high` | 新建 agent 的模型路由 |
| `streaming` | `draft` | `draft` 草稿流式；`edit` 占位消息编辑；`off` 只在结束时发 |
| `richMessages` | `true` | 富消息；失败自动回退 HTML |
| `promptSection` | `true` | 向 system prompt 注入界面渲染规则 |
| `media` | `true` | 下载入站附件 |
| `mediaDir` | `<state 目录>/inbox` | 附件保存目录，按 chat 分子目录 |
| `maxDownloadBytes` | 20 MB | 单文件下载上限 |
| `maxUploadBytes` | 50 MB | 单文件上传上限 |
| `voiceTranscribe` | `true` | 语音转写开关 |
| `whisperUrl` | `http://127.0.0.1:8777` | 本机 Whisper 服务地址 |
| `whisperLanguage` | `zh` | 转写语言 |
| `reactions` | `👀` | 收到消息的回执表情；`false` 关闭 |
| `replyToUser` | `true` | 回复时引用触发消息 |
| `retryMax` / `backoffMs` | `3` / `[1000,4000,16000]` | 发送重试 |
| `sendSpacingMs` | `1050` | 单 chat 发送间隔 |
| `debug` | `false` | 事件与错误链日志 |

## 命令

`/start` `/new` `/stop` `/status` `/help`，启动时通过 `setMyCommands` 注册到客户端菜单。

`/status` 输出运行时长、会话数、轮询状态、渲染模式、语音服务状态、冲突情况。

## 渲染

同一份 Markdown 有两条渲染路径：

- **富消息**（Bot API 10.1+）：标题、列表、任务列表、表格、引用、代码语言、公式原生渲染，单条上限 32768 字符 / 500 块。
- **HTML 降级**：`<b>` `<i>` `<s>` `<code>` `<pre><code class="language-x">` `<blockquote>` `<a>` 等；标题变粗体行，列表变 `•`，窄表变等宽 `<pre>` 表，宽表变键值行。单条 4096 字符。

分块按块级边界进行，长代码块会拆开并重新补围栏，不会出现半个标签或半截代码块。草稿预览用纯文本，最终消息才带格式。

细节见 [docs/telegram-formatting.md](packages/dsh-telegram/docs/telegram-formatting.md)。

## 媒体

入站：图片、文件、语音、音频、视频下载到 `mediaDir/<chat_id>/`，消息里带上绝对路径与类型。图片可用 `read_image` 读取，文件用 `read`。

出站：回答里写

```
[[file:/absolute/path/report.pdf|季度报告]]
[[photo:/absolute/path/chart.png|趋势图]]
```

插件会去掉标记并用 multipart 上传（Bot API 不接受本地路径）。标记单独成行，最多各发一条消息。

## 语音

`voice`/`audio` 落盘后 POST 到 `whisperUrl` 的 `/transcribe`（字段 `audio`，可选 `language`），转写文本以 `[语音转写] …` 作为用户消息派发。服务不可用时只保留附件路径，不影响其它消息；启动时探活并在 `/status` 里显示 `ready` / `unavailable`。

Whisper 服务本身不在本仓库内，任何兼容以下接口的实现都可以：

```
GET  /health      -> {"status":"ok","model":"...","device":"..."}
POST /transcribe  -> {"text":"...","language":"zh","duration":3.2}
```

## 按钮

```
[[buttons:继续=继续|新会话=/new|状态=status]]
```

最多 8 个，两列排布。动作可以是任意文本（点击后作为下一条用户消息），也可以是内置的 `new` / `stop` / `status` / `help` 或以 `/` 开头的命令。`callback_data` 只存 14 字节的内存 token，点击后立即失效并移除键盘。

## 测试

```bash
node tests/format.test.mjs
node tests/sender.test.mjs
node tests/bridge.test.mjs
node tests/media.test.mjs
node tests/buttons.test.mjs
node tests/buttons-bridge.test.mjs
node tests/whisper.test.mjs
node tests/status.test.mjs
node tests/portability.test.mjs
```

共 78 项，覆盖格式化、分块、multipart 上传、附件落盘、按钮解析与回调、Whisper 客户端（起真实本地 HTTP 服务）、`/status`、跨平台守卫。

端到端（需要 DSH runtime 与真实模型凭证）：

```bash
python tests/e2e_telegram_plugin.py
```

会启动一个隔离 profile，指向本地假 Bot API，跑通多轮对话、`/stop`、图片落盘。

## 发布（维护者）

1. 改 `packages/dsh-telegram/package.json` 的 `version`，提交这一步。
2. `node scripts/build-index.mjs` —— 把该版本的 `name@version` 和当前 commit 写进 `market/index.json`（受限环境可传 `GIT_COMMIT=<sha>`）。
3. 提交并推送；GitHub Pages 会自动发布新的 index。
4. 可选：`npm publish --access public`（先 `npm login`，`@uwings` scope）。

index 地址：`https://uwings.github.io/dsh-telegram/market/index.json`

## 限制

- 一个 bot token 只能有一个轮询者；切换部署时要先停旧的。
- 群聊与论坛话题尚未验证；当前以私聊为主。
- 富消息依赖较新客户端，旧客户端请设 `richMessages: false`。
- 只有长轮询，没有 webhook 模式。

路线图与能力对照见 [docs/capability-matrix.md](packages/dsh-telegram/docs/capability-matrix.md)。

## License

MIT
