// routes/deliverymain.js — representative sample covering CRUD, the
// permission-gated create/bulk routes, the packaging-holding cancel/
// uncomplete flows that reverse SAP staging via the shared
// cancelHeldPicksheet() helper, and the linked-picksheets (shared pallet
// pool) routes. The picksheet-materials/complete/zdelflag routes'
// SAP-sync-heavy happy paths are a known, deliberate gap (see CLAUDE.md) —
// PATCH /:deliveryId/complete's new "fully picked" precondition and its
// linked-group resolution are covered, but not the ZDEL/ZDELFLAG/Goods
// Issue mutation logic itself.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';
import request from 'supertest';
import { createMockSql, resetMockSql } from '../helpers/mockPool.js';
import { buildTestApp } from '../helpers/testApp.js';
import { operatorUser } from '../helpers/fixtures/users.js';

const { sqlModule, pool, request: dbRequest, connect } = createMockSql();
jest.unstable_mockModule('mssql', () => ({ default: sqlModule }));

const axiosMock = { get: jest.fn(), post: jest.fn(), request: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

jest.unstable_mockModule('../../routes/sap.js', () => ({
  makeSapToken: jest.fn(() => 'fake-sap-token'),
  sapAgent: null,
}));

const reverseStagedPackageMock = jest.fn();
jest.unstable_mockModule('../../routes/sapStaging.js', () => ({
  reverseStagedPackage: reverseStagedPackageMock,
}));

const logSuperUser    = { ...operatorUser, permissions: ['LOG_SUPER'] };
const warehouseOpUser = { ...operatorUser, permissions: ['WAREHOUSE_OP'] };

let deliveryRouter;
let app;
let appLogSuper;
let appWarehouseOp;

beforeAll(async () => {
  ({ default: deliveryRouter } = await import('../../routes/deliverymain.js'));
  app = buildTestApp(deliveryRouter, { sessionUser: operatorUser });
  appLogSuper = buildTestApp(deliveryRouter, { sessionUser: logSuperUser });
  appWarehouseOp = buildTestApp(deliveryRouter, { sessionUser: warehouseOpUser });
});

beforeEach(() => {
  resetMockSql({ pool, request: dbRequest, connect });
  reverseStagedPackageMock.mockReset();
  axiosMock.get.mockReset();
  axiosMock.post.mockReset();
  axiosMock.request.mockReset();
});

function queueResults(...results) {
  for (const r of results) dbRequest.query.mockResolvedValueOnce(r);
}

describe('GET /', () => {
  test('returns the raw recordset', async () => {
    queueResults({ recordset: [{ deliveryID: 1 }, { deliveryID: 2 }] });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ deliveryID: 1 }, { deliveryID: 2 }]);
  });
});

describe('GET /id/:deliveryId', () => {
  test('returns an empty array when nothing matches', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).get('/id/999');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST / (create)', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/').send({ deliveryID: 1, customerID: 1 });
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('creates a delivery for a LOG_SUPER user', async () => {
    queueResults({ recordset: [] });
    const res = await request(appLogSuper).post('/').send({ deliveryID: 100, customerID: 5 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, deliveryID: 100 });
  });
});

describe('POST /bulk', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/bulk').send({ records: [{ deliveryID: 1 }] });
    expect(res.status).toBe(403);
  });

  test('rejects an empty records array', async () => {
    const res = await request(appLogSuper).post('/bulk').send({ records: [] });
    expect(res.status).toBe(400);
  });

  test('reports inserted vs skipped counts', async () => {
    queueResults(
      { rowsAffected: [1] }, // record 1 inserted
      { rowsAffected: [0] }, // record 2 already existed — skipped
    );
    const res = await request(appLogSuper).post('/bulk').send({
      records: [{ deliveryID: 1, customerID: 1 }, { deliveryID: 2, customerID: 1 }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, inserted: 1, skipped: 1, errors: [] });
  });
});

