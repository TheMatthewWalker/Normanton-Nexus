using Moq;
using NormantonNexus.Controllers;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Controllers;

// SaveCustomerInstruction/BulkImportCustomerInstructions/DeleteCustomerInstruction's
// success paths need a real SQL Server (INexusOperationsDb.CreateConnectionAsync
// actually opens a connection) — untestable in this sandbox, same caveat as
// every other Dapper-backed Helper in this migration. These tests cover the
// validation-failure path (which never reaches the database) and the fully
// SAP-only ScheduleWaterfall action.
public class SalesControllerTests
{
    private static SalesController CreateController(
        Mock<INexusOperationsDb>? nexusOperationsDb = null,
        Mock<ISapServerClient>? sap = null)
    {
        var controller = new SalesController(
            (nexusOperationsDb ?? new Mock<INexusOperationsDb>()).Object,
            (sap ?? new Mock<ISapServerClient>()).Object);

        ControllerTestHelpers.SetUser(controller, userId: 42, departments: [NexusDepartments.Sales]);
        return controller;
    }

    [Fact]
    public async Task SaveCustomerInstruction_propagates_NexusValidationException_for_blank_instructions()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        var controller = CreateController(nexusOperationsDb: db);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.SaveCustomerInstruction("CUST1", new CustomerInstructionSaveRequest(null, "   "), CancellationToken.None));
    }

    [Fact]
    public async Task ScheduleWaterfall_wraps_SapServer_rows_in_ApiResponse_using_the_real_calling_user()
    {
        var rows = new[]
        {
            new ScheduleWaterfallRow("SHIP1", "DOC1", "10", "MAT1", "Widget", "IDOC1", 100m, null, "12:00", null, 50m, "1000", "F", "", 1, 1, true, 50m),
        };
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<ScheduleWaterfallRow[]>("api/sales/schedule-waterfall", It.IsAny<object>(), 42, false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(rows);
        var controller = CreateController(sap: sap);
        var query = new ScheduleWaterfallQuery("1000", ["SHIP1"], "2026-01-01", "2026-01-31", null);

        var result = await controller.ScheduleWaterfall(query, CancellationToken.None);

        var response = ControllerTestHelpers.AssertOk<IReadOnlyList<ScheduleWaterfallRow>>(result);
        Assert.True(response.Success);
        Assert.Single(response.Data!);
        Assert.Equal("SHIP1", response.Data![0].ShipToParty);
    }

    [Fact]
    public async Task ScheduleWaterfall_propagates_NexusValidationException_when_required_query_params_are_missing()
    {
        var controller = CreateController();
        var query = new ScheduleWaterfallQuery(null, null, null, null, null);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.ScheduleWaterfall(query, CancellationToken.None));
    }
}
