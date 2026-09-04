using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.Extensions.Options;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Services;

/// <summary>
/// A ClearPort API call failed — carries ClearPort's own status code
/// through (or 502 for anything this app can't otherwise categorise,
/// matching Node's own `err.statusCode = err.statusCode || 502` default).
/// </summary>
public sealed class ClearPortException(int statusCode, string message) : NexusApiException("CLEARPORT_ERROR", message)
{
    public override int StatusCode { get; } = statusCode;
}

/// <summary>
/// Typed HttpClient wrapper for ClearPort — Logistics Sub-phase 8a.5c. Port
/// of routes/shipmentmain.js's createClearPortExport/downloadClearPortPdf
/// (plain axios + X-API-Key header, not the JWT scheme SapServerClient
/// uses — ClearPort is a separate third-party customs broker, not
/// SapServer).
///
/// UNVERIFIED against a live ClearPort sandbox or real credentials — no
/// live ClearPort access has been reachable in any environment this port
/// has been developed in, the same caveat class as this migration's other
/// external integrations at the point they were first built (SapServerClient,
/// SmtpMailer) before real-world confirmation. The specific status-code/
/// error-message mapping below is a faithful port of Node's own handling,
/// not independently re-verified against ClearPort's actual API docs.
/// </summary>
public interface IClearPortClient
{
    Task<string> CreateExportAsync(ClearPortExportRequest payload, CancellationToken ct);
    Task<byte[]> DownloadPdfAsync(string correlationId, CancellationToken ct);
}

internal sealed class ClearPortClient(HttpClient httpClient, IOptions<ClearPortOptions> options) : IClearPortClient
{
    private readonly ClearPortOptions _options = options.Value;

    public async Task<string> CreateExportAsync(ClearPortExportRequest payload, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(_options.ApiToken))
            throw new ClearPortException(StatusCodes.Status503ServiceUnavailable, "ClearPort integration is not configured. Set CLEARPORT_API_TOKEN in appsettings.");

        using var request = new HttpRequestMessage(HttpMethod.Post, CombineUrl("/v1/cds/exports"));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.Add("X-API-Key", _options.ApiToken);
        request.Content = JsonContent.Create(payload);

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(30));

        HttpResponseMessage response;
        try
        {
            response = await httpClient.SendAsync(request, timeoutCts.Token);
        }
        catch (Exception ex) when (ex is HttpRequestException || (ex is OperationCanceledException && !ct.IsCancellationRequested))
        {
            throw new ClearPortException(StatusCodes.Status502BadGateway, $"Could not reach ClearPort API: {ex.Message}");
        }

        if (response.StatusCode == HttpStatusCode.Unauthorized)
            throw new ClearPortException(StatusCodes.Status502BadGateway, "ClearPort rejected the API token.");
        if ((int)response.StatusCode == 429)
            throw new ClearPortException(429, "ClearPort rate limit reached. Please retry shortly.");

        var rawBody = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            var detail = string.IsNullOrEmpty(rawBody) ? $"HTTP {(int)response.StatusCode} with no response body" : rawBody;
            throw new ClearPortException(StatusCodes.Status502BadGateway, $"ClearPort create failed ({(int)response.StatusCode}): {detail}");
        }

        ClearPortExportResponse? body;
        try
        {
            body = System.Text.Json.JsonSerializer.Deserialize<ClearPortExportResponse>(rawBody, JsonOptions);
        }
        catch (System.Text.Json.JsonException)
        {
            body = null;
        }

        if (body?.Success == false)
        {
            var detail = body.ErrorMessages is { Count: > 0 } messages ? string.Join(" | ", messages) : "ClearPort rejected the customs declaration.";
            throw new ClearPortException(StatusCodes.Status502BadGateway, detail);
        }

        var correlationId = (body?.CorrelationId ?? payload.CorrelationId).Trim();
        if (correlationId.Length == 0)
            throw new ClearPortException(StatusCodes.Status502BadGateway, "ClearPort did not return a correlationId.");

        return correlationId;
    }

    public async Task<byte[]> DownloadPdfAsync(string correlationId, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(_options.ApiToken))
            throw new ClearPortException(StatusCodes.Status503ServiceUnavailable, "ClearPort integration is not configured. Set CLEARPORT_API_TOKEN in appsettings.");

        using var request = new HttpRequestMessage(HttpMethod.Get, CombineUrl($"/v1/cds/exports/{Uri.EscapeDataString(correlationId)}/pdf"));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/pdf"));
        request.Headers.Add("X-API-Key", _options.ApiToken);

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(30));

        HttpResponseMessage response;
        try
        {
            response = await httpClient.SendAsync(request, timeoutCts.Token);
        }
        catch (Exception ex) when (ex is HttpRequestException || (ex is OperationCanceledException && !ct.IsCancellationRequested))
        {
            throw new ClearPortException(StatusCodes.Status502BadGateway, $"Could not download customs PDF: {ex.Message}");
        }

        if (response.StatusCode == HttpStatusCode.Unauthorized)
            throw new ClearPortException(StatusCodes.Status502BadGateway, "ClearPort rejected the API token while downloading the customs PDF.");
        if (response.StatusCode == HttpStatusCode.NotFound)
            throw new ClearPortException(StatusCodes.Status404NotFound, $"ClearPort could not find declaration {correlationId}.");
        if ((int)response.StatusCode == 429)
            throw new ClearPortException(429, "ClearPort rate limit reached while downloading the customs PDF.");
        if (!response.IsSuccessStatusCode)
            throw new ClearPortException(StatusCodes.Status502BadGateway, $"ClearPort PDF download failed ({(int)response.StatusCode}).");

        return await response.Content.ReadAsByteArrayAsync(ct);
    }

    private static readonly System.Text.Json.JsonSerializerOptions JsonOptions = new(System.Text.Json.JsonSerializerDefaults.Web);

    private string CombineUrl(string path) => _options.ApiUrl.TrimEnd('/') + path;
}
