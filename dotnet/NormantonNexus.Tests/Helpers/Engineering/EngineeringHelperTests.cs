using Moq;
using NormantonNexus.Helpers.Engineering;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Tests.Helpers.Engineering;

public class EngineeringHelperTests
{
    [Fact]
    public async Task GetInstructionAsync_swallows_a_404_into_null_not_an_error()
    {
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.GetAsync<PackagingInstrRow>(It.IsAny<string>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new SapProxyException(404, "NOT_FOUND", "No plant-default packaging instruction found."));

        var result = await EngineeringHelper.GetInstructionAsync(sap.Object, "IB_363800_SD", null, userId: 1, CancellationToken.None);

        Assert.Null(result);
    }

    [Fact]
    public async Task GetInstructionAsync_rethrows_a_non_404_SapProxyException()
    {
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.GetAsync<PackagingInstrRow>(It.IsAny<string>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new SapProxyException(503, "SAP_UNAVAILABLE", "Timed out."));

        await Assert.ThrowsAsync<SapProxyException>(() =>
            EngineeringHelper.GetInstructionAsync(sap.Object, "IB_363800_SD", null, userId: 1, CancellationToken.None));
    }

    [Fact]
    public async Task GetInstructionAsync_returns_the_row_on_success()
    {
        var row = new PackagingInstrRow("IB_TSHV3-4B01/S_SB", 10, 5, true, false, true, false, false, true, false);
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.GetAsync<PackagingInstrRow>(It.IsAny<string>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(row);

        var result = await EngineeringHelper.GetInstructionAsync(sap.Object, "IB_363800_SD", "363660", userId: 1, CancellationToken.None);

        Assert.Same(row, result);
    }

    [Fact]
    public async Task GetInstructionAsync_appends_the_customer_query_string_only_when_a_customer_is_given()
    {
        var sap = new Mock<ISapServerClient>();
        string? capturedPath = null;
        sap.Setup(s => s.GetAsync<PackagingInstrRow>(It.IsAny<string>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .Callback<string, int, bool, CancellationToken>((path, _, _, _) => capturedPath = path)
            .ReturnsAsync((PackagingInstrRow?)null);

        await EngineeringHelper.GetInstructionAsync(sap.Object, "MAT1", "363660", userId: 1, CancellationToken.None);
        Assert.Equal("api/packaging/MAT1/instruction?customer=363660", capturedPath);

        await EngineeringHelper.GetInstructionAsync(sap.Object, "MAT1", null, userId: 1, CancellationToken.None);
        Assert.Equal("api/packaging/MAT1/instruction", capturedPath);
    }

    [Fact]
    public async Task MassUpdateAsync_throws_NexusValidationException_when_rows_is_empty()
    {
        var sap = new Mock<ISapServerClient>();
        var audit = new Mock<IAuditLogger>();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            EngineeringHelper.MassUpdateAsync(sap.Object, audit.Object, new MassPackagingUpdateRequest([]),
                userId: 1, username: "alice", ipAddress: null, CancellationToken.None));

        sap.Verify(s => s.PostAsync<List<MassPackagingUpdateResult>>(It.IsAny<string>(), It.IsAny<object>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task MassUpdateAsync_audits_the_success_count_out_of_the_total()
    {
        var results = new List<MassPackagingUpdateResult>
        {
            new("MAT1", true, "OK"),
            new("MAT2", false, "No existing plant-default row"),
            new("MAT3", true, "OK"),
        };
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PostAsync<List<MassPackagingUpdateResult>>("api/packaging/mass-update", It.IsAny<object>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(results);
        var audit = new Mock<IAuditLogger>();

        var request = new MassPackagingUpdateRequest([new MassPackagingUpdateRow("MAT1", "PACK1")]);
        var actual = await EngineeringHelper.MassUpdateAsync(sap.Object, audit.Object, request, userId: 1, username: "alice", ipAddress: "10.0.0.1", CancellationToken.None);

        Assert.Same(results, actual);
        audit.Verify(a => a.LogAsync("PACKAGING_MASS_UPDATE", "alice", "2/3 materials updated", "10.0.0.1", It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task SaveInstructionAsync_audits_with_the_material_and_customer_scope()
    {
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PutAsync<string>("api/packaging/instruction", It.IsAny<object>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync("Instruction saved.");
        var audit = new Mock<IAuditLogger>();
        var body = new PackagingInstrSaveRequest("MAT1", "363660", "U", "PACK1", 10, 5, true, false, false, false, false, false, false);

        var message = await EngineeringHelper.SaveInstructionAsync(sap.Object, audit.Object, body, userId: 1, username: "alice", ipAddress: null, CancellationToken.None);

        Assert.Equal("Instruction saved.", message);
        audit.Verify(a => a.LogAsync("PACKAGING_INSTRUCTION_SAVED", "alice", "MAT1/363660", null, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task SaveInstructionAsync_audits_plant_default_scope_when_customer_is_null()
    {
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.PutAsync<string>("api/packaging/instruction", It.IsAny<object>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync("Instruction saved.");
        var audit = new Mock<IAuditLogger>();
        var body = new PackagingInstrSaveRequest("MAT1", null, "I", "PACK1", 0, 0, false, false, false, false, false, false, false);

        await EngineeringHelper.SaveInstructionAsync(sap.Object, audit.Object, body, userId: 1, username: "alice", ipAddress: null, CancellationToken.None);

        audit.Verify(a => a.LogAsync("PACKAGING_INSTRUCTION_SAVED", "alice", "MAT1/(plant)", null, It.IsAny<CancellationToken>()), Times.Once);
    }
}
