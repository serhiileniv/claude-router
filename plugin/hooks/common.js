'use strict';
// Shared by the two hooks. Zero dependencies, CommonJS, Node >= 20 — the hooks
// run under whatever `node` Claude Code finds, on every OS the proxy supports.
const http = require('node:http');

const isLoopback = (u) => (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port;

/**
 * Loopback ports named by ANTHROPIC_BASE_URL, most likely router first. A front
 * proxy that takes the upstream as a path suffix (billion-context:
 * `http://127.0.0.1:48787/bili/http://127.0.0.1:4000`) embeds the next hop in the
 * path, so the embedded URLs come last-hop first and the URL's own host, which is
 * only the outermost relay, comes last.
 */
function candidatePorts(env = process.env) {
  const ports = [];
  try {
    const u = new URL(env.ANTHROPIC_BASE_URL || '');
    for (const part of u.pathname.split(/\/(?=https?:\/\/)/).slice(1).reverse()) {
      try {
        const inner = new URL(part);
        if (isLoopback(inner)) ports.push(Number(inner.port));
      } catch { /* not a URL */ }
    }
    if (isLoopback(u)) ports.push(Number(u.port));
  } catch { /* not a URL */ }
  return [...new Set(ports)];
}

/** Static guess: CLAUDE_ROUTER_PORT, else the most likely candidate from ANTHROPIC_BASE_URL, else 4000. */
function proxyPort(env = process.env) {
  const explicit = Number(env.CLAUDE_ROUTER_PORT);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return candidatePorts(env)[0] ?? 4000;
}

/**
 * The port the router really listens on. CLAUDE_ROUTER_PORT is authoritative;
 * otherwise every candidate from ANTHROPIC_BASE_URL is asked for /health and the
 * first one answering as `claude-router-proxy` wins, so the router can sit anywhere
 * in a chain of local relays. With no answer, falls back to the static guess.
 */
async function findProxyPort(env = process.env) {
  const explicit = Number(env.CLAUDE_ROUTER_PORT);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  for (const port of candidatePorts(env)) {
    const res = await request(port, 'GET', '/health');
    try {
      if (res && res.status === 200 && JSON.parse(res.body).service === 'claude-router-proxy') return port;
    } catch { /* not the router */ }
  }
  return proxyPort(env);
}

/** Read all of stdin as JSON; `{}` on empty or malformed input (hooks must never fail on it). */
function readStdinJson() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (raw += chunk));
    process.stdin.on('end', () => {
      try { resolve(raw.trim() ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    process.stdin.on('error', () => resolve({}));
    if (process.stdin.isTTY) resolve({});
  });
}

/** One short HTTP request to the proxy on loopback; resolves null on any failure or after `timeoutMs`. */
function request(port, method, path, body, timeoutMs = 300) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path,
        headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    const giveUp = () => { req.destroy(); resolve(null); };
    req.setTimeout(timeoutMs, giveUp);
    req.on('error', () => resolve(null));
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { proxyPort, findProxyPort, candidatePorts, readStdinJson, request };
