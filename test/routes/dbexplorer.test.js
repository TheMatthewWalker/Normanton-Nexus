// routes/dbexplorer.js is the most security-sensitive read surface in the
// app — it can browse schema and data across every database on the SQL
// Server instance. Its safety hinges on two things this suite checks
// directly: the blanket `router.use(requireSuperadmin)` gate (stricter than
// plain 'admin' — even an admin, not just an operator, must be rejected),
// and the verify-then-interpolate pattern (every identifier that reaches a
// dynamic query string must first come back as an exact match from a
// parameterized sys.* lookup, or the request 404s before anything is built).

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser, adminUser, superadminUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let dbExplorerRouter;
let appOperator;
let appAdmin;
let appSuperadmin;

beforeAll(async () => {
  ({ default: dbExplorerRouter } = await import('../../routes/dbexplorer.js'));
  appOperator = buildTestApp(dbExplorerRouter, { sessionUser: operatorUser });
  appAdmin = buildTestApp(dbExplorerRouter, { sessionUser: adminUser });
  appSuperadmin = buildTestApp(dbExplorerRouter, { sessionUser: superadminUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('requireSuperadmin gate (applies to every route in this file)', () => {
  test('rejects a plain operator', async () => {
    const res = await request(appOperator).get('/databases');
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('rejects an admin — stricter than the usual requireRole(\'admin\') gate', async () => {
    const res = await request(appAdmin).get('/databases');
    expect(res.status).toBe(403);
  });

  test('allows a superadmin through', async () => {
    queueResults({ recordset: [{ name: 'kongsberg' }] });
    const res = await request(appSuperadmin).get('/databases');
    expect(res.status).toBe(200);
  });
});

describe('GET /:database/tables', () => {
  test('404s when the database name does not verify against sys.databases', async () => {
    queueResults({ recordset: [] }); // verifyDatabase finds nothing
    const res = await request(appSuperadmin).get('/NotARealDb/tables');
    expect(res.status).toBe(404);
    expect(dbRequest.query).toHaveBeenCalledTimes(1); // never reaches the tables query
  });

  test('returns the table list for a verified database', async () => {
    queueResults(
      { recordset: [{ name: 'kongsberg' }] },
      { recordset: [{ SchemaName: 'dbo', TableName: 'PortalUsers', ApproxRowCount: 100 }] },
    );
    const res = await request(appSuperadmin).get('/kongsberg/tables');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('GET /:database/:schema/:table/columns', () => {
  test('404s when the database does not verify', async () => {
    queueResults({ recordset: [] });
    const res = await request(appSuperadmin).get('/NotARealDb/dbo/PortalUsers/columns');
    expect(res.status).toBe(404);
  });

  test('404s when the table does not verify against sys.tables', async () => {
    queueResults(
      { recordset: [{ name: 'kongsberg' }] },
      { recordset: [] }, // verifyTable finds nothing
    );
    const res = await request(appSuperadmin).get('/kongsberg/dbo/NotARealTable/columns');
    expect(res.status).toBe(404);
  });

  test('returns column metadata for a verified table', async () => {
    queueResults(
      { recordset: [{ name: 'kongsberg' }] },
      { recordset: [{ SchemaName: 'dbo', TableName: 'PortalUsers' }] },
      { recordset: [{ ColumnName: 'UserID', DataType: 'int', IsPrimaryKey: true }] },
    );
    const res = await request(appSuperadmin).get('/kongsberg/dbo/PortalUsers/columns');
    expect(res.status).toBe(200);
    expect(res.body.data[0].ColumnName).toBe('UserID');
  });
});

describe('GET /:database/:schema/:table/preview', () => {
  test('clamps an excessively large ?top= to 500', async () => {
    queueResults(
      { recordset: [{ name: 'kongsberg' }] },
      { recordset: [{ SchemaName: 'dbo', TableName: 'PortalUsers' }] },
      { recordset: [] }, // the TOP (N) SELECT itself
      { recordset: [] }, // auditQuery's own insert
    );
    const res = await request(appSuperadmin).get('/kongsberg/dbo/PortalUsers/preview?top=999999');
    expect(res.status).toBe(200);
    const previewQuery = dbRequest.query.mock.calls[2][0];
    expect(previewQuery).toContain('TOP (500)');
  });

  test('clamps a non-positive ?top= up to 1, and defaults to 100 when omitted', async () => {
    queueResults(
      { recordset: [{ name: 'kongsberg' }] },
      { recordset: [{ SchemaName: 'dbo', TableName: 'PortalUsers' }] },
      { recordset: [] },
      { recordset: [] },
    );
    const res = await request(appSuperadmin).get('/kongsberg/dbo/PortalUsers/preview?top=-5');
    expect(res.status).toBe(200);
    expect(dbRequest.query.mock.calls[2][0]).toContain('TOP (1)');
  });

  test('audits both a successful preview and a failed one', async () => {
    queueResults(
      { recordset: [{ name: 'kongsberg' }] },
      { recordset: [{ SchemaName: 'dbo', TableName: 'PortalUsers' }] },
    );
    dbRequest.query.mockRejectedValueOnce(new Error('boom')); // the preview SELECT itself fails
    dbRequest.query.mockResolvedValueOnce({ recordset: [] }); // auditQuery's own error-path insert

    const res = await request(appSuperadmin).get('/kongsberg/dbo/PortalUsers/preview');

    expect(res.status).toBe(500);
    expect(dbRequest.query).toHaveBeenCalledTimes(4);
  });
});
