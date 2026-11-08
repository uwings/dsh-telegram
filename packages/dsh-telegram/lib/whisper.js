// Client for the local Whisper service (<whisper-server>).
// The service is a separate process with its own CUDA setup, so the plugin only
// talks HTTP to it and never owns its lifecycle.

import fs from "node:fs";
import path from "node:path";

const DEFAULT_URL = "http://127.0.0.1:8777";

function baseUrl(url) {
  return String(url || DEFAULT_URL).replace(/\/+$/, "");
}

/** One-shot health probe; returns the parsed body or throws. */
export async function whisperHealth({ url = DEFAULT_URL, timeoutMs = 3000 } = {}) {
  const response = await fetch(`${baseUrl(url)}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `whisper /health HTTP ${response.status}`);
  return body;
}

/**
 * Transcribe one audio file through POST /transcribe.
 * @returns {{text: string, language: string, duration: number}}
 */
export async function transcribeFile(filePath, { url = DEFAULT_URL, language = "zh", timeoutMs = 120000, mime = "audio/ogg" } = {}) {
  const bytes = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("audio", new Blob([bytes], { type: mime }), path.basename(filePath));
  if (language) form.append("language", language);

  const response = await fetch(`${baseUrl(url)}/transcribe`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `whisper HTTP ${response.status}`);
  return {
    text: String(body.text || "").trim(),
    language: String(body.language || language || ""),
    duration: Number(body.duration || 0),
  };
}
