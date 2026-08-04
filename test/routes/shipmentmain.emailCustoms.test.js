// routes/shipmentmain.js's email and ClearPort-customs logic (flagged as
// uncovered in CLAUDE.md) is built from module-private helpers only
// reachable through the HTTP routes. This suite covers what's testable
// without standing up a full SMTP-socket or ClearPort-API fixture:
//
// POST /:shipmentId/send-collection-email — the Ex-Works/destination-email
// validation gates (using manual shipments, since their getShipmentContext
// never has deliveries and so predictably fails the "missing email" check —
// see getShipmentContext's IsManual branch, which always returns
// deliveries: []).
//
// POST /customs/create — input validation and the three "skip, don't fail
// the whole batch" branches (cancelled / not customs-required / already
// complete), each captured per-shipment in the response's `failed` array.
//
// Not covered here (documented gap, see CLAUDE.md): the actual SMTP send
// (routes/shipmentmain.js hand-rolls the SMTP protocol directly over
// net/tls sockets — no library — which would need a full multi-line
// protocol simulator to test meaningfully) and the ClearPort export/PDF
// download success path (createClearPortExport/downloadClearPortPdf are
// axios calls to an external system, gated behind a multi-query
// transactional sync this suite doesn't stand up).

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect, transaction, Transaction } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const logPlanningUser = { ...operatorUser, permissions: ['LOG_PLANNING'] };

let shipmentModule;
let app;
let appLogPlanning;

beforeAll(async () => {
  shipmentModule = await import('../../routes/shipmentmain.js');
  app = buildTestApp(shipmentModule.default, { sessionUser: operatorUser });
  appLogPlanning = buildTestApp(shipmentModule.default, { sessionUser: logPlanningUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect, transaction, Transaction });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

function manualShipmentRow(overrides) {
  return {
    shipmentID: 1, IsManual: true, forwarderID: null,
    incoTerms: 'EXW', destinationName: 'Acme Ltd',
    shipmentCancelled: false, customsRequired: true, customsComplete: false,
    ...overrides,
  };
}

describe('POST /:shipmentId/send-collection-email — validation', () => {
  test('403s without LOG_PLANNING', async () => {
    const res = await request(app).post('/1/send-collection-email').send({});
    expect(res.status).toBe(403);
  });

  test('400s when the shipment is not Ex Works', async () => {
    queueResults(
      { recordset: [manualShipmentRow({ incoTerms: 'DAP' })] }, // getShipmentById
      { recordset: [] }, // ManualCargoItem
    );
    const res = await request(appLogPlanning).post('/1/send-collection-email').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ex Works/);
  });

  test('400s when the destination has no email on file', async () => {
    queueResults(
      { recordset: [manualShipmentRow({ incoTerms: 'EXW' })] },
      { recordset: [] },
    );
    const res = await request(appLogPlanning).post('/1/send-collection-email').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Destination email is missing/);
  });

  test('404s when the shipment does not exist', async () => {
    queueResults({ recordset: [] });
    const res = await request(appLogPlanning).post('/999/send-collection-email').send({});
    expect(res.status).toBe(404);
  });
});

describe('POST /customs/create — validation', () => {
  test('403s without LOG_PLANNING', async () => {
    const res = await request(app).post('/customs/create').send({ shipmentIDs: [1] });
    expect(res.status).toBe(403);
  });

  test('400s when no shipmentIDs are given', async () => {
    const res = await request(appLogPlanning).post('/customs/create').send({ shipmentIDs: [] });
    expect(res.status).toBe(400);
  });
});

describe('POST /customs/create — per-shipment skip conditions', () => {
  test('skips (without failing the batch) a cancelled shipment', async () => {
    queueResults(
      { recordset: [{ IsManual: true }] },      // syncShipmentAggregateData's manual check
      { recordset: [] },                         // recalcManualShipmentTotals UPDATE
      { recordset: [manualShipmentRow({ shipmentCancelled: true })] }, // getShipmentContext -> getShipmentById
      { recordset: [] },                         // getShipmentContext -> ManualCargoItem
    );
    const res = await request(appLogPlanning).post('/customs/create').send({ shipmentIDs: [1] });
    expect(res.status).toBe(502); // nothing completed
    expect(res.body.data.failed).toEqual([{ shipmentID: 1, shipmentRef: '00000001', error: 'Shipment is cancelled.' }]);
  });

  test('skips a shipment not marked customs-required', async () => {
    queueResults(
      { recordset: [{ IsManual: true }] },
      { recordset: [] },
      { recordset: [manualShipmentRow({ customsRequired: false })] },
      { recordset: [] },
    );
    const res = await request(appLogPlanning).post('/customs/create').send({ shipmentIDs: [1] });
    expect(res.body.data.failed[0].error).toMatch(/not marked as customs required/);
  });

  test('skips a shipment whose customs documents are already complete', async () => {
    queueResults(
      { recordset: [{ IsManual: true }] },
      { recordset: [] },
      { recordset: [manualShipmentRow({ customsComplete: true })] },
      { recordset: [] },
    );
    const res = await request(appLogPlanning).post('/customs/create').send({ shipmentIDs: [1] });
    expect(res.body.data.failed[0].error).toMatch(/already complete/);
  });

  test('one shipment failing does not abort the rest of the batch', async () => {
    queueResults(
      // shipment 1: cancelled -> fails
      { recordset: [{ IsManual: true }] },
      { recordset: [] },
      { recordset: [manualShipmentRow({ shipmentID: 1, shipmentCancelled: true })] },
      { recordset: [] },
      // shipment 2: not customs-required -> fails too, independently
      { recordset: [{ IsManual: true }] },
      { recordset: [] },
      { recordset: [manualShipmentRow({ shipmentID: 2, customsRequired: false })] },
      { recordset: [] },
    );
    const res = await request(appLogPlanning).post('/customs/create').send({ shipmentIDs: [1, 2] });
    expect(res.body.data.failed).toHaveLength(2);
    expect(res.body.data.failed.map(f => f.shipmentID)).toEqual([1, 2]);
  });
});
