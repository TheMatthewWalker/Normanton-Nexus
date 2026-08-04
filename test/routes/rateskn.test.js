// routes/rateskn.js manages Logistics.dbo.RatesKN (KN carrier rate cards).
// The real logic is GET /lookup: it derives a 2-char postcode prefix,
// ceils the chargeable weight, and applies a minimum-charge floor to the
// computed cost — verified here against the exact arithmetic.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let ratesKnRouter;
let app;

beforeAll(async () => {
  ({ default: ratesKnRouter } = await import('../../routes/rateskn.js'));
  app = buildTestApp(ratesKnRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET routes', () => {
  test('GET / returns every row', async () => {
    queueResults({ recordset: [{ countryCode: 'DE' }] });
    const res = await request(app).get('/');
    expect(res.body).toEqual([{ countryCode: 'DE' }]);
  });

  test('GET /country/:countryCode filters by country', async () => {
    queueResults({ recordset: [{ countryCode: 'DE' }] });
    const res = await request(app).get('/country/DE');
    expect(res.body).toEqual([{ countryCode: 'DE' }]);
  });

  test('GET /postalcode/:postalCode filters by postcode', async () => {
    queueResults({ recordset: [{ postalCode: '15' }] });
    const res = await request(app).get('/postalcode/15');
    expect(res.body).toEqual([{ postalCode: '15' }]);
  });
});

describe('POST /', () => {
  test('creates a record', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).post('/').send({ countryCode: 'DE', postalCode: '15', minWeight: 0, maxWeight: 100, agreedRate: 1.5, transitTime: 2 });
    expect(res.status).toBe(201);
  });
});

describe('GET /lookup', () => {
  test('400s when country, postcode or weight is missing', async () => {
    const res = await request(app).get('/lookup').query({ country: 'DE', postcode: '15100' });
    expect(res.status).toBe(400);
  });

  test('derives the 2-char uppercased postcode prefix and uppercased country', async () => {
    queueResults({ recordset: [{ agreedRate: 1.5, minimumCharge: 10, transitTime: 2 }] });
    await request(app).get('/lookup').query({ country: 'de', postcode: '15100', weight: '10' });
    expect(dbRequest.input).toHaveBeenCalledWith('country', expect.anything(), 'DE');
    expect(dbRequest.input).toHaveBeenCalledWith('prefix', expect.anything(), '15');
  });

  test('returns success:true with null data when no rate matches', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).get('/lookup').query({ country: 'DE', postcode: '15100', weight: '10' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: null, message: 'No rate found for this destination and weight' });
  });

  test('ceils a fractional weight before pricing', async () => {
    queueResults({ recordset: [{ agreedRate: 2, minimumCharge: 0, transitTime: 3 }] });
    const res = await request(app).get('/lookup').query({ country: 'DE', postcode: '15100', weight: '10.2' });
    expect(res.body.data.chargeableWeight).toBe(11); // ceil(10.2)
    expect(res.body.data.expectedCost).toBe(22); // 2 * 11
  });

  test('a negative weight floors to zero, not a negative charge', async () => {
    queueResults({ recordset: [{ agreedRate: 2, minimumCharge: 5, transitTime: 3 }] });
    const res = await request(app).get('/lookup').query({ country: 'DE', postcode: '15100', weight: '-5' });
    expect(res.body.data.chargeableWeight).toBe(0);
    expect(res.body.data.expectedCost).toBe(5); // max(0, minimumCharge)
  });

  test('applies the minimum-charge floor when the computed rate is lower', async () => {
    queueResults({ recordset: [{ agreedRate: 0.5, minimumCharge: 20, transitTime: 2 }] });
    const res = await request(app).get('/lookup').query({ country: 'DE', postcode: '15100', weight: '5' });
    expect(res.body.data.expectedCost).toBe(20); // 0.5*5=2.5, floored to the 20 minimum
  });

  test('uses the computed rate when it exceeds the minimum charge', async () => {
    queueResults({ recordset: [{ agreedRate: 3, minimumCharge: 5, transitTime: 2 }] });
    const res = await request(app).get('/lookup').query({ country: 'DE', postcode: '15100', weight: '10' });
    expect(res.body.data.expectedCost).toBe(30); // 3*10=30 > 5
  });

  test('rounds the final cost to 2 decimal places', async () => {
    queueResults({ recordset: [{ agreedRate: 1.005, minimumCharge: 0, transitTime: 2 }] });
    const res = await request(app).get('/lookup').query({ country: 'DE', postcode: '15100', weight: '3' });
    expect(res.body.data.expectedCost).toBe(3.01); // 1.005*3 = 3.0149999999999997 in floating point -> rounds to 3.01
  });

  test('a DB failure is reported as a 500', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
    const res = await request(app).get('/lookup').query({ country: 'DE', postcode: '15100', weight: '10' });
    expect(res.status).toBe(500);
  });
});
