// routes/shipmentcost.js (883 lines) — representative sample of the plain
// CRUD + validation endpoints, plus the LOG_PLANNING permission gate on
// every write route. The SAP-posting-heavy body logic of /post-migo and
// /:costId/reverse (beyond the permission check) and /estimate aren't
// covered here yet — they pull in lib/sapCredentials.js +
// routes/materialgroups.js + a live-posting axios flow and are a natural
// next slice — see CLAUDE.md. POST /manual and the manual-cost leg of
// GET /unprocessed / GET /processed (both read-only three-way UNION ALL
// queries, added for manual/unlinked cost entry) are covered below.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const reportsUser = { ...operatorUser, permissions: ['LOG_REPORTS'] };
const planningUser = { ...operatorUser, permissions: ['LOG_PLANNING'] };

let costRouter;
let app;
let appReports;
let appPlanning;
let resolveMaterialGroup;

beforeAll(async () => {
  ({ default: costRouter, resolveMaterialGroup } = await import('../../routes/shipmentcost.js'));
  app = buildTestApp(costRouter, { sessionUser: operatorUser });
  appReports = buildTestApp(costRouter, { sessionUser: reportsUser });
  appPlanning = buildTestApp(costRouter, { sessionUser: planningUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET /', () => {
  test('returns the raw recordset', async () => {
    queueResults({ recordset: [{ costID: 1 }] });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ costID: 1 }]);
  });
});

