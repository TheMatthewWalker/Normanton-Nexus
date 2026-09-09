using System.Text;
using Microsoft.Extensions.Options;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Collection email — Logistics Sub-phase 8a.4. Port of routes/
/// shipmentmain.js's POST /:shipmentId/send-collection-email plus its
/// supporting buildCollectionEmailBody/buildMimeMessage/
/// generateShipmentDocuments (the email-specific call site of it — the
/// documents/folder call site was already ported in 8a.3 as
/// ShipmentDocumentHelper.GeneratePackingListAsync). Only available for Ex
/// Works shipments, matching Node's own gate exactly — everything else
/// (DAP/DDP etc.) has its collection arranged by the forwarder, not the
/// customer, so there's no "customer picks it up" email to send.
/// </summary>
internal static class ShipmentCollectionEmailHelper
{
    internal static async Task<SendCollectionEmailResult> SendAsync(INexusOperationsDb db, IOptions<LogisticsOptions> options, long shipmentId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var context = await ShipmentHelper.GetShipmentContextAsync(connection, shipmentId, ct);

        if (!ShipmentHelper.IsExWorks(context.Shipment.IncoTerms))
            throw new NexusValidationException("Collection email is only available for Ex Works shipments.");

        var destinationEmail = (context.Deliveries.Count > 0 ? context.Deliveries[0].DestinationEmail : null)?.Trim() ?? "";
        if (destinationEmail.Length == 0)
            throw new NexusValidationException("Destination email is missing for this shipment.");

        // Node's generateShipmentDocuments re-syncs aggregate data and
        // regenerates the packing-list PDF before attaching it — same
        // "the attached copy must be current" reasoning as
        // ShipmentDocumentHelper.GetDocumentFolderAsync in 8a.3. Written to
        // disk (the shipment's saved packing list) AND attached from the
        // same in-memory byte buffer, rather than Node's write-then-
        // fsp.readFile round trip, which has no purpose here beyond
        // reproducing itself.
        var syncedContext = await ShipmentHelper.SyncShipmentAggregateDataAsync(connection, shipmentId, ct);
        var folder = ShipmentHelper.GetShipmentFolderInfo(syncedContext.Shipment, options.Value);
        Directory.CreateDirectory(folder.ShipmentPath);
        var pdfBytes = ShipmentPackingListPdfHelper.BuildPackingListPdf(syncedContext);
        var fileName = $"{folder.ShipmentRef}.pdf";
        await File.WriteAllBytesAsync(Path.Combine(folder.ShipmentPath, fileName), pdfBytes, ct);

        var settings = options.Value;
        var subject = $"Kongsberg Automotive // Collection Ref: {folder.ShipmentRef} // {syncedContext.Shipment.DestinationName ?? ""}";
        var message = BuildMimeMessage(settings.MailFrom, [destinationEmail], settings.MailCc, subject,
            BuildCollectionEmailBody(folder.ShipmentRef), [(fileName, pdfBytes)]);

        try
        {
            await SmtpMailer.SendAsync(settings, settings.MailFrom, [destinationEmail], settings.MailCc, settings.MailBcc, message, ct);
        }
        catch (Exception ex) when (ex is not NexusApiException)
        {
            throw new NexusBadGatewayException(ex.Message);
        }

        return new SendCollectionEmailResult(folder.ShipmentRef, destinationEmail, settings.MailCc, settings.MailBcc, [fileName]);
    }

    internal static string BuildCollectionEmailBody(string shipmentRef) => string.Join("\r\n",
    [
        "Hi,", "", "The following reference is ready to collect from Kongsberg.", "", $"Ref: {shipmentRef}", "",
        "Invoice & packing list attached.", "", "Please arrange collection.",
        "Open Monday - Thursday, 08:00 - 16:00", "Open Friday, 08:00 - 12:00", "",
        "Collection Address:", "", "Kongsberg Automotive", "Euroflex Centre", "Foxbridge Way", "Normanton", "WF6 1TN, West Yorkshire", "",
        "Best Regards", "Kongsberg Automotive", "Logistics Department",
    ]);

    internal static string BuildMimeMessage(
        string from, IReadOnlyList<string> to, IReadOnlyList<string> cc, string subject, string textBody,
        IReadOnlyList<(string FileName, byte[] Content)> attachments)
    {
        var boundary = $"----PortalShipment{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
        var parts = new List<string> { $"From: {from}", $"To: {string.Join(", ", to)}" };
        if (cc.Count > 0) parts.Add($"Cc: {string.Join(", ", cc)}");
        parts.Add($"Subject: {subject}");
        parts.Add($"Date: {DateTime.UtcNow:R}");
        parts.Add("MIME-Version: 1.0");
        parts.Add($"Content-Type: multipart/mixed; boundary=\"{boundary}\"");
        parts.Add("");
        parts.Add($"--{boundary}");
        parts.Add("Content-Type: text/plain; charset=\"utf-8\"");
        parts.Add("Content-Transfer-Encoding: 8bit");
        parts.Add("");
        parts.Add(textBody);

        foreach (var attachment in attachments)
        {
            parts.Add("");
            parts.Add($"--{boundary}");
            parts.Add($"Content-Type: application/pdf; name=\"{attachment.FileName}\"");
            parts.Add("Content-Transfer-Encoding: base64");
            parts.Add($"Content-Disposition: attachment; filename=\"{attachment.FileName}\"");
            parts.Add("");
            parts.Add(SplitBase64Lines(Convert.ToBase64String(attachment.Content)));
        }
        parts.Add("");
        parts.Add($"--{boundary}--");
        parts.Add("");
        return string.Join("\r\n", parts);
    }

    internal static string SplitBase64Lines(string value)
    {
        var sb = new StringBuilder();
        for (var i = 0; i < value.Length; i += 76)
        {
            if (i > 0) sb.Append("\r\n");
            sb.Append(value, i, Math.Min(76, value.Length - i));
        }
        return sb.ToString();
    }
}
