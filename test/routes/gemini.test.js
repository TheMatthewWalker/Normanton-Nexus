// routes/gemini.js proxies chat questions to an internal GenAI service
// (GEMINI_URL env var) and audits every ask/error via mssql. global.fetch
// is mocked here (Node's built-in fetch, not axios). Note: the askLimiter
// rate-limit middleware is created once at module load and its counter is
// shared across every test in this file (same source IP throughout) — the
// dedicated rate-limit test is deliberately last and fires a burst of
// requests rather than relying on an exact running count.

import { describe, test, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const originalFetch = global.fetch;
const originalGeminiUrl = process.env.GEMINI_URL;

let geminiRouter;
let app;

beforeAll(async () => {
  ({ default: geminiRouter } = await import('../../routes/gemini.js'));
  app = buildTestApp(geminiRouter, { sessionUser: operatorUser });
});

afterAll(() => {
  global.fetch = originalFetch;
  if (originalGeminiUrl === undefined) delete process.env.GEMINI_URL;
  else process.env.GEMINI_URL = originalGeminiUrl;
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  dbRequest.query.mockResolvedValue({ recordset: [] });
  global.fetch = jest.fn();
  process.env.GEMINI_URL = 'https://gemini.internal';
});

function auditedEventTypes() {
  return dbRequest.input.mock.calls.filter(c => c[0] === 'eventType').map(c => c[2]);
}

test('400s when question is missing or blank', async () => {
  const res = await request(app).post('/ask').send({ question: '   ' });
  expect(res.status).toBe(400);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('500s with a clear message when GEMINI_URL is not configured', async () => {
  delete process.env.GEMINI_URL;
  const res = await request(app).post('/ask').send({ question: 'What is OTIF?' });
  expect(res.status).toBe(500);
  expect(res.body.error).toMatch(/GEMINI_URL is not configured/);
});

test('trims a trailing slash off GEMINI_URL before building the target URL', async () => {
  process.env.GEMINI_URL = 'https://gemini.internal/';
  global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ reply: 'Hi' }) });
  await request(app).post('/ask').send({ question: 'Hi' });
  expect(global.fetch.mock.calls[0][0]).toBe('https://gemini.internal/genai/chat');
});

test('returns the trimmed reply and audits ASK_GEMINI on success', async () => {
  global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ reply: '  The answer.  ' }) });
  const res = await request(app).post('/ask').send({ question: 'What is OTIF?' });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, answer: 'The answer.' });
  expect(auditedEventTypes()).toEqual(['ASK_GEMINI']);
});

test('falls back to "No response returned." when the reply is empty', async () => {
  global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
  const res = await request(app).post('/ask').send({ question: 'Hi' });
  expect(res.body.answer).toBe('No response returned.');
});

test('a non-ok response uses detail/error from the body for the thrown message, and audits ASK_GEMINI_ERROR', async () => {
  global.fetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ detail: 'Model overloaded' }) });
  const res = await request(app).post('/ask').send({ question: 'Hi' });
  expect(res.status).toBe(500);
  expect(res.body).toEqual({ success: false, error: 'Failed to get response from Gemini server' });
  expect(auditedEventTypes()).toEqual(['ASK_GEMINI_ERROR']);
});

test('a network-level fetch rejection is also caught and audited as an error', async () => {
  global.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
  const res = await request(app).post('/ask').send({ question: 'Hi' });
  expect(res.status).toBe(500);
  expect(auditedEventTypes()).toEqual(['ASK_GEMINI_ERROR']);
});

test('eventually rate-limits after enough requests from the same source', async () => {
  global.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ reply: 'ok' }) });
  const statuses = [];
  for (let i = 0; i < 25; i++) {
    const res = await request(app).post('/ask').send({ question: `Q${i}` });
    statuses.push(res.status);
  }
  expect(statuses).toContain(429);
}, 20000);
