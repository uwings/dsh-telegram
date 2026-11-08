import test from "node:test";
import assert from "node:assert/strict";

import { buildKeyboard, ButtonRegistry, parseButtonsDirective } from "../packages/dsh-telegram/lib/buttons.js";

test("parseButtonsDirective extracts labels and actions", () => {
  const { text, buttons } = parseButtonsDirective("要哪个？\n[[buttons:重跑测试=重跑测试|停止=stop|新会话=/new]]");
  assert.equal(text, "要哪个？");
  assert.equal(buttons.length, 3);
  assert.deepEqual(buttons[0], { label: "重跑测试", action: "重跑测试" });
  assert.deepEqual(buttons[1], { label: "停止", action: "stop" });
  assert.deepEqual(buttons[2], { label: "新会话", action: "/new" });
});

test("parseButtonsDirective ignores malformed entries and caps at 8", () => {
  const { buttons } = parseButtonsDirective("[[buttons:|=x|a=|ok=1|b=2|c=3|d=4|e=5|f=6|g=7|h=8]]");
  assert.equal(buttons.length, 8);
  assert.ok(buttons.every((button) => button.label && button.action));
});

test("no directive leaves the text untouched", () => {
  const { text, buttons } = parseButtonsDirective("plain answer");
  assert.equal(text, "plain answer");
  assert.equal(buttons.length, 0);
});

test("buildKeyboard makes rows of two and mints short callback data", () => {
  const registry = new ButtonRegistry();
  const keyboard = buildKeyboard(
    [{ label: "A", action: "a" }, { label: "B", action: "b" }, { label: "C", action: "c" }],
    registry,
    "42"
  );
  assert.equal(keyboard.inline_keyboard.length, 2);
  assert.equal(keyboard.inline_keyboard[0].length, 2);
  assert.equal(keyboard.inline_keyboard[1].length, 1);
  for (const row of keyboard.inline_keyboard) {
    for (const button of row) {
      assert.ok(button.callback_data.length <= 64);
      assert.ok(button.callback_data.startsWith("b:"));
    }
  }
});

test("registry resolves a token exactly once", () => {
  const registry = new ButtonRegistry();
  const data = registry.put("42", "继续");
  const entry = registry.take(data);
  assert.equal(entry.chatId, "42");
  assert.equal(entry.action, "继续");
  assert.equal(registry.take(data), null);
});

test("registry drops expired tokens", () => {
  const registry = new ButtonRegistry({ ttlMs: -1 });
  const data = registry.put("42", "继续");
  assert.equal(registry.take(data), null);
});

test("registry prunes to its cap", () => {
  const registry = new ButtonRegistry({ max: 3 });
  registry.put("1", "a");
  registry.put("1", "b");
  registry.put("1", "c");
  registry.put("1", "d");
  assert.ok(registry.entries.size <= 3);
});
