// Text pipeline for Telegram: Markdown → Telegram HTML / rich Markdown / plain.
//
// Telegram's Bot API supports far more than bold + code. Rendering rules used
// here come from core.telegram.org/bots/api/formatting.md and
// core.telegram.org/bots/api/rich-messages.md (see docs/telegram-formatting.md):
//
//   HTML style (parse_mode=HTML)   b/strong, i/em, u/ins, s/strike/del,
//                                  span.tg-spoiler, a, code, pre>code.language-x,
//                                  blockquote, blockquote expandable.
//   No HTML entity for headings, lists or tables — those must be flattened to
//   bold lines / bullet text / monospace blocks.
//   Rich messages (sendRichMessage) do support headings, lists, tables, math,
//   details and footnotes natively, with a 32768-char / 500-block budget.
//
// Everything is block-parsed first, then rendered per block, so chunking never
// cuts a tag or a code fence in half.

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

export function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (char) => HTML_ESCAPES[char]);
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

const SAFE_LINK = /^(https?:|tg:|mailto:|tel:|#|\/)/i;

export function sanitizeUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (!SAFE_LINK.test(value)) return "";
  // Telegram rejects control characters and unescaped quotes in hrefs.
  return value.replace(/[\u0000-\u001f"<>]/g, "");
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isBlank(line) {
  return /^\s*$/.test(line);
}

/**
 * Parse a Markdown document into blocks. Never throws: malformed input becomes
 * paragraph text.
 * @param {string} input
 * @param {{partial?: boolean}} [options]
 */
export function parseBlocks(input, { partial = false } = {}) {
  const lines = String(input).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    // Fenced code (``` or ~~~), tolerant of a missing closing fence.
    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[2];
      const indent = fence[1].length;
      const lang = (fence[3] || "").trim();
      const body = [];
      let closed = false;
      i += 1;
      while (i < lines.length) {
        const candidate = lines[i];
        if (new RegExp(`^\\s{0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(candidate)) {
          closed = true;
          i += 1;
          break;
        }
        body.push(candidate.slice(Math.min(indent, candidate.length)));
        i += 1;
      }
      blocks.push({ type: "code", lang, content: body.join("\n"), closed });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    // Blockquote: consume consecutive "> " lines; ">>" continues the same quote.
    if (/^\s{0,3}>/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && (/^\s{0,3}>/.test(lines[i]) || (!isBlank(lines[i]) && quoteLines.length > 0 && !isBlockStart(lines[i])))) {
        quoteLines.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", lines: quoteLines });
      continue;
    }

    // Table: header row followed by a divider row.
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const splitRow = (row) =>
        row
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((cell) => cell.trim());
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        return "left";
      });
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && !isBlank(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: "table", header, align, rows });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const { ordered, items } = readList(lines, i);
      i = readList.next;
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraph: consecutive plain lines.
    const paragraph = [];
    while (i < lines.length && !isBlank(lines[i]) && !isBlockStart(lines[i], { first: paragraph.length === 0 })) {
      paragraph.push(lines[i]);
      i += 1;
    }
    if (paragraph.length === 0) {
      // Safety valve: never loop forever on an unexpected line.
      paragraph.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}

function isBlockStart(line, { first = true } = {}) {
  if (FENCE.test(line) || RULE.test(line) || /^\s{0,3}>/.test(line)) return true;
  if (HEADING.test(line)) return true;
  if (!first && (BULLET.test(line) || ORDERED.test(line))) return true;
  return false;
}

function readList(lines, start) {
  const orderedMatch = lines[start].match(ORDERED);
  const ordered = Boolean(orderedMatch);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const match = ordered ? lines[i].match(ORDERED) : lines[i].match(BULLET);
    if (!match) break;
    let text = match[3];
    let task = null;
    const taskMatch = text.match(TASK);
    if (taskMatch) {
      task = taskMatch[1].toLowerCase() === "x";
      text = taskMatch[2];
    }
    i += 1;
    // Lazy continuation: indented lines belong to the current item.
    const extra = [];
    while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !BULLET.test(lines[i]) && !ORDERED.test(lines[i])) {
      extra.push(lines[i].trim());
      i += 1;
    }
    if (extra.length > 0) text += "\n" + extra.join("\n");
    items.push({ text, task });
  }
  readList.next = i;
  return { ordered, items };
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

function isWordChar(char) {
  return Boolean(char) && /[\p{L}\p{N}_]/u.test(char);
}

/**
 * Render inline Markdown to Telegram HTML.
 * Nested emphasis is handled recursively; code spans are kept outside
 * bold/italic because Telegram forbids code inside those entities.
 */
export function renderInline(input, { plain = false } = {}) {
  const text = String(input);
  let out = "";
  let i = 0;
  const n = text.length;

  const literal = (value) => (plain ? value : escapeHtml(value));

  while (i < n) {
    const char = text[i];

    if (char === "\\" && i + 1 < n) {
      out += literal(text[i + 1]);
      i += 2;
      continue;
    }

    // Code span (handles ``double`` backticks).
    if (char === "`") {
      let run = 1;
      while (text[i + run] === "`") run += 1;
      const marker = "`".repeat(run);
      const close = findUnescaped(text, marker, i + run);
      if (close !== -1) {
        const code = text.slice(i + run, close);
        out += plain ? code : `<code>${escapeHtml(code.trim() === "" ? code : code)}</code>`;
        i = close + run;
        continue;
      }
      out += literal(marker);
      i += run;
      continue;
    }

    // Image → link (Telegram HTML has no inline image).
    if (char === "!" && text[i + 1] === "[") {
      const parsed = parseLink(text, i + 1);
      if (parsed) {
        const label = parsed.label || parsed.url;
        out += plain ? label : `<a href="${escapeAttr(sanitizeUrl(parsed.url))}">${renderInline(label)}</a>`;
        i = parsed.end;
        continue;
      }
    }

    if (char === "[") {
      const parsed = parseLink(text, i);
      if (parsed) {
        const href = sanitizeUrl(parsed.url);
        if (!href) {
          out += renderInline(parsed.label, { plain });
        } else if (plain) {
          const label = renderInline(parsed.label, { plain: true });
          out += label === href ? href : `${label} (${href})`;
        } else {
          out += `<a href="${escapeAttr(href)}">${renderInline(parsed.label)}</a>`;
        }
        i = parsed.end;
        continue;
      }
    }

    // <https://autolink>
    if (char === "<") {
      const match = text.slice(i).match(/^<((?:https?|tg|mailto):[^\s<>]+)>/i);
      if (match) {
        const url = sanitizeUrl(match[1]);
        out += plain ? match[1] : `<a href="${escapeAttr(url)}">${escapeHtml(match[1])}</a>`;
        i += match[0].length;
        continue;
      }
      out += literal("<");
      i += 1;
      continue;
    }

    // Strong / emphasis / strike / spoiler.
    const emphasis = matchEmphasis(text, i);
    if (emphasis) {
      const inner = text.slice(i + emphasis.open.length, emphasis.close);
      if (inner !== "") {
        out += renderEmphasis(inner, emphasis.kind, { plain });
        i = emphasis.close + emphasis.open.length;
        continue;
      }
    }

    if (char === "&") {
      out += plain ? "&" : "&amp;";
      i += 1;
      continue;
    }
    if (char === ">" && !plain) {
      out += "&gt;";
      i += 1;
      continue;
    }

    out += char;
    i += 1;
  }
  return out;
}

const EMPHASIS = [
  { marker: "***", kind: "bolditalic" },
  { marker: "**", kind: "bold" },
  { marker: "__", kind: "bold" },
  { marker: "~~", kind: "strike" },
  { marker: "||", kind: "spoiler" },
  { marker: "*", kind: "italic" },
  { marker: "_", kind: "italic" },
];

function matchEmphasis(text, index) {
  for (const { marker, kind } of EMPHASIS) {
    if (!text.startsWith(marker, index)) continue;
    if (index > 0 && text[index - 1] === "\\") continue;
    // Underscores only delimit at word boundaries (snake_case stays literal).
    if (marker.includes("_") && isWordChar(text[index - 1]) && isWordChar(text[index + marker.length])) continue;
    const close = findUnescaped(text, marker, index + marker.length);
    if (close === -1) continue;
    if (close === index + marker.length) continue; // empty span
    const inner = text.slice(index + marker.length, close);
    if (inner.trim() === "") continue;
    // A delimiter must open and close on non-space characters.
    if (inner.startsWith(" ") || inner.endsWith(" ")) continue;
    return { open: marker, close, kind };
  }
  return null;
}

function renderEmphasis(inner, kind, { plain }) {
  if (plain) return renderInline(inner, { plain: true });
  if (kind === "bolditalic") return `<b><i>${renderInline(inner)}</i></b>`;
  const tag = kind === "bold" ? "b" : kind === "italic" ? "i" : kind === "strike" ? "s" : "span";
  const open = kind === "spoiler" ? '<span class="tg-spoiler">' : `<${tag}>`;
  const close = kind === "spoiler" ? "</span>" : `</${tag}>`;

  // Telegram forbids code/pre inside bold/italic/strike/spoiler: split the span
  // around code segments and emit them as siblings.
  const segments = splitCodeSpans(inner);
  if (segments.length === 1) return `${open}${renderInline(inner)}${close}`;
  return segments
    .map((segment) =>
      segment.code
        ? `<code>${escapeHtml(segment.text)}</code>`
        : `${open}${renderInline(segment.text)}${close}`
    )
    .join("");
}

function splitCodeSpans(text) {
  const segments = [];
  let rest = String(text);
  while (rest !== "") {
    const start = rest.indexOf("`");
    if (start === -1) {
      segments.push({ code: false, text: rest });
      break;
    }
    let run = 1;
    while (rest[start + run] === "`") run += 1;
    const marker = "`".repeat(run);
    const close = rest.indexOf(marker, start + run);
    if (close === -1) {
      segments.push({ code: false, text: rest });
      break;
    }
    if (start > 0) segments.push({ code: false, text: rest.slice(0, start) });
    segments.push({ code: true, text: rest.slice(start + run, close) });
    rest = rest.slice(close + run);
  }
  return segments.filter((segment) => segment.text !== "");
}

function findUnescaped(text, marker, from) {
  let index = text.indexOf(marker, from);
  while (index !== -1) {
    if (text[index - 1] !== "\\") return index;
    index = text.indexOf(marker, index + 1);
  }
  return -1;
}

function parseLink(text, start) {
  if (text[start] !== "[") return null;
  let depth = 0;
  let close = -1;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === "[") depth += 1;
    else if (text[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1 || text[close + 1] !== "(") return null;
  let parenDepth = 0;
  let end = -1;
  for (let i = close + 1; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === "(") parenDepth += 1;
    else if (text[i] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const url = text.slice(close + 2, end).trim().split(/\s+/)[0];
  const label = text.slice(start + 1, close);
  return { label, url, end: end + 1 };
}

// ---------------------------------------------------------------------------
// Block → HTML
// ---------------------------------------------------------------------------

function sanitizeLang(lang) {
  const value = String(lang || "").trim().toLowerCase();
  return /^[a-z0-9_+#.-]{1,24}$/.test(value) ? value : "";
}

function renderBlockHtml(block) {
  switch (block.type) {
    case "code": {
      const lang = sanitizeLang(block.lang);
      const code = escapeHtml(block.content);
      return lang
        ? `<pre><code class="language-${lang}">${code}</code></pre>`
        : `<pre>${code}</pre>`;
    }
    case "heading":
      return `<b>${renderInline(block.text)}</b>`;
    case "rule":
      return "────────";
    case "quote": {
      const body = block.lines.map((line) => renderInline(line)).join("\n");
      const expandable = block.lines.length > 6 && block.expandable !== false;
      return expandable ? `<blockquote expandable>${body}</blockquote>` : `<blockquote>${body}</blockquote>`;
    }
    case "list": {
      const lines = block.items.map((item, index) => {
        const marker = block.ordered ? `${index + 1}. ` : "• ";
        const check = item.task === null ? "" : item.task ? "☑ " : "☐ ";
        return `${marker}${check}${renderInline(item.text)}`;
      });
      return lines.join("\n");
    }
    case "table":
      return renderTableHtml(block);
    default:
      return renderInline(block.text);
  }
}

function renderTableHtml(block) {
  const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length), 1);
  const plainCell = (cell) => renderInline(cell ?? "", { plain: true });
  const matrix = [block.header, ...block.rows].map((row) => {
    const cells = [];
    for (let c = 0; c < columns; c += 1) cells.push(plainCell(row[c] ?? ""));
    return cells;
  });

  if (columns > 4) return renderTableAsList(block, columns);

  const widths = [];
  for (let c = 0; c < columns; c += 1) {
    widths[c] = Math.max(...matrix.map((row) => displayWidth(row[c])), 1);
  }
  const total = widths.reduce((sum, width) => sum + width + 3, 0);
  if (total > 56) return renderTableAsList(block, columns);

  const pad = (value, width, align) => {
    const gap = Math.max(0, width - displayWidth(value));
    if (align === "right") return " ".repeat(gap) + value;
    if (align === "center") {
      const left = Math.floor(gap / 2);
      return " ".repeat(left) + value + " ".repeat(gap - left);
    }
    return value + " ".repeat(gap);
  };

  const lines = matrix.map((row, index) =>
    row.map((cell, c) => pad(cell, widths[c], block.align?.[c] || "left")).join(" │ ")
  );
  lines.splice(1, 0, widths.map((width) => "─".repeat(width)).join("─┼─"));
  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

function renderTableAsList(block, columns) {
  const rows = block.rows.length > 0 ? block.rows : [block.header];
  return rows
    .map((row) => {
      const parts = [];
      for (let c = 0; c < columns; c += 1) {
        const value = renderInline(row[c] ?? "");
        if (value === "") continue;
        const key = block.header[c] ? `<b>${renderInline(block.header[c])}</b>: ` : "";
        parts.push(`${key}${value}`);
      }
      return `• ${parts.join(" · ")}`;
    })
    .join("\n");
}

function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1;
  }
  return width;
}

// ---------------------------------------------------------------------------
// Block → plain text (drafts, fallbacks)
// ---------------------------------------------------------------------------

function renderBlockPlain(block) {
  switch (block.type) {
    case "code":
      return block.content;
    case "heading":
      return renderInline(block.text, { plain: true });
    case "rule":
      return "────────";
    case "quote":
      return block.lines.map((line) => `▎ ${renderInline(line, { plain: true })}`).join("\n");
    case "list":
      return block.items
        .map((item, index) => {
          const marker = block.ordered ? `${index + 1}. ` : "• ";
          const check = item.task === null ? "" : item.task ? "☑ " : "☐ ";
          return `${marker}${check}${renderInline(item.text, { plain: true })}`;
        })
        .join("\n");
    case "table": {
      const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length), 1);
      return block.rows
        .map((row) => {
          const parts = [];
          for (let c = 0; c < columns; c += 1) {
            const value = renderInline(row[c] ?? "", { plain: true });
            if (!value) continue;
            const key = block.header[c] ? `${renderInline(block.header[c], { plain: true })}: ` : "";
            parts.push(`${key}${value}`);
          }
          return `• ${parts.join(" · ")}`;
        })
        .join("\n");
    }
    default:
      return renderInline(block.text, { plain: true });
  }
}

/** Markdown → readable plain text (no markers). Used for draft previews. */
export function toPlainText(input) {
  const blocks = parseBlocks(input, { partial: true });
  return blocks.map(renderBlockPlain).filter(Boolean).join("\n\n");
}

/** Markdown → sanitized rich-message Markdown (headings/lists/tables kept). */
export function toRichMarkdown(input) {
  const blocks = parseBlocks(input, { partial: false });
  return blocks
    .map((block) => renderBlockRich(block))
    .filter((value) => value !== "")
    .join("\n\n");
}

function renderBlockRich(block) {
  const esc = (text) => String(text).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  switch (block.type) {
    case "code": {
      const lang = sanitizeLang(block.lang);
      return `${lang ? "```" + lang : "```"}\n${block.content}\n\`\`\``;
    }
    case "heading":
      return `${"#".repeat(Math.min(6, Math.max(1, block.level)))} ${esc(block.text)}`;
    case "rule":
      return "---";
    case "quote":
      return block.lines.map((line) => `> ${esc(line)}`).join("\n");
    case "list": {
      return block.items
        .map((item, index) => {
          if (block.ordered) return `${index + 1}. ${esc(item.text)}`;
          const check = item.task === null ? "" : item.task ? "[x] " : "[ ] ";
          return `- ${check}${esc(item.text)}`;
        })
        .join("\n");
    }
    case "table": {
      const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length), 1);
      const row = (cells) => `| ${Array.from({ length: columns }, (_, c) => esc(cells[c] ?? "")).join(" | ")} |`;
      const align = Array.from({ length: columns }, (_, c) => {
        const value = block.align?.[c];
        if (value === "center") return ":---:";
        if (value === "right") return "---:";
        return ":---";
      });
      return [row(block.header), `| ${align.join(" | ")} |`, ...block.rows.map(row)].join("\n");
    }
    default:
      return esc(block.text);
  }
}

