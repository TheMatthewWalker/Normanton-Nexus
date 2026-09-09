using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// SAP customs-data lookup for ClearPort declarations — Logistics
/// Sub-phase 8a.5c. Port of routes/shipmentmain.js's fetchSapCustomsData,
/// which itself is a proxy: Node's version makes a self-referential HTTP
/// loopback call to this same app's own /api/sap/lips etc. (routes/sap.js),
/// which then forwards to SapServer's real api/customs/lips etc. — an
/// artifact of Express having no easy way to call another route's handler
/// logic directly without a real HTTP round trip. This port skips that
/// workaround entirely and calls SapServer directly via ISapServerClient
/// (same as every other Helper in this app), matching SapServer's own
/// CustomsController (api/customs/lips/likp/vbfa/marc/kna1) — see that
/// controller's header comment: it deliberately checks NO per-user
/// permission (only ever called via a real portal user's own token here,
/// same as every other SapServerClient call in this app), so the real
/// gate is this app's own LOG_CUSTOMS_REPORT-equivalent permission on the
/// route calling this Helper.
/// </summary>
internal static class SapCustomsDataHelper
{
    internal static async Task<SapCustomsData> FetchAsync(ISapServerClient sap, IReadOnlyList<long> deliveryIds, int userId, CancellationToken ct)
    {
        var sapDeliveryNumbers = deliveryIds.Select(d => d.ToString()).ToList();

        // Round 1 — parallel: LIPS (line items) + LIKP (delivery header).
        var lipsTask = sap.PostAsync<List<LipsRow>>("api/customs/lips", new { deliveries = sapDeliveryNumbers }, userId, ct: ct);
        var likpTask = sap.PostAsync<List<LikpRow>>("api/customs/likp", new { deliveries = sapDeliveryNumbers }, userId, ct: ct);
        await Task.WhenAll(lipsTask, likpTask);
        var lipsData = lipsTask.Result ?? [];
        var likpData = likpTask.Result ?? [];

        if (lipsData.Count == 0)
            throw new NexusUnprocessableEntityException("SAP returned no delivery line items (LIPS). Verify delivery numbers exist in SAP with WERKS 3012 and quantity > 0.");

        // Round 2 — parallel: VBFA (invoice/stat value per line) + MARC (commodity/origin per material) + KNA1 (customer country).
        var lineItems = lipsData.Select(r => new { delivery = r.DeliveryNumber, item = r.ItemNumber }).ToList();
        var materials = lipsData.Select(r => (r.MaterialNumber ?? "").Trim()).Where(m => m.Length > 0).Distinct().ToList();
        var customers = likpData.Select(r => (r.ConsigneeCode ?? "").Trim()).Where(c => c.Length > 0).Distinct().ToList();

        var vbfaTask = sap.PostAsync<List<VbfaRow>>("api/customs/vbfa", new { lines = lineItems }, userId, ct: ct);
        var marcTask = materials.Count > 0 ? sap.PostAsync<List<MarcRow>>("api/customs/marc", new { materials }, userId, ct: ct) : Task.FromResult<List<MarcRow>?>([]);
        // kna1Data is fetched to mirror Node's own fetchSapCustomsData exactly, even though
        // buildClearPortShipmentPayload never actually reads it (Node destructures only
        // lipsData/likpData/vbfaData/marcData from this method's return value) — a real,
        // confirmed vestigial fetch in the original app, preserved rather than silently
        // dropped in case a future caller (or Node itself, later) starts relying on it.
        var kna1Task = customers.Count > 0 ? sap.PostAsync<List<Kna1Row>>("api/customs/kna1", new { customers }, userId, ct: ct) : Task.FromResult<List<Kna1Row>?>([]);
        await Task.WhenAll(vbfaTask, marcTask, kna1Task);

        return new SapCustomsData(lipsData, likpData, vbfaTask.Result ?? [], marcTask.Result ?? [], kna1Task.Result ?? []);
    }
}
