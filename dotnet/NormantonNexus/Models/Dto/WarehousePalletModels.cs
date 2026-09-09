namespace NormantonNexus.Models.Dto;

// Pallet Builder — port of routes/palletmain.js and routes/palletpackages.js.
// Sub-phase 7b. sapStaging.js's shared reverseStagedPackage is ported
// alongside these (see WarehouseSapModels.cs's PicksheetUnstageBatchRequest/
// Response and SapStagingHelper) since both files depend on it for their
// own delete/remove actions.

// ── Pallet header (log.PalletMain) ──────────────────────────────────────

public sealed record PalletMainRow(
    int PalletId, string? PalletType, bool PalletFinish, decimal? PackagingWeight, decimal? GrossWeight,
    decimal? PalletVolume, int? PalletLength, int? PalletWidth, int? PalletHeight, bool PalletRemoved,
    string? PalletCategory, string? PalletLocation, DateTime? PalletCreationDate, DateTime? PalletFinishDate);

public sealed record CreatePalletRequest(
    string? PalletType, bool? PalletFinish, decimal? PackagingWeight, decimal? GrossWeight,
    decimal? PalletVolume, int? PalletLength, int? PalletWidth, int? PalletHeight, bool? PalletRemoved,
    string? PalletCategory, string? PalletLocation, DateTime? PalletCreationDate, DateTime? PalletFinishDate);

public sealed record CreatePalletResult(int PalletId);

/// <summary>
/// Every field is optional and only touches the column when non-null
/// (COALESCE(@x, column)) — a client omitting a key and a client sending
/// an explicit JSON null land in the same C# null and are treated
/// identically ("leave this column alone"), a small, deliberate
/// simplification over Node's own `!== undefined` presence check (which
/// would let an explicit `null` attempt to null out a NOT NULL column —
/// an edge case with no real caller and no reason to preserve).
/// </summary>
public sealed record UpdatePalletRequest(
    bool? PalletFinish, string? PalletLocation, string? PalletCategory, decimal? GrossWeight, decimal? PackagingWeight,
    decimal? PalletVolume, bool? PalletRemoved, string? PalletType, int? PalletLength, int? PalletWidth, int? PalletHeight);

/// <summary>One package that couldn't have its SAP staging reversed when its pallet was being removed — the pallet is NOT marked removed while any of these remain (see PalletMainHelper.UpdateAsync).</summary>
public sealed record PalletRemovalFailure(int PalletItemId, string? SapMaterial, string? SapBatch, string? Error);

/// <summary>Success is false only for the SAP-reversal-blocked case (422) — every other outcome (including a plain field update) is Success:true with Failures null.</summary>
public sealed record PalletUpdateResult(bool Success, string? Error, List<PalletRemovalFailure>? Failures);

// ── Pallet line items (log.PalletPackages) ──────────────────────────────

public sealed record PalletPackageRow(
    int PalletItemId, int PalletId, string? PackagingId, int? PalletLayer,
    string? SapMaterial, decimal? SapQuantity, string? SapBatch, string? SapDelivery, string? SapDeliveryItem,
    string? SapCustomer, string? SapCustomerMaterial, DateTime? ScanTime,
    string? SapSourceStorageType, string? SapSourceBin, string? SapStageTransferOrder, string? SapPackagingInstruction,
    string? PackDescription, string? PackMaterial, decimal? PackWeight, int? PackHeight);

public sealed record CreatePalletPackageRequest(
    int PalletId, string? PackagingId, int? PalletLayer, string? SapMaterial,
    decimal? SapQuantity, string? SapBatch, string? SapDelivery, string? SapDeliveryItem,
    string? SapCustomer, string? SapCustomerMaterial, DateTime? ScanTime,
    string? SapSourceStorageType, string? SapSourceBin, string? SapStageTransferOrder, string? SapPackagingInstruction);

public sealed record CreatePalletPackageResult(int PalletItemId);

/// <summary>Both fields optional, but at least one must be provided — moving a package to a different layer, or correcting its packaging type, in place instead of a remove-then-re-add (which for a staged batch would mean reversing and re-running a real SAP transfer order just to fix a layer number).</summary>
public sealed record UpdatePalletPackageRequest(int? PalletLayer, string? PackagingId);
