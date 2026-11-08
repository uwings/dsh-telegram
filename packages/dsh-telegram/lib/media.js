// Pure helpers for Telegram attachments: detach incoming media from a message,
// extract outbound file directives from an assistant reply, name and describe
// saved files. No I/O here so it stays unit-testable.

import path from "node:path";

const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "video/mp4": ".mp4",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "text/plain": ".txt",
  "application/json": ".json",
};

/** Strip path separators and control characters from a Telegram file name. */
export function safeFileName(name, fallback = "file") {
  const base = String(name || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  const trimmed = base.slice(0, 120);
  return trimmed === "" ? fallback : trimmed;
}

export function humanBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Describe the media attached to an incoming Telegram message.
 * Returns null for plain text, otherwise the largest usable attachment.
 */
export function detectMedia(message) {
  if (!message || typeof message !== "object") return null;

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1];
    return {
      kind: "photo",
      fileId: photo.file_id,
      name: `photo-${message.message_id ?? Date.now()}.jpg`,
      mime: "image/jpeg",
      size: photo.file_size,
      width: photo.width,
      height: photo.height,
    };
  }

  const doc = message.document;
  if (doc) {
    return {
      kind: "document",
      fileId: doc.file_id,
      name: safeFileName(doc.file_name || `document-${message.message_id ?? Date.now()}`),
      mime: doc.mime_type || "application/octet-stream",
      size: doc.file_size,
    };
  }

  if (message.voice) {
    return {
      kind: "voice",
      fileId: message.voice.file_id,
      name: `voice-${message.message_id ?? Date.now()}.ogg`,
      mime: message.voice.mime_type || "audio/ogg",
      size: message.voice.file_size,
      duration: message.voice.duration,
    };
  }

  if (message.audio) {
    return {
      kind: "audio",
      fileId: message.audio.file_id,
      name: safeFileName(message.audio.file_name || `audio-${message.message_id ?? Date.now()}.mp3`),
      mime: message.audio.mime_type || "audio/mpeg",
      size: message.audio.file_size,
      duration: message.audio.duration,
    };
  }

  if (message.video) {
    return {
      kind: "video",
      fileId: message.video.file_id,
      name: safeFileName(message.video.file_name || `video-${message.message_id ?? Date.now()}.mp4`),
      mime: message.video.mime_type || "video/mp4",
      size: message.video.file_size,
      duration: message.video.duration,
    };
  }

  if (message.animation) {
    return {
      kind: "animation",
      fileId: message.animation.file_id,
      name: safeFileName(message.animation.file_name || `animation-${message.message_id ?? Date.now()}.mp4`),
      mime: message.animation.mime_type || "video/mp4",
      size: message.animation.file_size,
    };
  }

  return null;
}

/** Guess an extension for a downloaded file when Telegram's path has none. */
export function extensionFor(mime, name) {
  const fromName = path.extname(String(name || ""));
  if (fromName) return fromName;
  return EXT_BY_MIME[String(mime || "")] || "";
}

/**
 * The note prepended to the user text so the agent knows a file arrived.
 * The path is absolute and readable by the agent's file tools.
 */
export function attachmentNote(media, savedPath, { transcribed = "" } = {}) {
  const parts = [
    `[附件] 用户发来${labelFor(media.kind)} ${media.name}（${media.mime}，${humanBytes(media.size)}）`,
    `已保存到 ${savedPath}`,
  ];
  if (media.kind === "photo") parts.push("需要查看图片内容时用 read_image 读这个路径。");
  else if (media.kind === "voice" || media.kind === "audio") parts.push("这是音频文件，可以直接引用路径。");
  else parts.push("需要内容时用 read 读这个路径。");
  if (transcribed) parts.push(`转写：${transcribed}`);
  return parts.join("；");
}

function labelFor(kind) {
  switch (kind) {
    case "photo":
      return "图片";
    case "voice":
      return "语音";
    case "audio":
      return "音频";
    case "video":
      return "视频";
    case "animation":
      return "动图";
    default:
      return "文件";
  }
}

const DIRECTIVE = /\[\[(file|photo):([^\]|]+?)(?:\|([^\]]*))?\]\]/g;

/**
 * Pull `[[file:/abs/path|caption]]` / `[[photo:/abs/path|caption]]` directives
 * out of an assistant reply. Returns the cleaned text and the attachments.
 */
export function extractDirectives(input) {
  const text = String(input ?? "");
  const attachments = [];
  const cleaned = text.replace(DIRECTIVE, (_match, type, filePath, caption) => {
    const value = filePath.trim();
    if (value === "") return "";
    attachments.push({
      kind: type === "photo" ? "photo" : "document",
      path: value,
      caption: String(caption || "").trim(),
    });
    return "";
  });
  return { text: cleaned.replace(/\n{3,}/g, "\n\n").trim(), attachments };
}
