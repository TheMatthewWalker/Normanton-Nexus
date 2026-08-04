// routes/useradmin.js is the highest-security-value route file in the app:
// role/department/permission escalation guards live here. This suite
// focuses on those guards plus one representative test per endpoint for
// wiring/validation — not exhaustive line coverage of every audit branch.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { adminUser, superadminUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let adminRouter;
let appAsAdmin;
let appAsSuperadmin;

beforeAll(async () => {
  ({ default: adminRouter } = await import('../../routes/useradmin.js'));
  appAsAdmin = buildTestApp(adminRouter, { sessionUser: adminUser });
  appAsSuperadmin = buildTestApp(adminRouter, { sessionUser: superadminUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET /pending', () => {
  test('returns the pending-user list', async () => {
    queueResults({ recordset: [{ UserID: 5, Username: 'new.user' }] });
    const res = await request(appAsAdmin).get('/pending');
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([{ UserID: 5, Username: 'new.user' }]);
  });
});

describe('GET /users', () => {
  test('merges department and permission rows onto each user by UserID', async () => {
    queueResults(
      { recordset: [{ UserID: 1, Username: 'a' }, { UserID: 2, Username: 'b' }] },
      { recordset: [{ UserID: 1, Department: 'production' }, { UserID: 1, Department: 'logistics' }] },
      { recordset: [{ UserID: 2, PermissionCode: 'LOG_PLANNING' }] },
    );

    const res = await request(appAsAdmin).get('/users');

    expect(res.body.users).toEqual([
      { UserID: 1, Username: 'a', departments: ['production', 'logistics'], permissions: [] },
      { UserID: 2, Username: 'b', departments: [], permissions: ['LOG_PLANNING'] },
    ]);
  });
});

describe('PUT /users/:id — privilege escalation guards', () => {
  test('400s on a non-numeric user id', async () => {
    const res = await request(appAsAdmin).put('/users/not-a-number').send({ role: 'operator' });
    expect(res.status).toBe(400);
  });

  test('400s on an invalid role value', async () => {
    const res = await request(appAsAdmin).put('/users/1').send({ role: 'god-mode' });
    expect(res.status).toBe(400);
  });

  test('400s on an invalid department in the list', async () => {
    const res = await request(appAsAdmin).put('/users/1').send({ departments: ['not-a-real-department'] });
    expect(res.status).toBe(400);
  });

  test('an admin (non-superadmin) cannot change username/name/email — 403 before touching the DB', async () => {
    const res = await request(appAsAdmin).put('/users/1').send({ username: 'new.name' });
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('404s when the target user does not exist', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAsAdmin).put('/users/999').send({ role: 'operator' });
    expect(res.status).toBe(404);
  });

  test('an admin cannot edit a user whose current role is equal to or higher than their own', async () => {
    queueResults({ recordset: [{ Username: 'peer.admin', Role: 'admin', FirstName: 'P', LastName: 'A', Email: 'p@x.com', IsActive: true, IsLocked: false, ShortIdleTimeout: false }] });

    const res = await request(appAsAdmin).put('/users/2').send({ notes: 'trying to edit a peer' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/equal or higher role/);
  });

  test('an admin cannot promote someone to a role equal to or higher than their own', async () => {
    queueResults({ recordset: [{ Username: 'j.smith', Role: 'operator', FirstName: 'J', LastName: 'S', Email: 'j@x.com', IsActive: true, IsLocked: false, ShortIdleTimeout: false }] });

    const res = await request(appAsAdmin).put('/users/3').send({ role: 'superadmin' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cannot assign a role/);
  });

  test('a superadmin CAN edit a peer superadmin and change identity fields', async () => {
    queueResults(
      { recordset: [{ Username: 'old.name', Role: 'superadmin', FirstName: 'F', LastName: 'L', Email: 'old@x.com', IsActive: true, IsLocked: false, ShortIdleTimeout: false }] }, // fetch current
      { recordset: [] }, // username uniqueness check — not taken
      { recordset: [] }, // main UPDATE
      { recordset: [] }, // cascade: PortalAuditLog rename
      { recordset: [] }, // cascade: ApprovedBy rename
      { recordset: [] }, // cascade: GrantedBy rename
      { recordset: [] }, // audit(USERNAME_CHANGE) insert
    );

    const res = await request(appAsSuperadmin).put('/users/4').send({ username: 'new.name' });

    expect(res.status).toBe(200);
    expect(dbRequest.query).toHaveBeenCalledTimes(7);
  });

  test('a plain role change (no identity fields) only touches fetch + update + one audit insert', async () => {
    // An 'admin' actor can only ever assign 'operator' (the one role below
    // their own level) to a user who is already below their level — which
    // means an admin can never actually produce a role *change* through this
    // endpoint (target and assignable role coincide). A real change needs a
    // superadmin actor, which has no such restriction.
    queueResults(
      { recordset: [{ Username: 'j.smith', Role: 'operator', FirstName: 'J', LastName: 'S', Email: 'j@x.com', IsActive: true, IsLocked: false, ShortIdleTimeout: false }] },
      { recordset: [] }, // main UPDATE
      { recordset: [] }, // audit(ROLE_CHANGE)
    );

    const res = await request(appAsSuperadmin).put('/users/3').send({ role: 'admin' });

    expect(res.status).toBe(200);
    expect(dbRequest.query).toHaveBeenCalledTimes(3);
  });

  test('409s when the new username is already taken', async () => {
    queueResults(
      { recordset: [{ Username: 'old.name', Role: 'operator', FirstName: 'F', LastName: 'L', Email: 'old@x.com', IsActive: true, IsLocked: false, ShortIdleTimeout: false }] },
      { recordset: [{ }] }, // username uniqueness check — IS taken
    );

    const res = await request(appAsSuperadmin).put('/users/4').send({ username: 'taken.name' });

    expect(res.status).toBe(409);
  });

  test('400s on an invalid new email format', async () => {
    const res = await request(appAsSuperadmin).put('/users/4').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });
});

describe('POST /users/:id/approve', () => {
  test('400s on an invalid role', async () => {
    const res = await request(appAsAdmin).post('/users/5/approve').send({ role: 'god-mode' });
    expect(res.status).toBe(400);
  });

  test('an admin cannot approve someone into a role equal to or higher than their own', async () => {
    const res = await request(appAsAdmin).post('/users/5/approve').send({ role: 'admin' });
    expect(res.status).toBe(403);
  });

  test('400s on an invalid department', async () => {
    const res = await request(appAsAdmin).post('/users/5/approve').send({ role: 'operator', departments: ['not-real'] });
    expect(res.status).toBe(400);
  });

  test('404s when there is no matching pending user', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAsAdmin).post('/users/5/approve').send({ role: 'operator', departments: [] });
    expect(res.status).toBe(404);
  });

  test('approves a pending user and grants the listed departments', async () => {
    queueResults(
      { recordset: [{ Username: 'new.user' }] }, // UPDATE ... OUTPUT INSERTED.Username
      { recordset: [] }, // INSERT department 1
      { recordset: [] }, // INSERT department 2
      { recordset: [] }, // audit(APPROVED)
    );

    const res = await request(appAsAdmin).post('/users/5/approve').send({ role: 'operator', departments: ['production', 'logistics'] });

    expect(res.status).toBe(200);
    expect(dbRequest.query).toHaveBeenCalledTimes(4);
  });
});

describe('POST /users/:id/reject', () => {
  test('404s when there is no matching pending user', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAsAdmin).post('/users/5/reject');
    expect(res.status).toBe(404);
  });

  test('deletes the pending registration and audits it', async () => {
    queueResults({ recordset: [{ Username: 'new.user' }] }, { recordset: [] });
    const res = await request(appAsAdmin).post('/users/5/reject');
    expect(res.status).toBe(200);
  });
});

