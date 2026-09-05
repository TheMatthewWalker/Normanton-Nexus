using Microsoft.Data.SqlClient;
using Moq;
using NormantonNexus.Helpers.Sales;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Sales;

// SalesHelper's SQL-touching paths (ListCustomerInstructionsAsync, the
// UpsertAsync success path, DeleteCustomerInstructionAsync) need a live
// SQL Server the way INexusOperationsDb.CreateConnectionAsync actually opens
// a real connection — untestable in this sandbox (same caveat CLAUDE.md
// already documents for every Dapper query in this migration). These tests
// cover what IS testable without a database: validation that fails before
// ever calling CreateConnectionAsync, bulk-import row validation when every
// row fails validation (so the loop never reaches a real query), and the
// fully SAP-only (no SQL at all) Schedule Waterfall path.
public class SalesHelperTests
{
    [Fact]
    public async Task SaveCustomerInstructionAsync_throws_for_blank_customer_without_ever_opening_a_connection()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            SalesHelper.SaveCustomerInstructionAsync(db.Object, "   ", new CustomerInstructionSaveRequest(null, "Some instructions"), "alice", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task SaveCustomerInstructionAsync_throws_for_blank_instructions_without_ever_opening_a_connection()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            SalesHelper.SaveCustomerInstructionAsync(db.Object, "CUST1", new CustomerInstructionSaveRequest(null, "   "), "alice", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task BulkImportCustomerInstructionsAsync_rejects_a_missing_account_code()
    {
        var result = await RunBulkImport(new BulkImportCustomerInstructionRow("", null, "Store in a cool dry place."));

        var failure = Assert.Single(result.Failed);
        Assert.Equal("Missing account code.", failure.Error);
        Assert.Equal(0, result.Created);
        Assert.Equal(0, result.Updated);
    }

    [Fact]
    public async Task BulkImportCustomerInstructionsAsync_rejects_an_account_code_longer_than_10_characters()
    {
        var result = await RunBulkImport(new BulkImportCustomerInstructionRow("12345678901", null, "Instructions"));

        var failure = Assert.Single(result.Failed);
        Assert.Equal("12345678901", failure.Customer);
        Assert.Equal("Account code is longer than 10 characters.", failure.Error);
    }

    [Fact]
    public async Task BulkImportCustomerInstructionsAsync_rejects_missing_instructions_text()
    {
        var result = await RunBulkImport(new BulkImportCustomerInstructionRow("CUST1", null, "   "));

        var failure = Assert.Single(result.Failed);
        Assert.Equal("Missing instructions text.", failure.Error);
    }

    [Fact]
    public async Task BulkImportCustomerInstructionsAsync_rejects_instructions_text_over_1000_characters_and_reports_the_actual_length()
    {
        var tooLong = new string('x', 1001);
        var result = await RunBulkImport(new BulkImportCustomerInstructionRow("CUST1", null, tooLong));

        var failure = Assert.Single(result.Failed);
        Assert.Equal("Instructions text too long (1001 of max 1000 characters).", failure.Error);
    }

    [Fact]
    public async Task BulkImportCustomerInstructionsAsync_continues_past_failures_instead_of_aborting_the_whole_batch()
    {
        var result = await RunBulkImport(
            new BulkImportCustomerInstructionRow("", null, "Instructions"),
            new BulkImportCustomerInstructionRow("CUST2", null, ""),
            new BulkImportCustomerInstructionRow("12345678901", null, "Instructions"));

        Assert.Equal(3, result.Failed.Count);
        Assert.Equal(0, result.Created);
        Assert.Equal(0, result.Updated);
    }

    private static async Task<BulkImportResult> RunBulkImport(params BulkImportCustomerInstructionRow[] rows)
    {
        // Every row here fails validation, so SalesHelper never reaches
        // UpsertAsync/Dapper — the connection this mock hands back is
        // constructed but never opened or queried, so it's safe without a
        // real SQL Server.
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SqlConnection("Server=unused;Database=unused;"));

        var body = new BulkImportCustomerInstructionsRequest(rows.ToList());
        return await SalesHelper.BulkImportCustomerInstructionsAsync(db.Object, body, "alice", CancellationToken.None);
    }

    [Theory]
    [InlineData(false, true, true, true)]
    [InlineData(true, false, true, true)]
    [InlineData(true, true, false, true)]
    [InlineData(true, true, true, false)]
    public async Task GetScheduleWaterfallAsync_requires_salesOrg_shipToParties_and_both_schedule_dates(
        bool hasSalesOrg, bool hasShipToParties, bool hasScheduleDateFrom, bool hasScheduleDateTo)
    {
        var sap = new Mock<ISapServerClient>();
        var query = new ScheduleWaterfallQuery(
            SalesOrg: hasSalesOrg ? "1000" : null,
            ShipToParties: hasShipToParties ? ["SHIP1"] : null,
            ScheduleDateFrom: hasScheduleDateFrom ? "2026-01-01" : null,
            ScheduleDateTo: hasScheduleDateTo ? "2026-01-31" : null,
            Materials: null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            SalesHelper.GetScheduleWaterfallAsync(sap.Object, query, userId: 42, CancellationToken.None));

        sap.Verify(s => s.PostAsync<ScheduleWaterfallRow[]>(It.IsAny<string>(), It.IsAny<object>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task GetScheduleWaterfallAsync_requires_at_least_one_shipToParty_not_just_a_non_null_empty_list()
    {
        var sap = new Mock<ISapServerClient>();
        var query = new ScheduleWaterfallQuery("1000", [], "2026-01-01", "2026-01-31", null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            SalesHelper.GetScheduleWaterfallAsync(sap.Object, query, userId: 42, CancellationToken.None));
    }

    [Fact]
    public async Task GetScheduleWaterfallAsync_calls_SapServer_with_the_real_calling_user_id_not_a_fixed_service_identity()
    {
        // Distinct from QualityHelper's fixed {userId: 0} pattern — salessap.js
        // signs its SapServer JWT with the real calling user, confirmed against
        // the Node source. Locks that distinction in for Sales.
        ScheduleWaterfallRequest? captured = null;
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<ScheduleWaterfallRow[]>("api/sales/schedule-waterfall", It.IsAny<object>(), 42, false, It.IsAny<CancellationToken>()))
            .Callback<string, object, int, bool, CancellationToken>((_, body, _, _, _) => captured = (ScheduleWaterfallRequest)body)
            .ReturnsAsync([]);

        var query = new ScheduleWaterfallQuery("1000", ["SHIP1", "SHIP2"], "2026-01-01", "2026-01-31", ["MAT1"], IncludeForecast: false, IncludeJit: true, IdocCreatedAfter: "2025-12-01", IncludeZeroQty: true);
        await SalesHelper.GetScheduleWaterfallAsync(sap.Object, query, userId: 42, CancellationToken.None);

        sap.Verify(s => s.PostAsync<ScheduleWaterfallRow[]>("api/sales/schedule-waterfall", It.IsAny<object>(), 42, false, It.IsAny<CancellationToken>()), Times.Once);
        Assert.NotNull(captured);
        Assert.Equal("1000", captured!.SalesOrg);
        Assert.Equal(["SHIP1", "SHIP2"], captured.ShipToParties);
        Assert.Equal(["MAT1"], captured.Materials);
        Assert.False(captured.IncludeForecast);
        Assert.True(captured.IncludeJit);
        Assert.Equal(new DateTime(2025, 12, 1), captured.IdocCreatedAfter);
        Assert.Equal(new DateTime(2026, 1, 1), captured.ScheduleDateFrom);
        Assert.Equal(new DateTime(2026, 1, 31), captured.ScheduleDateTo);
        Assert.True(captured.IncludeZeroQty);
    }

    [Fact]
    public async Task GetScheduleWaterfallAsync_defaults_Materials_to_an_empty_list_and_IdocCreatedAfter_to_null_when_omitted()
    {
        ScheduleWaterfallRequest? captured = null;
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<ScheduleWaterfallRow[]>(It.IsAny<string>(), It.IsAny<object>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .Callback<string, object, int, bool, CancellationToken>((_, body, _, _, _) => captured = (ScheduleWaterfallRequest)body)
            .ReturnsAsync([]);

        var query = new ScheduleWaterfallQuery("1000", ["SHIP1"], "2026-01-01", "2026-01-31", null);
        await SalesHelper.GetScheduleWaterfallAsync(sap.Object, query, userId: 1, CancellationToken.None);

        Assert.NotNull(captured);
        Assert.Empty(captured!.Materials);
        Assert.Null(captured.IdocCreatedAfter);
    }

    [Fact]
    public async Task GetScheduleWaterfallAsync_returns_an_empty_list_rather_than_null_when_SapServer_returns_no_body()
    {
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<ScheduleWaterfallRow[]>(It.IsAny<string>(), It.IsAny<object>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((ScheduleWaterfallRow[]?)null);

        var query = new ScheduleWaterfallQuery("1000", ["SHIP1"], "2026-01-01", "2026-01-31", null);
        var rows = await SalesHelper.GetScheduleWaterfallAsync(sap.Object, query, userId: 1, CancellationToken.None);

        Assert.Empty(rows);
    }
}
