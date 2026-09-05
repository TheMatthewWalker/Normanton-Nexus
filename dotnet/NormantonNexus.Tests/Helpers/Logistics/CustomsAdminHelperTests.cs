using Moq;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class CustomsAdminHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    // ── VAT overrides validation ──────────────────────────────────────

    [Fact]
    public async Task CreateVatOverrideAsync_rejects_a_missing_consigneeCode_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            CustomsAdminHelper.CreateVatOverrideAsync(db.Object, new CreateCustomsVatOverrideRequest(null, "GB123456789", null), "tester", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CreateVatOverrideAsync_rejects_a_missing_vatNumber_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            CustomsAdminHelper.CreateVatOverrideAsync(db.Object, new CreateCustomsVatOverrideRequest("CUST01", "  ", null), "tester", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UpdateVatOverrideAsync_rejects_a_missing_consigneeCode_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            CustomsAdminHelper.UpdateVatOverrideAsync(db.Object, 1, new CreateCustomsVatOverrideRequest("", "GB123456789", null), CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    // ── HS descriptions validation ────────────────────────────────────

    [Fact]
    public async Task CreateHsDescriptionAsync_rejects_a_missing_commodityCode_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            CustomsAdminHelper.CreateHsDescriptionAsync(db.Object, new CreateCustomsHsDescriptionRequest(null, "PTFE tubing"), "tester", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task CreateHsDescriptionAsync_rejects_a_missing_description_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            CustomsAdminHelper.CreateHsDescriptionAsync(db.Object, new CreateCustomsHsDescriptionRequest("39173900", " "), "tester", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UpdateHsDescriptionAsync_rejects_a_missing_description_without_opening_a_connection()
    {
        var db = UnreachableDb();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            CustomsAdminHelper.UpdateHsDescriptionAsync(db.Object, 1, new CreateCustomsHsDescriptionRequest("39173900", null), CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    // ── Lookup short-circuits ─────────────────────────────────────────
    // LookupVatOverrideAsync/LookupHsDescriptionAsync are called by the
    // report-generation helper for every line, most of which have a blank
    // key (e.g. no commodity code resolved from MARC yet) — must not touch
    // the DB at all for those, mirroring Node's own `if (!x) return null;`
    // early return exactly.

    [Fact]
    public async Task LookupVatOverrideAsync_returns_null_for_a_blank_consigneeCode_without_opening_a_connection()
    {
        var db = UnreachableDb();

        var result = await CustomsAdminHelper.LookupVatOverrideAsync(db.Object, "   ", CancellationToken.None);

        Assert.Null(result);
        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task LookupHsDescriptionAsync_returns_null_for_a_null_commodityCode_without_opening_a_connection()
    {
        var db = UnreachableDb();

        var result = await CustomsAdminHelper.LookupHsDescriptionAsync(db.Object, null, CancellationToken.None);

        Assert.Null(result);
        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }
}
