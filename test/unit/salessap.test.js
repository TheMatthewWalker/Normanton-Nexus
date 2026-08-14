// routes/salessap.js is the axios client wrapper for SapServer's
// /api/sales/schedule-waterfall endpoint. Same makeSapTokenForUser/unwrap()
// shape as performancesap.js (see test/unit/performancesap.test.js) — this
// file focuses on what's specific to salessap.js: the POST body passthrough
// and its error handling.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

const clientMock = { get: jest.fn(), post: jest.fn() };
const axiosCreateMock = jest.fn(() => clientMock);
jest.unstable_mockModule('axios', () => ({ default: { create: axiosCreateMock } }));

let sap;

beforeAll(async () => {
  sap = await import('../../routes/salessap.js');
});

beforeEach(() => {
  clientMock.get.mockReset();
  clientMock.post.mockReset();
});

function decodeAuthToken(mockCall) {
  const token = mockCall.headers.Authorization.replace('Bearer ', '');
  return jwt.verify(token, process.env.SAP_SERVER_SECRET, { issuer: 'normanton-nexus', audience: 'sap-server' });
}

describe('getScheduleWaterfall', () => {
  const query = { salesOrg: '0302', shipToParties: ['0000302879'], scheduleDateFrom: '2020-01-01', scheduleDateTo: '2020-12-31' };

  test('posts the filter query as the body with a bearer auth header', async () => {
    clientMock.post.mockResolvedValueOnce({ data: { success: true, data: [] } });

    await sap.getScheduleWaterfall({}, query);

    const [url, body, opts] = clientMock.post.mock.calls[0];
    expect(url).toBe('/api/sales/schedule-waterfall');
    expect(body).toEqual(query);
    expect(opts.headers.Authorization).toMatch(/^Bearer /);
  });

  test('carries the session user\'s identity when req.session.user is present', async () => {
    clientMock.post.mockResolvedValueOnce({ data: { success: true, data: [] } });
    const req = { session: { user: { userID: 4, username: 'a.jones', role: 'operator', departments: ['sales'] } } };

    await sap.getScheduleWaterfall(req, query);

    const decoded = decodeAuthToken(clientMock.post.mock.calls[0][2]);
    expect(decoded).toMatchObject({ userId: 4, username: 'a.jones', role: 'operator', departments: ['sales'] });
  });

  test('unwraps the success envelope and returns the rows', async () => {
    clientMock.post.mockResolvedValueOnce({ data: { success: true, data: [{ material: 'M1' }] } });
    const result = await sap.getScheduleWaterfall({}, query);
    expect(result).toEqual([{ material: 'M1' }]);
  });

  test('throws using the envelope\'s error message when success is false', async () => {
    clientMock.post.mockResolvedValueOnce({ data: { success: false, error: { message: 'Sales org not found' } } });
    await expect(sap.getScheduleWaterfall({}, query)).rejects.toThrow('Sales org not found');
  });

  test('propagates a network/axios-level rejection', async () => {
    clientMock.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(sap.getScheduleWaterfall({}, query)).rejects.toThrow('ECONNREFUSED');
  });
});
