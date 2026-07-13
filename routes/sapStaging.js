import axios from 'axios';
import { sapConfig } from '../config.js';
import { makeSapToken, sapAgent } from './sap.js';

// Reverses a picksheet-stage-batch transfer order for one PalletPackages row,
// moving its batch's stock back out of the picksheet's 916 bin to wherever it
// came from. Shared by routes/palletpackages.js (single package delete) and
// routes/palletmain.js (pallet delete — reverses every one of its packages).
// See SapServer's WarehouseController.PicksheetUnstageBatch for the actual
// logic (fresh LQUA re-query, "nothing to reverse" if it's no longer sitting
// in the 916 bin).
//
// `row` needs: sapMaterial, sapBatch, sapDelivery, sapSourceStorageType,
// sapSourceBin (whatever was recorded on the row when it was staged).
// Returns { attempted, success, error }:
//   - attempted:false — the row was never staged (no SAP fields recorded,
//     e.g. a manually-typed batch with no SAP match). Nothing to do.
//   - attempted:true, success:true — reversed (or SAP itself reported
//     nothing left to reverse, e.g. already picked/moved since).
//   - attempted:true, success:false — SAP rejected the reversal; caller
//     must not proceed with deleting/removing this package.
export async function reverseStagedPackage(row) {
    if (!row || !row.sapMaterial || !row.sapBatch || !row.sapDelivery
        || !row.sapSourceStorageType || !row.sapSourceBin) {
        return { attempted: false, success: true, error: null };
    }

    const stagedBin = String(row.sapDelivery).trim().padStart(10, '0');

    try {
        const response = await axios.post(
            `${sapConfig.url}/api/warehouse/picksheet-unstage-batch`,
            {
                material: row.sapMaterial,
                batch: row.sapBatch,
                stagedBin,
                originalSourceType: row.sapSourceStorageType,
                originalSourceBin: row.sapSourceBin,
            },
            { timeout: 30000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken()}` } }
        ).catch(err => {
            // SapServer returns 422 (with a normal ApiResponse body) for
            // business-level reversal failures — surface that body rather
            // than treating it as a transport error.
            if (err.response?.data) return { data: err.response.data };
            throw err;
        });

        const body = response.data;
        if (!body?.success) {
            return {
                attempted: true,
                success: false,
                error: body?.error?.message || body?.data?.error || 'SAP transfer-order reversal failed',
            };
        }
        return { attempted: true, success: true, error: null };
    } catch (err) {
        return { attempted: true, success: false, error: err.message };
    }
}
