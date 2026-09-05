using System.Globalization;
using ClosedXML.Excel;
using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// MRP Analysis forecasting — Logistics Sub-phase 8b.5. Port of
/// routes/mrpanalysis.js's two forecast methods (Percentage: preview+save;
/// Sales Breakdown: products/export, forecast/bom/upload+save) + snapshot
/// history (forecast/runs, forecast/runs/:runId) + their performancesql.js
/// backing queries. Every forecast calculation is saved as an immutable,
/// dated snapshot in log.MrpForecastRun — never overwritten, so estimates
/// can be compared over time. Both methods follow the same preview-then-save
/// shape: a preview computes/returns the result without writing anything,
/// a separate save (fed the previewed data back) is what actually creates
/// the snapshot.
/// </summary>
internal static class MrpForecastHelper
{
    // ── Percentage method (pure math) ────────────────────────────────────

    private static bool IsLeapYear(int year) => (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;

    internal static int DaysInYear(int year) => IsLeapYear(year) ? 366 : 365;

    /// <summary>
    /// log.MaterialConsumptionHistory.ConsumedQty for the CURRENT (still in progress) calendar
    /// year is a year-to-date total, not a full year's. Applying "+X%" straight to that partial
    /// total would badly understate the following year's requirement (e.g. 8 months of data read
    /// as if it were the whole year) — only the current calendar year needs this; any other
    /// baseline year is already a complete, closed total.
    /// </summary>
    internal static decimal AnnualisationFactor(int baselineYear, DateTime now)
    {
        if (baselineYear != now.Year) return 1m;
        return (decimal)DaysInYear(now.Year) / Math.Max(now.DayOfYear, 1);
    }

    internal static (IReadOnlyList<PercentageForecastMaterialResult> Materials, bool IsPartialYearBaseline) ApplyPercentage(
        IReadOnlyList<ConsumptionByYearRow> consumptionRows, int baselineYear, decimal percentageChange, DateTime now)
    {
        var factor = 1 + percentageChange / 100m;
        var annualise = AnnualisationFactor(baselineYear, now);
        var isPartialYearBaseline = annualise != 1m;

        var materials = consumptionRows
            .Where(r => r.FiscalYear == baselineYear)
            .Select(r =>
            {
                var actualQty = r.ConsumedQty ?? 0m;
                var annualisedQty = actualQty * annualise;
                return new PercentageForecastMaterialResult(
                    r.Material, r.MaterialText,
                    Math.Round(actualQty, 3, MidpointRounding.AwayFromZero),
                    isPartialYearBaseline ? Math.Round(annualisedQty, 3, MidpointRounding.AwayFromZero) : null,
                    Math.Round(annualisedQty * factor, 3, MidpointRounding.AwayFromZero),
                    null);
            }).ToList();

        return (materials, isPartialYearBaseline);
    }

    internal static async Task<PercentageForecastPreviewResult> PreviewPercentageAsync(INexusOperationsDb db, PercentageForecastPreviewRequest body, CancellationToken ct)
    {
        if (body.BaselineYear is null) throw new NexusValidationException("baselineYear is required.");
        if (body.PercentageChange is null) throw new NexusValidationException("percentageChange is required.");

        var consumptionRows = await MrpAnalysisHelper.GetConsumptionByYearAsync(db, body.Materials, ct);
        var (materials, isPartialYearBaseline) = ApplyPercentage(consumptionRows, body.BaselineYear.Value, body.PercentageChange.Value, DateTime.UtcNow);

        return new PercentageForecastPreviewResult(body.BaselineYear.Value, body.PercentageChange.Value, isPartialYearBaseline, materials);
    }

    internal static async Task<CreateMrpForecastRunResult> SavePercentageAsync(INexusOperationsDb db, IAuditLogger audit, PercentageForecastSaveRequest body, string? createdBy, string? ipAddress, CancellationToken ct)
    {
        if (body.TargetYear is null) throw new NexusValidationException("targetYear is required.");
        if (body.Materials is not { Count: > 0 }) throw new NexusValidationException("No predicted materials to save — run a preview first.");

        var materialInputs = body.Materials.Select(m => new MrpForecastRunMaterialInput(m.Material, m.PredictedQty, m.Uom)).ToList();
        var runId = await CreateRunAsync(db, body.TargetYear.Value, "Percentage", body.BaselineYear, body.PercentageChange, createdBy, materialInputs, null, ct);

        await audit.LogAsync("MRP_FORECAST_SAVE", createdBy,
            $"Saved a Percentage MRP forecast for {body.TargetYear} ({body.Materials.Count} materials, run #{runId})", ipAddress, ct);

        return new CreateMrpForecastRunResult(runId);
    }

    // ── Sales Breakdown method ────────────────────────────────────────────

    /// <summary>Finished goods (SAP MaterialType 'FERT') at this plant, for the downloadable template — the operator only ever enters Expected Sales Units against something sellable; the raw materials it explodes down to are never part of this input list.</summary>
    internal static async Task<IReadOnlyList<MaterialForSalesExportRow>> ListMaterialsForSalesExportAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<MaterialForSalesExportRow>(new CommandDefinition("""
            SELECT Material, MaterialText, MaterialType, ProfitCentre, Uom
            FROM log.TurnsValClassSnapshot
            WHERE MaterialType = 'FERT'
            ORDER BY Material
            """, cancellationToken: ct));
        return rows.AsList();
    }