// ---------------------------------------------------------------------------
// Entities + chunking
// ---------------------------------------------------------------------------

const ENTITY_TAG = /<(?:b|i|u|s|code|pre|a|blockquote|span|tg-emoji|tg-time)\b[^>]*>/gi;

/** Count Telegram entities (one opening tag = one entity). */
export function countEntities(html) {
  return (String(html).match(ENTITY_TAG) || []).length;
}

/**
 * Render Markdown to Telegram HTML.
 * @returns {{html: string, entities: number}}
 */
export function markdownToHtml(input) {
  const blocks = parseBlocks(input, { partial: true });
  const html = blocks.map(renderBlockHtml).filter(Boolean).join("\n\n");
  return { html, entities: countEntities(html) };
}

function splitPlainText(text, maxLength) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > maxLength) {
    const cut = findCut(rest, maxLength);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest !== "") chunks.push(rest);
  return chunks;
}

function findCut(text, limit) {
  let cut = limit;
  const nl = text.lastIndexOf("\n", limit);
  if (nl > limit * 0.5) return nl;
  const period = text.lastIndexOf("。", limit);
  if (period > limit * 0.5) return period + 1;
  const dotSpace = text.lastIndexOf(". ", limit);
  if (dotSpace > limit * 0.5) return dotSpace + 2;
  return cut;
}

