// BOM-validated traceability for Convo/Braiding/Coverline/TapeWrap/Drumming
// (CO/BR/CL/TW/DR) — routes/productionnexus.js's fetchBom/persistBomSnapshot/
// validateTraceabilityAgainstBom/unresolvedProblems/buildActualComponentList
// helpers, wired into POST /process/:code/draft (warn, non-blocking) and
// POST /process/:code/complete/:recordID (hard block, unless an APPROVED
// prod.TraceabilityConcessions row covers it — in which case the job posts
// via the concession goods-movement path instead of the normal automatic
// backflush), plus the concession raise/list/approve/reject routes
// themselves. Mirrors productionnexus.billetStaging.test.js's mocking style
// (same file, same "Billet-staging gate on EX completion" test is the
// direct precedent for the CO complete-block tests below) — deliberately a
// separate file since EX/MX's own validateMxTubLinks gate is untouched by
// this feature and already covered there.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const axiosMock = { request: jest.fn(), post: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

const qualityReviewer = {
  userID: 401, username: 'q.reviewer', email: 'q.reviewer@example.com',
  role: 'operator', departments: ['quality'], permissions: ['QUAL_CONCESSION'],
  shortIdleTimeout: false,
};

let nexusRouter;
let app;      // operator session — draft/complete/raise-concession
let qApp;     // QUAL_CONCESSION session — list/approve/reject