    // Column labels are the exact header text the upload side matches on (ReadCellText below) —
    // keep the two in sync if either changes.
    private static readonly string[] ExportColumns = ["Material", "Material Text", "Material Type", "Profit Centre", "Uom", "Expected Sales Units"];

    /// <summary>
    /// Every material Nexus tracks at this plant, plus a blank "Expected Sales Units" column for
    /// the operator to fill in offline. Styling mirrors Node's ExcelJS version (dark header band,
    /// alternating row shading, autofilter, frozen header row) but isn't pixel-verified against it
    /// — same "not pixel-perfect, can't visually confirm in this sandbox" caveat as every other
    /// generated-document Helper in this migration.
    /// </summary>
    internal static byte[] BuildSalesForecastTemplate(IReadOnlyList<MaterialForSalesExportRow> rows)
    {
        using var wb = new XLWorkbook();
        var ws = wb.Worksheets.Add("Data");

        for (var i = 0; i < ExportColumns.Length; i++)
        {
            var cell = ws.Cell(1, i + 1);
            cell.Value = ExportColumns[i];
            cell.Style.Fill.BackgroundColor = XLColor.FromArgb(0x1F, 0x38, 0x64);
            cell.Style.Font.FontColor = XLColor.White;
            cell.Style.Font.Bold = true;
            cell.Style.Font.FontName = "Arial";
            cell.Style.Font.FontSize = 10;
            cell.Style.Alignment.Vertical = XLAlignmentVerticalValues.Center;
            cell.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Left;
            cell.Style.Border.OutsideBorder = XLBorderStyleValues.Thin;
        }
        ws.Row(1).Height = 22;

        for (var i = 0; i < rows.Count; i++)
        {
            var r = rows[i];
            var rowNumber = i + 2;
            object?[] values = [r.Material, r.MaterialText, r.MaterialType, r.ProfitCentre, r.Uom, ""];
            var fill = i % 2 == 0 ? XLColor.FromArgb(0xE9, 0xEE, 0xF4) : XLColor.White;
            for (var c = 0; c < values.Length; c++)
            {
                var cell = ws.Cell(rowNumber, c + 1);
                cell.Value = values[c]?.ToString() ?? "";
                cell.Style.Fill.BackgroundColor = fill;
                cell.Style.Font.FontName = "Arial";
                cell.Style.Font.FontSize = 10;
                cell.Style.Border.OutsideBorder = XLBorderStyleValues.Thin;
            }
        }

        ws.Columns(1, ExportColumns.Length).AdjustToContents(1, rows.Count + 1);
        foreach (var col in ws.Columns(1, ExportColumns.Length))
        {
            if (col.Width > 52) col.Width = 52;
        }

        ws.RangeUsed()?.SetAutoFilter();
        ws.SheetView.FreezeRows(1);

        using var stream = new MemoryStream();
        wb.SaveAs(stream);
        return stream.ToArray();
    }

    private static string ReadCellText(IXLRow row, int colNumber)
    {
        if (colNumber <= 0) return "";
        var cell = row.Cell(colNumber);
        if (cell.IsEmpty()) return "";
        if (cell.DataType == XLDataType.DateTime) return cell.GetDateTime().ToString("yyyy-MM-dd");
        return cell.GetString().Trim();
    }

