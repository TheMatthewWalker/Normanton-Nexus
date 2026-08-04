// routes/debugsap.js is an ad-hoc dev/debug endpoint that pulls stock and
// agreements data from SapServer (via routes/performancesap.js, mocked
// here) and dumps each to a CSV file (csv-writer, also mocked so no real
// files are written during tests). The real behavior worth testing: each
// dataset is fetched/written independently — one failing must not abort
// the other or the overall 200 response — and an empty dataset skips the
// CSV write rather than erroring.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const sapMock = { getStock: jest.fn(), getAgreements: jest.fn() };
jest.unstable_mockModule('../../routes/performancesap.js', () => sapMock);

const writeRecordsMock = jest.fn().mockResolvedValue(undefined);
const createObjectCsvWriterMock = jest.fn(() => ({ writeRecords: writeRecordsMock }));
jest.unstable_mockModule('csv-writer', () => ({ createObjectCsvWriter: createObjectCsvWriterMock }));

let debugSapRouter;
let app;

beforeAll(async () => {
  ({ default: debugSapRouter } = await import('../../routes/debugsap.js'));
  app = buildTestApp(debugSapRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  sapMock.getStock.mockReset();
  sapMock.getAgreements.mockReset();
  writeRecordsMock.mockClear();
  createObjectCsvWriterMock.mockClear();
});

test('dumps both datasets successfully and writes a CSV for each', async () => {
  sapMock.getStock.mockResolvedValueOnce([{ material: 'M1' }]);
  sapMock.getAgreements.mockResolvedValueOnce([{ referenceDocument: 'SO1' }, { referenceDocument: 'SO2' }]);

  const res = await request(app).post('/debug-sap-dump').send({});

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.results).toEqual([
    { dataset: 'stock', status: 'success', rows: 1 },
    { dataset: 'agreements', status: 'success', rows: 2 },
  ]);
  expect(writeRecordsMock).toHaveBeenCalledTimes(2);
});

test('skips the CSV write for an empty dataset but still reports success', async () => {
  sapMock.getStock.mockResolvedValueOnce([]);
  sapMock.getAgreements.mockResolvedValueOnce([{ referenceDocument: 'SO1' }]);

  const res = await request(app).post('/debug-sap-dump').send({});

  expect(res.body.results[0]).toEqual({ dataset: 'stock', status: 'success', rows: 0 });
  expect(writeRecordsMock).toHaveBeenCalledTimes(1); // only for agreements
});

test('one dataset failing does not abort the other, and the response is still 200', async () => {
  sapMock.getStock.mockRejectedValueOnce(new Error('RFC timeout'));
  sapMock.getAgreements.mockResolvedValueOnce([{ referenceDocument: 'SO1' }]);

  const res = await request(app).post('/debug-sap-dump').send({});

  expect(res.status).toBe(200);
  expect(res.body.results).toEqual([
    { dataset: 'stock', status: 'failed', error: 'RFC timeout' },
    { dataset: 'agreements', status: 'success', rows: 1 },
  ]);
});

test('both datasets failing still returns a 200 with both failures reported', async () => {
  sapMock.getStock.mockRejectedValueOnce(new Error('down'));
  sapMock.getAgreements.mockRejectedValueOnce(new Error('down too'));

  const res = await request(app).post('/debug-sap-dump').send({});

  expect(res.status).toBe(200);
  expect(res.body.results.every(r => r.status === 'failed')).toBe(true);
});