/** Split one block into blocks that individually fit the character budget. */
function splitBlock(block, limit) {
  const measure = (value) => {
    if (block.type === "code") return value.content.length;
    if (block.type === "table") return JSON.stringify(value).length;
    if (block.type === "list") return value.items.reduce((sum, item) => sum + item.text.length + 4, 0);
    if (block.type === "quote") return value.lines.join("\n").length;
    return (value.text || "").length;
  };
  if (measure(block) <= limit) return [block];

  if (block.type === "code") {
    const parts = splitPlainText(block.content, Math.max(200, limit - 32));
    return parts.map((content) => ({ ...block, content }));
  }
  if (block.type === "list") {
    const groups = [];
    let current = [];
    let size = 0;
    for (const item of block.items) {
      if (current.length > 0 && size + item.text.length + 4 > limit) {
        groups.push(current);
        current = [];
        size = 0;
      }
      current.push(item);
      size += item.text.length + 4;
    }
    if (current.length > 0) groups.push(current);
    return groups.map((items) => ({ ...block, items }));
  }
  if (block.type === "quote") {
    const parts = splitPlainText(block.lines.join("\n"), Math.max(200, limit)).map((part) => part.split("\n"));
    return parts.map((lines) => ({ ...block, lines }));
  }
  if (block.type === "table") {
    const head = { ...block, rows: [] };
    const groups = [];
    let current = [];
    let size = 0;
    for (const row of block.rows) {
      const rowSize = JSON.stringify(row).length;
      if (current.length > 0 && size + rowSize > limit) {
        groups.push({ ...block, rows: current });
        current = [];
        size = 0;
      }
      current.push(row);
      size += rowSize;
    }
    if (current.length > 0) groups.push({ ...block, rows: current });
    return groups.length > 0 ? groups : [head];
  }
  // Paragraph.
  return splitPlainText(block.text, limit).map((text) => ({ ...block, text }));
}

