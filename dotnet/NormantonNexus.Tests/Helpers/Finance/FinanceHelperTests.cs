using Moq;
using NormantonNexus.Helpers.Finance;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Finance;

// GL group CRUD's success paths need a live SQL Server the way
// INexusOperationsDb.CreateConnectionAsync actually opens a connection —
// untestable in this sandbox, same caveat as every other Dapper-backed
// Helper in this migration. These tests cover the validation-failure path
// (which never reaches the database) and the fully SAP-only costing
// proxies (Material Costing/Actual Costs/Profit Center Data — no SQL at
// all).
public class FinanceHelperTests
{
    [Fact]
    public async Task CreateGlGroupAsync_throws_for_blank_label_without_ever_opening_a_connection()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            FinanceHelper.CreateGlGroupAsync(db.Object, new GlGroupSaveRequest("   ", ["100000"]), CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UpdateGlGroupAsync_throws_for_blank_label_without_ever_opening_a_connection()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            FinanceHelper.UpdateGlGroupAsync(db.Object, 1, new GlGroupSaveRequest(null, ["100000"]), CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task GetCostSheetAsync_requires_a_date_and_at_least_one_material()
    {
        var sap = new Mock<ISapServerClient>();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            FinanceHelper.GetCostSheetAsync(sap.Object, new CostSheetRequest("", []), userId: 1, CancellationToken.None));

        sap.Verify(s => s.PostAsync<CostSheetRow[]>(It.IsAny<string>(), It.IsAny<object>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task GetCostSheetAsync_posts_to_SapServer_and_returns_an_empty_list_when_no_body_comes_back()
    {
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<CostSheetRow[]>("api/costing/cost-sheet", It.IsAny<object>(), 7, false, It.IsAny<CancellationToken>()))
            .ReturnsAsync((CostSheetRow[]?)null);

        var rows = await FinanceHelper.GetCostSheetAsync(sap.Object, new CostSheetRequest("31.12.2026", ["MAT1"]), userId: 7, CancellationToken.None);

        Assert.Empty(rows);
    }

    [Fact]
    public async Task GetPeriodBalanceAsync_requires_fiscalYear_periodFrom_periodTo_and_glAccounts()
    {
        var sap = new Mock<ISapServerClient>();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            FinanceHelper.GetPeriodBalanceAsync(sap.Object, new PeriodBalanceRequest("2026", "", "P12", ["100000"]), userId: 1, CancellationToken.None));
        await Assert.ThrowsAsync<NexusValidationException>(() =>
            FinanceHelper.GetPeriodBalanceAsync(sap.Object, new PeriodBalanceRequest("2026", "P01", "P12", []), userId: 1, CancellationToken.None));

        sap.Verify(s => s.PostAsync<PeriodBalanceRow[]>(It.IsAny<string>(), It.IsAny<object>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task GetPeriodBalanceAsync_passes_the_request_through_to_SapServer_unchanged()
    {
        PeriodBalanceRequest? captured = null;
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<PeriodBalanceRow[]>("api/costing/period-balance", It.IsAny<object>(), 3, false, It.IsAny<CancellationToken>()))
            .Callback<string, object, int, bool, CancellationToken>((_, body, _, _, _) => captured = (PeriodBalanceRequest)body)
            .ReturnsAsync([new PeriodBalanceRow("100000", "P01", 100m, -20m, 80m, 80m)]);

        var request = new PeriodBalanceRequest("2026", "P01", "P06", ["100000", "200000"]);
        var rows = await FinanceHelper.GetPeriodBalanceAsync(sap.Object, request, userId: 3, CancellationToken.None);

        Assert.Same(request, captured);
        Assert.Single(rows);
        Assert.Equal("100000", rows[0].GlAccount);
    }

    [Fact]
    public async Task GetProfitCenterAsync_requires_dateFrom_dateTo_and_glAccounts()
    {
        var sap = new Mock<ISapServerClient>();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            FinanceHelper.GetProfitCenterAsync(sap.Object, new ProfitCenterRequest("", "31.01.2026", ["100000"]), userId: 1, CancellationToken.None));

        sap.Verify(s => s.PostAsync<ProfitCenterRow[]>(It.IsAny<string>(), It.IsAny<object>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()), Times.Never);
    }
}
