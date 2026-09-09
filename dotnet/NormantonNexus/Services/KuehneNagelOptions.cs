namespace NormantonNexus.Services;

/// <summary>
/// C# equivalent of routes/freightbooking.js's KN_API_URL/KN_CUSTOMER_ID/
/// KN_CUSTOMER_KEY/KN_SECRET_64 env vars — Logistics Sub-phase 8c.3.
/// KN's OAuth token endpoint (https://portal.api.kuehne-nagel.com/oauth2/token)
/// is hardcoded in Node, not configurable, so it stays a constant on
/// KuehneNagelClient rather than a config value here. Secret is already the
/// full `Basic` header value Node sends as-is (KN_SECRET_64 — presumably
/// itself base64(client_id:client_secret), never re-encoded by this app),
/// not a raw client secret this app would need to encode itself.
/// </summary>
public sealed class KuehneNagelOptions
{
    public const string SectionName = "KuehneNagel";

    /// <summary>Real production KN booking endpoint — confirmed against the real (gitignored) .env's KN_API_URL directly, not the stale value in .env.example. Not a secret, so it's a safe default here rather than requiring every environment to repeat it, same as ClearPortOptions.ApiUrl.</summary>
    public string ApiUrl { get; set; } = "https://gateway.api.kuehne-nagel.com/booking/road/v1";
    public string CustomerId { get; set; } = "";
    public string CustomerKey { get; set; } = "";
    public string Secret { get; set; } = "";
}
