// routes/consignment.js delegates its DB work to consignmentsql.js and its
// SAP work to axios (calling SapServer) rather than touching mssql directly
// for anything except the fire-and-forget audit() helper — a different shape
// than routes/auth.js, so this exercises a second mocking pattern: mocking a
// sibling module's exports directly instead of mocking the mssql driver.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const db = {
  listConsignmentVendors: jest.fn(),
  getConsignmentVendor: jest.fn(),
  upsertConsignmentVendorConfig: jest.fn(),
  listVendorMaterials: jest.fn(),
  listConsignmentDeliveries: jest.fn(),
  upsertConsignmentDeliveriesFromSap: jest.fn(),
  addManualConsignmentDelivery: jest.fn(),
  updateConsignmentDelivery: jest.fn(),
  replaceConsignmentStockSnapshot: jest.fn(),
  getConsignmentStockSnapshot: jest.fn(),
  getConsignmentStockSnapshotMeta: jest.fn(),
  getVendorDeliveredAndDeclaredTotals: jest.fn(),
  createDeclaration: jest.fn(),
  setDeclarationLines: jest.fn(),
  getDeclaration: jest.fn(),
  listDeclarations: jest.fn(),
  confirmDeclaration: jest.fn(),
  cancelDeclaration: jest.fn(),
  buildAllocationProposal: jest.fn(),
};
jest.unstable_mockModule('../../routes/consignmentsql.js', () => db);

