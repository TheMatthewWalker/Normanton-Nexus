using Moq;
using NormantonNexus.Helpers.Admin;
using NormantonNexus.Models;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Tests.Helpers.Admin;

public class BapiInspectorHelperTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task LookupAsync_rejects_a_blank_functionName_without_calling_SapServer_or_auditing(string? functionName)
    {
        var sap = new Mock<ISapServerClient>(MockBehavior.Strict);
        var audit = new Mock<IAuditLogger>(MockBehavior.Strict);

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            BapiInspectorHelper.LookupAsync(sap.Object, audit.Object, functionName, 1, "tester", "127.0.0.1", CancellationToken.None));
    }
}
