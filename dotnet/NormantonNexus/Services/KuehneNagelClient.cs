using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Services;

/// <summary>A Kuehne+Nagel API call failed — always maps to 502 regardless of KN's own real status code, same "collapse an upstream failure to 502, embed the real detail in the message" precedent ClearPortClient already established for this app's other external customs/logistics integration.</summary>
public sealed class KuehneNagelException(string message) : NexusApiException("KN_ERROR", message)
{
    public override int StatusCode => StatusCodes.Status502BadGateway;
}

/// <summary>
/// Typed HttpClient wrapper for Kuehne+Nagel — Logistics Sub-phase 8c.3.
/// Port of routes/freightbooking.js's getKnAccessToken/booking-creation/
/// document-upload axios calls. UNVERIFIED against a live KN sandbox or
/// real credentials — no live KN access has been reachable in any
/// environment this port has been developed in, same caveat class as
/// ClearPortClient/SmtpMailer before real-world confirmation.
///
/// Deliberately thin: returns the deserialized 2xx response body and lets
/// FreightBookingHelper decide what an in-band failure (bookingIsSuccessful/
/// uploadIsSuccessful: false on an otherwise-2xx response) means for the
/// caller — that's response-shaping, not a generic HTTP-client concern.
/// </summary>
public interface IKuehneNagelClient
{
    Task<string> GetAccessTokenAsync(CancellationToken ct);
    Task<Dictionary<string, object?>?> CreateBookingAsync(KnBookingPayload payload, string accessToken, CancellationToken ct);
    Task<Dictionary<string, object?>?> UploadDocumentAsync(KnDocumentUploadPayload payload, string accessToken, CancellationToken ct);
}

internal sealed class KuehneNagelClient(HttpClient httpClient, IOptions<KuehneNagelOptions> options) : IKuehneNagelClient
{
    private const string TokenUrl = "https://portal.api.kuehne-nagel.com/oauth2/token";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly KuehneNagelOptions _options = options.Value;

    public async Task<string> GetAccessTokenAsync(CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, TokenUrl)
        {
            Content = new FormUrlEncodedContent([new KeyValuePair<string, string>("grant_type", "client_credentials")]),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Basic", _options.Secret);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(15));

        HttpResponseMessage response;
        try
        {
            response = await httpClient.SendAsync(request, timeoutCts.Token);
        }
        catch (Exception ex) when (ex is HttpRequestException || (ex is OperationCanceledException && !ct.IsCancellationRequested))
        {
            throw new KuehneNagelException($"KN OAuth request failed: {ex.Message}");
        }

        var rawBody = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
            throw new KuehneNagelException($"KN OAuth error {(int)response.StatusCode}: {rawBody}");

        var body = Deserialize<KnTokenResponse>(rawBody);
        if (string.IsNullOrEmpty(body?.AccessToken))
            throw new KuehneNagelException("KN OAuth response did not include an access_token.");

        return body.AccessToken;
    }

    public async Task<Dictionary<string, object?>?> CreateBookingAsync(KnBookingPayload payload, string accessToken, CancellationToken ct) =>
        await PostAsync($"{_options.ApiUrl}/bookings", payload, accessToken, "KN booking", ct);

    public async Task<Dictionary<string, object?>?> UploadDocumentAsync(KnDocumentUploadPayload payload, string accessToken, CancellationToken ct) =>
        await PostAsync($"{_options.ApiUrl}/documents", payload, accessToken, "KN document upload", ct, TimeSpan.FromSeconds(120));

    private async Task<Dictionary<string, object?>?> PostAsync(string url, object payload, string accessToken, string label, CancellationToken ct, TimeSpan? timeout = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = JsonContent.Create(payload, options: JsonOptions),
        };
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/problem+json"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout ?? TimeSpan.FromSeconds(30));

        HttpResponseMessage response;
        try
        {
            response = await httpClient.SendAsync(request, timeoutCts.Token);
        }
        catch (Exception ex) when (ex is HttpRequestException || (ex is OperationCanceledException && !ct.IsCancellationRequested))
        {
            throw new KuehneNagelException($"Could not reach KN API ({label}): {ex.Message}");
        }

        var rawBody = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
            throw new KuehneNagelException($"{label} API error {(int)response.StatusCode}: {rawBody}");

        return Deserialize<Dictionary<string, object?>>(rawBody);
    }

    private static T? Deserialize<T>(string json)
    {
        try { return JsonSerializer.Deserialize<T>(json, JsonOptions); }
        catch (JsonException) { return default; }
    }

    private sealed record KnTokenResponse(
        [property: JsonPropertyName("access_token")] string? AccessToken,
        [property: JsonPropertyName("token_type")] string? TokenType,
        [property: JsonPropertyName("expires_in")] int ExpiresIn);
}
