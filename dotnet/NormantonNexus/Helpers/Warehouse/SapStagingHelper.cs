using NormantonNexus.Models.Dto;
using NormantonNexus.Services;

namespace NormantonNexus.Helpers.Warehouse;

/// <summary>
/// Port of routes/sapStaging.js's reverseStagedPackage — reverses a
/// picksheet-stage-batch transfer order for one log.PalletPackages row,
/// moving its batch's stock back out of the picksheet's 916 bin to
/// wherever it came from. Shared by PalletPackagesHelper (single package
/// delete) and PalletMainHelper (pallet delete — reverses every one of
/// its packages). See SapServer's WarehouseController.PicksheetUnstageBatch
/// for the actual SAP-side logic (fresh LQUA re-query, "nothing to
/// reverse" if the batch is no longer sitting in the 916 bin).
/// </summary>
internal static class SapStagingHelper
{
    /// <summary>
    /// Mirrors Node's reverseStagedPackage exactly: SapServerClient's
    /// PostAsync already throws (a NexusApiException wrapping the real
    /// error) whenever SapServer's own ApiResponse envelope reports
    /// success:false — the 422 case for a genuine SAP-rejected reversal —
    /// which this catches and converts into the graceful Attempted:true/
    /// Success:false result the caller needs to keep processing the rest
    /// of a multi-package removal instead of aborting outright.
    /// </summary>
    internal static async Task<StagedPackageReversalResult> ReverseStagedPackageAsync(ISapServerClient sap, StagedPackageInfo? row, int userId, CancellationToken ct)
    {
        if (row is null || string.IsNullOrEmpty(row.SapMaterial) || string.IsNullOrEmpty(row.SapBatch) || string.IsNullOrEmpty(row.SapDelivery)
            || string.IsNullOrEmpty(row.SapSourceStorageType) || string.IsNullOrEmpty(row.SapSourceBin))
        {
            return new StagedPackageReversalResult(false, true, null);
        }

        var stagedBin = row.SapDelivery.Trim().PadLeft(10, '0');

        try
        {
            await sap.PostAsync<SapPicksheetUnstageBatchResponse>("api/warehouse/picksheet-unstage-batch",
                new SapPicksheetUnstageBatchRequest(row.SapMaterial, row.SapBatch, stagedBin, row.SapSourceStorageType, row.SapSourceBin), userId, ct: ct);
            return new StagedPackageReversalResult(true, true, null);
        }
        catch (Exception err)
        {
            return new StagedPackageReversalResult(true, false, err.Message);
        }
    }
}
