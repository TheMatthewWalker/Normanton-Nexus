namespace NormantonNexus.Models.Dto;

// Network printer selection + server-side print — port of the /printers,
// /printers/default, and POST /process/:pc/:id/print routes in
// routes/labels.js.

public sealed record PrinterSummary(string Id, string Name);

public sealed record PrintersListResult(IReadOnlyList<PrinterSummary> Printers, string? UserDefault);

public sealed record SetDefaultPrinterRequest(string? PrinterId);

public sealed record PrintLabelRequest(string? PrinterId, int? Tub);

public sealed record PrintLabelResult(string Message);
