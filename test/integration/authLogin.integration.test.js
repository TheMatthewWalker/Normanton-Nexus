// Runs the REAL routes/auth.js login route against the real staging SQL
// Server (not a mock) — this is the test that can actually catch behavior
// differences introduced by the SQL Server version migration (collation,
// implicit conversion, etc.), which test/routes/auth.test.js's mocked
// version cannot. Manages its own fixture row so it doesn't depend on
// anything being pre-seeded on staging.
//
// Skips (not fails) unless TEST_SQL_SERVER/TEST_SQL_DATABASE are set — see
// test/helpers/stagingDb.js. jest.globalSetup.js points config.json's
// sqlConfig at the same staging server when those env vars are present, so
// the app's own sql.connect(sqlConfig) call inside routes/auth.js reaches it
// too, exercising the real code path end-to-end.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { hasStagingDb, connectStaging } from '../helpers/stagingDb.js';
import { buildTestApp } from '../helpers/testApp.js';

const TEST_USERNAME = 'jest.integration.testuser';
const TEST_PASSWORD = 'Integration-Test-Pass1';

(hasStagingDb() ? describe : describe.skip)('routes/auth.js login — staging DB integration', () => {
  let pool;
  let app;

  beforeAll(async () => {
    pool = await connectStaging();

    // Clean up any leftover row from a previous failed run, then insert a
    // fresh known-good test user.
    await pool.request()
      .input('u', TEST_USERNAME)
      .query(`DELETE FROM kongsberg.dbo.PortalUsers WHERE Username = @u`);

    const hash = await bcrypt.hash(TEST_PASSWORD, 10);
    await pool.request()
      .input('u', TEST_USERNAME)
      .input('email', `${TEST_USERNAME}@example.invalid`)
      .input('hash', hash)
      .query(`
        INSERT INTO kongsberg.dbo.PortalUsers
          (Username, FirstName, LastName, Email, PasswordHash, Role, IsActive, IsLocked, FailedLogins)
        VALUES (@u, 'Jest', 'Integration', @email, @hash, 'operator', 1, 0, 0)
      `);

    const { default: authRouter } = await import('../../routes/auth.js');
    app = buildTestApp(authRouter);
  }, 30000);

  afterAll(async () => {
    if (pool) {
      await pool.request()
        .input('u', TEST_USERNAME)
        .query(`DELETE FROM kongsberg.dbo.PortalUsers WHERE Username = @u`);
      await pool.request()
        .input('u', TEST_USERNAME)
        .query(`DELETE FROM kongsberg.dbo.PortalAuditLog WHERE Username = @u`);
    }
  }, 30000);

  test('logs in successfully with the real password against the real DB', async () => {
    const res = await request(app).post('/login').send({ username: TEST_USERNAME, password: TEST_PASSWORD });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/private/landing.html');
  });

  test('rejects the wrong password', async () => {
    const res = await request(app).post('/login').send({ username: TEST_USERNAME, password: 'WrongPassword' });
    expect(res.headers.location).toBe('/?error=invalid_credentials');
  });

  test('rejects an unknown username', async () => {
    const res = await request(app).post('/login').send({ username: 'no.such.jest.user', password: 'whatever' });
    expect(res.headers.location).toBe('/?error=invalid_credentials');
  });
});
