// routes/productionnexus.js's POST /reversal/execute — flagged in CLAUDE.md
// as uncovered (only its PROD_SUPERVISOR 403 gate was tested previously).
// This endpoint's real logic is entirely in how it interprets SapServer's
// ZF40N reversal response codes (S/RM/196 = success, E/RM/210 = already
// reversed, E/M7/066 = needs MBST, anything else = a generic SAP error) —
// no DB writes beyond the fire-and-forget audit() call, so only axios needs
// mocking here.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { productionSupervisor } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const axiosMock = { post: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

let nexusRouter;
let app;

beforeAll(async () => {
  ({ default: nexusRouter } = await import('../../routes/productionnexus.js'));
  app = buildTestApp(nexusRouter, { sessionUser: productionSupervisor });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  dbRequest.query.mockResolvedValue({ recordset: [] }); // audit()'s fire-and-forget insert always succeeds
  axiosMock.post.mockReset();
});

test('400s without materialDocument', async () => {
  const res = await request(app).post('/reversal/execute').send({});
  expect(res.status).toBe(400);
  expect(axiosMock.post).not.toHaveBeenCalled();
});

test('502s when SapServer itself reports success:false', async () => {
  axiosMock.post.mockResolvedValueOnce({ data: { success: false, error: 'SapServer unreachable' } });
  const res = await request(app).post('/reversal/execute').send({ materialDocument: 'MD1' });
  expect(res.status).toBe(502);
  expect(res.body.error).toBe('SapServer unreachable');
});

test('returns the reversal document on a clean S/RM/196 reversal', async () => {
  axiosMock.post.mockResolvedValueOnce({
    data: { success: true, data: { type: 'S', messageClass: 'RM', messageNumber: '196', documentNumber: 'REV1' } },
  });
  const res = await request(app).post('/reversal/execute').send({ materialDocument: 'MD1' });
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ reversalDocument: 'REV1', originalDocument: 'MD1' });
});

test('409s with a friendly message when SAP reports the document was already reversed (E/RM/210)', async () => {
  axiosMock.post.mockResolvedValueOnce({
    data: { success: true, data: { type: 'E', messageClass: 'RM', messageNumber: '210' } },
  });
  const res = await request(app).post('/reversal/execute').send({ materialDocument: 'MD1' });
  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/already been reversed/);
});

test('422s with a friendly message when SAP requires MBST (E/M7/066)', async () => {
  axiosMock.post.mockResolvedValueOnce({
    data: { success: true, data: { type: 'E', messageClass: 'M7', messageNumber: '066' } },
  });
  const res = await request(app).post('/reversal/execute').send({ materialDocument: 'MD1' });
  expect(res.status).toBe(422);
  expect(res.body.error).toMatch(/MBST/);
});

test('502s with the raw SAP message for any other E-type response', async () => {
  axiosMock.post.mockResolvedValueOnce({
    data: { success: true, data: { type: 'E', messageClass: 'M3', messageNumber: '001', message: 'Posting period closed' } },
  });
  const res = await request(app).post('/reversal/execute').send({ materialDocument: 'MD1' });
  expect(res.status).toBe(502);
  expect(res.body.error).toBe('Posting period closed');
});

test('502s on an unexpected (non-S-success, non-E) response type', async () => {
  axiosMock.post.mockResolvedValueOnce({
    data: { success: true, data: { type: 'W', messageClass: 'RM', messageNumber: '999' } },
  });
  const res = await request(app).post('/reversal/execute').send({ materialDocument: 'MD1' });
  expect(res.status).toBe(502);
  expect(res.body.error).toMatch(/Unexpected SAP response/);
});

test('502s on a network-level failure calling SapServer', async () => {
  axiosMock.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));
  const res = await request(app).post('/reversal/execute').send({ materialDocument: 'MD1' });
  expect(res.status).toBe(502);
  expect(res.body.error).toBe('ECONNREFUSED');
});
