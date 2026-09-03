using Moq;
using NormantonNexus.Controllers;
using NormantonNexus.Models;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Controllers;

public class LabelsControllerTests
{
    private static LabelsController CreateController(Mock<INexusOperationsDb>? nexusOperationsDb = null)
    {
        var controller = new LabelsController((nexusOperationsDb ?? new Mock<INexusOperationsDb>()).Object);
        ControllerTestHelpers.SetUser(controller, userId: 11, departments: [NexusDepartments.Production]);
        return controller;
    }

    [Fact]
    public async Task PreviewProcess_rejects_an_unsupported_process_code_without_opening_a_connection()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        var controller = CreateController(db);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.PreviewProcess("ZZ", 1, null, CancellationToken.None));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task PreviewProcess_rejects_a_non_positive_record_id_without_opening_a_connection(int recordId)
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        var controller = CreateController(db);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.PreviewProcess("EX", recordId, null, CancellationToken.None));
    }
}
