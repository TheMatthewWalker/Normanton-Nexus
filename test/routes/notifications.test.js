// routes/notifications.js is a thin wrapper — the fan-out logic lives in
// lib/notify.js (covered directly in test/unit/notify.test.js) and is
// mocked wholesale here. This suite covers the tray unread-count
// calculation, the admin-only gate on /admin routes, and POST /admin's
// title/body/severity validation.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser, adminUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const notifyMock = jest.fn();
jest.unstable_mockModule('../../lib/notify.js', () => ({ notify: notifyMock }));

let notificationsRouter;
let app;
let appAdmin;

beforeAll(async () => {
  ({ default: notificationsRouter } = await import('../../routes/notifications.js'));
  app = buildTestApp(notificationsRouter, { sessionUser: operatorUser });
  appAdmin = buildTestApp(notificationsRouter, { sessionUser: adminUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  notifyMock.mockReset();
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET /', () => {
  test('counts unread deliveries', async () => {
    queueResults({ recordset: [{ DeliveryID: 1, IsRead: false }, { DeliveryID: 2, IsRead: true }, { DeliveryID: 3, IsRead: false }] });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(2);
    expect(res.body.data).toHaveLength(3);
  });

  test('a DB failure is reported as a 500', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/');
    expect(res.status).toBe(500);
  });
});

describe('GET /history', () => {
  test('returns the full recordset', async () => {
    queueResults({ recordset: [{ DeliveryID: 1 }] });
    const res = await request(app).get('/history');
    expect(res.body.data).toEqual([{ DeliveryID: 1 }]);
  });
});

describe('PATCH /read-all', () => {
  test('marks everything read', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).patch('/read-all');
    expect(res.status).toBe(200);
  });
});

describe('PATCH /:deliveryId/dismiss', () => {
  test('dismisses one delivery', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).patch('/5/dismiss');
    expect(res.status).toBe(200);
    expect(dbRequest.input).toHaveBeenCalledWith('id', 'Int', 5);
  });
});

describe('POST /admin', () => {
  test('403s a non-admin', async () => {
    const res = await request(app).post('/admin').send({ title: 'Hi', body: 'x' });
    expect(res.status).toBe(403);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  test('400s when title or body is missing', async () => {
    const res = await request(appAdmin).post('/admin').send({ title: 'Hi' });
    expect(res.status).toBe(400);
  });

  test.each([0, 4, 'x'])('400s on an invalid severity (%p)', async (severity) => {
    const res = await request(appAdmin).post('/admin').send({ title: 'Hi', body: 'x', severity });
    expect(res.status).toBe(400);
  });

  test('creates a notification and reports the recipient count', async () => {
    notifyMock.mockResolvedValueOnce(42);
    queueResults({ recordset: [{ Recipients: 7 }] });
    const res = await request(appAdmin).post('/admin').send({ title: 'Hi', body: 'x', target: { type: 'all' } });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ notificationID: 42, recipients: 7 });
    expect(notifyMock.mock.calls[0][1]).toMatchObject({ title: 'Hi', body: 'x', createdByUserID: adminUser.userID });
  });
});

describe('GET /admin', () => {
  test('403s a non-admin', async () => {
    const res = await request(app).get('/admin');
    expect(res.status).toBe(403);
  });

  test('returns sent notifications with delivery stats', async () => {
    queueResults({ recordset: [{ NotificationID: 1, TotalSent: 5 }] });
    const res = await request(appAdmin).get('/admin');
    expect(res.body.data).toEqual([{ NotificationID: 1, TotalSent: 5 }]);
  });
});

describe('DELETE /admin/:id', () => {
  test('403s a non-admin', async () => {
    const res = await request(app).delete('/admin/1');
    expect(res.status).toBe(403);
  });

  test('expires the notification', async () => {
    queueResults({ recordset: [] });
    const res = await request(appAdmin).delete('/admin/1');
    expect(res.status).toBe(200);
  });
});

describe('GET /admin/targets', () => {
  test('403s a non-admin', async () => {
    const res = await request(app).get('/admin/targets');
    expect(res.status).toBe(403);
  });

  test('returns departments and permissions for the send form', async () => {
    queueResults(
      { recordset: [{ Department: 'logistics' }, { Department: 'production' }] },
      { recordset: [{ PermissionCode: 'LOG_ADMIN', PermissionName: 'Logistics Admin', Category: 'Logistics' }] },
    );
    const res = await request(appAdmin).get('/admin/targets');
    expect(res.body.data.departments).toEqual(['logistics', 'production']);
    expect(res.body.data.permissions).toEqual([{ PermissionCode: 'LOG_ADMIN', PermissionName: 'Logistics Admin', Category: 'Logistics' }]);
  });
});