    /// <summary>Matched by header text (not column position) so the upload survives a reordered/re-saved copy of the template. Blank rows and raw-material rows the operator left blank are silently skipped, not treated as an error.</summary>
    private static (IReadOnlyList<BomUploadRowResult> Results, IReadOnlyList<BomUploadProduct> Products) ParseBomUploadWorkbook(byte[] fileBytes)
    {
        using var stream = new MemoryStream(fileBytes);
        using var wb = new XLWorkbook(stream);
        if (!wb.TryGetWorksheet("Data", out var ws))
            throw new NexusValidationException("This file has no \"Data\" sheet — is it a Sales Forecast Template export?");

        var headerMap = new Dictionary<string, int>();
        foreach (var cell in ws.Row(1).CellsUsed())
        {
            var text = cell.GetString().Trim();
            if (text.Length > 0) headerMap[text] = cell.Address.ColumnNumber;
        }

        var results = new List<BomUploadRowResult>();
        var products = new List<BomUploadProduct>();

        var lastRowNumber = ws.LastRowUsed()?.RowNumber() ?? 1;
        for (var rowNumber = 2; rowNumber <= lastRowNumber; rowNumber++)
        {
            var row = ws.Row(rowNumber);
            if (row.IsEmpty()) continue;

            var material = ReadCellText(row, headerMap.GetValueOrDefault("Material"));
            var salesText = ReadCellText(row, headerMap.GetValueOrDefault("Expected Sales Units"));
            if (material.Length == 0 || salesText.Length == 0) continue;

            if (!decimal.TryParse(salesText, NumberStyles.Number, CultureInfo.InvariantCulture, out var expectedSalesUnits) || expectedSalesUnits <= 0)
            {
                results.Add(new BomUploadRowResult(rowNumber, false, $"Invalid \"Expected Sales Units\" value \"{salesText}\" for material {material}."));
                continue;
            }

            products.Add(new BomUploadProduct(material, expectedSalesUnits));
            results.Add(new BomUploadRowResult(rowNumber, true, null));
        }

        return (results, products);
    }

    /// <summary>Explodes every uploaded product through SapServer's already-existing MrpAnalysisController.ExplodeBom (profit centre 2012) and returns a PREVIEW — nothing is saved here, see SaveBomForecastAsync.</summary>
    internal static async Task<BomUploadResult> UploadBomForecastAsync(ISapServerClient sap, int targetYear, byte[] fileBytes, int userId, CancellationToken ct)
    {
        if (targetYear <= 0) throw new NexusValidationException("targetYear query parameter is required.");
        if (fileBytes.Length == 0) throw new NexusValidationException("No file content received.");

        var (results, products) = ParseBomUploadWorkbook(fileBytes);
        if (products.Count == 0)
            throw new NexusValidationException("No rows had an \"Expected Sales Units\" value entered.");

        var sapRequest = new BomExplosionSapRequest(products.Select(p => new BomExplosionRequestItem(p.Material, p.ExpectedSalesUnits)).ToList());
        var sapResult = await sap.PostAsync<BomExplosionSapResponse>("api/mrp-analysis/explode-bom", sapRequest, userId, ct: ct);

        var succeeded = results.Count(r => r.Success);
        var rawMaterials = sapResult?.RawMaterials.Select(r => new BomUploadRawMaterial(r.Material, r.Quantity, r.Uom)).ToList() ?? [];
        var unresolved = sapResult?.Unresolved ?? [];

        return new BomUploadResult(targetYear, results.Count, succeeded, results.Count - succeeded, results, products, rawMaterials, unresolved);
    }

    internal static async Task<CreateMrpForecastRunResult> SaveBomForecastAsync(INexusOperationsDb db, IAuditLogger audit, BomForecastSaveRequest body, string? createdBy, string? ipAddress, CancellationToken ct)
    {
        if (body.TargetYear is null) throw new NexusValidationException("targetYear is required.");
        if (body.RawMaterials is not { Count: > 0 }) throw new NexusValidationException("No raw materials to save — run an upload/calculate first.");

        var materialInputs = body.RawMaterials.Select(r => new MrpForecastRunMaterialInput(r.Material, r.Quantity, r.Uom)).ToList();
        var runId = await CreateRunAsync(db, body.TargetYear.Value, "BomBreakdown", null, null, createdBy, materialInputs, body.Products ?? [], ct);

        await audit.LogAsync("MRP_FORECAST_SAVE", createdBy,
            $"Saved a Sales Breakdown MRP forecast for {body.TargetYear} ({body.RawMaterials.Count} raw materials, run #{runId})", ipAddress, ct);

        return new CreateMrpForecastRunResult(runId);
    }

