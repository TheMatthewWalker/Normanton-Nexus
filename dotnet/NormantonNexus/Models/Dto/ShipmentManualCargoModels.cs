namespace NormantonNexus.Models.Dto;

// Logistics Sub-phase 8a.2 — Manual Outbound Shipment cargo lines +
// create-folder. documents/folder, documents/:fileName and
// documents/upload were originally proposed for this slice too, but
// documents/folder calls into Node's generateShipmentDocuments (PDF
// regeneration) to guarantee the packing list is current before listing
// the folder — genuinely PDF-generation-slice (8a.3) territory, not
// filesystem-only work, so those three routes moved there instead. See
// dotnet/CLAUDE.md's Phase 8 section for the reasoning.

public sealed record ManualCargoItemRow(
    int CargoId, long ShipmentId, string? Description, int PackageCount, decimal Weight,
    decimal? Length, decimal? Width, decimal? Height, decimal? Volume, DateTime CreatedAtUtc, string? CreatedBy);

public sealed record CreateManualCargoItemRequest(string? Description, int? PackageCount, decimal Weight, decimal? Length, decimal? Width, decimal? Height);

/// <summary>A null field means "leave unchanged" — same deliberate simplification as Warehouse's UpdatePalletRequest (collapsing "field omitted" and "field explicitly null" into one behavior), since a plain nullable C# property can't distinguish the two the way Node's `!== undefined` check can. The one real capability this loses: Node lets an operator explicitly clear Length/Width/Height back to blank on an edit; this port can't represent "clear it" separately from "leave it alone" without a wrapper type. Flagged, not silently dropped — see ShipmentManualCargoHelper.UpdateAsync's own doc comment.</summary>
public sealed record UpdateManualCargoItemRequest(string? Description, int? PackageCount, decimal? Weight, decimal? Length, decimal? Width, decimal? Height);

public sealed record CreateShipmentFolderResult(string ShipmentRef, string FolderPath);
