using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Warehouse;

/// <summary>Pallet line-item CRUD — port of routes/palletpackages.js. Only GET pallet/:id, POST, PATCH, and DELETE have a confirmed live frontend caller (see dotnet/CLAUDE.md's Sub-phase 7b notes) — the bare GET /, GET /id/:id, GET /sapdelivery/:id, and GET /sapmaterial/:id are not ported.</summary>
internal static class PalletPackagesHelper
{
    /// <summary>packagingID is NVARCHAR(2) matching PackagingData.packID — joined here for descriptions the builder's package list displays.</summary>
    internal static async Task<IReadOnlyList<PalletPackageRow>> GetByPalletAsync(INexusOperationsDb db, int palletId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<PalletPackageRow>(new CommandDefinition("""
            SELECT pp.palletItemID AS PalletItemId, pp.palletID AS PalletId, pp.packagingID AS PackagingId, pp.palletLayer AS PalletLayer,
                   pp.sapMaterial AS SapMaterial, pp.sapQuantity AS SapQuantity, pp.sapBatch AS SapBatch,
                   pp.sapDelivery AS SapDelivery, pp.sapDeliveryItem AS SapDeliveryItem,
                   pp.sapCustomer AS SapCustomer, pp.sapCustomerMaterial AS SapCustomerMaterial, pp.scanTime AS ScanTime,
                   pp.sapSourceStorageType AS SapSourceStorageType, pp.sapSourceBin AS SapSourceBin, pp.sapStageTransferOrder AS SapStageTransferOrder,
                   pp.sapPackagingInstruction AS SapPackagingInstruction,
                   pd.packDescription AS PackDescription, pd.packMaterial AS PackMaterial, pd.packWeight AS PackWeight, pd.packHeight AS PackHeight
            FROM log.PalletPackages pp
            LEFT JOIN log.PackagingData pd ON pd.packID = pp.packagingID
            WHERE pp.palletID = @palletId
            ORDER BY pp.palletLayer, pp.palletItemID
            """, new { palletId }, cancellationToken: ct));
        return rows.ToArray();
    }

    /// <summary>
    /// palletItemID is IDENTITY — assigned by SQL Server, read back via
    /// SCOPE_IDENTITY(). sapSourceStorageType/sapSourceBin record where a
    /// staged batch's stock came from (its LGTYP/LGPLA before the
    /// picksheet-stage-batch transfer order moved it into the picksheet's
    /// 916 bin) — required so DeleteAsync can reverse the transfer order
    /// and put the stock back where it was. sapPackagingInstruction is the
    /// batch's raw SAP packaging instruction (ZPRODBATCH~PALL_MATNR),
    /// captured here so the delivery-complete ZDELFLAG/ZDELPACK
    /// maintenance step (Sub-phase 7c) can later look up its ZBOM_INFO
    /// packaging materials without re-querying SAP for the batch's stock row.
    /// </summary>
    internal static async Task<CreatePalletPackageResult> CreateAsync(INexusOperationsDb db, CreatePalletPackageRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var palletItemId = await connection.QuerySingleAsync<int>(new CommandDefinition("""
            INSERT INTO log.PalletPackages
                (palletID, packagingID, palletLayer, sapMaterial,
                 sapQuantity, sapBatch, sapDelivery, sapDeliveryItem,
                 sapCustomer, sapCustomerMaterial, scanTime,
                 sapSourceStorageType, sapSourceBin, sapStageTransferOrder,
                 sapPackagingInstruction)
            VALUES
                (@palletId, @packagingId, @palletLayer, @sapMaterial,
                 @sapQuantity, @sapBatch, @sapDelivery, @sapDeliveryItem,
                 @sapCustomer, @sapCustomerMaterial, @scanTime,
                 @sapSourceStorageType, @sapSourceBin, @sapStageTransferOrder,
                 @sapPackagingInstruction);
            SELECT CAST(SCOPE_IDENTITY() AS INT);
            """, new
        {
            palletId = body.PalletId,
            packagingId = body.PackagingId,
            palletLayer = body.PalletLayer,
            sapMaterial = body.SapMaterial,
            sapQuantity = body.SapQuantity,
            sapBatch = body.SapBatch,
            sapDelivery = body.SapDelivery,
            sapDeliveryItem = body.SapDeliveryItem,
            sapCustomer = body.SapCustomer,
            sapCustomerMaterial = body.SapCustomerMaterial,
            scanTime = body.ScanTime,
            sapSourceStorageType = body.SapSourceStorageType,
            sapSourceBin = body.SapSourceBin,
            sapStageTransferOrder = body.SapStageTransferOrder,
            sapPackagingInstruction = body.SapPackagingInstruction
        }, cancellationToken: ct));

        return new CreatePalletPackageResult(palletItemId);
    }

