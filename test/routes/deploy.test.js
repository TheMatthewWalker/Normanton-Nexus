// routes/deploy.js's whole design hinges on never round-tripping
// ScheduledAt through a JS Date object across the SQL boundary (see the
// file's own header comment) — this suite checks the exact literal string
// built for CONVERT(datetime, @str, 120), not just that the request
// succeeds, since a Date round-trip bug here would silently shift the
// stored time by the server's UTC offset without ever throwing.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser, superadminUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let deployRouter;
let appOperator;
let appSuperadmin;

beforeAll(async () => {
  ({ default: deployRouter } = await import('../../routes/deploy.js'));
  appOperator = buildTestApp(deployRouter, { sessionUser: operatorUser });
  appSuperadmin = buildTestApp(deployRouter, { sessionUser: superadminUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

// "YYYY-MM-DDTHH:mm" in LOCAL time, minutesFromNow away — matches exactly
// what a <input type="datetime-local"> sends, which is what the route
// expects (a literal wall-clock reading, no timezone).
function localDateTimeString(minutesFromNow) {
  const d = new Date(Date.now() + minutesFromNow * 60_000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe('GET /next — no permission gate, any logged-in user', () => {
  test('is reachable by a plain operator', async () => {
    queueResults({ recordset: [] });
    const res = await request(appOperator).get('/next');
    expect(res.status).toBe(200);
    expect(res.body.deployment).toBeNull();
  });
});

describe('GET / — superadmin only', () => {
  test('rejects a plain operator', async () => {
    const res = await request(appOperator).get('/');
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('lists deployments for a superadmin', async () => {
    queueResults({ recordset: [{ DeploymentID: 1 }] });
    const res = await request(appSuperadmin).get('/');
    expect(res.status).toBe(200);
  });
});

describe('POST / — validation', () => {
  test('rejects a malformed scheduledAt', async () => {
    const res = await request(appSuperadmin).post('/').send({ scheduledAt: '15/06/2026 14:30' });
    expect(res.status).toBe(400);
  });

  test('rejects warningMinutes outside 0-1440', async () => {
    const res = await request(appSuperadmin).post('/').send({
      scheduledAt: localDateTimeString(60), warningMinutes: 1500,
    });
    expect(res.status).toBe(400);
  });

  test('rejects a scheduled time that does not give the full warning window\'s lead time', async () => {
    const res = await request(appSuperadmin).post('/').send({
      scheduledAt: localDateTimeString(5), warningMinutes: 15,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 15 minute/);
  });

  test('rejects an invalid git ref', async () => {
    const res = await request(appSuperadmin).post('/').send({
      scheduledAt: localDateTimeString(60), gitRef: 'main; rm -rf /',
    });
    expect(res.status).toBe(400);
  });

  test('is rejected for a non-superadmin before any validation runs', async () => {
    const res = await request(appOperator).post('/').send({ scheduledAt: localDateTimeString(60) });
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });
});

describe('POST / — the literal timezone-safe string sent to SQL', () => {
  test('a 16-char "YYYY-MM-DDTHH:mm" input gets ":00" appended, not parsed through a Date', async () => {
    queueResults({ recordset: [{ DeploymentID: 42 }] }, { recordset: [] }); // insert, then audit()
    const scheduledAt = localDateTimeString(60); // 16 chars, no seconds
    expect(scheduledAt).toHaveLength(16);

    await request(appSuperadmin).post('/').send({ scheduledAt, gitRef: 'main', warningMinutes: 15 });

    const insertCall = dbRequest.input.mock.calls.find(([name]) => name === 'scheduledAt');
    expect(insertCall[2]).toBe(scheduledAt.replace('T', ' ') + ':00');
  });

  test('a 19-char input with explicit seconds is passed through unchanged apart from the T/space swap', async () => {
    queueResults({ recordset: [{ DeploymentID: 42 }] }, { recordset: [] });
    const scheduledAt = localDateTimeString(60) + ':30';

    await request(appSuperadmin).post('/').send({ scheduledAt, gitRef: 'main', warningMinutes: 15 });

    const insertCall = dbRequest.input.mock.calls.find(([name]) => name === 'scheduledAt');
    expect(insertCall[2]).toBe(scheduledAt.replace('T', ' '));
  });
});

describe('SQL SERVER\'S OWN CLOCK — corrects for the shared EU DC running ~1hr ahead of the UK site', () => {
  // dbo.ScheduledDeployments lives on a shared corporate SQL DC whose own
  // GETDATE() reads ~1hr ahead of true UK wall-clock time (see the SQL
  // SERVER'S OWN CLOCK comment at the top of routes/deploy.js) — bare
  // GETDATE() used to make just-scheduled future deployments look already
  // due and fire almost immediately. Every write of "now" in this file must
  // go through the DATEADD(HOUR, -1, GETDATE()) correction instead.
  test('POST / stamps CreatedAt via the corrected expression, not bare GETDATE()', async () => {
    queueResults({ recordset: [{ DeploymentID: 42 }] }, { recordset: [] });
    await request(appSuperadmin).post('/').send({
      scheduledAt: localDateTimeString(60), gitRef: 'main', warningMinutes: 15,
    });

    const insertSql = dbRequest.query.mock.calls[0][0];
    const corrected = insertSql.split('DATEADD(HOUR, -1, GETDATE())').length - 1;
    const bareTotal = insertSql.split('GETDATE()').length - 1;
    expect(corrected).toBeGreaterThan(0);
    expect(bareTotal).toBe(corrected); // every GETDATE() call is wrapped in the correction
  });

  test('POST /:id/cancel stamps CancelledAt via the corrected expression, not bare GETDATE()', async () => {
    queueResults({ recordset: [{ DeploymentID: 5 }] }, { recordset: [] });
    await request(appSuperadmin).post('/5/cancel');

    const cancelSql = dbRequest.query.mock.calls[0][0];
    const corrected = cancelSql.split('DATEADD(HOUR, -1, GETDATE())').length - 1;
    const bareTotal = cancelSql.split('GETDATE()').length - 1;
    expect(corrected).toBeGreaterThan(0);
    expect(bareTotal).toBe(corrected);
  });
});

describe('POST /:id/cancel', () => {
  test('400s on a non-numeric id', async () => {
    const res = await request(appSuperadmin).post('/not-a-number/cancel');
    expect(res.status).toBe(400);
  });

  test('404s when there is no matching pending deployment', async () => {
    queueResults({ recordset: [] });
    const res = await request(appSuperadmin).post('/5/cancel');
    expect(res.status).toBe(404);
  });

  test('cancels a pending deployment', async () => {
    queueResults({ recordset: [{ DeploymentID: 5 }] }, { recordset: [] }); // update, then audit()
    const res = await request(appSuperadmin).post('/5/cancel');
    expect(res.status).toBe(200);
  });
});
