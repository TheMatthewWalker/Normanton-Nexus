using System.Net.Sockets;
using Dapper;
using Microsoft.Extensions.Options;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// Printer selection + server-side direct-to-network-printer print — port
/// of GET /printers, PATCH /printers/default, and POST
/// /process/:pc/:id/print in routes/labels.js. Uses INexusDb (not
/// INexusOperationsDb), matching Node's own getNexusPool() call for these
/// two routes specifically — every other labels.js route reads from
/// NexusOperations, but printer selection lives on dbo.PortalUsers in the
/// Nexus database itself.
/// </summary>
internal static class LabelPrintHelper
{
    // Mirrors Node's sock.setTimeout(15000) in tcpPrint exactly.
    private static readonly TimeSpan PrintTimeout = TimeSpan.FromSeconds(15);

    internal static async Task<PrintersListResult> GetPrintersAsync(INexusDb db, IOptions<LabelPrinterOptions> printerOptions, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var userDefault = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "SELECT DefaultPrinterID FROM dbo.PortalUsers WHERE UserID = @userId",
            new { userId }, cancellationToken: ct));

        var printers = printerOptions.Value.Printers.Select(p => new PrinterSummary(p.Id, p.Name)).ToList();
        return new PrintersListResult(printers, userDefault);
    }

    internal static async Task SetDefaultPrinterAsync(INexusDb db, int userId, SetDefaultPrinterRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE dbo.PortalUsers SET DefaultPrinterID = @printerId WHERE UserID = @userId",
            new { printerId = string.IsNullOrEmpty(body.PrinterId) ? null : body.PrinterId, userId }, cancellationToken: ct));
    }

    /// <summary>
    /// Builds the PDF (same MX-fans-out-to-one-page-per-tub shape as the
    /// browser preview) and sends it to the configured printer over raw
    /// TCP. Mirrors Node's POST /process/:pc/:id/print exactly, including
    /// which printer gets picked when the caller doesn't specify one
    /// (printersConfig[0], i.e. whichever printer is first in config) and
    /// the exact "no printers configured" vs "printer X not found" error
    /// distinction.
    /// </summary>
    internal static async Task<PrintLabelResult> PrintAsync(
        INexusOperationsDb operationsDb, IOptions<LabelPrinterOptions> printerOptions,
        string processCode, int recordId, PrintLabelRequest body, CancellationToken ct)
    {
        var code = processCode.ToUpperInvariant();
        if (!LabelDataHelper.SupportedProcessCodes.Contains(code))
            throw new NexusValidationException($"Label not supported for {code}.");
        if (recordId <= 0)
            throw new NexusValidationException("Invalid record ID.");

        var printers = printerOptions.Value.Printers;
        var printer = !string.IsNullOrEmpty(body.PrinterId)
            ? printers.FirstOrDefault(p => p.Id == body.PrinterId)
            : printers.FirstOrDefault();

        if (printer is null)
        {
            throw new NexusValidationException(printers.Count == 0
                ? "No printers configured. Add a \"Printers\" array under LabelPrinters in appsettings.json."
                : $"Printer \"{body.PrinterId}\" not found.");
        }

        IReadOnlyList<LabelData> labels = code == "MX"
            ? await LabelDataHelper.FetchMixingTicketsDataAsync(operationsDb, recordId, body.Tub, ct)
            : [await LabelDataHelper.FetchLabelDataAsync(operationsDb, code, recordId, ct)];

        var pdf = LabelPdfHelper.BuildLabelsPdf(labels, printer.PaperSize);

        try
        {
            await SendToPrinterAsync(pdf, printer.Host, printer.Port, ct);
        }
        catch (Exception ex) when (ex is not NexusApiException)
        {
            throw new NexusBadGatewayException(ex.Message);
        }

        return new PrintLabelResult($"Sent to {(string.IsNullOrEmpty(printer.Name) ? printer.Host : printer.Name)}");
    }

    /// <summary>Raw-TCP send — port of Node's tcpPrint. Writes the PDF bytes, half-closes the send side, then waits for the printer to close its end (mirrors Node's `sock.on('close', resolve)`) before returning.</summary>
    private static async Task SendToPrinterAsync(byte[] buffer, string host, int port, CancellationToken ct)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(PrintTimeout);

        try
        {
            using var client = new TcpClient();
            await client.ConnectAsync(host, port, timeoutCts.Token);

            var stream = client.GetStream();
            await stream.WriteAsync(buffer, timeoutCts.Token);
            client.Client.Shutdown(SocketShutdown.Send);

            var drain = new byte[256];
            while (await stream.ReadAsync(drain, timeoutCts.Token) > 0)
            {
                // Draining until the printer closes its end (0-byte read) —
                // nothing meaningful is ever sent back, this just waits for
                // confirmation the job was received before returning.
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException($"Printer {host}:{port} timed out after {PrintTimeout.TotalSeconds:F0}s");
        }
    }
}
