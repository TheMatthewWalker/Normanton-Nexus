namespace NormantonNexus.Models.Dto;

// Warehouse master data — port of routes/palletdata.js, packagingdata.js,
// and palletvalidation.js. Genuinely shared between Warehouse (the pallet
// builder) and Logistics (an admin "Update Pallet/Packaging Data" screen)
// — confirmed via frontend grep, both private/js/warehouse.js and
// private/js/logistics.js call these same three Node files directly.
// Node mounts all three at their own top-level path with no department
// gate at all (requireLogin only, in server.js) — this port keeps that
// exactly (no Dept:warehouse policy added), since tightening it the way
// Production's report pages were tightened would incorrectly lock out
// Logistics users before that department exists in this migration.
//
// Only the routes with a confirmed live frontend caller are ported —
// GET /id/:id (palletdata/packagingdata), GET /packaging/:id and the bare
// GET / (palletvalidation), and every POST (create) on all three files
// have zero callers anywhere in private/ and are left unported, same
// "confirmed dead code, don't port" precedent as Production's
// /drumming/entry and deliverylink.js.

public sealed record PalletDataRow(string PalletId, string? PalletDescription, decimal? PalletWeight, int? PalletLength, int? PalletWidth, int? PalletHeight);

public sealed record UpdatePalletDataRequest(string? PalletDescription, decimal? PalletWeight, int? PalletLength, int? PalletWidth, int? PalletHeight);

public sealed record PackagingDataRow(string PackId, string? PackMaterial, string? PackDescription, decimal? PackWeight, int? PackLength, int? PackWidth, int? PackHeight);

public sealed record UpdatePackagingDataRequest(string? PackDescription, string? PackMaterial, decimal? PackWeight, int? PackLength, int? PackWidth, int? PackHeight);

/// <summary>packagingID in log.PalletValidation is NVARCHAR(2) = PackagingData.packID — the join target, not a separate ID space.</summary>
public sealed record PalletValidationRow(string PalletId, string PackagingId, string? PackMaterial, string? PackDescription, decimal? PackWeight, int? PackLength, int? PackWidth, int? PackHeight);
