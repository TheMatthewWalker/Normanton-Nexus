import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();

jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));
jest.unstable_mockModule('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

let authRouter;
let app;

// Low bcrypt cost — only test speed matters here, not production security.
const TEST_PASSWORD = 'CorrectPass123';
let realHash;

beforeAll(async () => {
  realHash = await bcrypt.hash(TEST_PASSWORD, 4);
  ({ default: authRouter } = await import('../../routes/auth.js'));
  app = buildTestApp(authRouter);
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('POST /login', () => {
  test('missing fields redirects with missing_fields error', async () => {
    const res = await request(app).post('/login').send({ username: 'x' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?error=missing_fields');
  });

  test('unknown username redirects with invalid_credentials (and still audits)', async () => {
    queueResults(
      { recordset: [] },   // user fetch — nobody found
      { recordset: [] },   // audit insert
    );

    const res = await request(app).post('/login').send({ username: 'ghost', password: 'whatever' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?error=invalid_credentials');
  });

  test('pending (inactive) account redirects with pending_approval', async () => {
    queueResults(
      { recordset: [{ UserID: 1, Username: 'new.user', PasswordHash: realHash, Role: 'operator', IsActive: false, IsLocked: false, FailedLogins: 0, ShortIdleTimeout: false }] },
      { recordset: [] }, // audit insert
    );

    const res = await request(app).post('/login').send({ username: 'new.user', password: TEST_PASSWORD });

    expect(res.headers.location).toBe('/?error=pending_approval');
  });

  test('locked account redirects with account_locked', async () => {
    queueResults(
      { recordset: [{ UserID: 1, Username: 'locked.user', PasswordHash: realHash, Role: 'operator', IsActive: true, IsLocked: true, FailedLogins: 3, ShortIdleTimeout: false }] },
      { recordset: [] }, // audit insert
    );

    const res = await request(app).post('/login').send({ username: 'locked.user', password: TEST_PASSWORD });

    expect(res.headers.location).toBe('/?error=account_locked');
  });

  test('wrong password redirects with invalid_credentials and updates the failed-login counter', async () => {
    queueResults(
      { recordset: [{ UserID: 1, Username: 'j.smith', PasswordHash: realHash, Role: 'operator', IsActive: true, IsLocked: false, FailedLogins: 2, ShortIdleTimeout: false }] },
      { recordset: [] }, // failed-login counter update
      { recordset: [] }, // audit insert
    );

    const res = await request(app).post('/login').send({ username: 'j.smith', password: 'WrongPassword' });

    expect(res.headers.location).toBe('/?error=invalid_credentials');
    expect(dbRequest.query).toHaveBeenCalledTimes(3);
  });

  test('correct credentials log the user in and redirect to the landing page', async () => {
    queueResults(
      { recordset: [{ UserID: operatorUser.userID, Username: operatorUser.username, Email: operatorUser.email, PasswordHash: realHash, Role: operatorUser.role, IsActive: true, IsLocked: false, FailedLogins: 0, ShortIdleTimeout: false }] },
      { recordset: [{ Department: 'production' }] },
      { recordset: [{ PermissionCode: 'PROD_ENTRY' }] },
      { recordset: [] }, // reset failed-login counter
      { recordset: [] }, // audit insert
    );

    const res = await request(app).post('/login').send({ username: operatorUser.username, password: TEST_PASSWORD });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/private/landing.html');
  });
});

describe('GET /logout', () => {
  test('destroys the session and redirects to /', async () => {
    queueResults({ recordset: [] }); // audit insert (fires because session had a user)
    const appWithSession = buildTestApp(authRouter, { sessionUser: operatorUser });

    const res = await request(appWithSession).get('/logout');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});

describe('GET /session-check', () => {
  test('reports loggedIn: false with no session user', async () => {
    const res = await request(app).get('/session-check');
    expect(res.body).toEqual({ loggedIn: false });
  });

  test('reports session details for a logged-in user', async () => {
    const appWithSession = buildTestApp(authRouter, { sessionUser: operatorUser });
    const res = await request(appWithSession).get('/session-check');

    expect(res.body).toMatchObject({
      loggedIn: true,
      username: operatorUser.username,
      role: operatorUser.role,
      departments: operatorUser.departments,
      permissions: operatorUser.permissions,
    });
  });
});

describe('POST /api/auth/orderbook-token', () => {
  test('requires both username and password', async () => {
    const res = await request(app).post('/api/auth/orderbook-token').send({ username: 'x' });
    expect(res.status).toBe(400);
  });

  test('rejects an unknown username', async () => {
    queueResults({ recordset: [] }, { recordset: [] });
    const res = await request(app).post('/api/auth/orderbook-token').send({ username: 'ghost', password: 'x' });
    expect(res.status).toBe(401);
  });

  test('rejects a locked/inactive account', async () => {
    queueResults(
      { recordset: [{ UserID: 1, Username: 'locked.user', PasswordHash: realHash, IsActive: true, IsLocked: true }] },
      { recordset: [] },
    );
    const res = await request(app).post('/api/auth/orderbook-token').send({ username: 'locked.user', password: TEST_PASSWORD });
    expect(res.status).toBe(401);
  });

  test('rejects the wrong password', async () => {
    queueResults(
      { recordset: [{ UserID: 1, Username: 'j.smith', PasswordHash: realHash, IsActive: true, IsLocked: false }] },
      { recordset: [] },
    );
    const res = await request(app).post('/api/auth/orderbook-token').send({ username: 'j.smith', password: 'WrongPassword' });
    expect(res.status).toBe(401);
  });

  test('issues a verifiable, correctly-scoped JWT on success', async () => {
    queueResults(
      { recordset: [{ UserID: 77, Username: 'macro.user', PasswordHash: realHash, IsActive: true, IsLocked: false }] },
      { recordset: [] },
    );

    const res = await request(app).post('/api/auth/orderbook-token').send({ username: 'macro.user', password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.token).toBe('string');

    const decoded = jwt.verify(res.body.token, process.env.SAP_SERVER_SECRET, {
      issuer: 'kongsberg-portal',
      audience: 'orderbook-notes-upload',
    });
    expect(decoded).toMatchObject({ userId: 77, username: 'macro.user' });
  });
});
