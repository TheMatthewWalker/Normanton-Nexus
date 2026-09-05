using ClosedXML.Excel;
using Moq;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class MrpForecastHelperTests
{
    private static DateTime Utc(int y, int m, int d) => new(y, m, d, 0, 0, 0, DateTimeKind.Utc);

    // ── AnnualisationFactor / DaysInYear ─────────────────────────────────

    [Fact]
    public void DaysInYear_returns_366_for_a_leap_year()
    {
        Assert.Equal(366, MrpForecastHelper.DaysInYear(2028));
        Assert.Equal(365, MrpForecastHelper.DaysInYear(2026));
    }

    [Fact]
    public void DaysInYear_treats_a_century_year_not_divisible_by_400_as_non_leap()
    {
        Assert.Equal(365, MrpForecastHelper.DaysInYear(2100));
        Assert.Equal(366, MrpForecastHelper.DaysInYear(2000));
    }

    [Fact]
    public void AnnualisationFactor_returns_1_for_a_baseline_year_other_than_the_current_one()
    {
        Assert.Equal(1m, MrpForecastHelper.AnnualisationFactor(2025, Utc(2026, 6, 15)));
    }

    [Fact]
    public void AnnualisationFactor_scales_up_a_partial_current_year()
    {
        // Halfway through a 365-day year (day 183ish) -> factor should be roughly 2x.
        var factor = MrpForecastHelper.AnnualisationFactor(2026, Utc(2026, 7, 2)); // day 183 of 365
        Assert.True(factor > 1.9m && factor < 2.1m);
    }

    [Fact]
    public void AnnualisationFactor_returns_exactly_1_on_the_last_day_of_the_year()
    {
        var factor = MrpForecastHelper.AnnualisationFactor(2026, Utc(2026, 12, 31));
        Assert.Equal(1m, factor);
    }

    // ── ApplyPercentage ───────────────────────────────────────────────────

    private static ConsumptionByYearRow Row(string material, int year, decimal qty, string? materialText = "Material One") =>
        new(material, materialText, year, qty);

    [Fact]
    public void ApplyPercentage_filters_to_only_the_baseline_year()
    {
        var rows = new[] { Row("MAT1", 2025, 1000m), Row("MAT1", 2024, 500m) };

        var (materials, _) = MrpForecastHelper.ApplyPercentage(rows, 2025, 10m, Utc(2026, 1, 1));

        var m = Assert.Single(materials);
        Assert.Equal(1000m, m.ActualQty);
    }

    [Fact]
    public void ApplyPercentage_applies_the_percentage_increase_for_a_closed_baseline_year()
    {
        var rows = new[] { Row("MAT1", 2025, 1000m) };

        var (materials, isPartialYearBaseline) = MrpForecastHelper.ApplyPercentage(rows, 2025, 10m, Utc(2026, 6, 1));

        Assert.False(isPartialYearBaseline);
        Assert.Null(materials[0].AnnualisedQty);
        Assert.Equal(1100m, materials[0].PredictedQty);
    }

    [Fact]
    public void ApplyPercentage_annualises_a_partial_current_year_baseline_before_applying_the_percentage()
    {
        // Baseline year IS the current year -> ConsumedQty is a year-to-date partial total.
        var rows = new[] { Row("MAT1", 2026, 500m) };
        var now = Utc(2026, 7, 2); // day 183 of 365, factor ~1.9945

        var (materials, isPartialYearBaseline) = MrpForecastHelper.ApplyPercentage(rows, 2026, 0m, now);

        Assert.True(isPartialYearBaseline);
        Assert.NotNull(materials[0].AnnualisedQty);
        Assert.True(materials[0].AnnualisedQty > 990m && materials[0].AnnualisedQty < 1000m);
        Assert.Equal(materials[0].AnnualisedQty, materials[0].PredictedQty);
    }

    [Fact]
    public void ApplyPercentage_treats_a_negative_percentage_as_a_reduction()
    {
        var rows = new[] { Row("MAT1", 2025, 1000m) };

        var (materials, _) = MrpForecastHelper.ApplyPercentage(rows, 2025, -20m, Utc(2026, 1, 1));

        Assert.Equal(800m, materials[0].PredictedQty);
    }

    [Fact]
    public void ApplyPercentage_uom_field_is_always_null()
    {
        var rows = new[] { Row("MAT1", 2025, 1000m) };

        var (materials, _) = MrpForecastHelper.ApplyPercentage(rows, 2025, 0m, Utc(2026, 1, 1));

        Assert.Null(materials[0].Uom);
    }

    // ── PreviewPercentageAsync validation ─────────────────────────────────

    [Fact]
    public async Task PreviewPercentageAsync_rejects_a_missing_baselineYear()
    {
        var db = new Mock<NormantonNexus.Services.Sql.INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>())).ThrowsAsync(new InvalidOperationException("should not be called"));

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MrpForecastHelper.PreviewPercentageAsync(db.Object, new PercentageForecastPreviewRequest(null, 10m, null), CancellationToken.None));
    }

    [Fact]
    public async Task PreviewPercentageAsync_rejects_a_missing_percentageChange()
    {
        var db = new Mock<NormantonNexus.Services.Sql.INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>())).ThrowsAsync(new InvalidOperationException("should not be called"));

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MrpForecastHelper.PreviewPercentageAsync(db.Object, new PercentageForecastPreviewRequest(2025, null, null), CancellationToken.None));
    }

    // ── BuildSalesForecastTemplate (Excel export) ─────────────────────────

    [Fact]
    public void BuildSalesForecastTemplate_produces_a_readable_workbook_with_a_Data_sheet_and_header_row()
    {
        var rows = new[] { new MaterialForSalesExportRow("MAT1", "Material One", "FERT", "2012", "EA") };

        var bytes = MrpForecastHelper.BuildSalesForecastTemplate(rows);

        using var stream = new MemoryStream(bytes);
        using var wb = new XLWorkbook(stream);
        Assert.True(wb.TryGetWorksheet("Data", out var ws));
        Assert.Equal("Material", ws!.Cell(1, 1).GetString());
        Assert.Equal("Expected Sales Units", ws.Cell(1, 6).GetString());
        Assert.Equal("MAT1", ws.Cell(2, 1).GetString());
        Assert.Equal("", ws.Cell(2, 6).GetString());
    }

    [Fact]
    public void BuildSalesForecastTemplate_does_not_throw_with_no_rows()
    {
        var bytes = MrpForecastHelper.BuildSalesForecastTemplate([]);
        Assert.True(bytes.Length > 0);
    }

    // ── UploadBomForecastAsync (Excel upload + SAP call, no DB) ───────────

    private static byte[] BuildUploadWorkbook(params (string Material, string SalesUnits)[] rows)
    {
        using var wb = new XLWorkbook();
        var ws = wb.Worksheets.Add("Data");
        string[] headers = ["Material", "Material Text", "Material Type", "Profit Centre", "Uom", "Expected Sales Units"];
        for (var i = 0; i < headers.Length; i++) ws.Cell(1, i + 1).Value = headers[i];
        for (var i = 0; i < rows.Length; i++)
        {
            ws.Cell(i + 2, 1).Value = rows[i].Material;
            ws.Cell(i + 2, 6).Value = rows[i].SalesUnits;
        }
        using var stream = new MemoryStream();
        wb.SaveAs(stream);
        return stream.ToArray();
    }

    [Fact]
    public async Task UploadBomForecastAsync_rejects_a_missing_targetYear()
    {
        var sap = new Mock<ISapServerClient>();
        var bytes = BuildUploadWorkbook(("MAT1", "100"));

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MrpForecastHelper.UploadBomForecastAsync(sap.Object, 0, bytes, 1, CancellationToken.None));
    }

    [Fact]
    public async Task UploadBomForecastAsync_rejects_empty_file_content()
    {
        var sap = new Mock<ISapServerClient>();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MrpForecastHelper.UploadBomForecastAsync(sap.Object, 2027, [], 1, CancellationToken.None));
    }

    [Fact]
    public async Task UploadBomForecastAsync_rejects_a_workbook_with_no_Data_sheet()
    {
        using var wb = new XLWorkbook();
        wb.Worksheets.Add("Sheet1");
        using var stream = new MemoryStream();
        wb.SaveAs(stream);
        var sap = new Mock<ISapServerClient>();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MrpForecastHelper.UploadBomForecastAsync(sap.Object, 2027, stream.ToArray(), 1, CancellationToken.None));
    }

    [Fact]
    public async Task UploadBomForecastAsync_rejects_a_workbook_with_no_valid_rows()
    {
        var bytes = BuildUploadWorkbook(); // header only, no data rows
        var sap = new Mock<ISapServerClient>();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MrpForecastHelper.UploadBomForecastAsync(sap.Object, 2027, bytes, 1, CancellationToken.None));
    }

    [Fact]
    public async Task UploadBomForecastAsync_flags_a_row_with_an_invalid_sales_units_value_without_dropping_the_batch()
    {
        var bytes = BuildUploadWorkbook(("MAT1", "not-a-number"), ("MAT2", "50"));
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<BomExplosionSapResponse>("api/mrp-analysis/explode-bom", It.IsAny<object>(), 1, false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new BomExplosionSapResponse([new RawMaterialRequirementSapRow("RAW1", 500m, "KG")], []));

        var result = await MrpForecastHelper.UploadBomForecastAsync(sap.Object, 2027, bytes, 1, CancellationToken.None);

        Assert.Equal(2, result.Total);
        Assert.Equal(1, result.Succeeded);
        Assert.Equal(1, result.Failed);
        Assert.Single(result.Products);
        Assert.Equal("MAT2", result.Products[0].Material);
    }

    [Fact]
    public async Task UploadBomForecastAsync_passes_through_SAPs_raw_materials_and_unresolved_list()
    {
        var bytes = BuildUploadWorkbook(("MAT1", "100"));
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<BomExplosionSapResponse>("api/mrp-analysis/explode-bom", It.IsAny<object>(), 1, false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new BomExplosionSapResponse([new RawMaterialRequirementSapRow("RAW1", 500m, "KG")], ["MAT-CYCLE"]));

        var result = await MrpForecastHelper.UploadBomForecastAsync(sap.Object, 2027, bytes, 1, CancellationToken.None);

        Assert.Equal(2027, result.TargetYear);
        Assert.Single(result.RawMaterials);
        Assert.Equal("RAW1", result.RawMaterials[0].Material);
        Assert.Equal(500m, result.RawMaterials[0].Quantity);
        Assert.Single(result.Unresolved);
        Assert.Equal("MAT-CYCLE", result.Unresolved[0]);
    }

    [Fact]
    public async Task UploadBomForecastAsync_skips_blank_rows_without_treating_them_as_errors()
    {
        var bytes = BuildUploadWorkbook(("", ""), ("MAT1", "100"));
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<BomExplosionSapResponse>("api/mrp-analysis/explode-bom", It.IsAny<object>(), 1, false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new BomExplosionSapResponse([], []));

        var result = await MrpForecastHelper.UploadBomForecastAsync(sap.Object, 2027, bytes, 1, CancellationToken.None);

        // Only the real row is counted — the blank row produces no result entry at all.
        Assert.Equal(1, result.Total);
        Assert.Equal(1, result.Succeeded);
    }

    // ── SavePercentageAsync / SaveBomForecastAsync validation ─────────────

    [Fact]
    public async Task SavePercentageAsync_rejects_a_missing_targetYear()
    {
        var db = new Mock<NormantonNexus.Services.Sql.INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>())).ThrowsAsync(new InvalidOperationException("should not be called"));
        var audit = new Mock<IAuditLogger>();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MrpForecastHelper.SavePercentageAsync(db.Object, audit.Object, new PercentageForecastSaveRequest(null, 2025, 10m, [new PercentageForecastMaterialResult("MAT1", null, 100m, null, 110m, null)]), "tester", null, CancellationToken.None));
    }

    [Fact]
    public async Task SavePercentageAsync_rejects_an_empty_materials_list()
    {
        var db = new Mock<NormantonNexus.Services.Sql.INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>())).ThrowsAsync(new InvalidOperationException("should not be called"));
        var audit = new Mock<IAuditLogger>();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MrpForecastHelper.SavePercentageAsync(db.Object, audit.Object, new PercentageForecastSaveRequest(2027, 2025, 10m, []), "tester", null, CancellationToken.None));
    }

    [Fact]
    public async Task SaveBomForecastAsync_rejects_an_empty_rawMaterials_list()
    {
        var db = new Mock<NormantonNexus.Services.Sql.INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>())).ThrowsAsync(new InvalidOperationException("should not be called"));
        var audit = new Mock<IAuditLogger>();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            MrpForecastHelper.SaveBomForecastAsync(db.Object, audit.Object, new BomForecastSaveRequest(2027, [], []), "tester", null, CancellationToken.None));
    }
}