beforeAll(async () => {
  ({ default: nexusRouter } = await import('../../routes/productionnexus.js'));
  app  = buildTestApp(nexusRouter, { sessionUser: operatorUser });
  qApp = buildTestApp(nexusRouter, { sessionUser: qualityReviewer });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  axiosMock.request.mockReset();
  axiosMock.post.mockReset();
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

function mockProfitCentreOk(prctr = '0000002002') { // CO allows 2002/2022
  axiosMock.request.mockResolvedValueOnce({ data: { success: true, data: prctr } });
}

const bomRow = { material: 'TCEL9-9CBT', plant: '3012', component: 'COMP1', item: '0010', componentQty: 1, componentUnit: 'KG', storageLocation: '1710', supplyArea: '312' };

// ── POST /process/CO/draft — BOM download + non-blocking warning ────────────

describe('POST /process/CO/draft — BOM download and warning', () => {
  test('downloads and saves the BOM, and warns (but still saves) on a mismatched traceability link', async () => {
    mockProfitCentreOk();
    axiosMock.request.mockResolvedValueOnce({ data: { success: true, data: [bomRow] } }); // fetchBom

    queueResults(
      { recordset: [{ ConvolutingID: 20 }] },     // INSERT prod.Convoluting
      { recordset: [] },                          // INSERT BatchOperators
      { recordset: [] },                          // INSERT ProductionTrace (1 parent)
      { recordset: [] },                          // writeEvent STARTED
      { recordset: [] },                          // persistBomSnapshot INSERT (1 row)
      { recordset: [{ Material: 'RUBBERMIX1' }] }, // validateTraceabilityAgainstBom: parent's own material
    );

    const res = await request(app).post('/process/CO/draft').send({
      material: 'TCEL9-9CBT',
      parentBatches: [{ processCode: 'MX', recordID: 5 }],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.recordID).toBe(20);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toMatch(/not a component/);
  });

  test('no warnings when every linked batch resolves to a real BOM component', async () => {
    mockProfitCentreOk();
    axiosMock.request.mockResolvedValueOnce({ data: { success: true, data: [bomRow] } });

    queueResults(
      { recordset: [{ ConvolutingID: 21 }] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [{ Material: 'COMP1' }] }, // matches the BOM component exactly
    );

    const res = await request(app).post('/process/CO/draft').send({
      material: 'TCEL9-9CBT',
      parentBatches: [{ processCode: 'MX', recordID: 5 }],
    });

    expect(res.status).toBe(201);
    expect(res.body.warnings).toBeUndefined();
  });
});

// ── POST /process/CO/complete/:recordID — hard block + concession override ──

describe('POST /process/CO/complete/:recordID — BOM traceability hard block', () => {
  test('blocks the SAP backflush entirely when a linked batch still does not match the BOM', async () => {
    mockProfitCentreOk();
    queueResults(
      { recordset: [{ ConvolutingID: 30, Material: 'TCEL9-9CBT', Status: 1 }] }, // existence/open check
      { recordset: [] },                                                        // UPDATE Convoluting -> Status=4
      { recordset: [] },                                                        // writeEvent STARTED
      { recordset: [{ processCode: 'MX', recordID: 5, tubID: null }] },          // ProductionTrace parents
      { recordset: [bomRow] },                                                  // latestBomSnapshot
      { recordset: [{ Material: 'RUBBERMIX1' }] },                              // parent's own material — mismatch
      { recordset: [] },                                                        // unresolvedProblems: no approved concession
      { recordset: [] },                                                        // markSapFailed: UPDATE Status=6
      { recordset: [] },                                                        // audit() fire-and-forget insert
      { recordset: [] },                                                        // INSERT SAPPostings (failed)
      { recordset: [] },                                                        // writeEvent SAP_FAIL
    );

    const res = await request(app).post('/process/CO/complete/30').send({ lengthMetres: 10 });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SAP_FAILED');
    expect(res.body.data.error).toMatch(/^Blocked:/);
    expect(res.body.data.error).toMatch(/not a component/);
    expect(res.body.data.error).toMatch(/concession/i);
    expect(axiosMock.post).not.toHaveBeenCalled(); // never reaches any backflush call
  });

  test('an approved concession unblocks completion and posts via the goods-movement path instead of the normal backflush', async () => {
    mockProfitCentreOk();
    queueResults(
      { recordset: [{ ConvolutingID: 31, Material: 'TCEL9-9CBT', Status: 1 }] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [{ processCode: 'MX', recordID: 5, tubID: null }] },
      { recordset: [bomRow] },
      { recordset: [{ Material: 'RUBBERMIX1' }] },
      { recordset: [{ x: 1 }] }, // unresolvedProblems: an approved concession covers this link
      { recordset: [{ ConcessionID: 7, Component: 'COMP1', ActualMaterial: 'RUBBERMIX1', Quantity: null }] }, // approvedConcessions
      { recordset: [] }, // audit() SAP_OK
      { recordset: [] }, // INSERT SAPPostings
      { recordset: [] }, // writeEvent SAP_POST
      { recordset: [] }, // UPDATE TraceabilityConcessions SET AppliedAt (1 concession)
    );
    axiosMock.post.mockResolvedValueOnce({ data: { success: true, data: {
      materialDocument: 'GM1001', materialDocumentYear: '2026', success: true, messages: [],
    } } });

    const res = await request(app).post('/process/CO/complete/31').send({ lengthMetres: 10 });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('COMPLETE');
    expect(res.body.data.concessionApplied).toBe(true);
    expect(res.body.data.materialDocument).toBe('GM1001');

    // buildActualComponentList: the mismatched component was substituted
    // with the concession's actual material, at the default BOM-ratio
    // quantity (componentQty 1 * lengthMetres 10) since no override was given.
    const posted = axiosMock.post.mock.calls[0][1];
    expect(posted.Components).toEqual([
      { Material: 'RUBBERMIX1', Quantity: 10, Unit: 'KG', StorageLocation: '1710' },
    ]);
  });
});

// ── Concession raise / approve / reject ──────────────────────────────────────

describe('POST /process/:processCode/:recordID/concession', () => {
  test('400s outside CO/BR/CL/TW/DR', async () => {
    const res = await request(app).post('/process/EX/40/concession').send({
      parentProcessCode: 'MX', parentRecordID: 5, component: 'COMP1', actualMaterial: 'RUBBERMIX1', reason: 'x',
    });
    expect(res.status).toBe(400);
  });

  test('400s without a reason', async () => {
    const res = await request(app).post('/process/CO/40/concession').send({
      parentProcessCode: 'MX', parentRecordID: 5, component: 'COMP1', actualMaterial: 'RUBBERMIX1',
    });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('raises a pending concession', async () => {
    queueResults(
      { recordset: [] },                  // no existing pending/approved concession for this link
      { recordset: [{ ConcessionID: 7 }] }, // INSERT ... OUTPUT INSERTED.ConcessionID
      { recordset: [] },                  // writeEvent NOTE
    );
    const res = await request(app).post('/process/CO/40/concession').send({
      parentProcessCode: 'MX', parentRecordID: 5, component: 'COMP1', actualMaterial: 'RUBBERMIX1',
      reason: 'Supplier substituted an equivalent material — confirmed by engineering.',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.concessionID).toBe(7);
  });

  test('409s when a concession for the same link is already pending or approved', async () => {
    queueResults({ recordset: [{ ConcessionID: 3 }] });
    const res = await request(app).post('/process/CO/40/concession').send({
      parentProcessCode: 'MX', parentRecordID: 5, component: 'COMP1', actualMaterial: 'RUBBERMIX1', reason: 'x',
    });
    expect(res.status).toBe(409);
  });
});

describe('GET /concessions and POST /concessions/:id/approve|reject — QUAL_CONCESSION gated', () => {
  test('403s for a plain operator', async () => {
    const res = await request(app).get('/concessions');
    expect(res.status).toBe(403);
  });

  test('200s and lists pending concessions for a QUAL_CONCESSION user', async () => {
    queueResults({ recordset: [{ ConcessionID: 7, ProcessCode: 'CO', RecordID: 40, Status: 'PENDING' }] });
    const res = await request(qApp).get('/concessions');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  test('approve: 403s for a plain operator', async () => {
    const res = await request(app).post('/concessions/7/approve').send({});
    expect(res.status).toBe(403);
  });

  test('approve: flips status to APPROVED and notifies the raiser', async () => {
    queueResults(
      { recordset: [{ ConcessionID: 7, ProcessCode: 'CO', RecordID: 40, ParentProcessCode: 'MX', ParentRecordID: 5, Component: 'COMP1', Status: 'PENDING', RaisedByUserID: 101 }] },
      { recordset: [] }, // UPDATE ... SET Status=APPROVED
      { recordset: [] }, // writeEvent NOTE
      { recordset: [{ Username: 'j.smith' }] }, // raiser lookup for notify()
    );
    const res = await request(qApp).post('/concessions/7/approve').send({ notes: 'Confirmed with QC.' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('APPROVED');
  });

  test('409s re-reviewing a concession that is no longer PENDING', async () => {
    queueResults({ recordset: [{ ConcessionID: 7, Status: 'APPROVED' }] });
    const res = await request(qApp).post('/concessions/7/approve').send({});
    expect(res.status).toBe(409);
  });

  test('reject: flips status to REJECTED', async () => {
    queueResults(
      { recordset: [{ ConcessionID: 8, ProcessCode: 'CO', RecordID: 41, ParentProcessCode: 'MX', ParentRecordID: 6, Component: 'COMP1', Status: 'PENDING', RaisedByUserID: 101 }] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [{ Username: 'j.smith' }] },
    );
    const res = await request(qApp).post('/concessions/8/reject').send({ notes: 'Not acceptable — relink the correct batch.' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('REJECTED');
  });
});
