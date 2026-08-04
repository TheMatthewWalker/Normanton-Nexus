// routes/profile.js is self-service-only account settings (currently just
// SAP credentials) — every route only ever acts on req.session.user.userID,
// never an ID from the request body/params, since nobody but the account
// owner should ever set their own SAP password. lib/sapCredentials.js
// (covered directly in test/unit/sapCredentials.test.js) is mocked
// wholesale here; auditQuery is real (mocked mssql underneath), same
// pattern as sqlqueries.test.js/quality.test.js.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const sapCredentialsMock = {
  getSapCredentialStatus: jest.fn(),
  setSapCredentials: jest.fn(),
  clearSapCredentials: jest.fn(),
};
jest.unstable_mockModule('../../lib/sapCredentials.js', () => sapCredentialsMock);

let profileRouter;
let app;
let appNoSession;

beforeAll(async () => {
  ({ default: profileRouter } = await import('../../routes/profile.js'));
  app = buildTestApp(profileRouter, { sessionUser: operatorUser });
  appNoSession = buildTestApp(profileRouter);
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  dbRequest.query.mockResolvedValue({ recordset: [] });
  Object.values(sapCredentialsMock).forEach(fn => fn.mockReset());
});

function auditedEventTypes() {
  return dbRequest.input.mock.calls.filter(c => c[0] === 'eventType').map(c => c[2]);
}

describe('GET /sap-credentials', () => {
  test('rejects (401 JSON or redirect) when not logged in', async () => {
    const res = await request(appNoSession).get('/sap-credentials');
    expect([302, 401]).toContain(res.status);
    expect(sapCredentialsMock.getSapCredentialStatus).not.toHaveBeenCalled();
  });

  test('returns the status for the logged-in user\'s own ID', async () => {
    sapCredentialsMock.getSapCredentialStatus.mockResolvedValueOnce({ sapUsername: 'J.SMITH', hasCredentials: true, updatedAt: '2026-01-01' });
    const res = await request(app).get('/sap-credentials');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sapUsername: 'J.SMITH', hasCredentials: true, updatedAt: '2026-01-01' });
    expect(sapCredentialsMock.getSapCredentialStatus).toHaveBeenCalledWith(operatorUser.userID);
  });

  test('a lookup failure is reported as a 500', async () => {
    sapCredentialsMock.getSapCredentialStatus.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/sap-credentials');
    expect(res.status).toBe(500);
  });
});

describe('POST /sap-credentials', () => {
  test('rejects when not logged in', async () => {
    const res = await request(appNoSession).post('/sap-credentials').send({ sapUsername: 'J.SMITH', sapPassword: 'x' });
    expect([302, 401]).toContain(res.status);
  });

  test('400s without a username', async () => {
    const res = await request(app).post('/sap-credentials').send({ sapPassword: 'x' });
    expect(res.status).toBe(400);
    expect(sapCredentialsMock.setSapCredentials).not.toHaveBeenCalled();
  });

  test('400s without a password', async () => {
    const res = await request(app).post('/sap-credentials').send({ sapUsername: 'J.SMITH' });
    expect(res.status).toBe(400);
  });

  test('sets credentials for the logged-in user\'s own ID and audits SAP_CRED_SET', async () => {
    const res = await request(app).post('/sap-credentials').send({ sapUsername: ' J.SMITH ', sapPassword: 'S3cret!' });
    expect(res.status).toBe(200);
    expect(sapCredentialsMock.setSapCredentials).toHaveBeenCalledWith(operatorUser.userID, 'J.SMITH', 'S3cret!');
    expect(auditedEventTypes()).toEqual(['SAP_CRED_SET']);
  });

  test('a save failure is reported as a 500', async () => {
    sapCredentialsMock.setSapCredentials.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post('/sap-credentials').send({ sapUsername: 'J.SMITH', sapPassword: 'x' });
    expect(res.status).toBe(500);
  });
});

describe('DELETE /sap-credentials', () => {
  test('rejects when not logged in', async () => {
    const res = await request(appNoSession).delete('/sap-credentials');
    expect([302, 401]).toContain(res.status);
  });

  test('clears credentials for the logged-in user\'s own ID and audits SAP_CRED_CLEAR', async () => {
    const res = await request(app).delete('/sap-credentials');
    expect(res.status).toBe(200);
    expect(sapCredentialsMock.clearSapCredentials).toHaveBeenCalledWith(operatorUser.userID);
    expect(auditedEventTypes()).toEqual(['SAP_CRED_CLEAR']);
  });

  test('a clear failure is reported as a 500', async () => {
    sapCredentialsMock.clearSapCredentials.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).delete('/sap-credentials');
    expect(res.status).toBe(500);
  });
});

describe('POST /change-password', () => {
  // Low bcrypt cost — only test speed matters here, not production security.
  const CURRENT_PASSWORD = 'CorrectPass123';
  let realHash;

  beforeAll(async () => {
    realHash = await bcrypt.hash(CURRENT_PASSWORD, 4);
  });

  test('rejects when not logged in', async () => {
    const res = await request(appNoSession).post('/change-password').send({ currentPassword: 'x', newPassword: 'BrandNewPass9' });
    expect([302, 401]).toContain(res.status);
  });

  test('400s when a field is missing', async () => {
    const res = await request(app).post('/change-password').send({ currentPassword: 'x' });
    expect(res.status).toBe(400);
  });

  test('400s when the new password fails the policy (min length/upper/digit)', async () => {
    const res = await request(app).post('/change-password').send({ currentPassword: 'x', newPassword: 'weak' });
    expect(res.status).toBe(400);
  });

  test('401s when the current password is wrong, and audits the failure', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ PasswordHash: realHash }] });
    const res = await request(app).post('/change-password').send({ currentPassword: 'WrongPass1', newPassword: 'BrandNewPass9' });
    expect(res.status).toBe(401);
    expect(auditedEventTypes()).toEqual(['PASSWORD_CHANGE']);
  });

  test('400s when the new password is the same as the current password', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ PasswordHash: realHash }] });
    const res = await request(app).post('/change-password').send({ currentPassword: CURRENT_PASSWORD, newPassword: CURRENT_PASSWORD });
    expect(res.status).toBe(400);
  });

  test('404s when the user row is not found', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });
    const res = await request(app).post('/change-password').send({ currentPassword: CURRENT_PASSWORD, newPassword: 'BrandNewPass9' });
    expect(res.status).toBe(404);
  });

  test('changes the password and audits PASSWORD_CHANGE on success', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ PasswordHash: realHash }] }); // fetch current hash
    dbRequest.query.mockResolvedValueOnce({ recordset: [] });                           // UPDATE
    const res = await request(app).post('/change-password').send({ currentPassword: CURRENT_PASSWORD, newPassword: 'BrandNewPass9' });
    expect(res.status).toBe(200);
    expect(auditedEventTypes()).toEqual(['PASSWORD_CHANGE']);
  });

  test('a lookup failure is reported as a 500', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post('/change-password').send({ currentPassword: CURRENT_PASSWORD, newPassword: 'BrandNewPass9' });
    expect(res.status).toBe(500);
  });
});
