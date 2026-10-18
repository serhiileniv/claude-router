import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProxyApp } from '../proxy/server.js';
import { SseUsageParser, usageFromSse, MAX_REQUEST_BODY_BYTES, routeHistory } from '../proxy/handler.js';
import { readLifetimeStatsAsync, resetHistoryCache } from '../proxy/history.js';
import { DEFAULT_MODELS } from '../models.js';

const START = 'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":3}}}\n\n';
const DELTA = 'data: {"type":"message_delta","usage":{"output_tokens":7}}\n\n';

describe('SseUsageParser - bounded streaming usage parse', () => {
  it('matches usageFromSse when fed in arbitrary chunk splits', () => {
    const text = START + 'data: nope\n\n' + DELTA;
    for (const size of [1, 3, 17, text.length]) {
      const p = new SseUsageParser();
      for (let i = 0; i < text.length; i += size) p.push(text.slice(i, i + size));
      assert.deepEqual(p.result(), usageFromSse(text), `chunk size ${size}`);
    }
  });

  it('does not grow with stream length', () => {
    const p = new SseUsageParser();
    p.push(START);
    const line = 'data: {"type":"content_block_delta","delta":{"text":"' + 'x'.repeat(1000) + '"}}\n\n';
    let peak = 0;
    for (let i = 0; i < 20_000; i++) { // ~20 MB of stream
      p.push(line);
      peak = Math.max(peak, p.bufferedChars);
    }
    p.push(DELTA);
    assert.ok(peak < 4096, `buffer stayed at one partial line, peak ${peak}`);
    assert.deepEqual(p.result(), { model: 'm', usage: { input_tokens: 3, output_tokens: 7 } });
  });

  it('drops a single endless line instead of buffering it, and recovers at the next newline', () => {
    const p = new SseUsageParser();
    p.push(START);
    for (let i = 0; i < 100; i++) p.push('y'.repeat(100_000)); // 10 MB, no newline
    assert.ok(p.bufferedChars <= 1_048_576, `capped, was ${p.bufferedChars}`);
    p.push('\n\n' + DELTA);
    assert.deepEqual(p.result(), { model: 'm', usage: { input_tokens: 3, output_tokens: 7 } });
  });
});

describe('readLifetimeStatsAsync - dashboard stats do not block the event loop', () => {
  it('yields to timers while folding a large history, and totals match', async () => {
    resetHistoryCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crouter-mem-'));
    const file = path.join(dir, 'history.jsonl');
    const line = JSON.stringify({
      timestamp: '2026-07-02T10:00:00.000Z', tier: 'haiku', model: 'm', costCents: 1, savedCents: 2,
      confidence: 1, classifier: 'heuristic', retried: false, retryReason: null, inputTokens: 1, outputTokens: 1,
      reason: 'x'.repeat(500),
    }) + '\n';
    const count = 40_000; // ~22 MB, several chunks
    fs.writeFileSync(file, line.repeat(count));

    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    const stats = await readLifetimeStatsAsync(file);
    clearInterval(timer);

    assert.ok(ticks > 0, 'a timer fired while the file was being read');
    assert.equal(stats.requests, count);
    // Second call is incremental and concurrent callers do not double-fold.
    const [a, b] = await Promise.all([readLifetimeStatsAsync(file), readLifetimeStatsAsync(file)]);
    assert.equal(a, b);
    assert.equal(a.requests, count);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('GET /dashboard stays responsive and /health answers during the first lifetime read', async () => {
    resetHistoryCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crouter-mem-'));
    const file = path.join(dir, 'history.jsonl');
    const line = JSON.stringify({
      timestamp: '2026-07-02T10:00:00.000Z', tier: 'haiku', model: 'm', costCents: 1, savedCents: 2,
      confidence: 1, classifier: 'heuristic', retried: false, retryReason: null, inputTokens: 1, outputTokens: 1,
      reason: 'x'.repeat(500),
    }) + '\n';
    fs.writeFileSync(file, line.repeat(40_000));
    const app = createProxyApp({
      classifier: 'heuristic', defaultModel: 'claude-sonnet-4-6', verbose: false, provider: 'anthropic',
      models: DEFAULT_MODELS, forceRoute: false, historyFile: file,
    });
    let healthDone = false;
    const dash = Promise.resolve(app.request('/dashboard'));
    const health = Promise.resolve(app.request('/health')).then((r: Response) => { healthDone = true; return r; });
    const res = await dash;
    assert.equal(res.status, 200);
    assert.equal((await health).status, 200);
    assert.ok(healthDone);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('request body limit', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const make = (maxRequestBodyBytes?: number) => createProxyApp({
    classifier: 'heuristic', defaultModel: 'claude-sonnet-4-6', verbose: false, provider: 'anthropic',
    models: DEFAULT_MODELS, forceRoute: false, upstream: 'http://127.0.0.1:1', maxRequestBodyBytes,
  });
  const noFetch = () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
    return () => called;
  };

  it('default cap is 32 MiB, the Messages API request limit', () => {
    assert.equal(MAX_REQUEST_BODY_BYTES, 32 * 1024 * 1024);
  });

  it('413s a declared Content-Length over the cap without forwarding', async () => {
    const called = noFetch();
    const res = await make(1000).request('/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', pad: 'x'.repeat(5000) }),
    });
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as { error: { type: string } }).error.type, 'request_too_large');
    assert.equal(called(), false);
  });

  it('413s a chunked body that crosses the cap while streaming in', async () => {
    const called = noFetch();
    const chunk = new TextEncoder().encode('x'.repeat(400));
    const body = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(chunk); },
    });
    const res = await make(1000).request('/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body, duplex: 'half',
    } as RequestInit);
    assert.equal(res.status, 413);
    assert.equal(called(), false);
  });

  it('413s the catch-all passthrough too', async () => {
    noFetch();
    const res = await make(1000).request('/api/organizations', {
      method: 'POST', body: 'x'.repeat(5000),
    });
    assert.equal(res.status, 413);
  });

  it('lets a body under the cap through', async () => {
    const before = routeHistory.length;
    globalThis.fetch = (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch;
    const res = await make(100_000).request('/api/organizations', { method: 'POST', body: '{"a":1}' });
    assert.equal(res.status, 200);
    assert.equal(routeHistory.length, before);
  });
});
