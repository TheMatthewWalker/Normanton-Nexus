// routes/labels.js is dominated by PDF/HTML label-drawing helpers (pdfkit +
// bwip-js barcodes, ~500 lines of layout code) that aren't exported and
// carry low business risk (presentation formatting, not data correctness).
// This suite covers the four actual routes' validation, auth, and
// printer-selection logic — the network-print/PDF-generation happy path
// itself isn't covered (would need a realistic fetchLabelData fixture across
// several joined tables plus mocking pdfkit/bwip-js/node:net all at once for
// disproportionate value versus the formatting code it would actually be
// testing) — see CLAUDE.md.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

// printersConfig is mocked (rather than relying on the developer's real,
// git-ignored config.json) so this suite's printer-selection tests are
// deterministic regardless of what printers happen to be configured on
// whatever machine runs it.
const printersConfigMock = [];
jest.unstable_mockModule('../../config.js', () => ({
  getNexusOperationsPool: jest.fn(() => Promise.resolve(pool)),
  getNexusPool: jest.fn(() => Promise.resolve(pool)),
  printersConfig: printersConfigMock,
}));

let labelsRouter;
let app;
let appNoSession;

beforeAll(async () => {
  ({ default: labelsRouter } = await import('../../routes/labels.js'));
  app = buildTestApp(labelsRouter, { sessionUser: operatorUser });
  appNoSession = buildTestApp(labelsRouter);
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  printersConfigMock.length = 0; // routes/labels.js holds a reference to this same array
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET /printers', () => {
  test('returns the configured printers plus the user\'s saved default', async () => {
    queueResults({ recordset: [{ DefaultPrinterID: 'line1' }] });
    const res = await request(app).get('/printers');
    expect(res.status).toBe(200);
    expect(res.body.userDefault).toBe('line1');
  });

  test('skips the user-default lookup entirely when there is no session', async () => {
    const res = await request(appNoSession).get('/printers');
    expect(res.status).toBe(200);
    expect(res.body.userDefault).toBeNull();
    expect(dbRequest.query).not.toHaveBeenCalled();
  });
});

describe('PATCH /printers/default', () => {
  test('401s when not logged in', async () => {
    const res = await request(appNoSession).patch('/printers/default').send({ printerId: 'line1' });
    expect(res.status).toBe(401);
  });

  test('saves the default printer', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).patch('/printers/default').send({ printerId: 'line1' });
    expect(res.status).toBe(200);
  });
});

describe('GET /process/:processCode/:recordID — validation', () => {
  test('400s on an unsupported process code', async () => {
    const res = await request(app).get('/process/ZZ/1');
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('400s on a non-numeric record ID', async () => {
    const res = await request(app).get('/process/MX/not-a-number');
    expect(res.status).toBe(400);
  });

  test('404s when the record does not exist', async () => {
    queueResults({ recordset: [] }); // fetchMixingHeader/fetchLabelData finds nothing
    const res = await request(app).get('/process/MX/999');
    expect(res.status).toBe(404);
  });
});

describe('POST /process/:processCode/:recordID/print — validation and printer selection', () => {
  test('400s on an unsupported process code', async () => {
    const res = await request(app).post('/process/ZZ/1/print').send({});
    expect(res.status).toBe(400);
  });

  test('400s on a non-numeric record ID', async () => {
    const res = await request(app).post('/process/MX/abc/print').send({});
    expect(res.status).toBe(400);
  });

  test('400s with a clear message when no printers are configured at all', async () => {
    const res = await request(app).post('/process/MX/1/print').send({ printerId: 'not-a-real-printer' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No printers configured/);
  });

  test('400s naming the printer when printers ARE configured but the requested one isn\'t among them', async () => {
    printersConfigMock.push({ id: 'MX', name: 'Mixing', host: '10.0.0.1', port: 9100, paperSize: 'A4' });
    const res = await request(app).post('/process/MX/1/print').send({ printerId: 'not-a-real-printer' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Printer "not-a-real-printer" not found.');
  });
});
