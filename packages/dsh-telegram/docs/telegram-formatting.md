# Telegram 渲染能力与插件映射

本文件是 `lib/format.js` 与 `index.js` 里 surface prompt 的事实依据。上游文档（Bot API 10.3，2026-08）：

- 格式化：<https://core.telegram.org/bots/api/formatting.md>
- 富消息：<https://core.telegram.org/bots/api/rich-messages.md>
- sendRichMessage：<https://core.telegram.org/bots/api/methods/sendrichmessage.md>
- sendMessageDraft：<https://core.telegram.org/bots/api/methods/sendmessagedraft.md>
- sendMessage：<https://core.telegram.org/bots/api/methods/sendmessage.md>

## 1. 普通文本消息（sendMessage / editMessageText / sendMessageDraft）

`text` 解析后 1–4096 个 UTF-16 单元；`parse_mode` 取 `HTML` / `MarkdownV2` / `Markdown`（legacy）。

### HTML 模式支持的标签（只有这些）

| 目的 | 标签 |
|---|---|
| 粗体 | `<b>` / `<strong>` |
| 斜体 | `<i>` / `<em>` |
| 下划线 | `<u>` / `<ins>` |
| 删除线 | `<s>` / `<strike>` / `<del>` |
| 剧透 | `<span class="tg-spoiler">` / `<tg-spoiler>` |
| 行内链接 | `<a href="...">`（`tg://user?id=` 可 @ 用户） |
| 自定义 emoji | `<tg-emoji emoji-id="...">👍</tg-emoji>` |
| 时间 | `<tg-time unix="..." format="wDT">` |
| 行内代码 | `<code>` |
| 代码块 | `<pre>…</pre>`，带语言用 `<pre><code class="language-python">…</code></pre>` |
| 引用 | `<blockquote>`、`<blockquote expandable>`（默认折叠） |

注意：

- `<` `>` `&` 必须转义成 `&lt;` `&gt;` `&amp;`；命名实体只支持 `&lt;` `&gt;` `&amp;` `&quot;`。
- 没有标题、列表、表格的实体 —— 这些只能降级成加粗行、项目符号、等宽块。
- 嵌套规则：`bold/italic/underline/strikethrough/spoiler` 之间可互相嵌套，但**都不能包含也不能被 `code`/`pre` 包含**；`blockquote` 不能嵌套。违反会直接 400 `can't parse entities`。
- 语言标签只对 `pre` 生效，单独的 `code` 不能带 class。

### MarkdownV2 要点（本插件不用，仅备查）

`_ * [ ] ( ) ~ \` > # + - = | { } . !` 都要反斜杠转义；`pre`/`code` 内还要转义 `\` 和反引号；链接括号内转义 `)` 和 `\`。转义规则比 HTML 更容易炸，因此插件统一走 HTML。

### 草稿流式

`sendMessageDraft` 仅私聊：`draft_id` 非 0 整数，`text` 0–4096，可带 `parse_mode`/`entities`，`can_stop` 显示"停止"按钮（用户点按会回 `stopped_message_generation` 更新）。草稿是 30 秒临时预览，**最终必须再调 sendMessage** 才留下消息。

## 2. 富消息（sendRichMessage，Bot API 10.1+）

`rich_message` 是 `InputRichMessage`，`markdown` / `html` / `blocks` **三选一**。没有 `parse_mode`，也没有 `link_preview_options`。

### 限制

| 限制 | 值 |
|---|---|
| 文本 | 32768 UTF-8 字符 |
| 块 | 500（含嵌套、列表项、表格行） |
| 嵌套层级 | 16 |
| 媒体附件 | 50 |
| 表格列数 | 20 |

### 富 Markdown 语法（比普通 Markdown 多很多）

```
# 一到六级标题          **粗** / __粗__      *斜* / _斜_
~~删除线~~              ==标记==             ||剧透||
`行内代码`              ```python 代码块```   [链接](https://t.me)
- 无序 / 1. 有序 / - [x] 任务
> 引用（空行用 > 分段）
| 表头 | 表头 |         |:---|---:| 对齐
---                     分隔线
![](https://…/a.jpg "说明")   图片/视频/音频/文件
$行内公式$              $$块公式$$          ```math
[^1] 脚注 + [^1]: 定义
<details><summary>…</summary>…</details>   折叠块
<u>下划线</u> <sub>…</sub> <sup>…</sup> <tg-spoiler>…</tg-spoiler>
```

支持内联 HTML 标签，也支持 `<tg-button>`/`<tg-button-row>` 做行内按钮。**因为富消息能解析 HTML，插件在把模型输出转成 rich markdown 时会把 `<` `>` 转义**，避免模型输出注入 `<tg-button>` 之类的标签。

### 降级

`sendRichMessage` 返回 400/404 时，sender 把同一条内容的 HTML 版本 (`fallbackHtml`) 用 `sendMessage` 发出；若错误描述是 method not found 一类，本进程后续直接走 HTML，不再尝试。

## 3. 插件的映射表

模型输出的是普通 Markdown，`lib/format.js` 解析成块再分别渲染：

| Markdown | HTML 模式（fallback / rich 关闭） | 富消息模式 |
|---|---|---|
| `# 标题` … `######` | `<b>标题</b>` | `# 标题`（原生标题） |
| `**粗**` `*斜*` `~~删~~` `\|\|剧透\|\|` | `<b>` `<i>` `<s>` `<span class="tg-spoiler">` | 原样 |
| `` `code` `` / 围栏代码块 | `<code>` / `<pre><code class="language-x">` | 原样（保留语言） |
| `- 项` / `1. 项` / `- [x] 项` | `• ` / `1. ` / `☑ ☐` | 原生列表 / 任务列表 |
| `> 引用` | `<blockquote>`（>6 行自动 `expandable`） | 原生引用 |
| `\| 表格 \|` | 窄表 → `<pre>` 等宽表格；宽表/多列 → `• 键: 值 · …` | 原生表格 |
| `[文字](url)` | `<a href>`，只放行 http/https/tg/mailto/tel | 原样 |
| `---` | `────────` | `---` |
| `![](img)` | 链接文字 | 原生图片（若 URL 可抓取） |

分块规则：按块聚合，单条不超 4096 字符 / 90 实体（可配）；超长代码块会被拆开并**重新补上围栏**，任何一块都不会出现半个标签或半个代码块。

草稿流式（`streaming: draft`）与 `edit` 流式用 `toPlainText()` 渲染：预览里不会出现 `**` 这类源码，最终消息才带格式。

## 4. 已知限制

- 普通 HTML 消息没有表格/标题实体，宽表只能降级成列表；要真正的表格必须走富消息。
- 富消息 2026-06 才进 Bot API；过旧的客户端或服务器会拒绝，插件自动退回 HTML。
- 一条消息最多 4096 字符（HTML 模式）；更长的回答被切成多条并带 `(1/n)` 编号。
