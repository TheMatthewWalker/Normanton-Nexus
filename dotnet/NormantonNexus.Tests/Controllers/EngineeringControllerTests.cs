using Moq;
using NormantonNexus.Controllers;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Controllers;

public class EngineeringControllerTests
{
    private static EngineeringController CreateController(
        Mock<INexusOperationsDb>? nexusOperationsDb = null,
        Mock<INexusDb>? nexusDb = null,
        Mock<ISapServerClient>? sap = null,
        Mock<ISapCredentialCipher>? cipher = null,
        Mock<IAuditLogger>? audit = null)
    {
        var controller = new EngineeringController(
            (nexusOperationsDb ?? new Mock<INexusOperationsDb>()).Object,
            (nexusDb ?? new Mock<INexusDb>()).Object,
            (sap ?? new Mock<ISapServerClient>()).Object,
            (cipher ?? new Mock<ISapCredentialCipher>()).Object,
            (audit ?? new Mock<IAuditLogger>()).Object);

        ControllerTestHelpers.SetUser(controller, userId: 42, departments: [NexusDepartments.Engineering]);
        return controller;
    }

    [Fact]
    public async Task MaterialExists_wraps_the_SapServerClient_result_in_ApiResponse()
    {
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.GetAsync<bool>("api/packaging/IB_363800_SD/exists", 42, false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(true);
        var controller = CreateController(sap: sap);

        var result = await controller.MaterialExists("IB_363800_SD", CancellationToken.None);

        var response = ControllerTestHelpers.AssertOk<bool>(result);
        Assert.True(response.Success);
        Assert.True(response.Data);
    }

    [Fact]
    public async Task MassUpdate_propagates_NexusValidationException_for_empty_rows()
    {
        var controller = CreateController();

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.MassUpdate(new MassPackagingUpdateRequest([]), CancellationToken.None));
    }

    [Fact]
    public async Task SaveInstruction_propagates_NexusValidationException_when_material_is_blank()
    {
        var controller = CreateController();
        var body = new PackagingInstrSaveRequest("", null, "I", "PACK1", 0, 0, false, false, false, false, false, false, false);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            controller.SaveInstruction(body, CancellationToken.None));
    }

    [Fact]
    public async Task GetInstruction_returns_null_data_when_SapServer_has_none_saved_yet()
    {
        var sap = new Mock<ISapServerClient>();
        sap.Setup(s => s.GetAsync<PackagingInstrRow>(It.IsAny<string>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new SapProxyException(404, "NOT_FOUND", "No plant-default packaging instruction found."));
        var controller = CreateController(sap: sap);

        var result = await controller.GetInstruction("MAT1", null, CancellationToken.None);

        var response = ControllerTestHelpers.AssertOk<PackagingInstrRow?>(result);
        Assert.True(response.Success);
        Assert.Null(response.Data);
    }
}
