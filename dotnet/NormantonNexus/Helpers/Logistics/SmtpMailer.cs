using System.Net.Security;
using System.Net.Sockets;
using System.Text;
using NormantonNexus.Models;
using NormantonNexus.Services;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Minimal raw-socket SMTP client — Logistics Sub-phase 8a.4. Port of
/// routes/shipmentmain.js's sendSmtpMessage. Same "no drop-in NuGet
/// equivalent for this exact protocol shape, so hand-roll it" situation
/// LabelPrintHelper.cs's raw-TCP printer send already established the
/// idiom for in this codebase (TcpClient, explicit timeout via a linked
/// CancellationTokenSource) — this just adds the SMTP command/response
/// exchange itself and, for smtpSecure, an SslStream wrapping the same
/// socket (Node's tls.connect equivalent).
///
/// Deliberately NOT a general-purpose SMTP library: only the exact command
/// sequence this app's one caller (ShipmentCollectionEmailHelper) needs —
/// EHLO with a HELO fallback, optional AUTH LOGIN, MAIL FROM/RCPT TO/DATA,
/// QUIT — matching Node's own hand-rolled scope exactly.
/// </summary>
internal static class SmtpMailer
{
    /// <summary>
    /// Sends one already-built MIME message. Throws NexusValidationException
    /// for "no recipients" (400 in Node), NexusBadGatewayException for "not
    /// configured" (503 in Node — closest existing mapping, same as
    /// ShipmentHelper.AssertValidExportRoot's own config-misconfiguration
    /// precedent), and lets any other exception (connection/protocol
    /// failure) propagate as a plain Exception for the caller to wrap —
    /// mirrors LabelPrintHelper.PrintAsync's own "catch ex is not
    /// NexusApiException, wrap into NexusBadGatewayException" pattern
    /// rather than duplicating that wrap here.
    /// </summary>
    internal static async Task SendAsync(
        LogisticsOptions settings, string from, IReadOnlyList<string> to, IReadOnlyList<string> cc, IReadOnlyList<string> bcc,
        string message, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(settings.SmtpHost) || string.IsNullOrEmpty(settings.MailFrom))
            throw new NexusBadGatewayException("Logistics email is not configured. Set SMTP host and from address in appsettings.");

        var recipients = to.Concat(cc).Concat(bcc).Where(r => !string.IsNullOrWhiteSpace(r)).ToList();
        if (recipients.Count == 0)
            throw new NexusValidationException("No email recipients were provided.");

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromMilliseconds(settings.SmtpConnectionTimeoutMs));

        try
        {
            using var client = new TcpClient();
            await ConnectAsync(client, settings, timeoutCts.Token);

            Stream stream = client.GetStream();
            SslStream? ssl = null;
            if (settings.SmtpSecure)
            {
                ssl = new SslStream(stream, false,
                    (_, _, _, errors) => settings.SmtpAllowInvalidCert || errors == SslPolicyErrors.None);
                await ssl.AuthenticateAsClientAsync(new SslClientAuthenticationOptions { TargetHost = settings.SmtpHost }, timeoutCts.Token);
                stream = ssl;
            }

            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
            using var writer = new StreamWriter(stream, new UTF8Encoding(false), leaveOpen: true) { NewLine = "\r\n", AutoFlush = true };

            async Task<string> ReadResponseAsync()
            {
                var lines = new List<string>();
                while (true)
                {
                    var line = await reader.ReadLineAsync(timeoutCts.Token)
                        ?? throw new IOException($"SMTP connection to {settings.SmtpHost}:{settings.SmtpPort} closed unexpectedly.");
                    lines.Add(line);
                    if (line.Length >= 4 && char.IsAsciiDigit(line[0]) && line[3] == ' ') break;
                }
                return string.Join('\n', lines);
            }

            void AssertCode(string response, params int[] allowed)
            {
                var code = int.Parse(response[..3]);
                if (!allowed.Contains(code)) throw new IOException($"SMTP error {code}: {response}");
            }

            async Task<string> SendCommandAsync(string command, params int[] allowed)
            {
                await writer.WriteLineAsync(command.AsMemory(), timeoutCts.Token);
                var response = await ReadResponseAsync();
                AssertCode(response, allowed);
                return response;
            }

            async Task<Exception?> SendEhloAsync()
            {
                try
                {
                    await SendCommandAsync($"EHLO {settings.SmtpHelloName}", 250);
                    return null;
                }
                catch (Exception ehloError)
                {
                    await SendCommandAsync($"HELO {settings.SmtpHelloName}", 250);
                    return ehloError;
                }
            }

            AssertCode(await ReadResponseAsync(), 220);
            var ehloError = await SendEhloAsync();

            if (!string.IsNullOrEmpty(settings.SmtpUser))
            {
                try
                {
                    await SendCommandAsync("AUTH LOGIN", 334);
                    await SendCommandAsync(Convert.ToBase64String(Encoding.UTF8.GetBytes(settings.SmtpUser)), 334);
                    await SendCommandAsync(Convert.ToBase64String(Encoding.UTF8.GetBytes(settings.SmtpPass ?? "")), 235);
                }
                catch (Exception authError)
                {
                    throw new IOException($"SMTP authentication failed for {settings.SmtpHost}:{settings.SmtpPort}. {authError.Message}", authError);
                }
            }
            else if (ehloError is not null && settings.SmtpSecure)
            {
                throw new IOException(
                    $"SMTP server {settings.SmtpHost}:{settings.SmtpPort} rejected EHLO during secure relay setup. {ehloError.Message}", ehloError);
            }

            await SendCommandAsync($"MAIL FROM:<{from}>", 250);
            foreach (var recipient in recipients)
                await SendCommandAsync($"RCPT TO:<{recipient}>", 250, 251);
            await SendCommandAsync("DATA", 354);

            await writer.WriteAsync($"{message}\r\n.\r\n".AsMemory(), timeoutCts.Token);
            await writer.FlushAsync(timeoutCts.Token);
            AssertCode(await ReadResponseAsync(), 250);

            await SendCommandAsync("QUIT", 221);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException($"SMTP session with {settings.SmtpHost}:{settings.SmtpPort} timed out.");
        }
    }

    private static async Task ConnectAsync(TcpClient client, LogisticsOptions settings, CancellationToken ct)
    {
        try
        {
            await client.ConnectAsync(settings.SmtpHost, settings.SmtpPort, ct);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException($"SMTP connection to {settings.SmtpHost}:{settings.SmtpPort} timed out.");
        }
    }
}
