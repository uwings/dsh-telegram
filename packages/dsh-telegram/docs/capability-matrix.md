# Telegram 能力覆盖对比（Bot API 10.3）

以 <https://core.telegram.org/bots/api> 的方法清单为基准，对照 `packages/dsh-telegram` 现状。
✅ 已实现　🟡 部分/可低成本补　⬜ 可做但未做　➖ 与本场景无关

## A. 消息与格式

| 能力 | 方法 | 状态 | 说明 |
|---|---|---|---|
| 文本/富文本 | `sendMessage` / `sendRichMessage` | ✅ | 富消息优先，HTML 自动降级 |
| 格式化 | `parse_mode=HTML` | ✅ | 标题/列表/表格/引用/代码/剧透/链接 |
| 草稿流式 | `sendMessageDraft` | ✅ | 纯文本预览，可带停止按钮 |
| 富文本草稿流式 | `sendRichMessageDraft` | ⬜ | 草稿也带格式；部分 Markdown 会让富解析报错，暂缓 |
| 编辑消息 | `editMessageText` | ✅ | `streaming: edit` 兜底路径 |
| 删除消息 | `deleteMessage` | ⬜ | 清理占位/临时消息用 |
| 引用回复 | `reply_parameters` | ✅ | 回复首条带引用；`replyToUser: false` 可关 |
| 链接预览 | `link_preview_options` | ⬜ | HTML 模式可关预览；rich 不支持该字段 |
| 静默/保护/特效 | `disable_notification` / `protect_content` / `message_effect_id` | ⬜ | 加配置项即可 |

## B. 媒体

| 能力 | 方法 | 状态 | 说明 |
|---|---|---|---|
| 收图片 | `getFile` + `/file/bot…` | ✅ | 落盘到 `mediaDir/<chat>/`，消息里给绝对路径 |
| 收文件 | 同上 | ✅ | 文档、压缩包、日志都可以 |
| 收语音/音频/视频 | `getFile` + 本机 Whisper | ✅ | 语音转写后当用户消息；转写失败退回路径 |
| 发图片 | `sendPhoto`（multipart） | ✅ | `[[photo:/abs/path|caption]]` |
| 发文件 | `sendDocument`（multipart） | ✅ | `[[file:/abs/path|caption]]` |
| 发语音/音频 | `sendVoice` / `sendAudio` | ⬜ | 结构同上，补两个分支即可 |
| 相册 | `sendMediaGroup` | ⬜ | 多图 |
| 贴纸/位置/联系人/投票/骰子 | `sendSticker` / `sendLocation` / `sendContact` / `sendPoll` / `sendDice` | ➖ | 场景弱 |

## C. 交互

| 能力 | 方法 | 状态 | 说明 |
|---|---|---|---|
| 命令菜单 | `setMyCommands` | ✅ | 启动时注册 5 个命令（含 zh-hans） |
| 输入状态 | `sendChatAction` | ✅ | 固定 `typing` |
| 表情回应 | `setMessageReaction` | ✅ | 收到消息回 `👀` |
| 行内按钮 | `inline_keyboard` | ✅ | `[[buttons:继续=继续\|新会话=/new]]`，最多 8 个 |
| 回调 | `callback_query` + `answerCallbackQuery` | ✅ | 一次性键盘；token 内存 TTL 1 小时，`callback_data` 14 字节 |
| Mini App / Web App | `web_app` 按钮 | ➖ | 与 DSH 桌面端重叠 |
| Inline 模式 | `answerInlineQuery` | ➖ | 需要 BotFather 开启，场景不符 |

## D. 会话与群聊

| 能力 | 状态 | 说明 |
|---|---|---|
| 私聊多会话 | ✅ | 按 `chat_id` 映射，持久化 |
| 群聊 | 🟡 | `allowGroups` 开关在，但成员鉴权未验证 |
| 论坛话题 | ⬜ | `message_thread_id` 全链路透传即可 |
| 编辑消息重生成 | ⬜ | `edited_message` 目前忽略 |
| 多用户隔离 | 🟡 | 白名单可用；无 per-user 配额 |

## E. 无关能力（不建议投入）

支付/Stars、礼物、Stories、Passport、Games、Business 账号、Ephemeral messages（仅群聊）、频道管理、贴纸集管理、Chat 管理（禁言/踢人/邀请链接）。

## 建议路线

已落地：富文本 + HTML 降级、入站媒体下载、出站 multipart 上传、语音转写（本机 Whisper）、引用回复、表情回应、命令菜单、行内按钮与回调。

1. **静默/预览/特效**（P1，配置项）：`disable_notification`、`link_preview_options`、`message_effect_id`。
2. **出站语音**（P2）：`sendVoice`/`sendAudio` 两个分支，复用现有 multipart。
3. **群聊/话题**（P2）：`message_thread_id` 透传 + 群成员鉴权。
4. **富文本草稿**（P3）：等上游富解析对半截 Markdown 更宽容再做。
5. **审批按钮**（P3）：把 DSH 的 `ask_user_question` 直接映射成按钮，而不只是文本动作。

## 测试

- `node tests/format.test.mjs` / `sender.test.mjs` / `bridge.test.mjs` / `media.test.mjs` / `buttons.test.mjs` / `buttons-bridge.test.mjs` / `whisper.test.mjs` / `status.test.mjs` / `portability.test.mjs` — 共 78 项
- `python tests/e2e_telegram_plugin.py` — 真运行时 + 假 Bot API，含图片下载用例

## 参考

- 方法总表：<https://core.telegram.org/bots/api#available-methods>
- 富消息：<https://core.telegram.org/bots/api/rich-messages.md>
- 格式化：<https://core.telegram.org/bots/api/formatting.md>
