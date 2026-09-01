// routes/shipmentmain.js (3341 lines) is dominated by module-private helper
// functions (PDF/email building, SAP customs sync, ClearPort export) not
// reachable except through its ~40 HTTP routes. This suite covers the three
// functions it actually exports (getShipmentContext, getShipmentFolderInfo,
// writeShipmentEvent — also depended on by routes/freightbooking.js's
// mocks) directly, plus a representative slice of the permission-gated
// route surface. The PDF/email/ClearPort/SAP-sync logic isn't covered yet —
// see CLAUDE.md.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
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
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('getShipmentFolderInfo', () => {
  test('builds a shipment folder path from the zero-padded shipment ID and destination name', () => {
    const info = shipmentModule.getShipmentFolderInfo({ shipmentID: 42, destinationName: 'ACME Ltd' });
    expect(info.shipmentRef).toBe('00000042');
    expect(info.customerPath.endsWith('ACME Ltd')).toBe(true);
    expect(info.shipmentPath.endsWith('00000042')).toBe(true);
  });

  test('sanitizes filesystem-unsafe characters out of the destination name', () => {
    const info = shipmentModule.getShipmentFolderInfo({ shipmentID: 1, destinationName: 'A/B:C*D?' });
    expect(info.customerPath.endsWith('A_B_C_D_')).toBe(true);
  });

  test('falls back to "Unknown Customer" when destinationName is missing', () => {
    const info = shipmentModule.getShipmentFolderInfo({ shipmentID: 1 });
    expect(info.customerPath.endsWith('Unknown Customer')).toBe(true);
  });
});

describe('getShipmentContext', () => {
  test('throws a 404-flagged error when the shipment does not exist', async () => {
    queueResults({ recordset: [] });
    await expect(shipmentModule.getShipmentContext(999)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('returns manual cargo (not deliveries/pallets) for a manual shipment', async () => {
    queueResults(
      { recordset: [{ shipmentID: 1, IsManual: true, forwarderID: null }] }, // getShipmentById
      { recordset: [{ CargoID: 1, Description: 'Box' }] }, // ManualCargoItem
    );
    const context = await shipmentModule.getShipmentContext(1);
    expect(context.manualCargo).toEqual([{ CargoID: 1, Description: 'Box' }]);
    expect(context.pallets).toEqual([]);
  });

  test('looks up the forwarder name when the shipment has a forwarderID', async () => {
    queueResults(
      { recordset: [{ shipmentID: 1, IsManual: false, forwarderID: 7 }] },
      { recordset: [{ forwarderName: 'Kuehne+Nagel' }] },
      { recordset: [] }, // deliveries query for a non-manual shipment
      { recordset: [] }, // pallets query for a non-manual shipment
    );
    const context = await shipmentModule.getShipmentContext(1);
    expect(context.shipment.forwarderName).toBe('Kuehne+Nagel');
  });
});

describe('writeShipmentEvent', () => {
  test('inserts a ShipmentEvent row', async () => {
    queueResults({ recordset: [] });
    await shipmentModule.writeShipmentEvent(pool, 1, 'TEST_EVENT', 'A test event');
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
  });
});

describe('permission-gated routes', () => {
  test('POST /cancel is rejected for a user without LOG_PLANNING', async () => {
    const res = await request(app).post('/cancel').send({ shipmentId: 1 });
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('POST /mark-booked is rejected for a user without LOG_PLANNING', async () => {
    const res = await request(app).post('/mark-booked').send({});
    expect(res.status).toBe(403);
  });

  test('POST /update-planned-collection is rejected for a user without LOG_PLANNING', async () => {
    const res = await request(app).post('/update-planned-collection').send({});
    expect(res.status).toBe(403);
  });

  test('POST /events is rejected for a user without LOG_PLANNING', async () => {
    const res = await request(app).post('/events').send({ events: [{ shipmentID: 1, category: 'TEST', description: 'x' }] });
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('POST /:shipmentId/create-folder is rejected for a user without LOG_PLANNING', async () => {
    const res = await request(app).post('/1/create-folder');
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('POST /:shipmentId/generate-packaging-declaration is rejected for a user without LOG_PLANNING', async () => {
    const res = await request(app).post('/1/generate-packaging-declaration').send({});
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });
});


// Validation runs before any DB/filesystem access (no shipment lookup or
// folder write happens for a request that fails these checks), so these are
// safe to exercise without mocking fs/promises or LOGISTICS_EXPORT_ROOT —
// see this file's header comment on why the actual PDF-generation success
// path isn't covered here either.
describe('POST /:shipmentId/generate-packaging-declaration validation', () => {
  test('rejects when no packaging type is selected', async () => {
    const res = await request(appLogPlanning).post('/1/generate-packaging-declaration').send({
      packaging: { woodenPallets: false, woodenSpools: false, cardboardBoxes: false, bubblewrapSheets: false },
      position: 'Logistics Specialist',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one packaging type/i);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('rejects a blank position', async () => {
    const res = await request(appLogPlanning).post('/1/generate-packaging-declaration').send({
      packaging: { woodenPallets: true },
      position: '   ',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/position/i);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });
});

describe('GET /', () => {
  test('returns the raw recordset', async () => {
    queueResults({ recordset: [{ shipmentID: 1 }] });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
  });
});
