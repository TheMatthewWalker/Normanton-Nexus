// routes/sapStaging.js's reverseStagedPackage() is depended on (mocked) by
// both test/routes/deliverymain.test.js and palletmain.js/palletpackages.js
// in production — this suite tests the real implementation directly.

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { jest } from '@jest/globals';

const axiosMock = { post: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));
jest.unstable_mockModule('../../routes/sap.js', () => ({
  makeSapToken: jest.fn(() => 'fake-token'),
  sapAgent: null,
}));

let reverseStagedPackage;

beforeAll(async () => {
  ({ reverseStagedPackage } = await import('../../routes/sapStaging.js'));
});

beforeEach(() => {
  axiosMock.post.mockReset();
});

const stagedRow = {
  sapMaterial: '30005R',
  sapBatch: 'BATCH1',
  sapDelivery: '1234',
  sapSourceStorageType: 'SA',
  sapSourceBin: 'BIN-001',
};

describe('reverseStagedPackage', () => {
  test('is a no-op when the row was never actually staged (missing SAP fields)', async () => {
    const result = await reverseStagedPackage({ sapMaterial: '30005R' }); // missing batch/delivery/etc.
    expect(result).toEqual({ attempted: false, success: true, error: null });
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  test('zero-pads the staged bin (sapDelivery) to 10 digits in the request body', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { success: true } });
    await reverseStagedPackage(stagedRow);
    const [, body] = axiosMock.post.mock.calls[0];
    expect(body.stagedBin).toBe('0000001234');
  });

  test('reports success when SapServer confirms the reversal', async () => {
    axiosMock.post.mockResolvedValueOnce({ data: { success: true } });
    const result = await reverseStagedPackage(stagedRow);
    expect(result).toEqual({ attempted: true, success: true, error: null });
  });

  test('surfaces a business-level rejection (422 with an ApiResponse body) as a clean failure, not a throw', async () => {
    const err = new Error('Request failed with status code 422');
    err.response = { data: { success: false, error: { message: 'Batch already picked' } } };
    axiosMock.post.mockRejectedValueOnce(err);

    const result = await reverseStagedPackage(stagedRow);

    expect(result).toEqual({ attempted: true, success: false, error: 'Batch already picked' });
  });

  test('reports a transport/network failure with the raw error message', async () => {
    axiosMock.post.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const result = await reverseStagedPackage(stagedRow);
    expect(result).toEqual({ attempted: true, success: false, error: 'ETIMEDOUT' });
  });
});
