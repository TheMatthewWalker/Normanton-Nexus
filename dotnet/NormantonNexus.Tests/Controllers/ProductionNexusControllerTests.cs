using Moq;
using NormantonNexus.Controllers;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Controllers;

public class ProductionNexusControllerTests
{
    private static ProductionNexusController CreateController(Mock<INexusOperationsDb>? nexusOperationsDb = null)
    {
        var controller = new ProductionNexusController((nexusOperationsDb ?? new Mock<INexusOperationsDb>()).Object);
        ControllerTestHelpers.SetUser(controller, userId: 11, departments: [NexusDepartments.Production]);
        return controller;
    }

    [Fact]
    public async Task AddTraceLink_propagates_NexusValidationException_for_missing_fields()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        var controller = CreateController(db);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.AddTraceLink(new TraceLinkCreateRequest("", 0, "", 0), CancellationToken.None));
    }
}