    // ── Shared: create the immutable run snapshot + child rows ───────────

    private static async Task<long> CreateRunAsync(
        INexusOperationsDb db, int targetYear, string method, int? baselineYear, decimal? percentageChange, string? createdBy,
        IReadOnlyList<MrpForecastRunMaterialInput> materials, IReadOnlyList<BomUploadProduct>? products, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var runId = await connection.QuerySingleAsync<long>(new CommandDefinition("""
            INSERT INTO log.MrpForecastRun (TargetYear, Method, BaselineYear, PercentageChange, CreatedBy)
            OUTPUT INSERTED.RunId
            VALUES (@targetYear, @method, @baselineYear, @percentageChange, @createdBy)
            """, new { targetYear, method, baselineYear, percentageChange, createdBy }, cancellationToken: ct));

        if (materials.Count > 0)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "INSERT INTO log.MrpForecastRunMaterial (RunId, Material, PredictedQty, Uom) VALUES (@runId, @Material, @PredictedQty, @Uom)",
                materials.Select(m => new { runId, m.Material, m.PredictedQty, m.Uom }), cancellationToken: ct));
        }

        if (products is { Count: > 0 })
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "INSERT INTO log.MrpForecastRunProduct (RunId, Material, ExpectedSalesUnits) VALUES (@runId, @Material, @ExpectedSalesUnits)",
                products.Select(p => new { runId, p.Material, p.ExpectedSalesUnits }), cancellationToken: ct));
        }

        return runId;
    }

    // ── Snapshot history ──────────────────────────────────────────────────

    internal static async Task<IReadOnlyList<MrpForecastRunSummaryRow>> ListRunsAsync(INexusOperationsDb db, int? targetYear, CancellationToken ct)
    {
        var whereSql = targetYear.HasValue ? "WHERE TargetYear = @targetYear" : "";
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<MrpForecastRunSummaryRow>(new CommandDefinition($"""
            SELECT RunId, TargetYear, Method, BaselineYear, PercentageChange, CreatedBy, CreatedAtUtc
            FROM log.MrpForecastRun
            {whereSql}
            ORDER BY CreatedAtUtc DESC
            """, new { targetYear }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<MrpForecastRunDetail?> GetRunDetailAsync(INexusOperationsDb db, long runId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var run = await connection.QuerySingleOrDefaultAsync<MrpForecastRunSummaryRow?>(new CommandDefinition(
            "SELECT RunId, TargetYear, Method, BaselineYear, PercentageChange, CreatedBy, CreatedAtUtc FROM log.MrpForecastRun WHERE RunId = @runId",
            new { runId }, cancellationToken: ct));
        if (run is null) return null;

        var materials = await connection.QueryAsync<MrpForecastRunMaterialRow>(new CommandDefinition("""
            SELECT m.Material, t.MaterialText, m.PredictedQty, m.Uom
            FROM log.MrpForecastRunMaterial m
            LEFT JOIN log.TurnsValClassSnapshot t ON t.Material = m.Material
            WHERE m.RunId = @runId
            ORDER BY m.Material
            """, new { runId }, cancellationToken: ct));

        var products = await connection.QueryAsync<MrpForecastRunProductRow>(new CommandDefinition("""
            SELECT p.Material, t.MaterialText, p.ExpectedSalesUnits
            FROM log.MrpForecastRunProduct p
            LEFT JOIN log.TurnsValClassSnapshot t ON t.Material = p.Material
            WHERE p.RunId = @runId
            ORDER BY p.Material
            """, new { runId }, cancellationToken: ct));

        return new MrpForecastRunDetail(run.RunId, run.TargetYear, run.Method, run.BaselineYear, run.PercentageChange, run.CreatedBy, run.CreatedAtUtc, materials.AsList(), products.AsList());
    }
}