describe('GET /audit', () => {
  test('400s on an unrecognised event filter', async () => {
    const res = await request(appAsAdmin).get('/audit?event=NOT_A_REAL_EVENT');
    expect(res.status).toBe(400);
  });

  test('200s with a valid event filter', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAsAdmin).get('/audit?event=LOGIN_FAIL');
    expect(res.status).toBe(200);
  });
});

describe('permission definition endpoints — superadmin only', () => {
  test('POST /permissions is rejected for a plain admin (local requireSuperadmin gate)', async () => {
    const res = await request(appAsAdmin).post('/permissions').send({ permissionCode: 'X', permissionName: 'X', category: 'General' });
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('POST /permissions rejects a badly-formatted code', async () => {
    const res = await request(appAsSuperadmin).post('/permissions').send({ permissionCode: 'bad code!', permissionName: 'X', category: 'General' });
    expect(res.status).toBe(400);
  });

  test('POST /permissions 409s on a duplicate code', async () => {
    queueResults({ recordset: [{}] }); // exists check — found
    const res = await request(appAsSuperadmin).post('/permissions').send({ permissionCode: 'PROD_NEW', permissionName: 'New', category: 'Production' });
    expect(res.status).toBe(409);
  });

  test('POST /permissions creates a new permission', async () => {
    queueResults({ recordset: [] }, { recordset: [] }, { recordset: [] }); // exists check, insert, audit
    const res = await request(appAsSuperadmin).post('/permissions').send({ permissionCode: 'prod_new', permissionName: 'New', category: 'Production' });
    expect(res.status).toBe(200);
    expect(res.body.permissionCode).toBe('PROD_NEW');
  });

  test('PUT /permissions/:code 404s when the code does not exist', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAsSuperadmin).put('/permissions/NOPE').send({ permissionName: 'New Name' });
    expect(res.status).toBe(404);
  });

  test('DELETE /permissions/:code 404s when the code does not exist', async () => {
    queueResults({ recordset: [] }, { recordset: [] }); // cascade delete from PortalUserPermissions, then the main delete
    const res = await request(appAsSuperadmin).delete('/permissions/NOPE');
    expect(res.status).toBe(404);
  });
});