/**
 * Split text into Telegram-safe chunks.
 *
 * @param {string} input Markdown (or plain text when markdown=false).
 * @param {{maxLength?: number, entityBudget?: number, markdown?: boolean, rich?: boolean}} [options]
 * @returns {Array<{kind: "html"|"plain"|"rich", text: string, entities?: number}>}
 */
export function splitMessage(input, { maxLength = 4096, entityBudget = 90, markdown = true, rich = false } = {}) {
  const text = String(input ?? "");
  if (!markdown) {
    return splitPlainText(text, maxLength).map((part) => ({ kind: "plain", text: part }));
  }

  const blocks = parseBlocks(text, { partial: false });

  if (rich) {
    const chunks = [];
    let current = [];
    let size = 0;
    const flush = () => {
      if (current.length === 0) return;
      chunks.push({ kind: "rich", text: current.join("\n\n") });
      current = [];
      size = 0;
    };
    for (const block of blocks) {
      const rendered = renderBlockRich(block);
      if (rendered === "") continue;
      const pieces = rendered.length > maxLength ? splitPlainText(rendered, maxLength - 8) : [rendered];
      for (const piece of pieces) {
        const separator = current.length > 0 ? 2 : 0;
        if (current.length > 0 && (size + separator + piece.length > maxLength || current.length >= 480)) flush();
        current.push(piece);
        size += piece.length + (current.length > 1 ? 2 : 0);
      }
    }
    flush();
    return chunks.length > 0 ? chunks : [{ kind: "rich", text: "" }];
  }

  const chunks = [];
  let html = "";
  let entities = 0;

  const flush = () => {
    if (html === "") return;
    chunks.push({ kind: "html", text: html, entities });
    html = "";
    entities = 0;
  };

  for (const block of blocks) {
    for (const piece of splitBlock(block, Math.max(256, maxLength - 64))) {
      let rendered = renderBlockHtml(piece);
      if (rendered === "") continue;
      const pieceEntities = countEntities(rendered);

      // A single block that is still too long (escaping can grow text) or too
      // entity-heavy degrades to plain text for that block only.
      if (rendered.length > maxLength || pieceEntities > entityBudget) {
        const plain = renderBlockPlain(piece);
        for (const part of splitPlainText(plain, maxLength)) {
          flush();
          chunks.push({ kind: "plain", text: part });
        }
        continue;
      }

      const separator = html === "" ? 0 : 2;
      if (html !== "" && (html.length + separator + rendered.length > maxLength || entities + pieceEntities > entityBudget)) {
        flush();
      }
      html += (html === "" ? "" : "\n\n") + rendered;
      entities += pieceEntities;

      if (html.length > 0 && (html.length >= maxLength * 0.95 || entities >= entityBudget)) flush();
    }
  }
  flush();

  if (chunks.length === 0) return [{ kind: "plain", text: "" }];
  return chunks;
}

