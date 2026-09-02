using Moq;
using NormantonNexus.Controllers;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Controllers;

public class StockCountControllerTests
{
    private static StockCountController CreateController(
        Mock<INexusOperationsDb>? nexusOperationsDb = null,
        Mock<ISapServerClient>? sap = null)
    {
        var controller = new StockCountController(
            (nexusOperationsDb ?? new Mock<INexusOperationsDb>()).Object,
            (sap ?? new Mock<ISapServerClient>()).Object);

        ControllerTestHelpers.SetUser(controller, userId: 4, departments: [NexusDepartments.Finance]);
        return controller;
    }

    [Fact]
    public async Task GetCountReport_propagates_NexusValidationException_for_groupBy_bin()
    {
        var controller = CreateController();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.GetCountReport(1, "bin", CancellationToken.None));
    }

    [Fact]
    public async Task Reject_propagates_NexusValidationException_for_a_blank_reason()
    {
        var controller = CreateController();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.Reject(1, new RejectCountRequest(""), CancellationToken.None));
    }
}
