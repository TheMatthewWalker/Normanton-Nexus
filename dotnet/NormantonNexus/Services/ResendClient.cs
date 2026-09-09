using System.Net.Http.Json;
using Microsoft.Extensions.Options;
using NormantonNexus.Models;

namespace NormantonNexus.Services;

public sealed class ResendException(int statusCode, string message) : NexusApiException("RESEND_ERROR", message)
{
    public override int StatusCode { get; } = statusCode;
}

/// <summary>
/// Typed HttpClient wrapper for Resend's transactional email API — used only
/// by the forgot-password flow (routes/auth.js's POST /forgot-password, the
/// one caller of Node's `resend.emails.send`). UNVERIFIED against a live
/// Resend account — same caveat class as this migration's other external
/// integrations before real-world confirmation.
/// </summary>
public interface IResendClient
{
    Task SendEmailAsync(string to, string subject, string html, CancellationToken ct);
}

internal sealed record ResendSendRequest(string From, string[] To, string Subject, string Html);

internal sealed class ResendClient(HttpClient httpClient, IOptions<ResendOptions> options) : IResendClient
{
    private readonly ResendOptions _options = options.Value;

    public async Task SendEmailAsync(string to, string subject, string html, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(_options.ApiKey))
            throw new ResendException(StatusCodes.Status503ServiceUnavailable, "Email sending is not configured. Set RESEND_API_KEY in appsettings.");

        using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.resend.com/emails");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", _options.ApiKey);
        request.Content = JsonContent.Create(new ResendSendRequest(_options.FromAddress, [to], subject, html));

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(15));

        HttpResponseMessage response;
        try
        {
            response = await httpClient.SendAsync(request, timeoutCts.Token);
        }
        catch (Exception ex) when (ex is HttpRequestException || (ex is OperationCanceledException && !ct.IsCancellationRequested))
        {
            throw new ResendException(StatusCodes.Status502BadGateway, $"Could not reach Resend: {ex.Message}");
        }

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(ct);
            throw new ResendException(StatusCodes.Status502BadGateway, $"Resend rejected the email ({(int)response.StatusCode}): {body}");
        }
    }
}
