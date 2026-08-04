// routes/reports.js dispatches on REPORTS[report].type. This suite covers
// every type actually reachable today: quad-chart (Batches), double-chart
// (Firewall_FailedByMaterial), chart-filterable-table (Convo),
// filterable-table (Firewall_FailedByBatch), chart-table (Firewall_FailedByReason).
//
// NOTE: Ewald/Mixing/Extrusion deliberately have no test here — they don't
// set a `type` field, and the inner switch (line ~419 in reports.js) has no
// default case matching undefined, so a request for any of them never calls
// res.json() at all and the request hangs indefinitely. That's a real bug,
// not a gap in this suite — flagged separately rather than "fixed" here,
// since the right default type is a product decision (probably chart-table,
// matching its "Default: chart" comment, but that's a call for whoever owns
// this file to make).

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let reportsRouter;
let app;

beforeAll(async () => {
  ({ default: reportsRouter } = await import('../../routes/reports.js'));
  app = buildTestApp(reportsRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

describe('validation', () => {
  test('rejects an unknown report key', async () => {
    const res = await request(app).post('/').send({ report: 'NotARealReport', dateFrom: '2026-01-01', dateTo: '2026-01-31' });
    expect(res.status).toBe(400);
  });

  test('rejects a malformed date', async () => {
    const res = await request(app).post('/').send({ report: 'Batches', dateFrom: '01/01/2026', dateTo: '2026-01-31' });
    expect(res.status).toBe(400);
  });

  test('rejects dateFrom after dateTo', async () => {
    const res = await request(app).post('/').send({ report: 'Batches', dateFrom: '2026-02-01', dateTo: '2026-01-01' });
    expect(res.status).toBe(400);
  });
});

describe('quad-chart (Batches)', () => {
  test('runs all four chart queries and maps rows, coercing null labels/values', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ label: '30005R', value: 100 }] })
      .mockResolvedValueOnce({ recordset: [{ label: null, value: null }] })
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ recordset: [{ label: 'J. Smith', value: '250' }] });

    const res = await request(app).post('/').send({ report: 'Batches', dateFrom: '2026-01-01', dateTo: '2026-01-31' });

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ type: 'quad-chart', title: 'Overview' });
    expect(res.body.chartData).toHaveLength(4);
    expect(res.body.chartData[0].rows).toEqual([{ label: '30005R', value: 100 }]);
    expect(res.body.chartData[1].rows).toEqual([{ label: '(blank)', value: 0 }]);
    expect(res.body.chartData[3].rows).toEqual([{ label: 'J. Smith', value: 250 }]); // string value coerced to Number
  });
});

describe('double-chart (Firewall_FailedByMaterial)', () => {
  test('runs both chart queries', async () => {
    dbRequest.query
      .mockResolvedValueOnce({ recordset: [{ label: '30005R', value: 5.5 }] })
      .mockResolvedValueOnce({ recordset: [{ label: '30005R', value: 12.3 }] });

    const res = await request(app).post('/').send({ report: 'Firewall_FailedByMaterial', dateFrom: '2026-01-01', dateTo: '2026-01-31' });

    expect(res.status).toBe(200);
    expect(res.body.meta.type).toBe('double-chart');
    expect(res.body.chartData).toHaveLength(2);
  });
});

describe('chart-filterable-table (Convo)', () => {
  test('returns raw rows plus a groupBy/aggregate chartRows summary sorted descending', async () => {
    dbRequest.query.mockResolvedValueOnce({
      recordset: [
        { Material: '30005R', Meters: 100 },
        { Material: '30006R', Meters: 300 },
        { Material: '30005R', Meters: 50 },
      ],
    });

    const res = await request(app).post('/').send({ report: 'Convo', dateFrom: '2026-01-01', dateTo: '2026-01-31' });

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(3); // raw, ungrouped
    expect(res.body.chartRows).toEqual([
      { label: '30006R', value: 300 },
      { label: '30005R', value: 150 }, // 100 + 50, summed across both rows
    ]);
    expect(res.body.meta.filterColumns).toEqual(['Material']);
  });
});

describe('filterable-table (Firewall_FailedByBatch)', () => {
  test('returns raw rows verbatim with column metadata', async () => {
    const rows = [{ Material: '30005R', Batch: 'B1', Reason: 'X', Total: 100, Failed: 5, Date: '2026-01-01' }];
    dbRequest.query.mockResolvedValueOnce({ recordset: rows });

    const res = await request(app).post('/').send({ report: 'Firewall_FailedByBatch', dateFrom: '2026-01-01', dateTo: '2026-01-31' });

    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual(rows);
    expect(res.body.meta.columns).toEqual(['Material', 'Batch', 'Reason', 'Total', 'Failed', 'Date']);
  });
});

describe('chart-table (Firewall_FailedByReason)', () => {
  test('maps rows to {label, value} with the configured valueLabel/AggregateLabel', async () => {
    dbRequest.query.mockResolvedValueOnce({ recordset: [{ label: 'Contamination', value: '42' }] });

    const res = await request(app).post('/').send({ report: 'Firewall_FailedByReason', dateFrom: '2026-01-01', dateTo: '2026-01-31' });

    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([{ label: 'Contamination', value: 42 }]);
    expect(res.body.meta).toEqual({ type: 'chart', title: 'Failed Amount by Reason', valueLabel: 'Failed Units', AggregateLabel: 'Reason' });
  });
});
