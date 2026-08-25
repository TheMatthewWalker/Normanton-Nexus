// routes/performance.js (3637 lines) delegates most of its MRP/vendor/
// demand-adjustment business logic to routes/performancesql.js (`db`,
// mocked wholesale here — its own 1984 lines of query logic aren't
// exercised directly by this file, only performance.js's routing/
// validation/permission layer on top of it). mssql is still mocked
// separately for the handful of routes that query directly (auditQuery,
// refresh-status). Covers the vendor/demand-adjustment CRUD surface,
// consignment-customer flagging, and the LOG_MRP/LOG_ADMIN permission
// gates — the MRP order-suggestions/shipment/SAP-posting endpoints (the
// largest remaining chunk of this file) aren't covered yet, see CLAUDE.md.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const db = {
  listVendors: jest.fn(),
  createVendor: jest.fn(),
  updateVendor: jest.fn(),
  deleteVendor: jest.fn(),
  listVendorMaterials: jest.fn(),
  addVendorMaterial: jest.fn(),
  updateVendorMaterial: jest.fn(),
  deleteVendorMaterial: jest.fn(),
  listDemandAdjustmentsForAdmin: jest.fn(),
  createDemandAdjustment: jest.fn(),
  updateDemandAdjustment: jest.fn(),
  deleteDemandAdjustment: jest.fn(),
  listConsignmentCustomers: jest.fn(),
  upsertConsignmentCustomer: jest.fn(),
  deleteConsignmentCustomer: jest.fn(),
};
jest.unstable_mockModule('../../routes/performancesql.js', () => db);

const mrpUser = { ...operatorUser, permissions: ['LOG_MRP'] };
const adminUser2 = { ...operatorUser, permissions: ['LOG_ADMIN'] };

let performanceRouter;
let app;
let appMrp;
let appAdmin;

beforeAll(async () => {
  ({ default: performanceRouter } = await import('../../routes/performance.js'));
  app = buildTestApp(performanceRouter, { sessionUser: operatorUser });
  appMrp = buildTestApp(performanceRouter, { sessionUser: mrpUser });
  appAdmin = buildTestApp(performanceRouter, { sessionUser: adminUser2 });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  Object.values(db).forEach(fn => fn.mockReset());
  dbRequest.query.mockResolvedValue({ recordset: [] }); // auditQuery etc. default to succeeding
});

describe('vendors', () => {
  test('GET /vendors is rejected without LOG_MRP', async () => {
    const res = await request(app).get('/vendors');
    expect(res.status).toBe(403);
  });

  test('GET /vendors returns the list for an LOG_MRP user', async () => {
    db.listVendors.mockResolvedValueOnce([{ vendorId: 1, vendorName: 'Raaj Ratna' }]);
    const res = await request(appMrp).get('/vendors');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ vendorId: 1, vendorName: 'Raaj Ratna' }]);
  });

  test('POST /vendors requires a vendorName', async () => {
    const res = await request(appMrp).post('/vendors').send({});
    expect(res.status).toBe(400);
    expect(db.createVendor).not.toHaveBeenCalled();
  });

  test('POST /vendors rewrites a duplicate-name SQL error into a clear message', async () => {
    db.createVendor.mockRejectedValueOnce(new Error('Violation of UQ_Vendor_Name constraint'));
    const res = await request(appMrp).post('/vendors').send({ vendorName: 'Raaj Ratna' });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toMatch(/already exists/);
  });

  test('POST /vendors creates successfully', async () => {
    db.createVendor.mockResolvedValueOnce(42);
    const res = await request(appMrp).post('/vendors').send({ vendorName: 'New Vendor' });
    expect(res.status).toBe(200);
    expect(res.body.data.vendorId).toBe(42);
  });

  test('DELETE /vendors/:vendorId is rejected without LOG_MRP', async () => {
    const res = await request(app).delete('/vendors/1');
    expect(res.status).toBe(403);
    expect(db.deleteVendor).not.toHaveBeenCalled();
  });

  test('DELETE /vendors/:vendorId succeeds for an LOG_MRP user', async () => {
    const res = await request(appMrp).delete('/vendors/1');
    expect(res.status).toBe(200);
    expect(db.deleteVendor).toHaveBeenCalledWith('1');
  });
});

describe('demand adjustments', () => {
  test('POST requires a material', async () => {
    const res = await request(appMrp).post('/demand-adjustments').send({ usagePercent: 50 });
    expect(res.status).toBe(400);
  });

  test('POST rejects a negative usagePercent', async () => {
    const res = await request(appMrp).post('/demand-adjustments').send({ material: '30005R', usagePercent: -10 });
    expect(res.status).toBe(400);
  });

  test('POST creates successfully, stamping the creator from the session', async () => {
    db.createDemandAdjustment.mockResolvedValueOnce(7);
    const res = await request(appMrp).post('/demand-adjustments').send({ material: '30005R', usagePercent: 50 });
    expect(res.status).toBe(200);
    expect(db.createDemandAdjustment).toHaveBeenCalledWith(expect.objectContaining({ material: '30005R', createdBy: mrpUser.username }));
  });
});

