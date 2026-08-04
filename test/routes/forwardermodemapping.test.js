// routes/forwardermodemapping.js manages dbo.ForwarderModeMapping and also
// exports lookupModeOfTransport() directly for shipmentmain.js's
// mark-booked to call in-process. Unlike materialgroups.js's
// lookupMaterialGroup, this lookup is deliberately best-effort: no match
// (or any DB error at all) falls back to the raw forwarderMode value rather
// than throwing, since mode-of-transport here is metadata, not a hard SAP
// requirement.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const logAdmin = { ...operatorUser, permissions: ['LOG_ADMIN'] };

let mappingRouter;
let lookupModeOfTransport;
let app;
let appAdmin;

beforeAll(async () => {
  ({ default: mappingRouter, lookupModeOfTransport } = await import('../../routes/forwardermodemapping.js'));
  app = buildTestApp(mappingRouter, { sessionUser: operatorUser });
  appAdmin = buildTestApp(mappingRouter, { sessionUser: logAdmin });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET /', () => {
  test('403s without LOG_ADMIN', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(403);
  });

  test('returns the mapping list', async () => {
    queueResults({ recordset: [{ MappingId: 1, ForwarderMode: 'Road', ModeOfTransport: 'Road' }] });
    const res = await request(appAdmin).get('/');
    expect(res.body.data).toEqual([{ MappingId: 1, ForwarderMode: 'Road', ModeOfTransport: 'Road' }]);
  });
});

describe('GET /forwarder-types', () => {
  test('returns a flat array of distinct modes', async () => {
    queueResults({ recordset: [{ forwarderMode: 'Road' }, { forwarderMode: 'Sea' }] });
    const res = await request(appAdmin).get('/forwarder-types');
    expect(res.body.data).toEqual(['Road', 'Sea']);
  });
});

describe('POST /', () => {
  test('400s without forwarderMode', async () => {
    const res = await request(appAdmin).post('/').send({ modeOfTransport: 'Road' });
    expect(res.status).toBe(400);
  });

  test('400s without modeOfTransport', async () => {
    const res = await request(appAdmin).post('/').send({ forwarderMode: 'Road' });
    expect(res.status).toBe(400);
  });

  test('creates a mapping', async () => {
    queueResults({ recordset: [{ MappingId: 3 }] });
    const res = await request(appAdmin).post('/').send({ forwarderMode: 'Road', modeOfTransport: 'Road' });
    expect(res.body.data).toEqual({ mappingId: 3 });
  });

  test('rewrites a duplicate-key violation into a friendly message', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('Violation of UNIQUE KEY constraint UQ_ForwarderModeMapping_ForwarderMode.'));
    const res = await request(appAdmin).post('/').send({ forwarderMode: 'Road', modeOfTransport: 'Road' });
    expect(res.body.error.message).toBe('A mapping for Forwarder Type "Road" already exists.');
  });
});

describe('PUT /:mappingId', () => {
  test('updates a mapping', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).put('/1').send({ forwarderMode: 'Road', modeOfTransport: 'Road' });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /:mappingId', () => {
  test('deletes a mapping', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).delete('/1');
    expect(res.body.success).toBe(true);
  });
});

describe('lookupModeOfTransport (called in-process by shipmentmain.js)', () => {
  test('returns null when no forwarderMode is given', async () => {
    const result = await lookupModeOfTransport(null);
    expect(result).toBeNull();
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('returns the mapped ModeOfTransport on a match', async () => {
    queueResults({ recordset: [{ ModeOfTransport: 'Road' }] });
    const result = await lookupModeOfTransport('RoadHaulier');
    expect(result).toBe('Road');
  });

  test('falls back to the raw forwarderMode when there is no mapping', async () => {
    queueResults({ recordset: [] });
    const result = await lookupModeOfTransport('Unmapped');
    expect(result).toBe('Unmapped');
  });

  test('falls back to the raw forwarderMode on a DB error, without throwing', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
    const result = await lookupModeOfTransport('Road');
    expect(result).toBe('Road');
  });
});
