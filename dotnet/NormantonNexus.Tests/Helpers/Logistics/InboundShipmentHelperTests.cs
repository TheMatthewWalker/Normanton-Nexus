using Moq;
using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Tests.Helpers.Logistics;

public class InboundShipmentHelperTests
{
    private static Mock<INexusOperationsDb> UnreachableDb()
    {
        var db = new Mock<INexusOperationsDb>();
        db.Setup(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("should not be called"));
        return db;
    }

    private static LogisticsOptions SampleOptions() => new() { PoRoot = @"C:\po-root", ImportRoot = @"C:\import-root" };

    // ── UploadDocumentAsync pre-connection guards ────────────────────────

    [Fact]
    public async Task UploadDocumentAsync_rejects_empty_file_content_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var options = Microsoft.Extensions.Options.Options.Create(SampleOptions());

        await Assert.ThrowsAsync<NexusValidationException>(() =>
            InboundShipmentHelper.UploadDocumentAsync(db.Object, options, 1, [], "invoice.pdf", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UploadDocumentAsync_rejects_a_file_over_20mb_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var options = Microsoft.Extensions.Options.Options.Create(SampleOptions());
        var oversized = new byte[20 * 1024 * 1024 + 1];

        await Assert.ThrowsAsync<NexusPayloadTooLargeException>(() =>
            InboundShipmentHelper.UploadDocumentAsync(db.Object, options, 1, oversized, "invoice.pdf", CancellationToken.None));

        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UploadDocumentAsync_rejects_an_unsupported_extension_without_opening_a_connection()
    {
        var db = UnreachableDb();
        var options = Microsoft.Extensions.Options.Options.Create(SampleOptions());

        var ex = await Assert.ThrowsAsync<NexusValidationException>(() =>
            InboundShipmentHelper.UploadDocumentAsync(db.Object, options, 1, [1, 2, 3], "malware.exe", CancellationToken.None));

        Assert.Contains(".exe", ex.Message);
        db.Verify(d => d.CreateConnectionAsync(It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task UploadDocumentAsync_accepts_every_documented_extension_past_the_guard()
    {
        // Each of these should clear the extension guard and reach the mock's "should not be
        // called" connection throw, not a validation error — proving the allow-list itself is right.
        string[] extensions = [".pdf", ".jpg", ".jpeg", ".png", ".docx", ".doc", ".xlsx", ".xls", ".msg", ".eml", ".txt", ".csv"];
        var db = UnreachableDb();
        var options = Microsoft.Extensions.Options.Options.Create(SampleOptions());

        foreach (var ext in extensions)
        {
            var ex = await Record.ExceptionAsync(() =>
                InboundShipmentHelper.UploadDocumentAsync(db.Object, options, 1, [1, 2, 3], $"file{ext}", CancellationToken.None));
            Assert.IsType<InvalidOperationException>(ex);
        }
    }

    // ── GetPoPdfPath (pure) ───────────────────────────────────────────────

    [Fact]
    public void GetPoPdfPath_combines_root_sanitized_vendor_and_po_number()
    {
        var path = InboundShipmentHelper.GetPoPdfPath("Acme Ltd", "4500001234", SampleOptions());

        Assert.Equal(Path.Combine(@"C:\po-root", "Acme Ltd", "4500001234.pdf"), path);
    }

    [Fact]
    public void GetPoPdfPath_falls_back_to_Unknown_Supplier_for_a_null_vendor_name()
    {
        var path = InboundShipmentHelper.GetPoPdfPath(null, "4500001234", SampleOptions());

        Assert.Equal(Path.Combine(@"C:\po-root", "Unknown Supplier", "4500001234.pdf"), path);
    }

    [Fact]
    public void GetPoPdfPath_sanitizes_illegal_filesystem_characters_in_the_vendor_name()
    {
        var path = InboundShipmentHelper.GetPoPdfPath("Acme / Sons: Ltd", "4500001234", SampleOptions());

        Assert.DoesNotContain("/", Path.GetFileName(Path.GetDirectoryName(path)));
        Assert.DoesNotContain(":", Path.GetFileName(Path.GetDirectoryName(path)));
    }

    [Fact]
    public void GetPoPdfPath_throws_a_bad_gateway_exception_for_a_misconfigured_root()
    {
        var badOptions = new LogisticsOptions { PoRoot = "relative/not/absolute" };

        Assert.Throws<NexusBadGatewayException>(() => InboundShipmentHelper.GetPoPdfPath("Acme Ltd", "4500001234", badOptions));
    }
}