describe('consignment customers', () => {
  test('PUT is rejected without LOG_ADMIN', async () => {
    const res = await request(app).put('/consignment-customers/CUST1').send({ customerName: 'ACME' });
    expect(res.status).toBe(403);
  });

  test('PUT flags a customer for an LOG_ADMIN user', async () => {
    const res = await request(appAdmin).put('/consignment-customers/CUST1').send({ customerName: 'ACME' });
    expect(res.status).toBe(200);
    expect(db.upsertConsignmentCustomer).toHaveBeenCalledWith('CUST1', 'ACME', adminUser2.username);
  });

  test('DELETE is rejected without LOG_ADMIN', async () => {
    const res = await request(app).delete('/consignment-customers/CUST1');
    expect(res.status).toBe(403);
  });
});

describe('GET /turns-valclass', () => {
  test('is rejected without LOG_MRP', async () => {
    const res = await request(app).get('/turns-valclass');
    expect(res.status).toBe(403);
  });

  test('material and materialText filter independently, each scoped to its own column', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });
    const res = await request(appMrp).get('/turns-valclass').query({ material: '30005R', materialText: 'widget' });
    expect(res.status).toBe(200);
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('Material LIKE @material');
    expect(sql).toContain('MaterialText LIKE @materialText');
    expect(sql).not.toContain('@search');
    expect(dbRequest.input).toHaveBeenCalledWith('material', expect.anything(), '%30005R%');
    expect(dbRequest.input).toHaveBeenCalledWith('materialText', expect.anything(), '%widget%');
  });

  test('material alone does not also match on description', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });
    const res = await request(appMrp).get('/turns-valclass').query({ material: '30005R' });
    expect(res.status).toBe(200);
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('WHERE Material LIKE @material\n');
    expect(sql).not.toContain('MaterialText LIKE');
  });
});

describe('GET /turns-valclass/refresh-status', () => {
  test('is rejected for a user with none of LOG_ADMIN/LOG_MRP/LOG_REPORTS', async () => {
    const res = await request(app).get('/turns-valclass/refresh-status');
    expect(res.status).toBe(403);
  });

  test('reports the latest status per dataset', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [
        { DatasetName: 'TurnsValClass', Status: 'Success', CompletedAtUtc: '2026-01-01T00:00:00Z', RunId: 2 },
        { DatasetName: 'ValuationClasses', Status: 'Failed', CompletedAtUtc: '2026-01-01T00:05:00Z', RunId: 1 },
      ],
    });
    const res = await request(appMrp).get('/turns-valclass/refresh-status');
    expect(res.status).toBe(200);
    expect(res.body.data.datasets).toHaveLength(2);
  });
});

describe('GET /turns-valclass/aggregates', () => {
  test('is rejected for a user with none of LOG_ADMIN/LOG_MRP/LOG_REPORTS', async () => {
    const res = await request(app).get('/turns-valclass/aggregates');
    expect(res.status).toBe(403);
  });

  test('returns totals grouped by turnover category, profit centre and material type', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ materialCount: 2, totalStockValue: 100, totalBookValue: 90, warningCount: 0, avgStockTurns: 1, avgDaysInStock: 30 }] })
      .mockResolvedValueOnce({ recordset: [{ category: '<10 days', materialCount: 1, stockValue: 40 }] })
      .mockResolvedValueOnce({ recordset: [{ profitCentre: '2012', materialCount: 2, stockValue: 100, bookValue: 90 }] })
      .mockResolvedValueOnce({ recordset: [{ materialType: 'FERT', materialCount: 2, stockValue: 100 }] });

    const res = await request(appMrp).get('/turns-valclass/aggregates');
    expect(res.status).toBe(200);
    expect(res.body.data.byProfitCentre).toEqual([{ profitCentre: '2012', materialCount: 2, stockValue: 100, bookValue: 90 }]);
    expect(res.body.data.byValuationClass).toBeUndefined();

    const profitCentreSql = dbRequest.query.mock.calls[2][0];
    expect(profitCentreSql).toContain('GROUP BY ProfitCentre');
  });
});

describe('GET /turns-valclass/value-history', () => {
  test('is rejected for a user with none of LOG_ADMIN/LOG_MRP/LOG_REPORTS', async () => {
    const res = await request(app).get('/turns-valclass/value-history');
    expect(res.status).toBe(403);
  });

  test('returns daily stock value per material type from the append-only history table', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [
        { snapshotDate: '2026-01-01T00:00:00.000Z', materialType: 'FERT', stockValue: 100 },
        { snapshotDate: '2026-01-02T00:00:00.000Z', materialType: 'FERT', stockValue: 110 },
      ],
    });
    const res = await request(appMrp).get('/turns-valclass/value-history');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('log.StockValuationHistory');
    expect(sql).toContain('GROUP BY SnapshotDate, MaterialType');
  });
});
