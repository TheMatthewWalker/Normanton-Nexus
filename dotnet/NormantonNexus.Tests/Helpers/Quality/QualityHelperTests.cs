using Moq;
using NormantonNexus.Helpers.Quality;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Tests.Helpers.Quality;

public class QualityHelperTests
{
    [Fact]
    public async Task DisplayStockAsync_skips_the_header_row_and_maps_pipe_delimited_fields_positionally()
    {
        var response = new RfcExecuteResponse(new Dictionary<string, List<Dictionary<string, string>>>
        {
            ["data_display"] =
            [
                new() { ["WA"] = "header-row-ignored" },
                new() { ["WA"] = "1710|WM01|A01-01|000000000012345678|100,000|BATCH1|S|K|12345" },
                new() { ["WA"] = "1000|   |       |000000000098765432|50,000 |      | |  |     " },
            ],
        });

        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<RfcExecuteResponse>("api/rfc/execute", It.IsAny<object>(), 0, false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(response);

        var rows = await QualityHelper.DisplayStockAsync(sap.Object, CancellationToken.None);

        Assert.Equal(2, rows.Count);
        Assert.Equal("000000000012345678", rows[0].Material);
        Assert.True(rows[0].IsBlocked);
        Assert.Equal("000000000098765432", rows[1].Material);
        Assert.False(rows[1].IsBlocked);
    }

    [Fact]
    public async Task DisplayStockAsync_drops_rows_with_no_material()
    {
        var response = new RfcExecuteResponse(new Dictionary<string, List<Dictionary<string, string>>>
        {
            ["data_display"] =
            [
                new() { ["WA"] = "header" },
                new() { ["WA"] = "1000|WM01|A01-01| |100,000|BATCH1|S|K|12345" },
            ],
        });
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<RfcExecuteResponse>("api/rfc/execute", It.IsAny<object>(), 0, false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(response);

        var rows = await QualityHelper.DisplayStockAsync(sap.Object, CancellationToken.None);

        Assert.Empty(rows);
    }

    [Fact]
    public async Task DisplayStockAsync_calls_SapServer_with_the_fixed_service_user_id_not_the_real_caller()
    {
        // quality.js signs every SAP call with a fixed {userId: 0}, distinct
        // from packaging.js's use of the real calling user — see QualityHelper's
        // own comments. This test locks that distinction in.
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<RfcExecuteResponse>(It.IsAny<string>(), It.IsAny<object>(), 0, false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RfcExecuteResponse(new()));

        await QualityHelper.DisplayStockAsync(sap.Object, CancellationToken.None);

        sap.Verify(s => s.PostAsync<RfcExecuteResponse>(It.IsAny<string>(), It.IsAny<object>(), 0, false, It.IsAny<CancellationToken>()), Times.Once);
        sap.Verify(s => s.PostAsync<RfcExecuteResponse>(It.IsAny<string>(), It.IsAny<object>(), It.Is<int>(id => id != 0), It.IsAny<bool>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task BlockOrUnblockAsync_audits_SAP_OK_with_the_material_and_messages_on_success()
    {
        var result = new QualityMb1bResponse(true, "E MB1B posted", "TO created", "");
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<QualityMb1bResponse>("api/quality/block", It.IsAny<object>(), 0, false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(result);
        var audit = new Mock<IAuditLogger>();
        var body = new BlockUnblockRequest("MAT1", 10, "Test header", null, "BATCH1", "1000", null, null, null);

        var actual = await QualityHelper.BlockOrUnblockAsync(sap.Object, audit.Object, "block", body, "alice", "10.0.0.1", CancellationToken.None);

        Assert.Same(result, actual);
        audit.Verify(a => a.LogAsync("SAP_OK", "alice",
            "Quality block succeeded - Material MAT1 | Batch BATCH1 | E MB1B posted | TO created",
            "10.0.0.1", It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task BlockOrUnblockAsync_audits_SAP_ERROR_and_rethrows_on_failure()
    {
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<QualityMb1bResponse>("api/quality/unblock", It.IsAny<object>(), 0, false, It.IsAny<CancellationToken>()))
            .ThrowsAsync(new SapProxyException(422, "422", "SAP rejected the quality stock movement."));
        var audit = new Mock<IAuditLogger>();
        var body = new BlockUnblockRequest("MAT2", 5, "Test header", null, null, "1000", null, null, null);

        await Assert.ThrowsAsync<SapProxyException>(() =>
            QualityHelper.BlockOrUnblockAsync(sap.Object, audit.Object, "unblock", body, "bob", null, CancellationToken.None));

        audit.Verify(a => a.LogAsync("SAP_ERROR", "bob",
            "Quality unblock failed for material MAT2 - SAP rejected the quality stock movement.",
            null, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task BlockOrUnblockAsync_only_sends_BinType_and_Bin_for_WM_managed_storage_locations()
    {
        QualityMb1bRequest? captured = null;
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<QualityMb1bResponse>("api/quality/block", It.IsAny<object>(), 0, false, It.IsAny<CancellationToken>()))
            .Callback<string, object, int, bool, CancellationToken>((_, body, _, _, _) => captured = (QualityMb1bRequest)body)
            .ReturnsAsync(new QualityMb1bResponse(true, "", "", ""));
        var audit = new Mock<IAuditLogger>();

        var nonWmBody = new BlockUnblockRequest("MAT1", 1, "H", null, null, "1000", "922", "BLOCK", null);
        await QualityHelper.BlockOrUnblockAsync(sap.Object, audit.Object, "block", nonWmBody, "alice", null, CancellationToken.None);
        Assert.Equal("", captured!.BinType);
        Assert.Equal("", captured.Bin);

        var wmBody = new BlockUnblockRequest("MAT1", 1, "H", null, null, "1710", "922", "BLOCK", null);
        await QualityHelper.BlockOrUnblockAsync(sap.Object, audit.Object, "block", wmBody, "alice", null, CancellationToken.None);
        Assert.Equal("922", captured!.BinType);
        Assert.Equal("BLOCK", captured.Bin);
    }

    [Theory]
    [InlineData("10.875,000", 10875)]
    [InlineData("1234.56", 123456)] // no comma -> every '.' is treated as thousands grouping, matching quality.js's own bulk-loop parsing exactly
    [InlineData("", 1)] // empty/zero falls back to 1, matching Node's `qty || 1`
    [InlineData("0", 1)]
    public async Task RunBulkRowAsync_parses_SAP_formatted_quantities_the_same_way_the_Node_bulk_loop_does(string rawQty, decimal expectedQuantity)
    {
        QualityMb1bRequest? captured = null;
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<QualityMb1bResponse>(It.IsAny<string>(), It.IsAny<object>(), 0, false, It.IsAny<CancellationToken>()))
            .Callback<string, object, int, bool, CancellationToken>((_, body, _, _, _) => captured = (QualityMb1bRequest)body)
            .ReturnsAsync(new QualityMb1bResponse(true, "Posted", "", ""));

        var row = new BulkStockRow("MAT1", rawQty, null, "1000", null, null, null, null);
        await QualityHelper.RunBulkRowAsync(sap.Object, "block", row, "Bulk header", "alice", CancellationToken.None);

        Assert.Equal(expectedQuantity, captured!.Quantity);
    }

    [Fact]
    public async Task RunBulkRowAsync_returns_a_failure_progress_event_without_throwing_when_SapServer_rejects_the_row()
    {
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<QualityMb1bResponse>(It.IsAny<string>(), It.IsAny<object>(), 0, false, It.IsAny<CancellationToken>()))
            .ThrowsAsync(new SapProxyException(422, "422", "Material does not exist."));

        var row = new BulkStockRow("BADMAT", "10", null, "1000", null, null, null, null);
        var evt = await QualityHelper.RunBulkRowAsync(sap.Object, "block", row, "Bulk header", "alice", CancellationToken.None);

        Assert.Equal("progress", evt.Type);
        Assert.False(evt.Success);
        Assert.Equal("BADMAT", evt.Material);
        Assert.Equal("Material does not exist.", evt.Error);
    }
}
