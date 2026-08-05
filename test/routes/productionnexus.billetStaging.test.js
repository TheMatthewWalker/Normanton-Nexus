// Billet staging / 96h mixing-tub shelf-life feature (routes/productionnexus.js).
// Covers the new standalone tub-lifecycle endpoints (stage / return-to-
// conditioning / staging queue / expired queue / expiry scrap+override) and
// the EX-completion billet-staging gate (validateMxTubLinks +
// apportionMxExpectedConsumption, wired into POST /process/EX/complete/:id).
// This sits right next to the already-documented test-coverage gap in
// CLAUDE.md around /drumming/entry's parent-batch-trace-link branches —
// written deliberately thoroughly rather than treated as a safe-by-adjacency
// area. axios is mocked (sapGet/sapPost/BOM lookups); notify()'s
// fire-and-forget insert is left unmocked and un-queued, same convention as
// productionnexus.mixing.test.js — it silently no-ops via its own .catch().

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser, productionSupervisor } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const axiosMock = { request: jest.fn(), post: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

let nexusRouter;
let app;       // operator session — stage/return/search/queue, and general entry routes
let supApp;    // PROD_SUPERVISOR session — expired queue/scrap/override

beforeAll(async () => {
  ({ default: nexusRouter } = await import('../../routes/productionnexus.js'));
  app    = buildTestApp(nexusRouter, { sessionUser: operatorUser });
  supApp = buildTestApp(nexusRouter, { sessionUser: productionSupervisor });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  axiosMock.request.mockReset();
  axiosMock.post.mockReset();
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

// ── PATCH /mixing/tubs/:tubId/stage ──────────────────────────────────────────

describe('PATCH /mixing/tubs/:tubId/stage', () => {
  test('404s when the tub does not exist', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).patch('/mixing/tubs/999/stage');
    expect(res.status).toBe(404);
  });

  test('409s when the tub has already been scrapped', async () => {
    queueResults({ recordset: [{ MixingID: 1, IsScrapped: true, IsStaged: false, IsReversed: false, Status: 1, AgeHours: 10, ExpiryOverrideAt: null, ReturnedKG: 0 }] });
    const res = await request(app).patch('/mixing/tubs/1/stage');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/scrapped/i);
  });

  test('409s when the parent mix has been reversed', async () => {
    queueResults({ recordset: [{ MixingID: 1, IsScrapped: false, IsStaged: false, IsReversed: true, Status: 4, AgeHours: 10, ExpiryOverrideAt: null, ReturnedKG: 0 }] });
    const res = await request(app).patch('/mixing/tubs/1/stage');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/reversed|cancelled/i);
  });

  test('409s when expired (>96h) and not expiry-overridden — directs to supervisor queue', async () => {
    queueResults({ recordset: [{ MixingID: 1, IsScrapped: false, IsStaged: false, IsReversed: false, Status: 1, AgeHours: 100, ExpiryOverrideAt: null, ReturnedKG: 0 }] });
    const res = await request(app).patch('/mixing/tubs/1/stage');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/expired/i);
  });

  test('stages successfully and computes the Billet balance net of prior returns', async () => {
    queueResults(
      { recordset: [{ MixingID: 1, TubWeightKG: 20, IsScrapped: false, IsStaged: false, IsReversed: false, Status: 1, AgeHours: 12.5, ExpiryOverrideAt: null, ReturnedKG: 5 }] },
      { recordset: [] }, // UPDATE MixingTubs
      { recordset: [] }, // writeEvent STAGED
    );
    const res = await request(app).patch('/mixing/tubs/1/stage');
    expect(res.status).toBe(200);
    expect(res.body.data.stagedQuantityKG).toBe(15); // 20 - 5
  });

  // Expired but expiry-overridden — allowed through even though AgeHours > 96,
  // matching the "supervisor already signed off" path.
  test('allows staging an expired tub when ExpiryOverrideAt is already set', async () => {
    queueResults(
      { recordset: [{ MixingID: 1, TubWeightKG: 10, IsScrapped: false, IsStaged: false, IsReversed: false, Status: 1, AgeHours: 120, ExpiryOverrideAt: new Date(), ReturnedKG: 0 }] },
      { recordset: [] },
      { recordset: [] },
    );
    const res = await request(app).patch('/mixing/tubs/1/stage');
    expect(res.status).toBe(200);
  });
});

// ── POST /mixing/tubs/:tubId/return-to-conditioning ─────────────────────────

