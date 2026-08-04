// routes/deliveryroutes.js manages Logistics.dbo.DeliveryRoutes. The real
// logic is GET /lookup: it uppercases the country, derives a 2-char
// uppercased postcode prefix, and returns null (not a 404/error) when
// nothing matches.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const logAdmin = { ...operatorUser, permissions: ['LOG_ADMIN'] };

let deliveryRoutesRouter;
let app;
let appAdmin;

beforeAll(async () => {
  ({ default: deliveryRoutesRouter } = await import('../../routes/deliveryroutes.js'));
  app = buildTestApp(deliveryRoutesRouter, { sessionUser: operatorUser });
  appAdmin = buildTestApp(deliveryRoutesRouter, { sessionUser: logAdmin });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET /lookup', () => {
  test('400s without a country', async () => {
    const res = await request(app).get('/lookup').query({ postcode: 'LS12' });
    expect(res.status).toBe(400);
  });

  test('uppercases the country and derives a 2-char uppercased postcode prefix', async () => {
    queueResults({ recordset: [{ transitDays: 2 }] });
    await request(app).get('/lookup').query({ country: 'uk', postcode: 'ls12' });
    expect(dbRequest.input).toHaveBeenCalledWith('country', expect.anything(), 'UK');
    expect(dbRequest.input).toHaveBeenCalledWith('prefix', expect.anything(), 'LS');
  });

  test('a missing postcode still succeeds — prefix is null, not required', async () => {
    queueResults({ recordset: [{ transitDays: 5 }] });
    const res = await request(app).get('/lookup').query({ country: 'DE' });
    expect(res.status).toBe(200);
    expect(dbRequest.input).toHaveBeenCalledWith('prefix', expect.anything(), null);
  });

  test('returns transitDays:null (not a 404) when nothing matches', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).get('/lookup').query({ country: 'ZZ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, transitDays: null });
  });

  test('returns the matched transitDays', async () => {
    queueResults({ recordset: [{ transitDays: 3 }] });
    const res = await request(app).get('/lookup').query({ country: 'UK', postcode: 'LS12' });
    expect(res.body).toEqual({ success: true, transitDays: 3 });
  });
});

describe('GET /', () => {
  test('returns every route', async () => {
    queueResults({ recordset: [{ countryCode: 'UK' }] });
    const res = await request(app).get('/');
    expect(res.body).toEqual({ success: true, data: [{ countryCode: 'UK' }] });
  });
});

describe('POST /', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).post('/').send({ countryCode: 'UK', transitDays: 2 });
    expect(res.status).toBe(403);
  });

  test('400s without countryCode or transitDays', async () => {
    const res = await request(appAdmin).post('/').send({ countryCode: 'UK' });
    expect(res.status).toBe(400);
  });

  test('accepts transitDays = 0', async () => {
    queueResults({ recordset: [{ routeID: 1 }] });
    const res = await request(appAdmin).post('/').send({ countryCode: 'UK', transitDays: 0 });
    expect(res.status).toBe(201);
  });

  test('creates a route, uppercasing country/prefix', async () => {
    queueResults({ recordset: [{ routeID: 9 }] });
    const res = await request(appAdmin).post('/').send({ countryCode: 'uk', postcodePrefix: 'ls', transitDays: 2 });
    expect(res.status).toBe(201);
    expect(res.body.routeID).toBe(9);
    expect(dbRequest.input).toHaveBeenCalledWith('countryCode', expect.anything(), 'UK');
    expect(dbRequest.input).toHaveBeenCalledWith('postcodePrefix', expect.anything(), 'LS');
  });
});

describe('PUT /:routeId', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).put('/1').send({ countryCode: 'UK', transitDays: 2 });
    expect(res.status).toBe(403);
  });

  test('updates a route', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).put('/1').send({ countryCode: 'UK', transitDays: 2 });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /:routeId', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).delete('/1');
    expect(res.status).toBe(403);
  });

  test('deletes a route', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).delete('/1');
    expect(res.body.success).toBe(true);
  });
});
