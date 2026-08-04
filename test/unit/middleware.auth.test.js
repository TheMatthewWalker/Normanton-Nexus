import { describe, test, expect, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import {
  requireLogin,
  requireRole,
  requireDepartment,
  requireAnyDepartment,
  requirePermission,
  requireAnyPermission,
  requireSessionOrApiToken,
  roleLevel,
} from '../../middleware/auth.js';
import {
  operatorUser,
  productionSupervisor,
  adminUser,
  superadminUser,
} from '../helpers/fixtures/users.js';

function mockReq(overrides = {}) {
  return { path: '/api/whatever', headers: {}, xhr: false, ...overrides };
}

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.redirect = jest.fn(() => res);
  res.sendFile = jest.fn(() => res);
  return res;
}

describe('roleLevel', () => {
  test('ranks operator < admin < superadmin', () => {
    expect(roleLevel('operator')).toBeLessThan(roleLevel('admin'));
    expect(roleLevel('admin')).toBeLessThan(roleLevel('superadmin'));
  });

  test('unknown role is treated as level 0', () => {
    expect(roleLevel('not-a-real-role')).toBe(0);
    expect(roleLevel(undefined)).toBe(0);
  });
});

describe('requireLogin', () => {
  test('calls next() when a session user is present', () => {
    const req = mockReq({ session: { user: operatorUser } });
    const res = mockRes();
    const next = jest.fn();

    requireLogin(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns 401 JSON for an unauthenticated API request', () => {
    const req = mockReq({ session: {}, path: '/api/production' });
    const res = mockRes();
    const next = jest.fn();

    requireLogin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  test('redirects to / for an unauthenticated page request', () => {
    const req = mockReq({ session: {}, path: '/private/landing.html' });
    const res = mockRes();
    const next = jest.fn();

    requireLogin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/');
  });

  test('treats an XHR request as an API request even off /api', () => {
    const req = mockReq({ session: {}, path: '/some-page', xhr: true });
    const res = mockRes();
    const next = jest.fn();

    requireLogin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('requireRole', () => {
  test('passes when the user meets the minimum role', () => {
    const req = mockReq({ session: { user: adminUser } });
    const res = mockRes();
    const next = jest.fn();

    requireRole('admin')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('superadmin always bypasses, regardless of minimum role', () => {
    const req = mockReq({ session: { user: superadminUser } });
    const res = mockRes();
    const next = jest.fn();

    requireRole('admin')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('rejects an operator from an admin-only API route with 403', () => {
    const req = mockReq({ session: { user: operatorUser }, path: '/api/admin/users' });
    const res = mockRes();
    const next = jest.fn();

    requireRole('admin')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('rejects a page request with the 403 page, not JSON', () => {
    const req = mockReq({ session: { user: operatorUser }, path: '/private/admin.html' });
    const res = mockRes();
    const next = jest.fn();

    requireRole('admin')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.sendFile).toHaveBeenCalledWith('403.html', { root: './public' });
  });
});

describe('requireDepartment', () => {
  test('passes when the user holds the department', () => {
    const req = mockReq({ session: { user: operatorUser } });
    const res = mockRes();
    const next = jest.fn();

    requireDepartment('production')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('superadmin bypasses department checks', () => {
    const req = mockReq({ session: { user: superadminUser } });
    const res = mockRes();
    const next = jest.fn();

    requireDepartment('finance')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('rejects a user without the department (API) with 403', () => {
    const req = mockReq({ session: { user: operatorUser }, path: '/api/finance/reports' });
    const res = mockRes();
    const next = jest.fn();

    requireDepartment('finance')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('redirects a page request without the department, with the denied dept in the query string', () => {
    const req = mockReq({ session: { user: operatorUser }, path: '/private/finance.html' });
    const res = mockRes();
    const next = jest.fn();

    requireDepartment('finance')(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith('/private/landing.html?denied=finance');
  });

  test('redirects to / when there is no session user at all', () => {
    const req = mockReq({ session: {} });
    const res = mockRes();
    const next = jest.fn();

    requireDepartment('production')(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith('/');
  });
});

describe('requireAnyDepartment', () => {
  test('passes if the user holds at least one of the listed departments', () => {
    const req = mockReq({ session: { user: operatorUser } });
    const res = mockRes();
    const next = jest.fn();

    requireAnyDepartment(['sales', 'production'])(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('rejects if the user holds none of the listed departments', () => {
    const req = mockReq({ session: { user: operatorUser }, path: '/api/sales' });
    const res = mockRes();
    const next = jest.fn();

    requireAnyDepartment(['sales', 'finance'])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('requirePermission', () => {
  test('passes when the user holds the exact permission code', () => {
    const req = mockReq({ session: { user: productionSupervisor } });
    const res = mockRes();
    const next = jest.fn();

    requirePermission('PROD_SUPERVISOR')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('superadmin bypasses permission checks', () => {
    const req = mockReq({ session: { user: superadminUser } });
    const res = mockRes();
    const next = jest.fn();

    requirePermission('PROD_SUPERVISOR')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('rejects a user lacking the permission with 403', () => {
    const req = mockReq({ session: { user: operatorUser } });
    const res = mockRes();
    const next = jest.fn();

    requirePermission('PROD_SUPERVISOR')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('returns 401 JSON when there is no session user at all', () => {
    const req = mockReq({ session: {} });
    const res = mockRes();
    const next = jest.fn();

    requirePermission('PROD_SUPERVISOR')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('requireAnyPermission', () => {
  test('passes if the user holds at least one of the listed codes', () => {
    const req = mockReq({ session: { user: adminUser } });
    const res = mockRes();
    const next = jest.fn();

    requireAnyPermission(['PROD_SUPERVISOR', 'LOG_PLANNING'])(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('rejects if the user holds none of the listed codes', () => {
    const req = mockReq({ session: { user: operatorUser } });
    const res = mockRes();
    const next = jest.fn();

    requireAnyPermission(['PROD_SUPERVISOR', 'SALES_SUPERVISOR'])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('requireSessionOrApiToken', () => {
  test('accepts a normal session and sets req.uploadUser', () => {
    const req = mockReq({ session: { user: operatorUser } });
    const res = mockRes();
    const next = jest.fn();

    requireSessionOrApiToken(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.uploadUser).toEqual({ userID: operatorUser.userID, username: operatorUser.username });
  });

  test('accepts a valid bearer token minted with the right issuer/audience', () => {
    const token = jwt.sign(
      { userId: 55, username: 'macro.user' },
      process.env.SAP_SERVER_SECRET,
      { issuer: 'kongsberg-portal', audience: 'orderbook-notes-upload', expiresIn: '5m' }
    );
    const req = mockReq({ session: {}, headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const next = jest.fn();

    requireSessionOrApiToken(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.uploadUser).toEqual({ userID: 55, username: 'macro.user' });
  });

  test('rejects a token signed with the wrong secret', () => {
    const token = jwt.sign(
      { userId: 55, username: 'macro.user' },
      'not-the-real-secret',
      { issuer: 'kongsberg-portal', audience: 'orderbook-notes-upload', expiresIn: '5m' }
    );
    const req = mockReq({ session: {}, headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const next = jest.fn();

    requireSessionOrApiToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('rejects a token minted for a different audience', () => {
    const token = jwt.sign(
      { userId: 55, username: 'macro.user' },
      process.env.SAP_SERVER_SECRET,
      { issuer: 'kongsberg-portal', audience: 'some-other-audience', expiresIn: '5m' }
    );
    const req = mockReq({ session: {}, headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const next = jest.fn();

    requireSessionOrApiToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('rejects when there is neither a session nor a bearer token', () => {
    const req = mockReq({ session: {} });
    const res = mockRes();
    const next = jest.fn();

    requireSessionOrApiToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
