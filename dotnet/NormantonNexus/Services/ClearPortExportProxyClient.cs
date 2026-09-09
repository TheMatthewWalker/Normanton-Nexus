using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace NormantonNexus.Services;

/// <summary>
/// Typed HttpClient wrapper for ClearPort's raw `/v1/cds/exports` proxy —
/// Logistics Sub-phase 8c.4, port of routes/clearportexport.js. A separate,
/// simpler client from IClearPortClient (Sub-phase 8a.5c) rather than a
/// reuse of its CreateExportAsync — same ApiUrl/ApiToken config values
/// (CLEARPORT_API_URL/CLEARPORT_API_TOKEN, so this still binds
/// ClearPortOptions), but a genuinely different, confirmed-real auth-scheme
/// inconsistency already present in the Node app itself: IClearPortClient
/// authenticates with an X-API-Key header (matching
/// routes/shipmentmain.js's own two ClearPort calls), while
/// clearportexport.js authenticates the *identical* endpoint with
/// `Authorization: Bearer &lt;token&gt;` instead. Preserved here rather than
/// silently unified — see ClearPortExportProxyController's own header
/// comment.
///
/// The caller assembles the full CDS declaration payload itself (this app
/// never builds it server-side the way ShipmentCustomsHelper's own
/// ClearPort flow does) — reused verbatim from the request body as a plain
/// JsonElement rather than modelled into a typed request DTO, matching
/// Node's own "validate items/exporter presence, forward everything else
/// blindly" behavior exactly.
///
/// UNVERIFIED against a live ClearPort sandbox or real credentials — same
/// caveat class as IClearPortClient/KuehneNagelClient before real-world
/// confirmation.
/// </summary>
public interface IClearPortExportProxyClient
{
    Task<JsonElement?> SubmitAsync(JsonElement payload, CancellationToken ct);
}

internal sealed class ClearPortExportProxyClient(HttpClient httpClient, IOptions<ClearPortOptions> options) : IClearPortExportProxyClient
{
    private readonly ClearPortOptions _options = options.Value;

    public async Task<JsonElement?> SubmitAsync(JsonElement payload, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(_options.ApiToken))
            throw new ClearPortException(StatusCodes.Status503ServiceUnavailable, "ClearPort integration is not configured. Check CLEARPORT_API_TOKEN in appsettings.");

        using var request = new HttpRequestMessage(HttpMethod.Post, $"{_options.ApiUrl.TrimEnd('/')}/v1/cds/exports")
        {
            Content = JsonContent.Create(payload),
        };
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.ApiToken);

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

        var rawBody = await response.Content.ReadAsStringAsync(ct);

        if (response.StatusCode == HttpStatusCode.Unauthorized)
            throw new ClearPortException(StatusCodes.Status502BadGateway, "ClearPort rejected the API token (401 Unauthorised). Check CLEARPORT_API_TOKEN.");
        if ((int)response.StatusCode == 429)
            throw new ClearPortException(429, "ClearPort rate limit reached (429). Please retry shortly.");
        if (!response.IsSuccessStatusCode)
            throw new ClearPortException((int)response.StatusCode, $"ClearPort returned an error ({(int)response.StatusCode}): {rawBody}");

        try
        {
            return JsonSerializer.Deserialize<JsonElement>(rawBody);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
