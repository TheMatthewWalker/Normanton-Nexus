// lib/stockCountGuard.js — the transfer-request block used by
// routes/sap.js's transfer-order/batch-cleanup-transfer/create-lt04 proxies
// and routes/staging.js's direct SapServer call. Pure logic over a mocked
// routes/stockcountsql.js, no real DB involved.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';

const findActiveCountForLocationMock = jest.fn();
jest.unstable_mockModule('../../routes/stockcountsql.js', () => ({
  findActiveCountForLocation: findActiveCountForLocationMock,
}));

let assertTransfersAllowed, TransferBlockedError;

beforeAll(async () => {
  ({ assertTransfersAllowed, TransferBlockedError } = await import('../../lib/stockCountGuard.js'));
});

beforeEach(() => {
  findActiveCountForLocationMock.mockReset();
});

describe('assertTransfersAllowed', () => {
  test('no-ops without querying when storageLocation is falsy', async () => {
    await expect(assertTransfersAllowed(null)).resolves.toBeUndefined();
    await expect(assertTransfersAllowed(undefined)).resolves.toBeUndefined();
    await expect(assertTransfersAllowed('')).resolves.toBeUndefined();
    expect(findActiveCountForLocationMock).not.toHaveBeenCalled();
  });

  test('resolves silently when no active count is found for the location', async () => {
    findActiveCountForLocationMock.mockResolvedValueOnce(null);
    await expect(assertTransfersAllowed('1710')).resolves.toBeUndefined();
    expect(findActiveCountForLocationMock).toHaveBeenCalledWith('1710');
  });

  test('throws TransferBlockedError with a clear message when an active count is found', async () => {
    findActiveCountForLocationMock.mockResolvedValueOnce({ CountId: 42, CountType: 'PRODUCTION', Status: 'PendingApproval' });

    await expect(assertTransfersAllowed('1716')).rejects.toThrow(TransferBlockedError);
    findActiveCountForLocationMock.mockResolvedValueOnce({ CountId: 42, CountType: 'PRODUCTION', Status: 'PendingApproval' });
    await expect(assertTransfersAllowed('1716')).rejects.toThrow(/PRODUCTION count #42/);
  });

  test('the thrown error carries the active count details for callers that want to surface them', async () => {
    findActiveCountForLocationMock.mockResolvedValueOnce({ CountId: 7, CountType: 'RAW_MATERIAL', Status: 'Open' });
    try {
      await assertTransfersAllowed('1710');
      throw new Error('expected assertTransfersAllowed to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TransferBlockedError);
      expect(err.activeCount).toMatchObject({ CountId: 7, CountType: 'RAW_MATERIAL', Status: 'Open', StorageLocation: '1710' });
    }
  });
});
