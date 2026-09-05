using System.IdentityModel.Tokens.Jwt;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using NormantonNexus.Models;

namespace NormantonNexus.Services;

/// <summary>
/// A SapServer proxy call returned success:false (or a non-2xx status) —
/// carries SapServer's own status code straight through, same as sap.js's
/// makeSapToken-based routes throwing an Error with `.status` set from the
/// upstream response.
///
/// <see cref="ResponseData"/> is the envelope's own `data` field on the failure
/// response, typed as whatever `T` the call site asked for — SapServer's
/// `ApiResponse&lt;T&gt;.Fail()` puts the generic error under
/// `error.message` but the real SAP diagnostic (e.g. the RETURN-table
/// messages from a rejected PO) under `data` (see
/// PurchasingController.CreatePurchaseOrderAndReceipt's `PoMessages`
/// field, always present on both its success AND failure response — both
/// are the same `CreatePoAndReceiptResponse` shape). Previously discarded
/// entirely — every caller only ever saw the generic wrapper text — until
/// Sub-phase 8a.5b's post-migo port needed the real detail, matching
/// Node's own `extractSapErrorMessage` (routes/shipmentcost.js). Cast back
/// to the expected `T` at the catch site.
/// </summary>
public sealed class SapProxyException(int statusCode, string code, string message, object? data = null) : NexusApiException(code, message)
{
    public override int StatusCode { get; } = statusCode;
    public object? ResponseData { get; } = data;
}

/// <summary>
/// Typed HttpClient wrapper for calling SapServer — the C# port of
/// routes/*.js's repeated axios-plus-makeSapToken pattern (sap.js /
/// bapiInspector.js / packaging.js, etc. each hand-roll this; here it's
/// one shared service). Every department Helper that needs SAP data calls
/// through this rather than building its own HttpClient/JWT — see the
/// migration plan's Architecture section (originally slated for the
/// Quality phase, built here in Phase 2/Engineering instead once real
/// research showed Engineering is actually the first real consumer).
///
/// TLS pinning (sap.js's certs/sap-server-cert.pem pattern) is NOT ported
/// yet — this uses the system trust store via a plain HttpClient. Add a
/// pinned HttpClientHandler here if/when that's confirmed still necessary
/// once both apps are actually deployed against real certificates.
/// </summary>
public interface ISapServerClient
{
    /// <summary>
    /// `body` is null for an ordinary GET; a handful of SapServer endpoints
    /// (e.g. Production's check-profit-centre) are declared [HttpGet] but
    /// still read a [FromBody] request, matching Node's own sapGet() helper
    /// (axios.request({ method: 'get', data: body })) — pass one when the
    /// specific endpoint's contract requires it.
    /// </summary>
    Task<T?> GetAsync<T>(string path, int userId, object? body = null, bool longRunning = false, CancellationToken ct = default);
    Task<T?> PostAsync<T>(string path, object body, int userId, bool longRunning = false, CancellationToken ct = default);
    Task<T?> PutAsync<T>(string path, object body, int userId, bool longRunning = false, CancellationToken ct = default);
    Task<T?> DeleteAsync<T>(string path, object? body, int userId, bool longRunning = false, CancellationToken ct = default);
}

internal sealed class SapServerClient(HttpClient httpClient, IOptions<SapServerOptions> options) : ISapServerClient
{
    private readonly SapServerOptions _options = options.Value;

    public Task<T?> GetAsync<T>(string path, int userId, object? body = null, bool longRunning = false, CancellationToken ct = default) =>
        SendAsync<T>(HttpMethod.Get, path, body, userId, longRunning, ct);

    public Task<T?> PostAsync<T>(string path, object body, int userId, bool longRunning = false, CancellationToken ct = default) =>
        SendAsync<T>(HttpMethod.Post, path, body, userId, longRunning, ct);

    public Task<T?> PutAsync<T>(string path, object body, int userId, bool longRunning = false, CancellationToken ct = default) =>
        SendAsync<T>(HttpMethod.Put, path, body, userId, longRunning, ct);

    public Task<T?> DeleteAsync<T>(string path, object? body, int userId, bool longRunning = false, CancellationToken ct = default) =>
        SendAsync<T>(HttpMethod.Delete, path, body, userId, longRunning, ct);

    private async Task<T?> SendAsync<T>(HttpMethod method, string path, object? body, int userId, bool longRunning, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, CombineUrl(_options.Url, path));
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", MakeSapToken(userId));
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(longRunning ? _options.LongRunningTimeoutSeconds : _options.TimeoutSeconds));

        HttpResponseMessage response;
        try
        {
            response = await httpClient.SendAsync(request, timeoutCts.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new SapProxyException(StatusCodes.Status503ServiceUnavailable, "SAP_UNAVAILABLE", "Timed out waiting for SapServer.");
        }
        catch (HttpRequestException ex)
        {
            throw new SapProxyException(StatusCodes.Status503ServiceUnavailable, "SAP_UNAVAILABLE", $"Could not reach SapServer: {ex.Message}");
        }

        var envelope = await response.Content.ReadFromJsonAsync<SapApiEnvelope<T>>(cancellationToken: ct);
        if (envelope is null || !envelope.Success)
        {
            var error = envelope?.Error;
            throw new SapProxyException(
                (int)response.StatusCode,
                error?.Code ?? "SAP_ERROR",
                error?.Message ?? $"SapServer returned {(int)response.StatusCode} with no error body.",
                envelope is null ? null : (object?)envelope.Data);
        }

        return envelope.Data;
    }

    private static string CombineUrl(string baseUrl, string path) =>
        baseUrl.TrimEnd('/') + "/" + path.TrimStart('/');

    /// <summary>Matches sap.js's makeSapToken exactly: {userId}, issuer 'normanton-nexus', audience 'sap-server', 60s expiry.</summary>
    private string MakeSapToken(int userId)
    {
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_options.JwtSecret));
        var credentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var token = new JwtSecurityToken(
            issuer: "normanton-nexus",
            audience: "sap-server",
            claims: [new Claim("userId", userId.ToString())],
            expires: DateTime.UtcNow.AddSeconds(60),
            signingCredentials: credentials);

        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}
