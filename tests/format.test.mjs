import test from "node:test";
import assert from "node:assert/strict";

import {
  escapeHtml,
  markdownToHtml,
  splitMessage,
  splitRichWithFallback,
  toPlainText,
  toRichMarkdown,
  countEntities,
  chunkText,
} from "../packages/dsh-telegram/lib/format.js";

test("escapeHtml escapes the three structural entities", () => {
  assert.equal(escapeHtml('& < > " \''), "&amp; &lt; &gt; \" '");
});

test("bold and inline code convert", () => {
  const { html } = markdownToHtml("**粗体** 和 `code`");
  assert.equal(html, "<b>粗体</b> 和 <code>code</code>");
});

test("italics, strike, spoiler and bold-italic render", () => {
  const { html } = markdownToHtml("*斜* ~~删~~ ||剧透|| ***粗斜***");
  assert.equal(html, "<i>斜</i> <s>删</s> <span class=\"tg-spoiler\">剧透</span> <b><i>粗斜</i></b>");
});

test("headings become bold lines", () => {
  const { html } = markdownToHtml("## 小结\n正文");
  assert.equal(html, "<b>小结</b>\n\n正文");
});

test("links render as anchors and unsafe schemes are dropped", () => {
  assert.equal(markdownToHtml("[文档](https://t.me)").html, '<a href="https://t.me">文档</a>');
  assert.equal(markdownToHtml("[x](javascript:alert(1))").html, "x");
});

test("bullet, ordered and task lists flatten to text markers", () => {
  const { html } = markdownToHtml("- 甲\n- 乙\n\n1. 一\n2. 二\n\n- [x] 完\n- [ ] 未完");
  assert.equal(html, "• 甲\n• 乙\n\n1. 一\n2. 二\n\n• ☑ 完\n• ☐ 未完");
});

test("blockquotes use the blockquote entity", () => {
  assert.equal(markdownToHtml("> 引用 **粗**").html, "<blockquote>引用 <b>粗</b></blockquote>");
});

test("tables become a monospace block when narrow", () => {
  const { html } = markdownToHtml("| 指标 | 值 |\n|:--|--:|\n| 延迟 | 1.2s |");
  assert.ok(html.startsWith("<pre>"), html);
  assert.ok(html.includes("指标"));
  assert.ok(html.includes("1.2s"));
  assert.ok(html.includes("┼"));
});

test("wide tables degrade to bullet rows", () => {
  const row = (n) => `| a${n} | b${n} | c${n} | d${n} | e${n} |`;
  const md = [row(1), "|:--|:--|:--|:--|:--|", row(2)].join("\n");
  const { html } = markdownToHtml(md);
  assert.ok(html.startsWith("• "), html);
  assert.ok(!html.includes("<pre>"));
});

test("fenced code block becomes pre with language class", () => {
  const { html } = markdownToHtml("```js\nconst a = 1;\n```");
  assert.ok(html.includes('<pre><code class="language-js">const a = 1;</code></pre>'));
});

test("fenced block content keeps entities escaped", () => {
  const { html } = markdownToHtml("```\n<b>\n```");
  assert.ok(html.includes("&lt;b&gt;"));
});

test("an unclosed fence still renders as code", () => {
  const { html } = markdownToHtml("```js\nconst a = 1;");
  assert.ok(html.includes("<pre>"));
  assert.ok(html.includes("const a = 1;"));
  assert.ok(!html.includes("```"));
});

test("plain input is escaped", () => {
  const { html } = markdownToHtml("1 < 2 & 3 > 0");
  assert.equal(html, "1 &lt; 2 &amp; 3 &gt; 0");
});

test("code inside bold is split out (Telegram forbids nesting)", () => {
  const { html } = markdownToHtml("**看 `x` 这里**");
  assert.equal(html, "<b>看 </b><code>x</code><b> 这里</b>");
  assert.equal(countEntities(html), 3);
});

test("snake_case is not italicised", () => {
  assert.equal(markdownToHtml("snake_case_name").html, "snake_case_name");
});

test("toPlainText strips markers and keeps content", () => {
  const plain = toPlainText("## 标题\n**粗** 和 `code`\n\n- 列表");
  assert.equal(plain, "标题\n\n粗 和 code\n\n• 列表");
});

test("toRichMarkdown keeps headings, lists and tables", () => {
  const md = toRichMarkdown("## 标题\n\n- 甲\n\n| a | b |\n|:--|--:|\n| 1 | 2 |");
  assert.ok(md.includes("## 标题"));
  assert.ok(md.includes("- 甲"));
  assert.ok(md.includes("| a | b |"));
  assert.ok(md.includes("| :--- | ---: |"));
});

