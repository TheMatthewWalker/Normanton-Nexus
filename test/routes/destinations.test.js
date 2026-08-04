// routes/destinations.js manages Logistics.dbo.Destinations. Real logic
// worth testing: GET /'s optional ?search= typeahead mode (TOP 200 + LIKE,
// vs. the unfiltered full-list default), bulk delete/update's dynamically
// built parameterized IN-clause, the field whitelist on PATCH /bulk, and
// PUT /:id/emails' delete-then-reinsert replace-all pattern. Only the
// mutating routes (bulk ops, PUT, PUT emails) are permission-gated
// (LOG_ADMIN) — the reads and POST / are open to any session per the file
// as written.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const logAdmin = { ...operatorUser, permissions: ['LOG_ADMIN'] };

let destinationsRouter;
let app;
let appAdmin;

beforeAll(async () => {
  ({ default: destinationsRouter } = await import('../../routes/destinations.js'));
  app = buildTestApp(destinationsRouter, { sessionUser: operatorUser });
  appAdmin = buildTestApp(destinationsRouter, { sessionUser: logAdmin });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET /', () => {
  test('an unfiltered request selects every row, unbounded', async () => {
    queueResults({ recordset: [] });
    await request(app).get('/');
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toBe('SELECT * FROM Logistics.dbo.Destinations  ORDER BY destinationName');
  });

  test('?search= switches to a TOP 200 name/city LIKE lookup', async () => {
    queueResults({ recordset: [{ destinationName: 'Acme UK' }] });
    const res = await request(app).get('/').query({ search: 'Acme' });
    expect(res.body).toEqual([{ destinationName: 'Acme UK' }]);
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('TOP 200');
    expect(sql).toContain('destinationName LIKE @search OR destinationCity LIKE @search');
    expect(dbRequest.input).toHaveBeenCalledWith('search', expect.anything(), '%Acme%');
  });
});

describe('GET /id/:destinationId, /country/:country, /zone/:zone', () => {
  test('looks up by ID', async () => {
    queueResults({ recordset: [{ destinationID: 1 }] });
    const res = await request(app).get('/id/1');
    expect(res.body).toEqual([{ destinationID: 1 }]);
  });

  test('looks up by country', async () => {
    queueResults({ recordset: [{ destinationCountry: 'GB' }] });
    const res = await request(app).get('/country/GB');
    expect(res.body).toEqual([{ destinationCountry: 'GB' }]);
  });

  test('looks up by zone', async () => {
    queueResults({ recordset: [{ destinationZone: 'Z1' }] });
    const res = await request(app).get('/zone/Z1');
    expect(res.body).toEqual([{ destinationZone: 'Z1' }]);
  });
});

describe('POST /', () => {
  test('creates a record', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).post('/').send({ destinationID: 1, destinationName: 'Acme' });
    expect(res.status).toBe(201);
  });
});

describe('DELETE /bulk', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).delete('/bulk').send({ ids: [1, 2] });
    expect(res.status).toBe(403);
  });

  test('400s when no valid IDs are provided', async () => {
    const res = await request(appAdmin).delete('/bulk').send({ ids: [0, -1, 'abc'] });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('builds a parameterized IN clause for every valid ID', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).delete('/bulk').send({ ids: [1, 2, 3] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(3);
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('IN (@id0,@id1,@id2)');
  });
});

describe('PATCH /bulk', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).patch('/bulk').send({ ids: [1], field: 'destinationZone', value: 'Z1' });
    expect(res.status).toBe(403);
  });

  test('400s on a field outside the whitelist', async () => {
    const res = await request(appAdmin).patch('/bulk').send({ ids: [1], field: 'destinationName', value: 'hacked' });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('400s when no valid IDs are provided', async () => {
    const res = await request(appAdmin).patch('/bulk').send({ ids: [], field: 'destinationZone', value: 'Z1' });
    expect(res.status).toBe(400);
  });

  test('updates the whitelisted column for every ID', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).patch('/bulk').send({ ids: [5, 6], field: 'defaultForwarder', value: 'FW1' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    const sql = dbRequest.query.mock.calls[0][0];
    expect(sql).toContain('SET defaultForwarder = @value');
    expect(sql).toContain('IN (@id0,@id1)');
  });
});

describe('PUT /:destinationId', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).put('/1').send({ destinationName: 'X' });
    expect(res.status).toBe(403);
  });

  test('updates the record', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).put('/1').send({ destinationName: 'Updated' });
    expect(res.status).toBe(200);
  });
});

describe('GET /:destinationId/emails', () => {
  test('returns the address list', async () => {
    queueResults({ recordset: [{ address: 'a@example.com' }, { address: 'b@example.com' }] });
    const res = await request(app).get('/1/emails');
    expect(res.body.addresses).toEqual(['a@example.com', 'b@example.com']);
  });
});

describe('PUT /:destinationId/emails', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).put('/1/emails').send({ addresses: ['a@example.com'] });
    expect(res.status).toBe(403);
  });

  test('deletes existing addresses then reinserts each non-blank one', async () => {
    queueResults(
      { recordset: [] }, // DELETE
      { recordset: [] }, // INSERT a@example.com
      { recordset: [] }, // INSERT b@example.com
    );
    const res = await request(appAdmin).put('/1/emails').send({ addresses: ['a@example.com', '  ', 'b@example.com'] });
    expect(res.status).toBe(200);
    expect(dbRequest.query).toHaveBeenCalledTimes(3); // delete + 2 real addresses, blank skipped
  });

  test('an empty address list still clears existing addresses', async () => {
    queueResults({ recordset: [] }); // DELETE only
    const res = await request(appAdmin).put('/1/emails').send({ addresses: [] });
    expect(res.status).toBe(200);
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
  });
});
