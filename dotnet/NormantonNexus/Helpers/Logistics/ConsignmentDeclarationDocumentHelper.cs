using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Declaration PDF route orchestration — Logistics Sub-phase 8e.2. Port of
/// routes/consignment.js's GET /declarations/:id/pdf: gathers the
/// declaration, its vendor, and the per-material stock summary (Starting
/// Stock/Deliveries since that material's previous Confirmed declaration —
/// Consumption/Ending Stock are derived here from the declaration's own
/// lines rather than re-queried, since QtyAllocated is already known), then
/// hands it all to ConsignmentDeclarationPdfHelper. Works for a Draft
/// (preview before confirming) or a Confirmed declaration alike.
/// </summary>
internal static class ConsignmentDeclarationDocumentHelper
{
    internal static async Task<byte[]> GeneratePdfAsync(INexusOperationsDb db, long declarationId, CancellationToken ct)
    {
        var declaration = await ConsignmentTrackerHelper.GetDeclarationAsync(db, declarationId, ct)
            ?? throw new NexusNotFoundException("Declaration not found.");
        var vendor = await ConsignmentTrackerHelper.GetVendorAsync(db, declaration.Header.VendorId, ct);

        var materials = declaration.Lines.Select(l => l.Material).Distinct().ToList();
        var stockSummary = await ConsignmentTrackerHelper.GetDeclarationStockSummaryAsync(db, declaration.Header.VendorId, declarationId, materials, ct);

        var materialSummaries = materials.Select(material =>
        {
            var consumption = declaration.Lines.Where(l => l.Material == material).Sum(l => l.QtyAllocated);
            var (startingStock, deliveries) = stockSummary.GetValueOrDefault(material, (0m, 0m));
            return new DeclarationMaterialSummary(material, startingStock, deliveries, consumption, startingStock - consumption);
        }).ToList();

        return ConsignmentDeclarationPdfHelper.Build(new ConsignmentDeclarationPdfHelper.Input(
            DeclarationId: declaration.Header.DeclarationId, VendorName: declaration.Header.VendorName, SapVendorNumber: vendor?.SapVendorNumber,
            Status: declaration.Header.Status, AllocationMethod: declaration.Header.AllocationMethod, TotalQty: declaration.Header.TotalQty,
            CreatedAtUtc: declaration.Header.CreatedAtUtc, SettlementDocumentNumber: declaration.Header.SettlementDocumentNumber,
            MaterialSummaries: materialSummaries, Lines: declaration.Lines));
    }
}
