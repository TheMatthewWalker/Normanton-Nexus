using System.Text.Json;
using NormantonNexus.Models;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Validation for ClearPort's raw `/v1/cds/exports` proxy — Logistics
/// Sub-phase 8c.4, port of routes/clearportexport.js's own inline guards.
/// Catches obvious mistakes early (missing items/exporter) before a round
/// trip to ClearPort; everything else in the payload is forwarded blindly,
/// same as Node.
/// </summary>
internal static class ClearPortExportProxyHelper
{
    internal static void ValidatePayload(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object)
            throw new NexusValidationException("Request body must be a JSON object.");

        if (!payload.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array || items.GetArrayLength() == 0)
            throw new NexusValidationException("Declaration must include at least one item.");

        if (!payload.TryGetProperty("exporter", out var exporter) || exporter.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            throw new NexusValidationException("Declaration must include an exporter.");
    }
}
