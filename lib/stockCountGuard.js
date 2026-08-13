// lib/stockCountGuard.js
//
// Blocks transfer-order/TR creation for a storage location while a Raw
// Material, Production, or Finished Goods stock count is active against
// that location — a stock movement mid-count would invalidate the count's
// quantity comparison. Deliberately scoped per storage location (not a
// global lock) and deliberately excludes PTFE_WEEKLY (small enough not to
// warrant blocking warehouse operations). See the approved Stock Count plan
// for the full rationale, and routes/stockcount.js's discrepancy-resolution
// endpoints for the one deliberate exemption (Finished Goods Count's own
// mass-move/manual-TO actions call SapServer directly, bypassing this guard,
// since they exist specifically to resolve findings from the very count that
// would otherwise block them).

import { findActiveCountForLocation } from '../routes/stockcountsql.js';

export class TransferBlockedError extends Error {
  constructor(activeCount) {
    super(
      `Transfers are blocked for storage location ${activeCount.StorageLocation ?? ''} while ` +
      `${activeCount.CountType} count #${activeCount.CountId} is active (status: ${activeCount.Status}).`
    );
    this.name = 'TransferBlockedError';
    this.activeCount = activeCount;
  }
}

// Throws TransferBlockedError if an active (Open/PendingApproval/Approved),
// non-PTFE_WEEKLY count exists for storageLocation. Silently no-ops (does
// not block) when storageLocation is missing — callers that can't determine
// a storage location for a given request (e.g. LT04, which has no
// StorageLocation field on its own payload) skip the check on old/unaware
// clients rather than failing closed.
export async function assertTransfersAllowed(storageLocation) {
  if (!storageLocation) return;
  const active = await findActiveCountForLocation(storageLocation);
  if (active) {
    throw new TransferBlockedError({ ...active, StorageLocation: storageLocation });
  }
}
