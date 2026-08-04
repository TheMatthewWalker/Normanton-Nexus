// routes/exportxlsx.js builds a real multi-sheet .xlsx workbook (exceljs is
// NOT mocked here — the generated binary is parsed back with a fresh
// ExcelJS.Workbook to verify sheet names, headers, and row data end-to-end,
// which is more meaningful than asserting exceljs was "called with the
// right arguments"). Only mssql is mocked. Security-relevant validation
// (table/column allowlists, filter mode/value validation, relation
// sanitization) is covered directly against the HTTP responses.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

let exportXlsxRouter;
let app;

beforeAll(async () => {
  ({ default: exportXlsxRouter } = await import('../../routes/exportxlsx.js'));
  app = buildTestApp(exportXlsxRouter, { sessionUser: operatorUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

// superagent has no built-in parser for the xlsx MIME type, so res.body
// would otherwise come back as {} — accumulate the raw bytes ourselves.
function bufferBody(req) {
  return req.buffer().parse((res, cb) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

async function loadWorkbook(res) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body);
  return wb;
}

describe('input validation', () => {
  test('400s without tableName', async () => {
    const res = await bufferBody(request(app).post('/')).send({});
    expect(res.status).toBe(400);
  });

  test('403s a table not on the allowlist', async () => {
    const res = await bufferBody(request(app).post('/')).send({ tableName: 'PortalUsers' });
    expect(res.status).toBe(403);
  });

  test('400s an invalid filter column', async () => {
    const res = await bufferBody(request(app).post('/')).send({ tableName: 'Batches', filter: { col: '1bad', mode: 'contains', val: 'x' } });
    expect(res.status).toBe(400);
  });

  test('400s an invalid filter mode', async () => {
    const res = await bufferBody(request(app).post('/')).send({ tableName: 'Batches', filter: { col: 'Batch', mode: 'regex', val: 'x' } });
    expect(res.status).toBe(400);
  });

  test('400s a non-string filter value', async () => {
    const res = await bufferBody(request(app).post('/')).send({ tableName: 'Batches', filter: { col: 'Batch', mode: 'contains', val: 123 } });
    expect(res.status).toBe(400);
  });

  test('400s when relations is not an array', async () => {
    const res = await bufferBody(request(app).post('/')).send({ tableName: 'Batches', relations: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  test('silently drops a relation entry pointing at a disallowed table', async () => {
    queueResults({ recordset: [{ BatchID: 1, Batch: 'B1' }] }); // main table only — no query for the dropped relation
    const res = await bufferBody(request(app).post('/')).send({
      tableName: 'Batches',
      relations: [{ table: 'PortalUsers', pkCol: 'BatchID', fkCol: 'BatchID' }],
    });
    expect(res.status).toBe(200);
    expect(dbRequest.query).toHaveBeenCalledTimes(1); // only the main-table fetch
    const wb = await loadWorkbook(res);
    expect(wb.worksheets).toHaveLength(1); // no sheet for the dropped relation
  });
});

describe('building the workbook', () => {
  test('writes the main table to sheet 1 with real headers and data', async () => {
    queueResults({ recordset: [{ Batch: 'B1', Material: '30005R' }, { Batch: 'B2', Material: '30006R' }] });
    const res = await bufferBody(request(app).post('/')).send({ tableName: 'Batches' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain('Batches_export_');

    const wb = await loadWorkbook(res);
    const sheet = wb.getWorksheet('Batches');
    expect(sheet.getRow(1).values.slice(1)).toEqual(['Batch', 'Material']);
    expect(sheet.getRow(2).values.slice(1)).toEqual(['B1', '30005R']);
    expect(sheet.getRow(3).values.slice(1)).toEqual(['B2', '30006R']);
  });

  test('writes a placeholder row when the main table has no data', async () => {
    queueResults({ recordset: [] });
    const res = await bufferBody(request(app).post('/')).send({ tableName: 'Batches' });
    const wb = await loadWorkbook(res);
    const sheet = wb.getWorksheet('Batches');
    expect(sheet.getRow(1).values.slice(1)).toEqual(['No data found']);
  });

  test('adds one sheet per relation, populated from the main rows\' PK values', async () => {
    queueResults(
      { recordset: [{ BatchID: 1, Batch: 'B1' }, { BatchID: 2, Batch: 'B2' }] }, // main table
      { recordset: [{ CoilID: 10, BatchID: 1 }, { CoilID: 11, BatchID: 2 }] },   // Coils relation
    );
    const res = await bufferBody(request(app).post('/')).send({
      tableName: 'Batches',
      relations: [{ table: 'Coils', pkCol: 'BatchID', fkCol: 'BatchID' }],
    });

    expect(res.status).toBe(200);
    const wb = await loadWorkbook(res);
    expect(wb.worksheets.map(ws => ws.name)).toEqual(['Batches', 'Coils']);
    const coilsSheet = wb.getWorksheet('Coils');
    expect(coilsSheet.getRow(2).values.slice(1)).toEqual([10, 1]);

    // fetchRelated's IN-clause should carry both unique BatchID values.
    const inClauseSql = dbRequest.query.mock.calls[1][0];
    expect(inClauseSql).toContain('WHERE BatchID IN (@v0, @v1)');
  });

  test('applies a "contains" filter as a parameterized LIKE against the main table', async () => {
    queueResults({ recordset: [] });
    await bufferBody(request(app).post('/')).send({ tableName: 'Batches', filter: { col: 'Batch', mode: 'contains', val: 'B1' } });
    expect(dbRequest.query.mock.calls[0][0]).toContain('WHERE Batch LIKE @val');
    expect(dbRequest.input).toHaveBeenCalledWith('val', expect.anything(), '%B1%');
  });

  test('a DB failure before any bytes are sent is reported as a JSON 500', async () => {
    dbRequest.query.mockRejectedValueOnce(new Error('connection lost'));
    const res = await bufferBody(request(app).post('/')).send({ tableName: 'Batches' });
    expect(res.status).toBe(500);
  });
});
