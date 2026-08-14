// routes/productionnexus.js's POST /scrap-reversal/reverse — previously
// untested. Its logic (reverseScrapDocumentItem) is now shared with
// /scrap-reversal/reverse/bulk, an SSE route added alongside it (mirroring
// the pre-existing /reversal/bulk) — that -bulk sibling is deliberately left
// untested here, same as /reversal/bulk itself, since this codebase has no
// existing SSE-stream test infrastructure to reuse; its per-item business
// logic is exactly reverseScrapDocumentItem, fully covered below via the
// single-item route.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { productionSupervisor, operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const axiosMock = { post: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

let nexusRouter;
let app;
let appSupervisor;

beforeAll(async () => {
  ({ default: nexusRouter } = await import('../../routes/productionnexus.js'));
  app = buildTestApp(nexusRouter, { sessionUser: operatorUser });
  appSupervisor = buildTestApp(nexusRouter, { sessionUser: productionSupervisor });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  dbRequest.query.mockResolvedValue({ recordset: [] }); // audit()'s fire-and-forget insert always succeeds
  axiosMock.post.mockReset();
});

describe('POST /scrap-reversal/reverse', () => {
  test('is rejected for a user without PROD_SUPERVISOR', async () => {
    const res = await request(app).post('/scrap-reversal/reverse').send({ scrapDocumentID: 1, materialDocument: 'MD1' });
    expect(res.status).toBe(403);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('400s without scrapDocumentID or materialDocument', async () => {
    const res = await request(appSupervisor).post('/scrap-reversal/reverse').send({ scrapDocumentID: 1 });
    expect(res.status).toBe(400);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('404s when the scrap document does not exist', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] }); // the IsReversed lookup

    const res = await request(appSupervisor)
      .post('/scrap-reversal/reverse')
      .send({ scrapDocumentID: 1, materialDocument: 'MD1' });

    expect(res.status).toBe(404);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('409s when the scrap document is already reversed in the DB', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ IsReversed: true }] });

    const res = await request(appSupervisor)
      .post('/scrap-reversal/reverse')
      .send({ scrapDocumentID: 1, materialDocument: 'MD1' });

    expect(res.status).toBe(409);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('syncs the DB and returns synced:true when SAP reports M7/067 (already reversed) via an error response', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ IsReversed: false }] }); // precondition check
    const sapErr = new Error('request failed');
    sapErr.response = { data: { data: { responses: [{ messageClass: 'M7', messageNumber: '067' }] } } };
    axiosMock.post.mockRejectedValueOnce(sapErr);

    const res = await request(appSupervisor)
      .post('/scrap-reversal/reverse')
      .send({ scrapDocumentID: 1, materialDocument: 'MD1' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, synced: true, data: { reversalDocument: null } });
    // precondition SELECT + the sync UPDATE + audit()'s insert
    expect(dbRequest.query).toHaveBeenCalledTimes(3);
  });

  test('syncs the DB and returns synced:true when SAP reports M7/067 in a 200 response body', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ IsReversed: false }] });
    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, data: { responses: [{ messageClass: 'M7', messageNumber: '067' }] } },
    });

    const res = await request(appSupervisor)
      .post('/scrap-reversal/reverse')
      .send({ scrapDocumentID: 1, materialDocument: 'MD1' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, synced: true });
  });

  test('502s when SapServer itself reports success:false (not M7/067)', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ IsReversed: false }] });
    axiosMock.post.mockResolvedValueOnce({ data: { success: false, error: 'SapServer unreachable' } });

    const res = await request(appSupervisor)
      .post('/scrap-reversal/reverse')
      .send({ scrapDocumentID: 1, materialDocument: 'MD1' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('SapServer unreachable');
  });

  test('extracts the reversal document and syncs the DB on success', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ IsReversed: false }] });
    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, data: { responses: [{ documentNumber: 'REV1' }] } },
    });

    const res = await request(appSupervisor)
      .post('/scrap-reversal/reverse')
      .send({ scrapDocumentID: 1, materialDocument: 'MD1' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { reversalDocument: 'REV1' } });
    expect(dbRequest.query).toHaveBeenCalledTimes(3); // precondition SELECT + sync UPDATE + audit()'s insert
  });

  test('502s and audits failure on an unexpected network-level error', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ IsReversed: false }] });
    axiosMock.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await request(appSupervisor)
      .post('/scrap-reversal/reverse')
      .send({ scrapDocumentID: 1, materialDocument: 'MD1' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('ECONNREFUSED');
  });
});
