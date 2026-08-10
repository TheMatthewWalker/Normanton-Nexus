// routes/performancesap.js is the axios client wrapper for SapServer's
// /api/performance/* endpoints. Real logic worth testing: makeSapTokenForUser
// issuing a user-context JWT (carrying session identity) vs. a
// system-context one (cron/background, no req.session), unwrap()'s
// success/error envelope handling, per-call query/path building, and
// postChangeValuationClass's special-cased 422 structured-error unwrapping
// (it must surface the validation body, not collapse to a generic axios
// error).

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

const clientMock = { get: jest.fn(), post: jest.fn() };
const axiosCreateMock = jest.fn(() => clientMock);
jest.unstable_mockModule('axios', () => ({ default: { create: axiosCreateMock } }));

let sap;

beforeAll(async () => {
  sap = await import('../../routes/performancesap.js');
});

beforeEach(() => {
  clientMock.get.mockReset();
  clientMock.post.mockReset();
});

function decodeAuthToken(mockCall) {
  const token = mockCall.headers.Authorization.replace('Bearer ', '');
  return jwt.verify(token, process.env.SAP_SERVER_SECRET, { issuer: 'normanton-nexus', audience: 'sap-server' });
}

describe('auth token issuance', () => {
  test('carries the session user\'s identity when req.session.user is present', async () => {
    clientMock.get.mockResolvedValueOnce({ data: { success: true, data: {} } });
    const req = { session: { user: { userID: 7, username: 'j.smith', role: 'operator', departments: ['production'] } } };
    await sap.getStock(req);
    const authOpts = clientMock.get.mock.calls[0][1];
    const decoded = decodeAuthToken(authOpts);
    expect(decoded).toMatchObject({ userId: 7, username: 'j.smith', role: 'operator', departments: ['production'] });
  });

  test('falls back to a system-context token when there is no session (cron/background)', async () => {
    clientMock.get.mockResolvedValueOnce({ data: { success: true, data: {} } });
    await sap.getStock(null);
    const authOpts = clientMock.get.mock.calls[0][1];
    const decoded = decodeAuthToken(authOpts);
    expect(decoded).toMatchObject({ userId: '0', username: 'system-refresh', role: 'system', departments: ['ALL'] });
  });
});

describe('unwrap() envelope handling', () => {
  test('returns the data payload on success', async () => {
    clientMock.get.mockResolvedValueOnce({ data: { success: true, data: { rows: [1, 2] } } });
    const result = await sap.getStock({});
    expect(result).toEqual({ rows: [1, 2] });
  });

  test('throws using the envelope\'s error message when success is false', async () => {
    clientMock.get.mockResolvedValueOnce({ data: { success: false, error: { message: 'Plant not found' } } });
    await expect(sap.getStock({})).rejects.toThrow('Plant not found');
  });

  test('throws a generic message when success is false and no error message is given', async () => {
    clientMock.get.mockResolvedValueOnce({ data: { success: false } });
    await expect(sap.getStock({})).rejects.toThrow('SAP API call failed');
  });

  test('propagates a network/axios-level rejection', async () => {
    clientMock.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(sap.getStock({})).rejects.toThrow('ECONNREFUSED');
  });
});

describe('per-call request shape', () => {
  test('getAgreements defaults horizonDays to 365', async () => {
    clientMock.get.mockResolvedValueOnce({ data: { success: true, data: [] } });
    await sap.getAgreements({});
    expect(clientMock.get.mock.calls[0][1].params).toEqual({ horizonDays: 365 });
  });

  test('getAgreements passes an explicit horizonDays through', async () => {
    clientMock.get.mockResolvedValueOnce({ data: { success: true, data: [] } });
    await sap.getAgreements({}, 30);
    expect(clientMock.get.mock.calls[0][1].params).toEqual({ horizonDays: 30 });
  });

  test('getVbfaOrderLink URL-encodes the delivery number into the path', async () => {
    clientMock.get.mockResolvedValueOnce({ data: { success: true, data: [] } });
    await sap.getVbfaOrderLink({}, '008/12345');
    expect(clientMock.get.mock.calls[0][0]).toBe('/api/performance/vbfa-order-link/008%2F12345');
  });

  test('getInvoicing passes from/to as query params', async () => {
    clientMock.get.mockResolvedValueOnce({ data: { success: true, data: [] } });
    await sap.getInvoicing({}, '2026-01-01', '2026-01-31');
    expect(clientMock.get.mock.calls[0][1].params).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });

  test('getOtif passes from/to as query params', async () => {
    clientMock.get.mockResolvedValueOnce({ data: { success: true, data: [] } });
    await sap.getOtif({}, '2026-01-01', '2026-01-31');
    expect(clientMock.get.mock.calls[0][1].params).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });

  test('getTurnsValClass passes its query object straight through as params', async () => {
    clientMock.get.mockResolvedValueOnce({ data: { success: true, data: [] } });
    await sap.getTurnsValClass({}, { plant: '1000', materialTypes: ['FERT'] });
    expect(clientMock.get.mock.calls[0][1].params).toEqual({ plant: '1000', materialTypes: ['FERT'] });
  });

  test('getValuationClassCatalog takes no query params', async () => {
    clientMock.get.mockResolvedValueOnce({ data: { success: true, data: [] } });
    await sap.getValuationClassCatalog({});
    expect(clientMock.get.mock.calls[0][0]).toBe('/api/performance/turns-valclass/valuation-classes');
  });
});

describe('postChangeValuationClass', () => {
  test('posts the body with auth headers and unwraps the success envelope', async () => {
    clientMock.post.mockResolvedValueOnce({ data: { success: true, data: { changed: 3 } } });
    const result = await sap.postChangeValuationClass({}, { materials: ['M1'] });
    expect(clientMock.post.mock.calls[0]).toEqual([
      '/api/performance/turns-valclass/change-valuation-class',
      { materials: ['M1'] },
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.any(String) }) }),
    ]);
    expect(result).toEqual({ changed: 3 });
  });

  test('surfaces a structured 422 validation body instead of a generic axios error', async () => {
    const err = new Error('Request failed with status code 422');
    err.response = { data: { success: false, error: { message: 'Batch already at target class' }, data: { rejected: ['B1'] } } };
    clientMock.post.mockRejectedValueOnce(err);

    await expect(sap.postChangeValuationClass({}, {})).rejects.toMatchObject({
      message: 'Batch already at target class',
      data: { rejected: ['B1'] },
    });
  });

  test('rethrows the original error when the failure has no structured data body', async () => {
    const err = new Error('ECONNRESET');
    clientMock.post.mockRejectedValueOnce(err);
    await expect(sap.postChangeValuationClass({}, {})).rejects.toBe(err);
  });
});