describe('PATCH /:costId', () => {
  test('is rejected for a user without LOG_PLANNING', async () => {
    const res = await request(app).patch('/1').send({ expectedCost: 100 });
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('rejects a non-positive expectedCost', async () => {
    const res = await request(appPlanning).patch('/1').send({ expectedCost: -5 });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('400s when the line does not exist or is already posted to SAP', async () => {
    queueResults({ recordset: [] });
    const res = await request(appPlanning).patch('/1').send({ expectedCost: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already posted/);
  });

  test('updates the amount when the line is editable', async () => {
    queueResults({ recordset: [{ costID: 1 }] });
    const res = await request(appPlanning).patch('/1').send({ expectedCost: 100 });
    expect(res.status).toBe(200);
  });

  test('rejects a blank costElement when one is supplied', async () => {
    const res = await request(appPlanning).patch('/1').send({ expectedCost: 100, costElement: '  ' });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('rejects a blank costCenter when one is supplied', async () => {
    const res = await request(appPlanning).patch('/1').send({ expectedCost: 100, costCenter: '  ' });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('also updates costElement/costCenter when supplied', async () => {
    queueResults({ recordset: [{ costID: 1 }] });
    const res = await request(appPlanning).patch('/1').send({ expectedCost: 100, costElement: '601300', costCenter: '0000002011' });
    expect(res.status).toBe(200);
    const sqlText = dbRequest.query.mock.calls[0][0];
    expect(sqlText).toMatch(/costElement = @costElement/);
    expect(sqlText).toMatch(/costCenter = @costCenter/);
    expect(dbRequest.input).toHaveBeenCalledWith('costElement', expect.anything(), '601300');
    expect(dbRequest.input).toHaveBeenCalledWith('costCenter', expect.anything(), '0000002011');
  });
});

describe('DELETE /:costId', () => {
  test('is rejected for a user without LOG_PLANNING', async () => {
    const res = await request(app).delete('/1');
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('400s when the line does not exist or is already posted', async () => {
    queueResults({ recordset: [] });
    const res = await request(appPlanning).delete('/1');
    expect(res.status).toBe(400);
  });

  test('deletes an editable line', async () => {
    queueResults({ recordset: [{ costID: 1 }] });
    const res = await request(appPlanning).delete('/1');
    expect(res.status).toBe(200);
  });
});

describe('GET /shipment/:shipmentId', () => {
  test('returns the wrapped {success, data} shape', async () => {
    queueResults({ recordset: [{ costID: 1, shipmentID: 55 }] });
    const res = await request(app).get('/shipment/55');
    expect(res.body).toEqual({ success: true, data: [{ costID: 1, shipmentID: 55 }] });
  });
});

describe('POST / (create)', () => {
  test('is rejected for a user without LOG_PLANNING', async () => {
    const res = await request(app).post('/').send({ shipmentID: 1, costElement: 'X', costCenter: 'Y', expectedCost: 100 });
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('requires either shipmentID or poShipmentID', async () => {
    const res = await request(appPlanning).post('/').send({ costElement: 'X', costCenter: 'Y', expectedCost: 10 });
    expect(res.status).toBe(400);
  });

  test('requires costElement', async () => {
    const res = await request(appPlanning).post('/').send({ shipmentID: 1, costCenter: 'Y', expectedCost: 10 });
    expect(res.status).toBe(400);
  });

  test('requires costCenter', async () => {
    const res = await request(appPlanning).post('/').send({ shipmentID: 1, costElement: 'X', expectedCost: 10 });
    expect(res.status).toBe(400);
  });

  test('requires a positive expectedCost', async () => {
    const res = await request(appPlanning).post('/').send({ shipmentID: 1, costElement: 'X', costCenter: 'Y', expectedCost: 0 });
    expect(res.status).toBe(400);
  });

  test('requires costType', async () => {
    const res = await request(appPlanning).post('/').send({ shipmentID: 1, costElement: 'X', costCenter: 'Y', expectedCost: 10 });
    expect(res.status).toBe(400);
  });

  test('creates a cost line and returns the new costID', async () => {
    queueResults({ recordset: [{ costID: 42 }] });
    const res = await request(appPlanning).post('/').send({ shipmentID: 1, costElement: 'X', costCenter: 'Y', costType: 'ITLG01A', expectedCost: 100 });
    expect(res.status).toBe(201);
    expect(res.body.costID).toBe(42);
  });
});

describe('GET /unprocessed', () => {
  test('returns the combined recordset (outbound/inbound/manual union)', async () => {
    queueResults({ recordset: [{ costID: 1, sourceType: 'manual', direction: 'outbound' }] });
    const res = await request(app).get('/unprocessed');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [{ costID: 1, sourceType: 'manual', direction: 'outbound' }] });
  });
});

describe('GET /processed', () => {
  test('returns the combined recordset', async () => {
    queueResults({ recordset: [{ costID: 2, sourceType: 'outbound', migoStatus: 1 }] });
    const res = await request(app).get('/processed');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [{ costID: 2, sourceType: 'outbound', migoStatus: 1 }] });
  });
});

describe('POST /manual (create manual cost line)', () => {
  const validBody = {
    direction: 'outbound',
    tier: 'standard',
    costType: '1',
    costCenter: '0000002004',
    costElement: '601200',
    expectedCost: 150,
    forwarderID: 7,
    modeOfTransport: 'Road',
    incurredDate: '2026-08-01',
    reference: 'Haulier invoice INV-123',
    country: 'GB',
    postcode: 'LS1',
  };

  test('is rejected for a user without LOG_PLANNING', async () => {
    const res = await request(app).post('/manual').send(validBody);
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('rejects an invalid direction', async () => {
    const res = await request(appPlanning).post('/manual').send({ ...validBody, direction: 'sideways' });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('rejects an invalid tier', async () => {
    const res = await request(appPlanning).post('/manual').send({ ...validBody, tier: 'gold' });
    expect(res.status).toBe(400);
  });

  test('rejects a non-positive expectedCost', async () => {
    const res = await request(appPlanning).post('/manual').send({ ...validBody, expectedCost: 0 });
    expect(res.status).toBe(400);
  });

  test.each([
    ['costCenter', ''],
    ['costType', ''],
    ['forwarderID', null],
    ['modeOfTransport', ''],
    ['incurredDate', null],
    ['reference', '  '],
    ['country', ''],
    ['postcode', ''],
  ])('requires %s', async (field, badValue) => {
    const res = await request(appPlanning).post('/manual').send({ ...validBody, [field]: badValue });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('creates a manual cost line with both FKs NULL and returns costID', async () => {
    queueResults({ recordset: [{ costID: 99 }] });
    const res = await request(appPlanning).post('/manual').send(validBody);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { costID: 99, costElement: '601200' } });
  });

  test('falls back to a server-side cost element lookup when the client omits one', async () => {
    queueResults(
      { recordset: [{ elementCode: '601300' }] }, // lookupCostElement
      { recordset: [{ costID: 100 }] },            // INSERT
    );
    const { costElement, ...bodyWithoutElement } = validBody;
    const res = await request(appPlanning).post('/manual').send(bodyWithoutElement);
    expect(res.status).toBe(201);
    expect(res.body.data.costElement).toBe('601300');
  });

  test('422s when no cost element is configured for the direction/tier and none was supplied', async () => {
    queueResults({ recordset: [] }); // lookupCostElement finds nothing
    const { costElement, ...bodyWithoutElement } = validBody;
    const res = await request(appPlanning).post('/manual').send(bodyWithoutElement);
    expect(res.status).toBe(422);
  });
});

describe('PATCH /manual/:costId (edit manual cost line)', () => {
  const validBody = {
    direction: 'outbound',
    tier: 'standard',
    costType: '1',
    costCenter: '0000002004',
    costElement: '601200',
    expectedCost: 150,
    forwarderID: 7,
    modeOfTransport: 'Road',
    incurredDate: '2026-08-01',
    reference: 'Haulier invoice INV-123 (corrected)',
    country: 'GB',
    postcode: 'LS1',
  };

  test('is rejected for a user without LOG_PLANNING', async () => {
    const res = await request(app).patch('/manual/1').send(validBody);
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('rejects an invalid direction', async () => {
    const res = await request(appPlanning).patch('/manual/1').send({ ...validBody, direction: 'sideways' });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('rejects a non-positive expectedCost', async () => {
    const res = await request(appPlanning).patch('/manual/1').send({ ...validBody, expectedCost: 0 });
    expect(res.status).toBe(400);
  });

  test.each([
    ['costCenter', ''],
    ['costType', ''],
    ['forwarderID', null],
    ['modeOfTransport', ''],
    ['incurredDate', null],
    ['reference', '  '],
    ['country', ''],
    ['postcode', ''],
  ])('requires %s', async (field, badValue) => {
    const res = await request(appPlanning).patch('/manual/1').send({ ...validBody, [field]: badValue });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('400s when the line does not exist, is not a manual line, or is already posted to SAP', async () => {
    queueResults({ recordset: [] });
    const res = await request(appPlanning).patch('/manual/1').send(validBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already posted/);
  });

  test('updates an editable manual line and returns its costID', async () => {
    queueResults({ recordset: [{ costID: 1 }] });
    const res = await request(appPlanning).patch('/manual/1').send(validBody);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { costID: 1, costElement: '601200' } });
  });

  test('falls back to a server-side cost element lookup when the client omits one', async () => {
    queueResults(
      { recordset: [{ elementCode: '601300' }] }, // lookupCostElement
      { recordset: [{ costID: 1 }] },              // UPDATE
    );
    const { costElement, ...bodyWithoutElement } = validBody;
    const res = await request(appPlanning).patch('/manual/1').send(bodyWithoutElement);
    expect(res.status).toBe(200);
    expect(res.body.data.costElement).toBe('601300');
  });
});

// Cost Type IS the SAP Material Group post-migo sends directly now (per the
// user, replacing the old GL-account + mode-of-transport -> Material Group
// lookup table, log.MaterialGroupMapping, now dropped). resolveMaterialGroup
// is the pre-flight check post-migo runs per line before ever calling SAP —
// see its own comment in routes/shipmentcost.js for the fail-fast reasoning.
describe('resolveMaterialGroup', () => {
  test('throws a clear error when costType is blank', async () => {
    await expect(resolveMaterialGroup(pool, '')).rejects.toThrow(/no Cost Type set/i);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('throws a clear error when costType is not a recognised code', async () => {
    queueResults({ recordset: [] });
    await expect(resolveMaterialGroup(pool, 'BOGUS')).rejects.toThrow(/not a recognised SAP Material Group code/i);
  });

  test('returns the costType unchanged when it is a recognised code', async () => {
    queueResults({ recordset: [{ typeID: 'ITLG01A' }] });
    await expect(resolveMaterialGroup(pool, 'ITLG01A')).resolves.toBe('ITLG01A');
  });
});

describe('POST /post-migo', () => {
  test('is rejected for a user without LOG_PLANNING', async () => {
    const res = await request(app).post('/post-migo').send({ costIDs: [1] });
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });
});

describe('POST /:costId/reverse', () => {
  test('is rejected for a user without LOG_PLANNING', async () => {
    const res = await request(app).post('/1/reverse');
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });
});

describe('GET /analytics', () => {
  test('is rejected for a user without LOG_ADMIN/LOG_MRP/LOG_REPORTS', async () => {
    const res = await request(app).get('/analytics');
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });
});
