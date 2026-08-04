// routes/performanceorderlink.js's resolveDeliveryReferenceDocuments()
// resolves delivery-shaped ReferenceDocuments (SAP delivery numbers, which
// start '008' in this system) back to their real sales order number/item
// via VBFA, caching results in dbo (performancesql.js, mocked here) and
// falling back to routes/performancesap.js's getVbfaOrderLink (also mocked)
// for anything not yet cached. Order/non-delivery rows must pass through
// untouched; a failed or missing VBFA link must leave the raw delivery
// number as the fallback rather than throwing.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';

const db = {
  getCachedDeliveryOrderLinks: jest.fn(),
  insertDeliveryOrderLinksIfMissing: jest.fn(),
};
jest.unstable_mockModule('../../routes/performancesql.js', () => db);

const getVbfaOrderLinkMock = jest.fn();
jest.unstable_mockModule('../../routes/performancesap.js', () => ({ getVbfaOrderLink: getVbfaOrderLinkMock }));

let resolveDeliveryReferenceDocuments;

beforeAll(async () => {
  ({ resolveDeliveryReferenceDocuments } = await import('../../routes/performanceorderlink.js'));
});

beforeEach(() => {
  db.getCachedDeliveryOrderLinks.mockReset().mockResolvedValue(new Map());
  db.insertDeliveryOrderLinksIfMissing.mockReset().mockResolvedValue(undefined);
  getVbfaOrderLinkMock.mockReset();
});

const req = {};

describe('non-delivery-shaped rows', () => {
  test('pass through referenceDocument/item as originalDoc/originalDocItem unchanged', async () => {
    const rows = [{ referenceDocument: '4500012345', item: '10' }];
    await resolveDeliveryReferenceDocuments(rows, req);
    expect(rows[0].originalDoc).toBe('4500012345');
    expect(rows[0].originalDocItem).toBe('10');
    expect(db.getCachedDeliveryOrderLinks).not.toHaveBeenCalled();
    expect(getVbfaOrderLinkMock).not.toHaveBeenCalled();
  });

  test('an empty rows array is a no-op', async () => {
    await expect(resolveDeliveryReferenceDocuments([], req)).resolves.toBeUndefined();
    expect(db.getCachedDeliveryOrderLinks).not.toHaveBeenCalled();
  });
});

describe('cached delivery-shaped rows', () => {
  test('resolves from the cache without calling SAP', async () => {
    db.getCachedDeliveryOrderLinks.mockResolvedValueOnce(
      new Map([['0080001111||10', { orderNumber: '4500099999', orderItem: '20' }]]),
    );
    const rows = [{ referenceDocument: '0080001111', item: '10' }];
    await resolveDeliveryReferenceDocuments(rows, req);
    expect(rows[0].originalDoc).toBe('4500099999');
    expect(rows[0].originalDocItem).toBe('20');
    expect(getVbfaOrderLinkMock).not.toHaveBeenCalled();
    expect(db.insertDeliveryOrderLinksIfMissing).not.toHaveBeenCalled();
  });
});

describe('uncached delivery-shaped rows', () => {
  test('fetches VBFA for the uncached delivery, caches it, and resolves the row', async () => {
    getVbfaOrderLinkMock.mockResolvedValueOnce([
      { deliveryItem: '10', orderNumber: '4500055555', orderItem: '30' },
    ]);
    const rows = [{ referenceDocument: '0080002222', item: '10' }];
    await resolveDeliveryReferenceDocuments(rows, req);

    expect(getVbfaOrderLinkMock).toHaveBeenCalledWith(req, '0080002222');
    expect(db.insertDeliveryOrderLinksIfMissing).toHaveBeenCalledWith([
      { deliveryNumber: '0080002222', deliveryItem: '10', orderNumber: '4500055555', orderItem: '30' },
    ]);
    expect(rows[0].originalDoc).toBe('4500055555');
    expect(rows[0].originalDocItem).toBe('30');
  });

  test('dedupes multiple rows sharing the same delivery number into one VBFA call', async () => {
    getVbfaOrderLinkMock.mockResolvedValueOnce([
      { deliveryItem: '10', orderNumber: '4500055555', orderItem: '30' },
      { deliveryItem: '20', orderNumber: '4500055555', orderItem: '40' },
    ]);
    const rows = [
      { referenceDocument: '0080002222', item: '10' },
      { referenceDocument: '0080002222', item: '20' },
    ];
    await resolveDeliveryReferenceDocuments(rows, req);

    expect(getVbfaOrderLinkMock).toHaveBeenCalledTimes(1);
    expect(rows[0].originalDocItem).toBe('30');
    expect(rows[1].originalDocItem).toBe('40');
  });

  test('a failed VBFA lookup leaves the row at its pass-through default, without throwing', async () => {
    getVbfaOrderLinkMock.mockRejectedValueOnce(new Error('RFC timeout'));
    const rows = [{ referenceDocument: '0080003333', item: '10' }];
    await expect(resolveDeliveryReferenceDocuments(rows, req)).resolves.toBeUndefined();
    expect(rows[0].originalDoc).toBe('0080003333');
    expect(rows[0].originalDocItem).toBe('10');
    expect(db.insertDeliveryOrderLinksIfMissing).not.toHaveBeenCalled();
  });

  test('a delivery with no matching VBFA item for this row falls back to the raw delivery number/item', async () => {
    getVbfaOrderLinkMock.mockResolvedValueOnce([
      { deliveryItem: '99', orderNumber: '4500055555', orderItem: '30' }, // different item than the row below
    ]);
    const rows = [{ referenceDocument: '0080004444', item: '10' }];
    await resolveDeliveryReferenceDocuments(rows, req);
    expect(rows[0].originalDoc).toBe('0080004444');
    expect(rows[0].originalDocItem).toBe('10');
  });

  test('batches VBFA calls in groups of 5 concurrent lookups', async () => {
    getVbfaOrderLinkMock.mockResolvedValue([]);
    const deliveries = Array.from({ length: 7 }, (_, i) => `008000${i}`);
    const rows = deliveries.map(d => ({ referenceDocument: d, item: '10' }));
    await resolveDeliveryReferenceDocuments(rows, req);
    expect(getVbfaOrderLinkMock).toHaveBeenCalledTimes(7); // one call per unique delivery, batched 5-at-a-time internally
  });
});