const axiosMock = { get: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

jest.unstable_mockModule('../../lib/consignmentDeclarationPdf.js', () => ({
  buildConsignmentDeclarationPdf: jest.fn().mockResolvedValue(Buffer.from('fake-pdf')),
}));

const mrpUser    = { userID: 1, username: 'mrp.user', role: 'operator', departments: ['logistics'], permissions: ['LOG_MRP', 'VENDOR_CONSIGNMENT'] };
const noPermUser = { userID: 2, username: 'no.perm', role: 'operator', departments: ['logistics'], permissions: [] };

let consignmentRouter;
let app;
let appNoPerm;

beforeAll(async () => {
  ({ default: consignmentRouter } = await import('../../routes/consignment.js'));
  app       = buildTestApp(consignmentRouter, { sessionUser: mrpUser });
  appNoPerm = buildTestApp(consignmentRouter, { sessionUser: noPermUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  Object.values(db).forEach(fn => fn.mockReset());
  axiosMock.get.mockReset();
});

describe('permission gating', () => {
  test('LOG_MRP-gated routes reject a user without that permission', async () => {
    const res = await request(appNoPerm).get('/vendors');
    expect(res.status).toBe(403);
    expect(db.listConsignmentVendors).not.toHaveBeenCalled();
  });
});

describe('GET /vendors', () => {
  test('returns the vendor list from the DB layer', async () => {
    db.listConsignmentVendors.mockResolvedValueOnce([{ VendorId: 1, VendorName: 'Raaj Ratna' }]);
    const res = await request(app).get('/vendors');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [{ VendorId: 1, VendorName: 'Raaj Ratna' }] });
  });
});

describe('GET /vendors/:vendorId', () => {
  test('404s when the vendor does not exist', async () => {
    db.getConsignmentVendor.mockResolvedValueOnce(null);
    const res = await request(app).get('/vendors/999');
    expect(res.status).toBe(404);
  });
});

describe('GET /vendors/:vendorId/balance', () => {
  test('computes undeclared quantity per material, clamped at zero, and flags expiring stock', async () => {
    db.getConsignmentVendor.mockResolvedValueOnce({
      VendorId: 1, VendorName: 'Raaj Ratna', TrackExpiry: true, ExpiryWarningDays: 30,
    });
    db.getVendorDeliveredAndDeclaredTotals.mockResolvedValueOnce([
      { Material: '30005R', Delivered: 100, Declared: 20 },   // undeclared = 100 - 40 - 20 = 40
      { Material: '30006R', Delivered: 50,  Declared: 60 },   // would be negative -> clamped to 0
    ]);
    db.getConsignmentStockSnapshot.mockResolvedValueOnce({ '30005R': 40, '30006R': 0 });
    db.getConsignmentStockSnapshotMeta.mockResolvedValueOnce({ lastRefreshedUtc: '2026-01-01T00:00:00Z' });
    db.listConsignmentDeliveries.mockResolvedValueOnce([
      { RemainingQty: 10, ExpiryDate: new Date().toISOString() }, // within the 30-day horizon
      { RemainingQty: 0,  ExpiryDate: new Date().toISOString() }, // fully consumed — not a warning
    ]);

    const res = await request(app).get('/vendors/1/balance');

    expect(res.status).toBe(200);
    expect(res.body.data.materials).toEqual([
      { material: '30005R', delivered: 100, currentStock: 40, declared: 20, undeclared: 40 },
      { material: '30006R', delivered: 50,  currentStock: 0,  declared: 60, undeclared: 0 },
    ]);
    expect(res.body.data.expiryWarnings).toHaveLength(1);
  });

  test('skips the expiry-warning scan entirely when the vendor does not track expiry', async () => {
    db.getConsignmentVendor.mockResolvedValueOnce({ VendorId: 2, VendorName: 'Fothergill', TrackExpiry: false });
    db.getVendorDeliveredAndDeclaredTotals.mockResolvedValueOnce([]);
    db.getConsignmentStockSnapshot.mockResolvedValueOnce({});
    db.getConsignmentStockSnapshotMeta.mockResolvedValueOnce({});

    const res = await request(app).get('/vendors/2/balance');

    expect(res.status).toBe(200);
    expect(res.body.data.expiryWarnings).toEqual([]);
    expect(db.listConsignmentDeliveries).not.toHaveBeenCalled();
  });
});

describe('POST /vendors/:vendorId/sync', () => {
  test('rejects with 422 when the vendor has no SAP vendor number set', async () => {
    db.getConsignmentVendor.mockResolvedValueOnce({ VendorId: 1, VendorName: 'Raaj Ratna', SapVendorNumber: null });

    const res = await request(app).post('/vendors/1/sync').send({});

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/no SAP vendor number set/);
  });

  test('pulls GR rows from SapServer via axios and upserts them on success', async () => {
    db.getConsignmentVendor.mockResolvedValueOnce({ VendorId: 1, VendorName: 'Raaj Ratna', SapVendorNumber: '100123' });
    axiosMock.get.mockResolvedValueOnce({
      data: {
        success: true,
        data: [
          { material: '30005R', materialDocument: '5001', materialDocItem: '1', quantity: 10, uom: 'KG', invoiceNumber: 'INV1', documentDate: '01.02.2026', postingDate: '02.02.2026' },
        ],
      },
    });
    db.upsertConsignmentDeliveriesFromSap.mockResolvedValueOnce({ inserted: 1 });

    const res = await request(app).post('/vendors/1/sync').send({});

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ pulled: 1, inserted: 1 });
    expect(db.upsertConsignmentDeliveriesFromSap).toHaveBeenCalledWith('1', [
      expect.objectContaining({ material: '30005R', quantity: 10 }),
    ]);
  });

  test('surfaces a SapServer error response as a failure, not a crash', async () => {
    db.getConsignmentVendor.mockResolvedValueOnce({ VendorId: 1, VendorName: 'Raaj Ratna', SapVendorNumber: '100123' });
    axiosMock.get.mockResolvedValueOnce({ data: { success: false, error: 'SAP is down' } });

    const res = await request(app).post('/vendors/1/sync').send({});

    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('SAP is down');
  });
});

describe('POST /declarations/:declarationId/confirm', () => {
  test('rejects a non-numeric settlement document number before touching the DB', async () => {
    const res = await request(app)
      .post('/declarations/1/confirm')
      .send({ settlementDocumentNumber: 'not-a-number' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/isn't a valid settlement document number/);
    expect(db.confirmDeclaration).not.toHaveBeenCalled();
  });

  test('rejects a settlement document number longer than 10 digits', async () => {
    const res = await request(app)
      .post('/declarations/1/confirm')
      .send({ settlementDocumentNumber: '12345678901' });

    expect(res.status).toBe(400);
  });

  test('accepts a valid numeric settlement document number', async () => {
    db.confirmDeclaration.mockResolvedValueOnce({ DeclarationId: 1, Status: 'Confirmed' });

    const res = await request(app)
      .post('/declarations/1/confirm')
      .send({ settlementDocumentNumber: '1700003535', settlementReconciledQty: 100 });

    expect(res.status).toBe(200);
    expect(db.confirmDeclaration).toHaveBeenCalledWith('1', '1700003535', 100, 'mrp.user');
  });
});
