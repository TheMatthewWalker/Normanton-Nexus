// routes/sales.js manages Customer Standard Instructions
// (dbo.CustomerStandardInstructions). Real logic worth testing: the single
// PUT's exists-then-UPDATE/INSERT branch, and bulk-import's per-row
// validation + continue-on-failure behavior (a single bad row must not
// abort the rest of the batch).

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const salesUser = { ...operatorUser, departments: ['sales'], permissions: [] };
const salesSupervisor = { ...operatorUser, departments: ['sales'], permissions: ['SALES_SUPERVISOR'] };

let salesRouter;
let appNone;
let appSales;
let appSupervisor;

beforeAll(async () => {
  ({ default: salesRouter } = await import('../../routes/sales.js'));
  appNone = buildTestApp(salesRouter, { sessionUser: operatorUser }); // production dept, no sales access
  appSales = buildTestApp(salesRouter, { sessionUser: salesUser });
  appSupervisor = buildTestApp(salesRouter, { sessionUser: salesSupervisor });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET /customer-instructions', () => {
  test('403s outside the sales department', async () => {
    const res = await request(appNone).get('/customer-instructions').set('Accept', 'application/json');
    expect(res.status).toBe(403);
  });

  test('returns the full list', async () => {
    queueResults({ recordset: [{ Customer: 'C1', Instructions: 'Leave at gate' }] });
    const res = await request(appSales).get('/customer-instructions');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ Customer: 'C1', Instructions: 'Leave at gate' }]);
  });
});

describe('PUT /customer-instructions/:customer', () => {
  test('403s without SALES_SUPERVISOR', async () => {
    const res = await request(appSales).put('/customer-instructions/C1').send({ instructions: 'x' });
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('400s when instructions text is missing or blank', async () => {
    const res = await request(appSupervisor).put('/customer-instructions/C1').send({ instructions: '   ' });
    expect(res.status).toBe(400);
  });

  test('inserts a new row when the customer has no existing instructions', async () => {
    queueResults(
      { recordset: [] }, // exists check
      { recordset: [] }, // INSERT
    );
    const res = await request(appSupervisor).put('/customer-instructions/C1').send({ customerName: 'Acme', instructions: 'Leave at gate' });
    expect(res.status).toBe(200);
    expect(dbRequest.query.mock.calls[1][0]).toMatch(/INSERT INTO/);
  });

  test('updates the row when the customer already has instructions', async () => {
    queueResults(
      { recordset: [{ 1: 1 }] }, // exists check finds a row
      { recordset: [] }, // UPDATE
    );
    const res = await request(appSupervisor).put('/customer-instructions/C1').send({ instructions: 'New text' });
    expect(res.status).toBe(200);
    expect(dbRequest.query.mock.calls[1][0]).toMatch(/UPDATE dbo\.CustomerStandardInstructions/);
  });
});

describe('POST /customer-instructions/bulk-import', () => {
  test('403s without SALES_SUPERVISOR', async () => {
    const res = await request(appSales).post('/customer-instructions/bulk-import').send({ rows: [{ customer: 'C1', instructions: 'x' }] });
    expect(res.status).toBe(403);
  });

  test('400s when rows is missing or empty', async () => {
    const res = await request(appSupervisor).post('/customer-instructions/bulk-import').send({ rows: [] });
    expect(res.status).toBe(400);
  });

  test('validates each row independently and does not abort the batch on a bad row', async () => {
    queueResults(
      { recordset: [] }, // exists check for the one valid row
      { recordset: [] }, // its INSERT
    );
    const res = await request(appSupervisor).post('/customer-instructions/bulk-import').send({
      rows: [
        { customer: '', instructions: 'x' },                          // missing account code
        { customer: '12345678901', instructions: 'x' },                // account code too long (11 chars)
        { customer: 'C3', instructions: '' },                          // missing instructions
        { customer: 'C4', instructions: 'x'.repeat(1001) },            // instructions too long
        { customer: 'C5', instructions: 'Good instructions' },         // the one valid row
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.updated).toBe(0);
    expect(res.body.data.failed).toHaveLength(4);
    expect(res.body.data.failed.map(f => f.customer)).toEqual(['', '12345678901', 'C3', 'C4']);
  });

  test('counts an existing customer as an update, not a create', async () => {
    queueResults(
      { recordset: [{ 1: 1 }] }, // exists check finds a row
      { recordset: [] }, // UPDATE
    );
    const res = await request(appSupervisor).post('/customer-instructions/bulk-import').send({
      rows: [{ customer: 'C1', instructions: 'Updated text' }],
    });
    expect(res.body.data).toEqual({ created: 0, updated: 1, failed: [] });
  });

  test('a per-row SQL failure is captured in `failed` without aborting the remaining rows', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [] })      // exists check for C1
      .mockRejectedValueOnce(new Error('duplicate key')) // C1's INSERT fails
      .mockResolvedValueOnce({ recordset: [] })      // exists check for C2
      .mockResolvedValueOnce({ recordset: [] });     // C2's INSERT succeeds

    const res = await request(appSupervisor).post('/customer-instructions/bulk-import').send({
      rows: [
        { customer: 'C1', instructions: 'x' },
        { customer: 'C2', instructions: 'y' },
      ],
    });
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.failed).toEqual([{ customer: 'C1', error: 'duplicate key' }]);
  });
});

describe('DELETE /customer-instructions/:customer', () => {
  test('403s without SALES_SUPERVISOR', async () => {
    const res = await request(appSales).delete('/customer-instructions/C1');
    expect(res.status).toBe(403);
  });

  test('deletes the row', async () => {
    queueResults({ recordset: [] });
    const res = await request(appSupervisor).delete('/customer-instructions/C1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