describe('user <-> permission grant/revoke — admin or superadmin', () => {
  test('POST /users/:id/permissions 404s when the permission code does not exist', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAsAdmin).post('/users/1/permissions').send({ permissionCode: 'NOPE' });
    expect(res.status).toBe(404);
  });

  test('POST /users/:id/permissions 404s when the user does not exist', async () => {
    queueResults({ recordset: [{}] }, { recordset: [] });
    const res = await request(appAsAdmin).post('/users/999/permissions').send({ permissionCode: 'PROD_ENTRY' });
    expect(res.status).toBe(404);
  });

  test('POST /users/:id/permissions 409s on a duplicate grant (unique constraint violation)', async () => {
    queueResults({ recordset: [{}] }, { recordset: [{ Username: 'j.smith' }] });
    const dupError = new Error('Violation of UNIQUE KEY constraint');
    dupError.number = 2627;
    dbRequest.query.mockRejectedValueOnce(dupError);

    const res = await request(appAsAdmin).post('/users/1/permissions').send({ permissionCode: 'PROD_ENTRY' });

    expect(res.status).toBe(409);
  });

  test('POST /users/:id/permissions grants successfully', async () => {
    queueResults(
      { recordset: [{}] },                        // permission exists
      { recordset: [{ Username: 'j.smith' }] },    // user exists
      { recordset: [] },                           // insert grant
      { recordset: [] },                           // audit(PERM_GRANT)
    );
    const res = await request(appAsAdmin).post('/users/1/permissions').send({ permissionCode: 'prod_entry' });
    expect(res.status).toBe(200);
  });

  test('DELETE /users/:id/permissions/:code 404s when not currently assigned', async () => {
    queueResults({ recordset: [{ Username: 'j.smith' }] }, { recordset: [] });
    const res = await request(appAsAdmin).delete('/users/1/permissions/PROD_ENTRY');
    expect(res.status).toBe(404);
  });

  test('DELETE /users/:id/permissions/:code revokes successfully', async () => {
    queueResults(
      { recordset: [{ Username: 'j.smith' }] },
      { recordset: [{ PermissionCode: 'PROD_ENTRY' }] },
      { recordset: [] }, // audit(PERM_REVOKE)
    );
    const res = await request(appAsAdmin).delete('/users/1/permissions/PROD_ENTRY');
    expect(res.status).toBe(200);
  });
});
