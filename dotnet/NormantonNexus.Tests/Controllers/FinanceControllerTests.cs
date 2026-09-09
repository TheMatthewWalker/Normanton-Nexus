using Moq;
using NormantonNexus.Controllers;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Controllers;

public class FinanceControllerTests
{
    private static FinanceController CreateController(
        Mock<INexusOperationsDb>? nexusOperationsDb = null,
        Mock<ISapServerClient>? sap = null)
    {
        var controller = new FinanceController(
            (nexusOperationsDb ?? new Mock<INexusOperationsDb>()).Object,
            (sap ?? new Mock<ISapServerClient>()).Object);

        ControllerTestHelpers.SetUser(controller, userId: 9, departments: [NexusDepartments.Finance]);
        return controller;
    }

    [Fact]
    public async Task CreateGlGroup_propagates_NexusValidationException_for_a_blank_label()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        var controller = CreateController(nexusOperationsDb: db);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.CreateGlGroup(new GlGroupSaveRequest("", []), CancellationToken.None));
    }

    [Fact]
    public async Task CostSheet_wraps_SapServer_rows_in_ApiResponse_using_the_real_calling_user()
    {
        var rows = new[]
        {
            new CostSheetRow("MAT1", "3012", "31.12.2026", "31.12.2026", "PC1", "3012", "",
                10m, 1m, 0.5m, 2m, 3m, 0.2m, 0.1m, 0m, 100m, "KG", "CU", "1", "01.01.2026", "31.12.2026", 5m, 0m),
        };
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<CostSheetRow[]>("api/costing/cost-sheet", It.IsAny<object>(), 9, false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(rows);
        var controller = CreateController(sap: sap);

        var result = await controller.CostSheet(new CostSheetRequest("31.12.2026", ["MAT1"]), CancellationToken.None);

        var response = ControllerTestHelpers.AssertOk<IReadOnlyList<CostSheetRow>>(result);
        Assert.True(response.Success);
        Assert.Single(response.Data!);
        Assert.Equal("MAT1", response.Data![0].Material);
    }

    [Fact]
    public async Task PeriodBalance_propagates_NexusValidationException_when_required_fields_are_missing()
    {
        var controller = CreateController();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.PeriodBalance(new PeriodBalanceRequest("", "", "", []), CancellationToken.None));
    }

    [Fact]
    public async Task ProfitCenter_wraps_SapServer_rows_in_ApiResponse()
    {
        var rows = new[] { new ProfitCenterRow("100000", "PC1", "2026", "01.01.2026", 500m, "INV1", "1", "MAT1", "CUST1", "SO1", "10") };
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<ProfitCenterRow[]>("api/costing/profit-center", It.IsAny<object>(), 9, false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(rows);
        var controller = CreateController(sap: sap);

        var result = await controller.ProfitCenter(new ProfitCenterRequest("01.01.2026", "31.01.2026", ["100000"]), CancellationToken.None);

        var response = ControllerTestHelpers.AssertOk<IReadOnlyList<ProfitCenterRow>>(result);
        Assert.True(response.Success);
        Assert.Single(response.Data!);
    }
}