test("toRichMarkdown neutralises raw HTML tags", () => {
  const md = toRichMarkdown("hello <script>alert(1)</script>");
  assert.ok(!md.includes("<script>"));
  assert.ok(md.includes("&lt;script&gt;"));
});

test("splitMessage cuts at newline then 句号", () => {
  const long = "A".repeat(3000) + "\n" + "B".repeat(1500);
  const chunks = splitMessage(long, { maxLength: 4096, markdown: false });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text.endsWith("A"), true);
  assert.equal(chunks[1].text, "\n" + "B".repeat(1500));
});

test("splitMessage renders html chunks and falls back when over budget", () => {
  const text = "**x**".repeat(2000);
  const chunks = splitMessage(text, { maxLength: 4096, entityBudget: 5, markdown: true });
  assert.ok(chunks.length >= 1);
  for (const chunk of chunks) assert.ok(chunk.kind === "html" || chunk.kind === "plain");
});

test("html chunk entity count respects budget", () => {
  const { html, entities } = markdownToHtml("**a** `b` **c**");
  assert.equal(entities, 3);
  assert.equal(html, "<b>a</b> <code>b</code> <b>c</b>");
});

test("every chunk stays inside the length budget and keeps tags balanced", () => {
  const paragraph = "这是一段比较长的说明文字，**加粗** 和 `code` 交替出现。".repeat(400);
  const code = "```python\n" + "print('x')\n".repeat(400) + "```";
  const chunks = splitMessage(`${paragraph}\n\n${code}`, { maxLength: 4096, entityBudget: 90 });
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 4096, `chunk too long: ${chunk.text.length}`);
    if (chunk.kind !== "html") continue;
    for (const tag of ["b", "code", "pre", "blockquote"]) {
      const open = (chunk.text.match(new RegExp(`<${tag}[ >]`, "g")) || []).length;
      const close = (chunk.text.match(new RegExp(`</${tag}>`, "g")) || []).length;
      assert.equal(open, close, `unbalanced <${tag}> in chunk`);
    }
  }
});

test("a long code block is re-fenced across chunks", () => {
  const lines = Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n");
  const chunks = splitMessage("```text\n" + lines + "\n```", { maxLength: 4096 });
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.text.startsWith("<pre>"), "each code chunk keeps a fence");
    assert.ok(chunk.text.endsWith("</pre>"));
  }
});

test("rich chunks respect the 32768 budget", () => {
  const text = "# 标题\n\n" + "段落内容。".repeat(3000);
  const chunks = splitMessage(text, { rich: true, maxLength: 32768 });
  assert.ok(chunks.length >= 1);
  for (const chunk of chunks) {
    assert.equal(chunk.kind, "rich");
    assert.ok(chunk.text.length <= 32768);
  }
});

test("rich chunks carry an HTML fallback that fits sendMessage", () => {
  const section = "## 小节\n\n" + "- 条目 **粗** `code`\n".repeat(30) + "\n";
  const text = (section + "正文段落。".repeat(200) + "\n\n").repeat(3);
  const items = splitRichWithFallback(text, { maxLength: 4096, entityBudget: 90 });
  assert.ok(items.length >= 2);
  for (const item of items) {
    assert.equal(item.kind, "rich");
    assert.ok(item.text.length <= 32768);
    assert.ok(item.fallbackHtml.length <= 4096, `fallback too long: ${item.fallbackHtml.length}`);
    for (const tag of ["b", "code", "pre", "blockquote"]) {
      const open = (item.fallbackHtml.match(new RegExp(`<${tag}[ >]`, "g")) || []).length;
      const close = (item.fallbackHtml.match(new RegExp(`</${tag}>`, "g")) || []).length;
      assert.equal(open, close, `unbalanced <${tag}> in fallback`);
    }
  }
});

test("chunkText handles shapes", () => {
  assert.equal(chunkText("plain"), "plain");
  assert.equal(chunkText({ type: "text", text: "t" }), "t");
  assert.equal(chunkText({ delta: "d" }), "d");
  assert.equal(chunkText([{ text: "a" }, "b"]), "ab");
  assert.equal(chunkText(null), "");
});

test("chunkText takes text-delta and ignores reasoning-delta", () => {
  assert.equal(chunkText({ type: "text-delta", index: 0, text: "答案" }), "答案");
  assert.equal(chunkText({ type: "reasoning-delta", index: 0, text: "思考过程" }), "");
  assert.equal(chunkText({ type: "block-start", index: 0, blockType: "reasoning" }), "");
  assert.equal(chunkText({ type: "block-end", index: 0 }), "");
});