describe('DELETE /:deliveryId/packaging-holding', () => {
  test('is rejected for a user without WAREHOUSE_OP', async () => {
    const res = await request(app).delete('/1/packaging-holding');
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('404s when the delivery does not exist', async () => {
    queueResults({ recordset: [] });
    const res = await request(appWarehouseOp).delete('/999/packaging-holding');
    expect(res.status).toBe(404);
  });

  test('409s when the delivery is not actually pending packaging data', async () => {
    queueResults({ recordset: [{ pendingPackagingData: false }] });
    const res = await request(appWarehouseOp).delete('/1/packaging-holding');
    expect(res.status).toBe(409);
  });

  test('422s and reports failures when a SAP staging reversal fails', async () => {
    queueResults(
      { recordset: [{ pendingPackagingData: true }] }, // pending check
      { recordset: [{ palletItemID: 10, sapMaterial: '30005R', sapBatch: 'B1' }] }, // packages to reverse
    );
    reverseStagedPackageMock.mockResolvedValueOnce({ attempted: true, success: false, error: 'SAP session lost' });

    const res = await request(appWarehouseOp).delete('/1/packaging-holding');

    expect(res.status).toBe(422);
    expect(res.body.failures).toEqual([{ palletItemID: 10, sapMaterial: '30005R', sapBatch: 'B1', error: 'SAP session lost' }]);
  });

  test('cancels the picksheet once every package reverses cleanly', async () => {
    queueResults(
      { recordset: [{ pendingPackagingData: true }] },
      { recordset: [{ palletItemID: 10, sapMaterial: '30005R', sapBatch: 'B1' }] },
      { recordset: [] }, // the UPDATE
    );
    reverseStagedPackageMock.mockResolvedValueOnce({ attempted: true, success: true });

    const res = await request(appWarehouseOp).delete('/1/packaging-holding');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});

describe('PATCH /:deliveryId/uncomplete', () => {
  test('404s when the delivery does not exist', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).patch('/999/uncomplete');
    expect(res.status).toBe(404);
  });

  test('409s when the delivery is not an active completed picksheet', async () => {
    queueResults({ recordset: [{ completionStatus: false, deliveryCancelled: false, pendingPackagingData: false, linkedShipmentDelivery: null }] });
    const res = await request(app).patch('/1/uncomplete');
    expect(res.status).toBe(409);
  });

  test('409s when already linked to a shipment', async () => {
    queueResults({ recordset: [{ completionStatus: true, deliveryCancelled: false, pendingPackagingData: false, linkedShipmentDelivery: 55 }] });
    const res = await request(app).patch('/1/uncomplete');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already linked to a shipment/);
  });

  test('reverses completion when eligible', async () => {
    queueResults(
      { recordset: [{ completionStatus: true, deliveryCancelled: false, pendingPackagingData: false, linkedShipmentDelivery: null }] },
      { recordset: [] }, // the UPDATE
    );
    const res = await request(app).patch('/1/uncomplete');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});

describe('PATCH /:deliveryId/comment', () => {
  test('is rejected for a user without WAREHOUSE_OP', async () => {
    const res = await request(app).patch('/1/comment').send({ picksheetComment: 'hello' });
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('404s when the delivery does not exist', async () => {
    queueResults({ recordset: [], rowsAffected: [0] });
    const res = await request(appWarehouseOp).patch('/999/comment').send({ picksheetComment: 'hello' });
    expect(res.status).toBe(404);
  });

  test('saves the comment', async () => {
    queueResults({ recordset: [], rowsAffected: [1] });
    const res = await request(appWarehouseOp).patch('/1/comment').send({ picksheetComment: 'Damaged pallet, see note' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(dbRequest.input).toHaveBeenCalledWith('comment', expect.anything(), 'Damaged pallet, see note');
  });

  test('truncates to 50 characters', async () => {
    queueResults({ recordset: [], rowsAffected: [1] });
    const long = 'x'.repeat(80);
    await request(appWarehouseOp).patch('/1/comment').send({ picksheetComment: long });
    expect(dbRequest.input).toHaveBeenCalledWith('comment', expect.anything(), 'x'.repeat(50));
  });

  test('clears the comment when sent an empty string', async () => {
    queueResults({ recordset: [], rowsAffected: [1] });
    await request(appWarehouseOp).patch('/1/comment').send({ picksheetComment: '   ' });
    expect(dbRequest.input).toHaveBeenCalledWith('comment', expect.anything(), null);
  });
});

describe('GET /:deliveryId/pallets', () => {
  test('returns pallets, widened to include any linked picksheet\'s own pallets', async () => {
    queueResults({ recordset: [{ palletID: 1, palletType: 'EU', palletFinish: 1 }] });
    const res = await request(app).get('/1/pallets');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [{ palletID: 1, palletType: 'EU', palletFinish: 1 }] });
    // Regression guard: for an unlinked delivery this must stay equivalent
    // to the old unwidened query (empty IN subquery), which this at least
    // confirms the widening clause is actually present in the SQL sent.
    expect(dbRequest.query).toHaveBeenCalledWith(expect.stringContaining('DeliveryPicksheetLink'));
  });
});

describe('GET /:deliveryId/linked-picksheets', () => {
  test('returns currently-linked deliveries', async () => {
    queueResults({ recordset: [{ deliveryID: 2, customerID: 5000, destinationName: 'Acme', completionStatus: 0, dispatchDate: null }] });
    const res = await request(app).get('/1/linked-picksheets');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].deliveryID).toBe(2);
  });
});

describe('GET /link-search', () => {
  test('is rejected for a user without WAREHOUSE_OP', async () => {
    const res = await request(app).get('/link-search?q=1&excludeDeliveryId=1');
    expect(res.status).toBe(403);
  });

  test('400s without excludeDeliveryId', async () => {
    const res = await request(appWarehouseOp).get('/link-search?q=1');
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('404s when excludeDeliveryId does not exist', async () => {
    queueResults({ recordset: [] });
    const res = await request(appWarehouseOp).get('/link-search?q=1&excludeDeliveryId=999');
    expect(res.status).toBe(404);
  });

  test('searches, scoped to the same customer', async () => {
    queueResults(
      { recordset: [{ customerID: 5000 }] },
      { recordset: [{ deliveryID: 2, customerID: 5000, destinationName: 'Acme', dispatchDate: null }] },
    );
    const res = await request(appWarehouseOp).get('/link-search?q=2&excludeDeliveryId=1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(dbRequest.input).toHaveBeenCalledWith('customerId', expect.anything(), 5000);
    expect(dbRequest.input).toHaveBeenCalledWith('q', expect.anything(), '%2%');
  });
});

describe('POST /:deliveryId/link/:otherDeliveryId', () => {
  test('is rejected for a user without WAREHOUSE_OP', async () => {
    const res = await request(app).post('/1/link/2');
    expect(res.status).toBe(403);
  });

  test('400s when linking a picksheet to itself', async () => {
    const res = await request(appWarehouseOp).post('/1/link/1');
    expect(res.status).toBe(400);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('404s when either delivery does not exist', async () => {
    queueResults({ recordset: [{ deliveryID: 1, customerID: 5000, completionStatus: 0, deliveryCancelled: 0 }] });
    const res = await request(appWarehouseOp).post('/1/link/999');
    expect(res.status).toBe(404);
  });

  test('400s when either delivery is completed or cancelled', async () => {
    queueResults({
      recordset: [
        { deliveryID: 1, customerID: 5000, completionStatus: 1, deliveryCancelled: 0 },
        { deliveryID: 2, customerID: 5000, completionStatus: 0, deliveryCancelled: 0 },
      ],
    });
    const res = await request(appWarehouseOp).post('/1/link/2');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be open/);
  });

  test('400s when the two picksheets have different customers', async () => {
    queueResults({
      recordset: [
        { deliveryID: 1, customerID: 5000, completionStatus: 0, deliveryCancelled: 0 },
        { deliveryID: 2, customerID: 6000, completionStatus: 0, deliveryCancelled: 0 },
      ],
    });
    const res = await request(appWarehouseOp).post('/1/link/2');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/same customer/);
  });

  test('409s when already linked', async () => {
    queueResults(
      { recordset: [
          { deliveryID: 1, customerID: 5000, completionStatus: 0, deliveryCancelled: 0 },
          { deliveryID: 2, customerID: 5000, completionStatus: 0, deliveryCancelled: 0 },
      ] },
      { recordset: [{}] }, // existing link found
    );
    const res = await request(appWarehouseOp).post('/1/link/2');
    expect(res.status).toBe(409);
  });

  test('links two open, same-customer picksheets', async () => {
    queueResults(
      { recordset: [
          { deliveryID: 1, customerID: 5000, completionStatus: 0, deliveryCancelled: 0 },
          { deliveryID: 2, customerID: 5000, completionStatus: 0, deliveryCancelled: 0 },
      ] },
      { recordset: [] }, // no existing link
      { recordset: [] }, // the two INSERTs
    );
    const res = await request(appWarehouseOp).post('/1/link/2');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true });
  });
});

describe('DELETE /:deliveryId/link/:otherDeliveryId', () => {
  test('is rejected for a user without WAREHOUSE_OP', async () => {
    const res = await request(app).delete('/1/link/2');
    expect(res.status).toBe(403);
  });

  test('409s when batches are already cross-staged onto each other\'s pallets', async () => {
    queueResults({ recordset: [{ cnt: 2 }] });
    const res = await request(appWarehouseOp).delete('/1/link/2');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/resolve those packages/);
  });

  test('unlinks when there is nothing cross-staged', async () => {
    queueResults(
      { recordset: [{ cnt: 0 }] },
      { recordset: [] }, // the DELETE
    );
    const res = await request(appWarehouseOp).delete('/1/link/2');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});

describe('GET /:deliveryId/picksheet-materials', () => {
  // Regression test: a batch already staged into THIS delivery's own 916
  // bin (i.e. already picked onto one of this delivery's pallets via
  // POST /:deliveryId/stage-batch) must not come back in the 'available'
  // group, or the pallet builder keeps offering it on every later pallet
  // even though it's already sitting on an earlier one.
  test('excludes a batch already staged to this delivery\'s own bin from "available"', async () => {
    queueResults(
      { recordset: [{ customerID: 363660 }] },       // DeliveryMain customerID lookup
      { recordset: [] },                              // already-picked-quantity rollup
    );
    axiosMock.post
      .mockResolvedValueOnce({ data: { success: true, data: [ // LIPS materials
        { materialNumber: '30005R', quantity: '10,000', itemNumber: '000010' },
      ] } })
      .mockResolvedValueOnce({ data: { success: true, data: [ // LQUA/ZPRODBATCH stock
        {
          material: '30005R', batch: 'B1',
          storageType: '916', bin: '0000000500', // = this delivery, zero-padded
          totalQty: '5,000', availableQty: '5,000',
          stockCategory: '', packagingMaterial: 'IB_363660_MD',
        },
      ] } });
    axiosMock.request.mockResolvedValue({ data: { success: false } }); // profit-centre lookup

    const res = await request(appWarehouseOp).get('/500/picksheet-materials');

    expect(res.status).toBe(200);
    const batch = res.body.data.materials[0].batches[0];
    expect(batch.group).toBe('restricted');
    expect(batch.allowed).toBe(false);
    expect(batch.reason).toMatch(/already picked/i);
  });
});

// Only the new "fully picked" precondition — the mutation/ZDEL/ZDELFLAG/
// Goods Issue happy path below it is the same SAP-sync-heavy logic this
// file's header comment already documents as an untested gap (would need
// the full SapServer call chain mocked for disproportionate value versus
// the routing/validation logic actually being tested).
describe('PATCH /:deliveryId/complete', () => {
  test('is rejected for a user without WAREHOUSE_OP', async () => {
    const res = await request(app).patch('/1/complete');
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('409s with the outstanding materials when nothing is linked and picking isn\'t finished', async () => {
    queueResults(
      { recordset: [] },                                   // linkedRes — no links
      { recordset: [{ pendingPackagingData: 0 }] },         // heldRes
      { recordset: [{ customerID: 5000 }] },                // getRemainingRequiredMaterials: dmRes
      { recordset: [] },                                    // getRemainingRequiredMaterials: pickedRes
    );
    axiosMock.post
      .mockResolvedValueOnce({ data: { success: true, data: [ // LIPS — 10 required
        { materialNumber: '30005R', quantity: '10,000', itemNumber: '000010' },
      ] } })
      .mockResolvedValueOnce({ data: { success: true, data: [] } }); // stock — nothing found yet
    axiosMock.request.mockResolvedValue({ data: { success: false } }); // profit-centre lookup

    const res = await request(appWarehouseOp).patch('/1/complete');

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.outstanding).toEqual([
      { deliveryId: '1', materials: [{ material: '30005R', requiredQty: 10 }] },
    ]);
  });

  test('skips the precondition for a delivery already in packaging holding', async () => {
    queueResults(
      { recordset: [] },                             // linkedRes — no links
      { recordset: [{ pendingPackagingData: 1 }] },   // heldRes — held, so requirement check is skipped
      { recordset: [] },                              // ownerRes — no owned pallets, doesn't matter for a group of one
      // completeOneDelivery's own queries follow — held path skips SAP calls
      { recordset: [{ pendingPackagingData: 1 }] },   // completeOneDelivery: pendingRes
      { recordset: [] },                              // rollup UPDATE
      { recordset: [{ palletCount: 0, grossWeight: 0, netWeight: 0 }] }, // rolledUp
    );
    const res = await request(appWarehouseOp).patch('/1/complete');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('resolves the linked group before checking ownership when everything is fully picked and held', async () => {
    queueResults(
      { recordset: [{ linkedDeliveryID: 2 }] },       // linkedRes — linked to #2
      { recordset: [{ pendingPackagingData: 1 }] },   // heldRes for #1
      { recordset: [{ pendingPackagingData: 1 }] },   // heldRes for #2
      // both held, so the precondition loop never calls getRemainingRequiredMaterials —
      // straight to ownership resolution + completeOneDelivery per group member.
      { recordset: [{ deliveryID: 1 }] },             // ownerRes — #1 owns a pallet, #2 doesn't
      { recordset: [{ pendingPackagingData: 1 }] },   // completeOneDelivery(#1): pendingRes
      { recordset: [] },                               // #1 rollup UPDATE
      { recordset: [{ palletCount: 1, grossWeight: 5, netWeight: 4 }] }, // #1 rolledUp
      { recordset: [{ pendingPackagingData: 1 }] },   // completeOneDelivery(#2): pendingRes
      { recordset: [] },                               // #2 rollup UPDATE
      { recordset: [{ palletCount: 0, grossWeight: 0, netWeight: 0 }] }, // #2 rolledUp
    );
    const res = await request(appWarehouseOp).patch('/1/complete');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.linkedResults).toBeDefined();
    expect(Object.keys(res.body.data.linkedResults).sort()).toEqual(['1', '2']);
  });
});

describe('POST /:deliveryId/stage-batch', () => {
  test('is rejected for a user without WAREHOUSE_OP', async () => {
    const res = await request(app).post('/1/stage-batch').send({ material: '30005R', batch: 'B1' });
    expect(res.status).toBe(403);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('400s when material or batch is missing', async () => {
    const res = await request(appWarehouseOp).post('/1/stage-batch').send({ material: '30005R' });
    expect(res.status).toBe(400);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('audits success with the created TR number in the detail', async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, data: { success: true, transferOrderNumber: '4500007777' } },
    });
    queueResults({ recordset: [] }); // the audit insert

    const res = await request(appWarehouseOp).post('/1/stage-batch').send({ material: '30005R', batch: 'B1' });

    expect(res.status).toBe(200);
    expect(dbRequest.input).toHaveBeenCalledWith('detail', 'NVarChar(500)', expect.stringContaining('TR 4500007777'));
  });

  test('audits and surfaces a 422 when SapServer rejects the staging', async () => {
    axiosMock.post.mockRejectedValueOnce({
      response: { data: { success: false, error: { message: 'SAP rejected the transfer order.' } } },
    });
    queueResults({ recordset: [] }); // the audit insert

    const res = await request(appWarehouseOp).post('/1/stage-batch').send({ material: '30005R', batch: 'B1' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('SAP rejected the transfer order.');
    expect(dbRequest.input).toHaveBeenCalledWith('detail', 'NVarChar(500)', expect.stringContaining('failed'));
  });
});

describe('POST /:deliveryId/goods-issue/reprocess', () => {
  test('409s when the latest ZDELFLAG run has not succeeded', async () => {
    queueResults({ recordset: [{ status: 'Failed' }] }); // ZDELFLAG check only
    const res = await request(app).post('/1/goods-issue/reprocess');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ZDELFLAG\/ZDELPACK maintenance has not succeeded/);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('409s when no ZDELFLAG run exists at all', async () => {
    queueResults({ recordset: [] }); // ZDELFLAG check only
    const res = await request(app).post('/1/goods-issue/reprocess');
    expect(res.status).toBe(409);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('409s when Goods Issue already succeeded for this delivery', async () => {
    queueResults(
      { recordset: [{ status: 'Success' }] }, // ZDELFLAG check
      { recordset: [{ status: 'Success' }] }, // GoodsIssueRun check
    );
    const res = await request(app).post('/1/goods-issue/reprocess');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already has a successful Goods Issue posting/);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('posts Goods Issue and records Success when both guards pass', async () => {
    queueResults(
      { recordset: [{ status: 'Success' }] }, // ZDELFLAG check
      { recordset: [{ status: 'Failed' }] },  // GoodsIssueRun check — eligible for retry
      { recordset: [] },                      // the INSERT into DeliveryGoodsIssueRun
    );
    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, data: { success: true, messages: [{ type: 'S', message: 'Delivery processed' }] } },
    });

    const res = await request(app).post('/1/goods-issue/reprocess');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('Success');
    expect(dbRequest.input).toHaveBeenCalledWith('status', expect.anything(), 'Success');
  });

  test('records Failed with the real SAP messages when SapServer returns 422', async () => {
    queueResults(
      { recordset: [{ status: 'Success' }] }, // ZDELFLAG check
      { recordset: [] },                      // GoodsIssueRun check — no prior run
      { recordset: [] },                      // the INSERT into DeliveryGoodsIssueRun
    );
    axiosMock.post.mockRejectedValueOnce({
      response: { data: { success: false, data: { success: false, messages: [{ type: 'E', message: 'Delivery not found' }] } } },
    });

    const res = await request(app).post('/1/goods-issue/reprocess');

    expect(res.status).toBe(200); // the reprocess endpoint itself succeeds — it just records a Failed run
    expect(res.body.data.status).toBe('Failed');
    expect(res.body.data.messages).toEqual([{ type: 'E', message: 'Delivery not found' }]);
  });
});

describe('GET /goods-issue/warnings', () => {
  test('maps Failed DeliveryGoodsIssueRun rows to the warning-log shape', async () => {
    queueResults({
      recordset: [{ deliveryID: '80001234', status: 'Failed', messages: '[{"type":"E","message":"Delivery not found"}]', ranAtUtc: '2026-08-25T10:00:00Z' }],
    });
    const res = await request(app).get('/goods-issue/warnings');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{
      deliveryID: '80001234', status: 'Failed',
      messages: [{ type: 'E', message: 'Delivery not found' }],
      ranAtUtc: '2026-08-25T10:00:00Z',
    }]);
  });
});

describe('GET /:deliveryId/goods-issue/status', () => {
  test('returns null status when no run exists yet', async () => {
    queueResults({ recordset: [] });
    const res = await request(app).get('/1/goods-issue/status');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: null, messages: [], ranAtUtc: null });
  });
});

describe('POST /:deliveryId/zdelflag/resolve', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/1/zdelflag/resolve');
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('409s when there is no outstanding warning (e.g. latest run is Success)', async () => {
    queueResults({ recordset: [{ status: 'Success' }] });
    const res = await request(appLogSuper).post('/1/zdelflag/resolve');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no outstanding ZDELFLAG\/ZDELPACK warning/);
  });

  test('409s when no run exists at all', async () => {
    queueResults({ recordset: [] });
    const res = await request(appLogSuper).post('/1/zdelflag/resolve');
    expect(res.status).toBe(409);
  });

  test('records a Resolved run with a default note when the latest run is Failed', async () => {
    queueResults(
      { recordset: [{ status: 'Failed' }] }, // latest-run check
      { recordset: [] },                     // the INSERT
    );
    const res = await request(appLogSuper).post('/1/zdelflag/resolve');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(dbRequest.input).toHaveBeenCalledWith('status', expect.anything(), 'Resolved');
    expect(dbRequest.input).toHaveBeenCalledWith('messages', expect.anything(),
      expect.stringContaining('Manually marked resolved by'));
  });

  test('records a Resolved run with a custom note when the latest run is Warning', async () => {
    queueResults(
      { recordset: [{ status: 'Warning' }] },
      { recordset: [] },
    );
    const res = await request(appLogSuper).post('/1/zdelflag/resolve').send({ note: 'Fixed manually in ZPIL9' });
    expect(res.status).toBe(200);
    expect(dbRequest.input).toHaveBeenCalledWith('messages', expect.anything(),
      expect.stringContaining('Fixed manually in ZPIL9'));
  });
});

describe('POST /:deliveryId/goods-issue/resolve', () => {
  test('is rejected for a user without LOG_SUPER', async () => {
    const res = await request(app).post('/1/goods-issue/resolve');
    expect(res.status).toBe(403);
    expect(dbRequest.query).not.toHaveBeenCalled();
  });

  test('409s when the latest run is not Failed', async () => {
    queueResults({ recordset: [] }); // no run at all
    const res = await request(appLogSuper).post('/1/goods-issue/resolve');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no outstanding Goods Issue warning/);
  });

  test('records a Resolved run when the latest run is Failed', async () => {
    queueResults(
      { recordset: [{ status: 'Failed' }] },
      { recordset: [] },
    );
    const res = await request(appLogSuper).post('/1/goods-issue/resolve').send({ note: 'Posted manually in VL06O' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(dbRequest.input).toHaveBeenCalledWith('status', expect.anything(), 'Resolved');
    expect(dbRequest.input).toHaveBeenCalledWith('messages', expect.anything(),
      expect.stringContaining('Posted manually in VL06O'));
  });
});
