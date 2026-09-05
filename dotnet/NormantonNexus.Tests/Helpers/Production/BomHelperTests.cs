using Moq;
using NormantonNexus.Helpers.Production;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Production;

// GetBomPreviewAsync/GetLatestBomAsync/RefreshBomAsync/AddRawMaterialBatchAsync/
// RaiseConcessionAsync all validate the process code (BomValidatedProcesses)
// before ever calling SapServer or opening a connection — the only paths
// unit-testable without a real SQL Server/SapServer, same caveat as
// everywhere else in this migration.
public class BomHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    // MockBehavior.Strict throws on ANY unconfigured call regardless of the
    // generic type argument used (GetAsync<List<SapBomRow>> here vs. a
    // loosely-typed setup that wouldn't actually intercept it) — the only
    // reliable way to prove a guard fires before SapServer is ever touched.
    private static Mock<ISapServerClient> UnreachableSap() => new(MockBehavior.Strict);

    [Fact]
    public async Task GetBomPreviewAsync_rejects_a_non_BOM_validated_process_without_calling_SapServer()
    {
        var sap = UnreachableSap();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            BomHelper.GetBomPreviewAsync(sap.Object, "EX", "MAT-1", userId: 1, CancellationToken.None));
    }

    [Fact]
    public async Task GetBomPreviewAsync_rejects_a_missing_material_without_calling_SapServer()
    {
        var sap = UnreachableSap();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            BomHelper.GetBomPreviewAsync(sap.Object, "DR", null, userId: 1, CancellationToken.None));
    }

    [Fact]
    public async Task GetLatestBomAsync_rejects_a_non_BOM_validated_process_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            BomHelper.GetLatestBomAsync(db.Object, "MX", recordId: 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task RefreshBomAsync_rejects_a_non_BOM_validated_process_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var sap = UnreachableSap();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            BomHelper.RefreshBomAsync(db.Object, sap.Object, "EX", recordId: 1, userId: 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task AddRawMaterialBatchAsync_rejects_a_non_BOM_validated_process_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            BomHelper.AddRawMaterialBatchAsync(db.Object, "MX", recordId: 1, new AddRawMaterialBatchRequest("MAT-1", "B1"), userId: 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task AddRawMaterialBatchAsync_rejects_missing_fields_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            BomHelper.AddRawMaterialBatchAsync(db.Object, "DR", recordId: 1, new AddRawMaterialBatchRequest("", ""), userId: 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task RaiseConcessionAsync_rejects_a_non_BOM_validated_process_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            BomHelper.RaiseConcessionAsync(db.Object, "MX", recordId: 1,
                new RaiseConcessionRequest("BR", 1, "COMP-1", "MAT-2", null, "wrong batch linked"), userId: 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task RaiseConcessionAsync_rejects_missing_fields_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            BomHelper.RaiseConcessionAsync(db.Object, "DR", recordId: 1,
                new RaiseConcessionRequest("", 1, "", "", null, ""), userId: 1, CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public void BuildActualComponentList_uses_the_concessions_own_quantity_when_present_and_a_computed_ratio_otherwise()
    {
        var bomRows = new List<BomRow>
        {
            new("COMP-A", 2.5m, "M", "0010", "1710", "2001", false),
            new("COMP-B", 1.0m, "M", "0020", "1710", "2012", true),
        };
        var concessions = new List<ApprovedConcessionRow> { new(1, "COMP-A", "COMP-A-SUB", 99.5m) };

        var result = BomHelper.BuildActualComponentList(bomRows, concessions, totalQty: 10m);

        Assert.Equal(2, result.Count);
        Assert.Equal("COMP-A-SUB", result[0].Material);
        Assert.Equal(99.5m, result[0].Quantity); // concession's own quantity wins outright
        Assert.Equal("COMP-B", result[1].Material);
        Assert.Equal(10.000m, result[1].Quantity); // 1.0 * 10, rounded to 3dp
    }
}