describe('POST /mixing/tubs/:tubId/return-to-conditioning', () => {
  test('400s on a non-positive quantity', async () => {
    const res = await request(app).post('/mixing/tubs/1/return-to-conditioning').send({ quantityKG: 0 });
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('404s when the tub does not exist', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).post('/mixing/tubs/1/return-to-conditioning').send({ quantityKG: 5 });
    expect(res.status).toBe(404);
  });

  test('409s when the tub is not currently staged', async () => {
    queueResults({ recordset: [{ MixingID: 1, IsStaged: false, StagedQuantityKG: 0 }] });
    const res = await request(app).post('/mixing/tubs/1/return-to-conditioning').send({ quantityKG: 5 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not currently staged/i);
  });

  test('409s when returning more than the current staged balance', async () => {
    queueResults({ recordset: [{ MixingID: 1, IsStaged: true, StagedQuantityKG: 3 }] });
    const res = await request(app).post('/mixing/tubs/1/return-to-conditioning').send({ quantityKG: 5 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only 3/);
  });

  test('partial return leaves the tub staged with a reduced balance', async () => {
    queueResults(
      { recordset: [{ MixingID: 1, IsStaged: true, StagedQuantityKG: 20 }] },
      { recordset: [] }, // INSERT MixingTubReturns
      { recordset: [] }, // UPDATE MixingTubs
      { recordset: [] }, // writeEvent COND_RETURN
    );
    const res = await request(app).post('/mixing/tubs/1/return-to-conditioning').send({ quantityKG: 8 });
    expect(res.status).toBe(200);
    expect(res.body.data.stagedQuantityKG).toBe(12);
    expect(res.body.data.isStaged).toBe(true);
  });

  test('returning the full balance un-stages the tub', async () => {
    queueResults(
      { recordset: [{ MixingID: 1, IsStaged: true, StagedQuantityKG: 20 }] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [] },
    );
    const res = await request(app).post('/mixing/tubs/1/return-to-conditioning').send({ quantityKG: 20 });
    expect(res.status).toBe(200);
    expect(res.body.data.stagedQuantityKG).toBe(0);
    expect(res.body.data.isStaged).toBe(false);
  });
});

// ── GET /mixing/staging/queue & /mixing/expired ──────────────────────────────

describe('GET /mixing/staging/queue', () => {
  test('returns rows as-is (age bucketing is done in SQL)', async () => {
    queueResults({ recordset: [{ TubID: 1, Bucket: '0-24' }, { TubID: 2, Bucket: 'expired' }] });
    const res = await request(app).get('/mixing/staging/queue');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });
});

describe('GET /mixing/expired — requires PROD_SUPERVISOR', () => {
  test('403s for a plain operator', async () => {
    const res = await request(app).get('/mixing/expired');
    expect(res.status).toBe(403);
  });

  test('200s for a supervisor', async () => {
    queueResults({ recordset: [] });
    const res = await request(supApp).get('/mixing/expired');
    expect(res.status).toBe(200);
  });
});

// ── POST /mixing/tubs/:tubId/expiry/override ─────────────────────────────────

describe('POST /mixing/tubs/:tubId/expiry/override', () => {
  test('400s without a reason', async () => {
    const res = await request(supApp).post('/mixing/tubs/1/expiry/override').send({});
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('409s when the tub is not actually expired yet', async () => {
    queueResults({ recordset: [{ MixingID: 1, TubWeightKG: 10, IsStaged: false, IsScrapped: false, AgeHours: 10, ReturnedKG: 0 }] });
    const res = await request(supApp).post('/mixing/tubs/1/expiry/override').send({ reason: 'Line down, need it now' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not yet expired/i);
  });

  test('stages the tub and records the override reason', async () => {
    queueResults(
      { recordset: [{ MixingID: 1, TubWeightKG: 10, IsStaged: false, IsScrapped: false, AgeHours: 100, ReturnedKG: 2 }] },
      { recordset: [] }, // UPDATE MixingTubs
      { recordset: [] }, // writeEvent EXPIRY_OVERRIDE
    );
    const res = await request(supApp).post('/mixing/tubs/1/expiry/override').send({ reason: 'Line down, need it now' });
    expect(res.status).toBe(200);
    expect(res.body.data.stagedQuantityKG).toBe(8); // 10 - 2
  });
});

// ── Billet-staging gate on EX completion ──────────────────────────────────────
// The core cross-cutting behaviour: an EX run linked to an unstaged MX tub
// must have its SAP backflush call skipped entirely (never calls
// sapPost('/api/production/backflush')), land on Status=6 the same way a
// real SAP failure would, and still return a normal 200 (the EX record and
// ExtRef already exist from draft time — nothing about creating it failed).

describe('POST /process/EX/complete/:recordID — billet-staging gate', () => {
  test('blocks the SAP backflush and reports SAP_FAILED when the linked MX tub is not staged', async () => {
    queueResults(
      { recordset: [{ ExtrusionID: 42, Material: 'TSHV3-4', Status: 1 }] },              // 1. existence/open check
      { recordset: [] },                                                                  // 2. UPDATE Extrusion -> Status=4
      { recordset: [] },                                                                  // 3. writeEvent STARTED
      { recordset: [{ recordID: 5, tubID: 3 }] },                                         // 4. MX parent trace lookup
      { recordset: [{ TraceID: 99, Material: 'RUBBERMIX1' }] },                            // 5. apportion: trace rows joined to tub material
      { recordset: [] },                                                                  // 6. apportion: UPDATE ExpectedConsumptionKG
      { recordset: [{ MixingID: 5, IsStaged: 0, IsScrapped: 0, Material: 'RUBBERMIX1' }] }, // 7. validateMxTubLinks: tub lookup — NOT staged
      { recordset: [] },                                                                  // 8. markSapFailed: UPDATE Extrusion Status=6
      { recordset: [] },                                                                  // 9. audit() fire-and-forget insert (see file header)
      { recordset: [] },                                                                  // 10. INSERT SAPPostings (failed)
      { recordset: [] },                                                                  // 11. writeEvent SAP_FAIL
    );
    axiosMock.request
      .mockResolvedValueOnce({ data: { success: true, data: '0000002001' } })                                    // assertProfitCentre (EX allows 2001/2021)
      .mockResolvedValueOnce({ data: { success: true, data: [{ material: 'TSHV3-4', component: 'RUBBERMIX1', componentQty: 0.75, componentUnit: 'KG' }] } }) // apportion's BOM lookup
      .mockResolvedValueOnce({ data: { success: true, data: [{ material: 'TSHV3-4', component: 'RUBBERMIX1', componentQty: 0.75, componentUnit: 'KG' }] } }); // validateMxTubLinks' BOM lookup

    const res = await request(app).post('/process/EX/complete/42').send({ lengthMetres: 10 });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SAP_FAILED');
    expect(res.body.data.error).toMatch(/^Blocked:/);
    expect(res.body.data.error).toMatch(/not been staged/i);
    expect(axiosMock.post).not.toHaveBeenCalled(); // the actual backflush call must never fire
  });
});
