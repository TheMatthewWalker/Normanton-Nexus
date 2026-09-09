using NormantonNexus.Models;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Helpers.Admin;

/// <summary>
/// BAPI/RFC Structure Inspector — Phase 9, superadmin-only. Port of
/// routes/bapiInspector.js: a thin proxy in front of SapServer's existing
/// GET /api/function/params (Controllers/FunctionController.cs) that lets a
/// superadmin type in any SAP function module/BAPI name and see its real
/// interface — every IMPORT/EXPORT/TABLE/CHANGING parameter, plus the field
/// list for any structured parameter — straight from SAP itself via
/// RFC_GET_FUNCTION_INTERFACE + DDIF_FIELDINFO_GET.
///
/// Why this exists: several SapServer RFC/BAPI request builders were written
/// against the standard documented shape of a BAPI with no SAP GUI access
/// to confirm field-for-field. This tool lets a superadmin confirm or
/// correct a guessed parameter/table name against the live SAP system
/// directly from the portal instead of needing SAP GUI's own SE37 access.
///
/// The response shape is passed through verbatim (a loose
/// Dictionary&lt;string, object?&gt;, not modelled field-for-field) — this app
/// never interprets it, matching Node's own thin-proxy behavior exactly;
/// ISapServerClient already unwraps SapServer's {success, data, error}
/// envelope and throws SapProxyException on failure, so a lookup failure
/// propagates through the same exception path every other SapServerClient
/// call in this app uses.
/// </summary>
internal static class BapiInspectorHelper
{
    internal static async Task<Dictionary<string, object?>?> LookupAsync(ISapServerClient sap, IAuditLogger audit, string? functionName, int userId, string? actorUsername, string? ipAddress, CancellationToken ct)
    {
        var name = (functionName ?? "").Trim();
        if (name.Length == 0)
            throw new NexusValidationException("functionName is required.");

        try
        {
            var result = await sap.GetAsync<Dictionary<string, object?>>("api/function/params", userId, new { functionName = name }, ct: ct);
            await audit.LogAsync("SAP_OK", actorUsername, $"BAPI structure lookup: {name}", ipAddress, ct);
            return result;
        }
        catch (Exception ex)
        {
            var detail = ex.Message.Length > 200 ? ex.Message[..200] : ex.Message;
            await audit.LogAsync("SAP_ERROR", actorUsername, $"BAPI structure lookup failed: {name} — {detail}", ipAddress, ct);
            throw;
        }
    }
}
