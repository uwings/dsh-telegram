# dsh-telegram-channel

把 Telegram 接成 DeepSeek Harness (DSH) 的对话渠道：长轮询、按 chat 保会话、富文本渲染、媒体收发、语音转写、行内按钮。

完整文档、配置表与测试说明见仓库根目录：[README](https://github.com/uwings/dsh-telegram#readme)。

## 安装

在 profile 的 `cordis.patch.yml` 里加：

```yaml
- id: telegram
  name: 'dsh-telegram-channel'
  config:
    token: ''
    allowedUserIds: [123456789]
```

`token` 留空时读 `DSH_TELEGRAM_TOKEN`。

## 能力

- 富消息（`sendRichMessage`）与 HTML 自动降级
- 图片/文件/语音入站落盘，`[[file:…]]`/`[[photo:…]]` 出站 multipart 上传
- 语音转写（兼容 `/transcribe` 的本地 Whisper 服务）
- `[[buttons:…]]` 行内键盘与一次性回调
- 引用回复、👀 回执、`setMyCommands` 命令菜单
- 代理健康池、重试账本、outbox 重启重放

## License

MIT