    /// <summary>Lets the builder move a package to a different layer, or change its packaging type (e.g. a batch scanned with the wrong code), in place instead of requiring a remove-then-re-add — which for a staged batch would mean reversing and re-running a real SAP transfer order just to fix a layer number or packaging type. Batch/material/SAP staging fields are still remove + re-add only, since those affect the actual SAP transfer order.</summary>
    internal static async Task UpdateAsync(INexusOperationsDb db, int palletItemId, UpdatePalletPackageRequest body, CancellationToken ct)
    {
        if (body.PalletLayer is null && body.PackagingId is null)
        {
            throw new NexusValidationException("Provide palletLayer and/or packagingID");
        }
        if (body.PalletLayer is not null && body.PalletLayer < 1)
        {
            throw new NexusValidationException("palletLayer must be a positive integer");
        }
        if (body.PackagingId is not null && body.PackagingId.Trim().Length == 0)
        {
            throw new NexusValidationException("packagingID must not be empty");
        }

        using var connection = await db.CreateConnectionAsync(ct);
        var rowsAffected = await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.PalletPackages SET
                palletLayer = COALESCE(@palletLayer, palletLayer),
                packagingID = COALESCE(@packagingId, packagingID)
            WHERE palletItemID = @palletItemId
            """, new { palletItemId, palletLayer = body.PalletLayer, packagingId = body.PackagingId?.Trim() }, cancellationToken: ct));

        if (rowsAffected == 0)
        {
            throw new NexusNotFoundException("Package not found");
        }
    }

    /// <summary>
    /// If this package was staged in SAP, reverses the picksheet-stage-batch
    /// transfer order first — moving the batch's stock back out of the
    /// picksheet's 916 bin to wherever it came from — before deleting the
    /// DB row. Deliberately fails closed, same reasoning as pallet removal:
    /// if SAP rejects the reversal, the row is NOT deleted, so the app and
    /// physical/SAP reality can't end up disagreeing about where the stock
    /// is. A package that was never staged (no SAP fields recorded) just
    /// deletes straight away.
    /// </summary>
    internal static async Task DeleteAsync(INexusOperationsDb db, ISapServerClient sap, int palletItemId, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var row = await connection.QuerySingleOrDefaultAsync<StagedPackageInfo>(new CommandDefinition("""
            SELECT palletItemID AS PalletItemId, sapMaterial AS SapMaterial, sapBatch AS SapBatch, sapDelivery AS SapDelivery,
                   sapSourceStorageType AS SapSourceStorageType, sapSourceBin AS SapSourceBin
            FROM log.PalletPackages WHERE palletItemID = @palletItemId
            """, new { palletItemId }, cancellationToken: ct));

        var reversal = await SapStagingHelper.ReverseStagedPackageAsync(sap, row, userId, ct);
        if (reversal.Attempted && !reversal.Success)
        {
            throw new NexusUnprocessableEntityException($"{reversal.Error} — package was not removed");
        }

        await connection.ExecuteAsync(new CommandDefinition(
            "DELETE FROM log.PalletPackages WHERE palletItemID = @palletItemId", new { palletItemId }, cancellationToken: ct));
    }
}
