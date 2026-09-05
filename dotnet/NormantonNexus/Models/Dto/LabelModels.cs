namespace NormantonNexus.Models.Dto;

// Production label preview — port of the fetch/render side of
// routes/labels.js (fetchLabelData/fetchMixingTicketsData/buildHTML).
// Server-side PDF generation + raw-TCP network printing
// (buildPDF/tcpPrint/POST .../print) is a separate, not-yet-built slice —
// see dotnet/CLAUDE.md's Phase 6 notes for the scope split and why.

public sealed record LabelOperatorRow(bool IsPrimary, string? Username, string? DisplayName);

public sealed record LabelData(
    string ProcessCode, string ProcessName, string BatchRef, int Status,
    string Material, string? Machine, IReadOnlyList<LabelOperatorRow> Operators,
    DateTime? CreatedAt, DateTime? CompletedAt, decimal? Quantity, string Uom,
    IReadOnlyList<string> ParentBatches, string? SapMatDoc, string? Notes,
    string? SupplierBatchNo, string? SupplierTubNo);
