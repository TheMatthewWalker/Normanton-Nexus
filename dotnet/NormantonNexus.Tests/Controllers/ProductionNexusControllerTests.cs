using Moq;
using NormantonNexus.Controllers;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Controllers;

public class ProductionNexusControllerTests
{
    private static ProductionNexusController CreateController(
        Mock<INexusOperationsDb>? nexusOperationsDb = null,
        Mock<ISapServerClient>? sap = null,
        Mock<IAuditLogger>? audit = null)
    {
        var controller = new ProductionNexusController(
            (nexusOperationsDb ?? new Mock<INexusOperationsDb>()).Object,
            (sap ?? new Mock<ISapServerClient>()).Object,
            (audit ?? new Mock<IAuditLogger>()).Object);
        ControllerTestHelpers.SetUser(controller, userId: 11, departments: [NexusDepartments.Production]);
        return controller;
    }

    [Fact]
    public async Task AddTraceLink_propagates_NexusValidationException_for_missing_fields()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        var controller = CreateController(nexusOperationsDb: db);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.AddTraceLink(new TraceLinkCreateRequest("", 0, "", 0), CancellationToken.None));
    }

    [Fact]
    public async Task MixingEntry_propagates_NexusValidationException_when_mixCode_or_tubs_are_missing()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        var controller = CreateController(nexusOperationsDb: db);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.MixingEntry(new MixingEntryRequest(null, "SB1", "ST1", null, null), CancellationToken.None));
    }

    [Fact]
    public async Task ScrapApprove_rejects_an_empty_scrapIds_array_without_opening_a_connection()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        var controller = CreateController(nexusOperationsDb: db);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.ScrapApprove(new ScrapBulkRequest([]), CancellationToken.None));
    }

    [Fact]
    public async Task ScrapReject_rejects_an_empty_scrapIds_array_without_opening_a_connection()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        var controller = CreateController(nexusOperationsDb: db);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.ScrapReject(new ScrapBulkRequest([]), CancellationToken.None));
    }

    [Fact]
    public async Task ScrapDocuments_propagates_NexusValidationException_for_a_non_positive_scrapId()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        var controller = CreateController(nexusOperationsDb: db);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.ScrapDocuments(0, CancellationToken.None));
    }

    [Fact]
    public async Task ReversalBulk_rejects_an_empty_materialDocuments_array_without_opening_a_connection()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        var controller = CreateController(nexusOperationsDb: db);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.ReversalBulk(new ReversalBulkRequest([]), CancellationToken.None));
    }
}
