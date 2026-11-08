// Inline keyboard support: parse `[[buttons:label=action|...]]` from a reply,
// mint compact callback tokens (Telegram caps callback_data at 64 bytes), and
// resolve them back to an action when the user taps.

const DIRECTIVE = /\[\[buttons:([^\]]+)\]\]/;

/** Parse at most one buttons directive out of an assistant reply. */
export function parseButtonsDirective(input) {
  const text = String(input ?? "");
  const match = text.match(DIRECTIVE);
  if (!match) return { text, buttons: [] };

  const buttons = [];
  for (const chunk of match[1].split("|")) {
    const part = chunk.trim();
    if (part === "") continue;
    const index = part.indexOf("=");
    if (index === -1) {
      buttons.push({ label: part.slice(0, 40), action: part });
      continue;
    }
    const label = part.slice(0, index).trim().slice(0, 40);
    const action = part.slice(index + 1).trim();
    if (label === "" || action === "") continue;
    buttons.push({ label, action });
  }

  return {
    text: text.replace(DIRECTIVE, "").replace(/\n{3,}/g, "\n\n").trim(),
    buttons: buttons.slice(0, 8),
  };
}

/** Build a one-or-two-row inline keyboard from parsed buttons. */
export function buildKeyboard(buttons, registry, chatId) {
  const rows = [];
  let row = [];
  for (const button of buttons) {
    row.push({ text: button.label, callback_data: registry.put(chatId, button.action) });
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);
  return rows.length > 0 ? { inline_keyboard: rows } : null;
}

/** Short-lived token → action map so callback_data stays under 64 bytes. */
export class ButtonRegistry {
  constructor({ ttlMs = 60 * 60 * 1000, max = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.entries = new Map();
  }

  put(chatId, action) {
    this.prune();
    const token = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 4);
    this.entries.set(token, { chatId: String(chatId), action: String(action), at: Date.now() });
    return `b:${token}`;
  }

  take(data) {
    const token = String(data || "").replace(/^b:/, "");
    const entry = this.entries.get(token);
    if (!entry) return null;
    this.entries.delete(token);
    if (Date.now() - entry.at > this.ttlMs) return null;
    return entry;
  }

  prune() {
    if (this.entries.size < this.max) return;
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (now - entry.at > this.ttlMs) this.entries.delete(token);
    }
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