/**
 * Build rich-message chunks together with an HTML fallback for each chunk.
 * Chunk boundaries follow the HTML budget (4096 chars / entity budget) so the
 * fallback can be sent as-is when `sendRichMessage` is unavailable.
 * @returns {Array<{kind: "rich", text: string, fallbackHtml: string, entities: number}>}
 */
export function splitRichWithFallback(input, { maxLength = 4096, entityBudget = 90 } = {}) {
  // Leave room for the caller's "(1/3)" suffix on both renderings.
  const limit = Math.max(256, maxLength - 12);
  const blocks = parseBlocks(String(input ?? ""), { partial: false });
  const groups = [];
  let current = [];
  let htmlLength = 0;
  let entities = 0;
  const flush = () => {
    if (current.length === 0) return;
    groups.push(current);
    current = [];
    htmlLength = 0;
    entities = 0;
  };

  for (const block of blocks) {
    for (const piece of splitBlock(block, Math.max(256, limit - 52))) {
      const html = renderBlockHtml(piece);
      if (html === "") continue;
      const pieceEntities = countEntities(html);
      const separator = current.length > 0 ? 2 : 0;
      if (current.length > 0 && (htmlLength + separator + html.length > limit || entities + pieceEntities > entityBudget)) {
        flush();
      }
      current.push(piece);
      htmlLength += (current.length > 1 ? 2 : 0) + html.length;
      entities += pieceEntities;
    }
  }
  flush();

  return groups.map((group) => {
    const fallbackHtml = group.map(renderBlockHtml).filter(Boolean).join("\n\n");
    let markdown = group.map(renderBlockRich).filter(Boolean).join("\n\n");
    if (markdown.length > 32000) markdown = markdown.slice(0, 32000);
    return { kind: "rich", text: markdown, fallbackHtml, entities: countEntities(fallbackHtml) };
  });
}

/** Extract visible text from an LLM stream chunk of unknown shape. */
export function chunkText(chunk) {
  if (chunk === null || chunk === undefined) return "";
  if (typeof chunk === "string") return chunk;
  // Assistant stream frames: only text-delta carries answer text. Reasoning
  // deltas must never leak into the draft or into a /stop partial.
  if (chunk.type === "reasoning-delta" || chunk.type === "reasoning-chunks") return "";
  if (chunk.type === "text-delta") return typeof chunk.text === "string" ? chunk.text : "";
  if (Array.isArray(chunk)) return chunk.map(chunkText).join("");
  if (typeof chunk.text === "string") return chunk.text;
  if (typeof chunk.delta === "string") return chunk.delta;
  if (typeof chunk.content === "string") return chunk.content;
  return "";
}
