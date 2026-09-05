namespace NormantonNexus.Models.Dto;

// ── Phase 10 cross-cutting closeout: Warehouse hourly SAP sync ────────────
// Port of routes/deliverymain.js's runSapSync — discovered missing while
// wiring Quartz.NET jobs (Node runs this hourly at xx:55). Pulls SAP's open
// picksheets, auto-creates any log.Destinations row SAP knows about that
// this app doesn't yet, inserts new log.DeliveryMain rows, and reconciles
// deliveries completed outside Nexus (moved to Packaging Holding).

/// <summary>SapServer's GET /api/logistics/picksheets/open response row (LogisticsController/PicksheetRow) — field-for-field.</summary>
public sealed record SapPicksheetRow(string DeliveryNumber, string CustomerNumber, string DispatchDate, string DeliveryDate, string Incoterms);

public sealed record SapSyncErrorRow(string DeliveryNumber, string Error);

public sealed record SapSyncMissingRow(string DeliveryNumber, string CustomerNumber);

public sealed record SapSyncAutoCreatedRow(string CustomerNumber, string DestinationName, bool NeedsReview);

public sealed record SapSyncResult(
    int Total, int Inserted, int Skipped,
    IReadOnlyList<SapSyncErrorRow> Errors, IReadOnlyList<SapSyncMissingRow> Missing,
    IReadOnlyList<SapSyncAutoCreatedRow> AutoCreated, string? Kna1Error,
    IReadOnlyList<long> MovedToHolding);
