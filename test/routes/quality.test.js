// routes/quality.js proxies quality-block/unblock calls to SapServer via
// axios (mocked here — no DB access in this file at all). The real logic
// worth testing beyond the proxy plumbing is POST /bulk's SAP-format
// quantity parsing ("10.875,000" -> 10875), its WM-vs-non-WM storage-type/
// bin field selection, and its Server-Sent-Events progress stream.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const axiosMock = { get: jest.fn(), post: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

const qualUser = { ...operatorUser, permissions: ['QUAL_BLOCKING'] };

let qualityRouter;
let app;
let appQual;

beforeAll(async () => {
  ({ default: qualityRouter } = await import('../../routes/quality.js'));
  app = buildTestApp(qualityRouter, { sessionUser: operatorUser });
  appQual = buildTestApp(qualityRouter, { sessionUser: qualUser });
});

beforeEach(() => {
  axiosMock.get.mockReset();
  axiosMock.post.mockReset();
});

function sseEvents(text) {
  return text.trim().split('\n\n').filter(Boolean).map(line => JSON.parse(line.replace(/^data: /, '')));
}

describe('GET /display', () => {
  test('forwards query params and returns SapServer\'s response body', async () => {
    axiosMock.get.mockResolvedValueOnce({ data: { rows: [{ Material: 'M1' }] } });
    const res = await request(app).get('/display').query({ plant: '1000' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rows: [{ Material: 'M1' }] });
    expect(axiosMock.get.mock.calls[0][1].params).toEqual({ plant: '1000' });
  });

  test('surfaces SapServer\'s error status and message', async () => {
    axiosMock.get.mockRejectedValueOnce({ response: { status: 422, data: { error: 'Bad plant' } } });
    const res = await request(app).get('/display');
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ success: false, error: 'Bad plant' });
  });
});

describe('POST /block and /unblock', () => {
  test('/block 403s without QUAL_BLOCKING', async () => {
    const res = await request(app).post('/block').send({});
    expect(res.status).toBe(403);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('/block injects the session username into the SAP request body', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { success: true } });
    await request(appQual).post('/block').send({ Material: 'M1' });
    expect(axiosMock.post.mock.calls[0][1]).toMatchObject({ Material: 'M1', Username: qualUser.username });
  });

  test('/unblock 403s without QUAL_BLOCKING', async () => {
    const res = await request(app).post('/unblock').send({});
    expect(res.status).toBe(403);
  });

  test('/unblock injects the session username too', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { success: true } });
    await request(appQual).post('/unblock').send({ Material: 'M2' });
    expect(axiosMock.post.mock.calls[0][1]).toMatchObject({ Material: 'M2', Username: qualUser.username });
  });
});

describe('POST /bulk', () => {
  test('403s without QUAL_BLOCKING', async () => {
    const res = await request(app).post('/bulk').send({ rows: [{}], direction: 'block' });
    expect(res.status).toBe(403);
  });

  test('400s when rows is missing or empty', async () => {
    const res = await request(appQual).post('/bulk').send({ rows: [], direction: 'block' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No rows/);
  });

  test('400s on an invalid direction', async () => {
    const res = await request(appQual).post('/bulk').send({ rows: [{}], direction: 'delete' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid direction/);
  });

  test('streams a start/progress/complete SSE sequence and posts one request per row', async () => {
    axiosMock.post
      .mockResolvedValueOnce({ data: { data: { toBlockedMessage: 'Blocked OK' } } })
      .mockResolvedValueOnce({ data: { data: { toBlockedMessage: 'Blocked OK 2' } } });

    const res = await request(appQual).post('/bulk').send({
      direction: 'block',
      header: 'Test run',
      rows: [
        { Material: 'M1', 'Storage Loc': '1000', Qty: '5' },
        { Material: 'M2', 'Storage Loc': '1000', Qty: '3' },
      ],
    });

    expect(axiosMock.post).toHaveBeenCalledTimes(2);
    const events = sseEvents(res.text);
    expect(events[0]).toEqual({ type: 'start', total: 2 });
    expect(events[1]).toMatchObject({ type: 'progress', done: 1, success: true, material: 'M1', message: 'Blocked OK' });
    expect(events[2]).toMatchObject({ type: 'progress', done: 2, success: true, material: 'M2', message: 'Blocked OK 2' });
    expect(events[3]).toEqual({ type: 'complete', total: 2 });
  });

  test('parses a SAP-format decimal quantity ("10.875,000" -> 10875)', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { data: {} } });
    await request(appQual).post('/bulk').send({
      direction: 'block',
      rows: [{ Material: 'M1', 'Storage Loc': '1000', Qty: '10.875,000' }],
    });
    expect(axiosMock.post.mock.calls[0][1].Quantity).toBe(10875);
  });

  test('parses a plain integer quantity with thousands separators ("1.200" -> 1200)', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { data: {} } });
    await request(appQual).post('/bulk').send({
      direction: 'block',
      rows: [{ Material: 'M1', 'Storage Loc': '1000', Qty: '1.200' }],
    });
    expect(axiosMock.post.mock.calls[0][1].Quantity).toBe(1200);
  });

  test('defaults an unparseable quantity to 1', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { data: {} } });
    await request(appQual).post('/bulk').send({
      direction: 'block',
      rows: [{ Material: 'M1', 'Storage Loc': '1000', Qty: '' }],
    });
    expect(axiosMock.post.mock.calls[0][1].Quantity).toBe(1);
  });

  test('sends BinType/Bin only for WM storage locations (1710/1711)', async () => {
    axiosMock.post.mockResolvedValue({ data: { data: {} } });
    await request(appQual).post('/bulk').send({
      direction: 'block',
      rows: [
        { Material: 'M1', 'Storage Loc': '1710', 'Storage Type': 'PDR', 'Storage Bin': 'B1', Qty: '1' },
        { Material: 'M2', 'Storage Loc': '1000', 'Storage Type': 'PDR', 'Storage Bin': 'B1', Qty: '1' },
      ],
    });
    expect(axiosMock.post.mock.calls[0][1]).toMatchObject({ BinType: 'PDR', Bin: 'B1' });
    expect(axiosMock.post.mock.calls[1][1]).toMatchObject({ BinType: '', Bin: '' });
  });

  test('reports a per-row failure without aborting the remaining rows', async () => {
    axiosMock.post
      .mockRejectedValueOnce({ response: { data: { error: 'Locked' } } })
      .mockResolvedValueOnce({ data: { data: { toBlockedMessage: 'OK' } } });

    const res = await request(appQual).post('/bulk').send({
      direction: 'block',
      rows: [
        { Material: 'M1', 'Storage Loc': '1000', Qty: '1' },
        { Material: 'M2', 'Storage Loc': '1000', Qty: '1' },
      ],
    });

    const events = sseEvents(res.text);
    expect(events[1]).toMatchObject({ success: false, material: 'M1', error: 'Locked' });
    expect(events[2]).toMatchObject({ success: true, material: 'M2', message: 'OK' });
  });
});
