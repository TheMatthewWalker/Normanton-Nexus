namespace NormantonNexus.Models.Dto;

// Sales department — Customer Standard Instructions (SQL-only) + Schedule
// Agreement Waterfall (proxies to SapServer's own SalesController). Ported
// from routes/sales.js + routes/salessap.js.

public sealed record CustomerInstructionRow(string Customer, string? CustomerName, string Instructions, DateTime LastUpdatedUtc, string? UpdatedByUsername);

public sealed record CustomerInstructionSaveRequest(string? CustomerName, string Instructions);

public sealed record BulkImportCustomerInstructionRow(string Customer, string? CustomerName, string Instructions);

public sealed record BulkImportCustomerInstructionsRequest(List<BulkImportCustomerInstructionRow> Rows);

public sealed record BulkImportFailure(string Customer, string Error);

public sealed record BulkImportResult(int Created, int Updated, List<BulkImportFailure> Failed);

/// <summary>Query params for GET /schedule-waterfall — mirrors routes/sales.js's own query validation exactly (all four base fields required).</summary>
public sealed record ScheduleWaterfallQuery(
    string? SalesOrg, List<string>? ShipToParties, string? ScheduleDateFrom, string? ScheduleDateTo,
    List<string>? Materials, bool IncludeForecast = true, bool IncludeJit = true,
    string? IdocCreatedAfter = null, bool IncludeZeroQty = false);

/// <summary>POST body sent on to SapServer's SalesController.ScheduleWaterfall — mirrors SapServer/Models/Bapi/SalesModels.cs's ScheduleWaterfallRequest field-for-field.</summary>
public sealed record ScheduleWaterfallRequest(
    string SalesOrg, List<string> ShipToParties, List<string> Materials,
    bool IncludeForecast, bool IncludeJit, DateTime? IdocCreatedAfter,
    DateTime ScheduleDateFrom, DateTime ScheduleDateTo, bool IncludeZeroQty);

/// <summary>Mirrors SapServer's ScheduleWaterfallRow exactly.</summary>
public sealed record ScheduleWaterfallRow(
    string ShipToParty, string SalesDocument, string SalesDocItem, string Material, string MaterialDescription,
    string IdocNumber, decimal CumQty, DateTime? IdocCreationDate, string EntryTime, DateTime? ScheduleLineDate,
    decimal OrderQty, string SalesOrg, string ReleaseType, string LastDel, int ScheduleWeek, int IdocWeek,
    bool IsCurrent, decimal CumulativeRelease);
