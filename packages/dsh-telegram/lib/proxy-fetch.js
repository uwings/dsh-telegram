// Zero-dependency HTTP(S) client with optional HTTP CONNECT proxy and
// multi-candidate proxy fallback.
//
// Node's global fetch ignores HTTP_PROXY, so we write the request on a socket.
//
// 2026-11-08 hardening (telegram bridge kept hanging after cutover):
//   1. The timeout now starts when the request is issued, so it also covers
//      TCP connect + proxy CONNECT + TLS handshake. Previously the timer was
//      armed only after the socket was established, so a stuck proxy could
//      hang a getUpdates poll for 135s+ with no error.
//   2. `proxies: [...]` tries candidates in order; the first success wins.
//      `onProxyUsed` / `onProxyFailed` let the caller feed a health pool.

import net from "node:net";
import tls from "node:tls";

/** Make one HTTP(S) request through one proxy ("" = direct). */
function requestOnce(url, { method = "GET", headers = {}, body, proxy = "", timeoutMs = 45000, connectTimeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const isHttps = target.protocol === "https:";
    const payload =
      body === undefined ? null : Buffer.isBuffer(body) ? body : typeof body === "string" ? body : JSON.stringify(body);
    let settled = false;
    let socket = null;
    let phase = "connect";

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    // Connect phase gets a short budget so a stalled proxy fails over quickly;
    // once the request is written, the full response budget applies.
    let timer = null;
    const arm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        finish(reject, new Error(`request timeout after ${ms}ms during ${phase}`));
        try {
          socket?.destroy();
        } catch {
          /* ignore */
        }
      }, ms);
    };
    arm(Math.min(connectTimeoutMs, timeoutMs));

    let status = 0;
    let resHeaders = {};
    let headerParsed = false;
    let chunked = false;
    let contentLength = null;
    let headerBuffer = Buffer.alloc(0);
    let bodyBuffer = Buffer.alloc(0);
    const bodyChunks = [];
    let bodyBytes = 0;

    const buildResponse = () => {
      const all = Buffer.concat(bodyChunks);
      return {
        status,
        headers: resHeaders,
        text: () => all.toString("utf-8"),
        bytes: () => all,
        json: () => {
          try {
            return JSON.parse(all.toString("utf-8"));
          } catch {
            return { ok: false, description: all.toString("utf-8").slice(0, 300) };
          }
        },
      };
    };

    const send = (sock) => {
      phase = "response";
      arm(timeoutMs);
      const reqHeaders = {
        Host: target.host,
        Connection: "close",
        "User-Agent": "dsh-telegram/0.1",
        ...headers,
      };
      if (payload !== null && reqHeaders["content-length"] === undefined && reqHeaders["Content-Length"] === undefined) {
        reqHeaders["Content-Length"] = Buffer.byteLength(payload);
      }
      let head = `${method} ${target.pathname}${target.search} HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(reqHeaders)) head += `${key}: ${value}\r\n`;
      head += "\r\n";

      const complete = () => finish(resolve, buildResponse());

      const processBody = () => {
        if (chunked) {
          while (true) {
            const lineEnd = bodyBuffer.indexOf("\r\n");
            if (lineEnd === -1) return;
            const sizeLine = bodyBuffer.subarray(0, lineEnd).toString("latin1").trim();
            const size = parseInt(sizeLine.split(";")[0], 16);
            if (!Number.isFinite(size)) {
              finish(reject, new Error(`bad chunk size line: ${sizeLine}`));
              return;
            }
            bodyBuffer = bodyBuffer.subarray(lineEnd + 2);
            if (size === 0) {
              bodyBuffer = Buffer.alloc(0);
              complete();
              return;
            }
            if (bodyBuffer.length < size + 2) return;
            bodyChunks.push(bodyBuffer.subarray(0, size));
            bodyBytes += size;
            bodyBuffer = bodyBuffer.subarray(size + 2);
          }
        } else if (contentLength !== null && bodyBytes >= contentLength) {
          complete();
        }
      };

      sock.on("data", (data) => {
        if (!headerParsed) {
          headerBuffer = Buffer.concat([headerBuffer, data]);
          const idx = headerBuffer.indexOf("\r\n\r\n");
          if (idx === -1) return;
          const raw = headerBuffer.subarray(0, idx).toString("latin1");
          const rest = headerBuffer.subarray(idx + 4);
          const lines = raw.split("\r\n");
          const match = /^HTTP\/1\.[01] (\d+)/.exec(lines[0] || "");
          status = match ? Number(match[1]) : 0;
          resHeaders = {};
          for (const line of lines.slice(1)) {
            const ci = line.indexOf(":");
            if (ci > 0) resHeaders[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
          }
          headerParsed = true;
          chunked = /chunked/i.test(resHeaders["transfer-encoding"] || "");
          if (resHeaders["content-length"] !== undefined) contentLength = Number(resHeaders["content-length"]);
          if (rest.length > 0) {
            if (chunked) bodyBuffer = Buffer.concat([bodyBuffer, rest]);
            else {
              bodyChunks.push(rest);
              bodyBytes += rest.length;
            }
            processBody();
          }
          return;
        }
        if (chunked) {
          bodyBuffer = Buffer.concat([bodyBuffer, data]);
          processBody();
        } else {
          bodyChunks.push(data);
          bodyBytes += data.length;
          if (contentLength !== null && bodyBytes >= contentLength) complete();
        }
      });
      sock.on("end", () => {
        if (!settled) {
          if (headerParsed && (chunked || contentLength !== null)) processBody();
          if (!settled) complete();
        }
      });
      sock.on("error", (error) => finish(reject, error));
      sock.on("close", () => {
        if (!settled && headerParsed) {
          if (chunked || contentLength !== null) processBody();
          complete();
        }
      });
      sock.write(head);
      if (payload !== null) sock.write(payload);
    };

    const connectDirect = () => {
      phase = "direct tcp";
      if (isHttps) {
        phase = "tls";
        socket = tls.connect(
          { host: target.hostname, port: Number(target.port) || 443, servername: target.hostname },
          () => send(socket)
        );
      } else {
        socket = net.connect(Number(target.port) || 80, target.hostname, () => send(socket));
      }
      socket.on("error", (error) => finish(reject, error));
    };

    const connectViaProxy = (proxyUrl) => {
      phase = "proxy connect";
      socket = net.connect(Number(proxyUrl.port) || 80, proxyUrl.hostname, () => {
        phase = "proxy CONNECT";
        socket.write(`CONNECT ${target.hostname}:${target.port || (isHttps ? 443 : 80)} HTTP/1.1\r\nHost: ${target.hostname}\r\n\r\n`);
      });
      let connected = false;
      socket.on("data", (data) => {
        if (connected) return;
        const text = data.toString("latin1");
        if (!/^HTTP\/1\.[01] 200/i.test(text)) {
          const error = new Error(`proxy CONNECT failed: ${text.split("\r\n")[0] || "no response"}`);
          socket.destroy(error);
          finish(reject, error);
          return;
        }
        connected = true;
        if (isHttps) {
          phase = "tls through proxy";
          const tlsSocket = tls.connect({ socket, servername: target.hostname }, () => send(tlsSocket));
          tlsSocket.on("error", (error) => finish(reject, error));
          socket = tlsSocket;
        } else {
          send(socket);
        }
      });
      socket.on("error", (error) => finish(reject, error));
    };

    if (proxy && isHttps) {
      try {
        connectViaProxy(new URL(proxy));
      } catch {
        finish(reject, new Error(`telegram: invalid proxy URL: ${proxy}`));
      }
    } else {
      connectDirect();
    }
  });
}

/**
 * Request a URL, trying each candidate proxy in order.
 * opts.proxies: string[] where "" means direct. Falls back to opts.proxy.
 */
export async function request(url, opts = {}) {
  const candidates =
    Array.isArray(opts.proxies) && opts.proxies.length > 0
      ? opts.proxies
      : [opts.proxy === undefined ? "" : opts.proxy];

  let lastError = null;
  for (const proxy of candidates) {
    try {
      const response = await requestOnce(url, { ...opts, proxy });
      response.proxyUsed = proxy;
      try {
        opts.onProxyUsed?.(proxy);
      } catch {
        /* ignore */
      }
      return response;
    } catch (error) {
      lastError = error;
      try {
        opts.onProxyFailed?.(proxy, error);
      } catch {
        /* ignore */
      }
    }
  }
  throw lastError || new Error("request failed: no proxy candidates");
}
