using Microsoft.Extensions.Options;
using Moq;
using NormantonNexus.Controllers;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Controllers;

public class LabelsControllerTests
{
    private static LabelsController CreateController(
        Mock<INexusOperationsDb>? nexusOperationsDb = null, Mock<INexusDb>? nexusDb = null, LabelPrinterOptions? printerOptions = null)
    {
        var controller = new LabelsController(
            (nexusOperationsDb ?? new Mock<INexusOperationsDb>()).Object,
            (nexusDb ?? new Mock<INexusDb>()).Object,
            Options.Create(printerOptions ?? new LabelPrinterOptions()));
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

    [Fact]
    public async Task PrintProcess_rejects_an_unsupported_process_code_without_opening_a_connection()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        var controller = CreateController(db);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.PrintProcess("ZZ", 1, new PrintLabelRequest(null, null), CancellationToken.None));
    }

    [Fact]
    public async Task PrintProcess_rejects_when_no_printers_are_configured_without_opening_a_connection()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        var controller = CreateController(db, printerOptions: new LabelPrinterOptions { Printers = [] });

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.PrintProcess("EX", 1, new PrintLabelRequest(null, null), CancellationToken.None));
    }

    [Fact]
    public async Task PrintProcess_rejects_an_unknown_printerId_without_opening_a_connection()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        var options = new LabelPrinterOptions { Printers = [new LabelPrinterConfig { Id = "line1", Name = "Line 1", Host = "10.0.0.1" }] };
        var controller = CreateController(db, printerOptions: options);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.PrintProcess("EX", 1, new PrintLabelRequest("does-not-exist", null), CancellationToken.None));
    }
}
