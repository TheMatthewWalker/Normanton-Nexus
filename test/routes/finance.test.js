// routes/finance.js manages GL account groupings (dbo.FinanceGlGroups +
// dbo.FinanceGlGroupAccounts) — no permission gates of its own (relies on
// server.js's mount-level session check). The logic worth verifying is the
// group/accounts join shape on GET, the replace-all-accounts behavior on
// PUT, and that blank account strings are skipped rather than inserted.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let financeRouter;
let app;

beforeAll(async () => {
  ({ default: financeRouter } = await import('../../routes/finance.js'));
  app = buildTestApp(financeRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET /gl-groups', () => {
  test('nests each group\'s GL accounts under it', async () => {
    queueResults(
      { recordset: [{ GroupID: 1, GroupLabel: 'Freight', SortOrder: 0 }, { GroupID: 2, GroupLabel: 'Duty', SortOrder: 1 }] },
      { recordset: [{ GroupID: 1, GlAccount: '602100' }, { GroupID: 1, GlAccount: '602200' }] },
    );
    const res = await request(app).get('/gl-groups');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: 1, label: 'Freight', accounts: ['602100', '602200'] },
      { id: 2, label: 'Duty', accounts: [] },
    ]);
  });

  test('a DB failure is reported as a 500', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
    const res = await request(app).get('/gl-groups');
    expect(res.status).toBe(500);
  });
});

describe('POST /gl-groups', () => {
  test('400s when label is missing or blank', async () => {
    const res = await request(app).post('/gl-groups').send({ label: '   ' });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('creates the group and inserts each non-blank account', async () => {
    queueResults(
      { recordset: [{ GroupID: 9 }] }, // the group INSERT
      { recordset: [] }, // account 1
      { recordset: [] }, // account 2 (blank one is skipped, no query for it)
    );
    const res = await request(app).post('/gl-groups').send({ label: 'Insurance', accounts: ['602300', '', '602400'] });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ id: 9 });
    expect(dbRequest.query).toHaveBeenCalledTimes(3); // group insert + 2 real accounts, blank skipped
  });
});

describe('PUT /gl-groups/:id', () => {
  test('400s when label is missing', async () => {
    const res = await request(app).put('/gl-groups/1').send({});
    expect(res.status).toBe(400);
  });

  test('404s when the group does not exist', async () => {
    queueResults({ rowsAffected: [0] });
    const res = await request(app).put('/gl-groups/999').send({ label: 'X' });
    expect(res.status).toBe(404);
    expect(dbRequest.query).toHaveBeenCalledTimes(1); // never reaches the delete/reinsert
  });

  test('replaces the account list entirely', async () => {
    queueResults(
      { rowsAffected: [1] }, // the UPDATE
      { recordset: [] },     // DELETE all existing accounts
      { recordset: [] },     // re-insert account 1
    );
    const res = await request(app).put('/gl-groups/1').send({ label: 'Freight', accounts: ['602500'] });
    expect(res.status).toBe(200);
    expect(dbRequest.query).toHaveBeenCalledTimes(3);
  });
});

describe('DELETE /gl-groups/:id', () => {
  test('404s when nothing was deleted', async () => {
    queueResults({ rowsAffected: [0] });
    const res = await request(app).delete('/gl-groups/999');
    expect(res.status).toBe(404);
  });

  test('deletes an existing group', async () => {
    queueResults({ rowsAffected: [1] });
    const res = await request(app).delete('/gl-groups/1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
