using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Real SAP purchase-order/goods-receipt posting and reversal for freight
/// cost lines — Logistics Sub-phase 8a.5b. Port of routes/shipmentcost.js's
/// POST /post-migo and POST /:costId/reverse, deliberately split out of
/// Sub-phase 8a.5a (the plain CRUD/read routes) given this is the single
/// highest-business-risk endpoint identified anywhere in this migration
/// plan: it creates a real SAP purchase order and goods receipt under the
/// CALLING USER'S OWN SAP credentials (decrypted just-in-time via
/// ISapCredentialCipher — the shared service account has no PO-creation
/// rights and isn't being given any), via SapServer's elevated
/// POST /api/purchasing/create-po-and-receipt.
///
/// Same not-yet-ported-inbound-leg gap as Sub-phase 8a.5a's GET
/// /unprocessed and /processed: the cost-line lookup query here is a 2-way
/// UNION ALL (outbound + manual only) where Node's is 3-way (+ inbound,
/// log.PurchaseOrderShipment). A caller posting cost IDs that only exist on
/// the inbound side gets "No unprocessed records found for the given IDs"
/// instead of a real posting attempt — flagged, not silently different,
/// until Sub-phase 8b lands the inbound leg everywhere else it's missing.
///
/// costType/log.CostTypes.typeID's real column types (NVARCHAR(3) vs
/// BIGINT respectively — see log.ShipmentCost's DDL) look mismatched for
/// a 7-character code like "ITLG01A" the domain comments describe; ported
/// exactly as Node's own WHERE typeID = @typeID does (relying on SQL
/// Server's implicit conversion), per this migration's "schema stays
/// as-is" principle — not something to silently "fix" here.
/// </summary>
internal static class ShipmentCostSapPostingHelper
{
    private const string FetchQuery = """
        SELECT sc.costID AS CostId, sc.costCenter AS CostCenter, sc.costElement AS CostElement, sc.costType AS CostType, sc.expectedCost AS ExpectedCost, sc.modeOfTransport AS ModeOfTransport,
            sc.purchaseOrder AS PurchaseOrder, sc.poLineNumber AS PoLineNumber,
            'outbound' AS Direction, 'outbound' AS SourceType, sm.shipmentID AS RefId,
            RIGHT('00000000' + CONVERT(VARCHAR(12), sm.shipmentID), 8) AS ShipmentRef,
            sm.forwarderID AS ForwarderId, sm.actualCollection AS ActualCollection, sm.ActualDelivery AS DeliveredDate, sm.trackingNumber AS TrackingNumber,
            sm.destinationCountry AS DestinationCountry, sm.destinationPostCode AS DestinationPostCode
        FROM log.ShipmentCost sc
        INNER JOIN log.ShipmentMain sm ON sm.shipmentID = sc.shipmentID
        WHERE sc.costID IN @costIds AND ISNULL(sc.migoStatus, 0) = 0

        UNION ALL

        SELECT sc.costID AS CostId, sc.costCenter AS CostCenter, sc.costElement AS CostElement, sc.costType AS CostType, sc.expectedCost AS ExpectedCost, sc.modeOfTransport AS ModeOfTransport,
            sc.purchaseOrder AS PurchaseOrder, sc.poLineNumber AS PoLineNumber,
            ISNULL(ce.direction, 'outbound') AS Direction, 'manual' AS SourceType, sc.costID AS RefId,
            sc.manualReference AS ShipmentRef,
            sc.manualForwarderID AS ForwarderId, sc.manualIncurredDate AS ActualCollection, sc.manualIncurredDate AS DeliveredDate, sc.manualTrackingNumber AS TrackingNumber,
            sc.manualCountry AS DestinationCountry, sc.manualPostcode AS DestinationPostCode
        FROM log.ShipmentCost sc
        OUTER APPLY (SELECT TOP 1 direction FROM log.CostElements WHERE elementCode = sc.costElement) ce
        WHERE sc.costID IN @costIds AND ISNULL(sc.migoStatus, 0) = 0 AND sc.shipmentID IS NULL AND sc.poShipmentID IS NULL
        """;
    // CostElements is joined via OUTER APPLY ... TOP 1, not a plain LEFT JOIN — the table has no
    // unique constraint on elementCode, so a duplicate row would otherwise fan this UNION branch
    // out and post the SAME cost line to SAP (MIGO) twice for one costID. Same fix already
    // applied to ShipmentCostHelper's queries and Node's own routes/shipmentcost.js.

    private sealed class FetchedCostRow
    {
        public long CostId { get; set; }
        public string? CostCenter { get; set; }
        public string? CostElement { get; set; }
        public string? CostType { get; set; }
        public decimal? ExpectedCost { get; set; }
        public string? ModeOfTransport { get; set; }
        public string? PurchaseOrder { get; set; }
        public int? PoLineNumber { get; set; }
        public string Direction { get; set; } = "";
        public string SourceType { get; set; } = "";
        public long RefId { get; set; }
        public string? ShipmentRef { get; set; }
        public long? ForwarderId { get; set; }
        public DateTime? ActualCollection { get; set; }
        public DateTime? DeliveredDate { get; set; }
        public string? TrackingNumber { get; set; }
        public string? DestinationCountry { get; set; }
        public string? DestinationPostCode { get; set; }
    }

    private sealed class SapCredentialsRow
    {
        public string? SapUsername { get; set; }
        public string? SapPasswordEncrypted { get; set; }
    }

    internal static async Task<PostMigoResult> PostMigoAsync(
        INexusOperationsDb db, INexusDb nexusDb, ISapServerClient sap, ISapCredentialCipher credentialCipher,
        IReadOnlyList<long> costIds, int userId, CancellationToken ct)
    {
        if (costIds.Count == 0)
            throw new NexusValidationException("costIDs array is required.");

        using var connection = await db.CreateConnectionAsync(ct);
        var fetched = (await connection.QueryAsync<FetchedCostRow>(new CommandDefinition(FetchQuery, new { costIds }, cancellationToken: ct))).AsList();

        if (fetched.Count == 0)
            throw new NexusNotFoundException("No unprocessed records found for the given IDs.");

        var blockedCostIds = fetched.Where(r => r.DeliveredDate is null).Select(r => r.CostId).ToList();
        var deliverable = fetched.Where(r => r.DeliveredDate is not null).ToList();

        if (deliverable.Count == 0)
            return new PostMigoResult([], blockedCostIds, "None of the selected lines have been delivered/received yet — nothing to post.");

        var results = new List<PostMigoLineResult>();

        // A line that already carries a purchaseOrder (from an earlier
        // attempt whose PO creation succeeded but whose goods receipt
        // failed) must NEVER go through create-po-and-receipt again — that
        // would create a genuinely second, duplicate purchase order for the
        // same freight cost, orphaning the first one forever with no goods
        // receipt (confirmed live: costID 66, PO 4500438488, 2026-09-09).
        // These are retried individually against the PO/item SAP already
        // committed, via SapServer's plain, non-elevated post-goods-receipt
        // — no per-user SAP credentials needed for this leg at all, since
        // only PO creation requires the calling user's own elevated session.
        var retryRows = deliverable.Where(r => !string.IsNullOrEmpty(r.PurchaseOrder)).ToList();
        var freshRows = deliverable.Where(r => string.IsNullOrEmpty(r.PurchaseOrder)).ToList();

        foreach (var line in retryRows)
        {
            var deliveredDayStr = (line.DeliveredDate ?? DateTime.UtcNow).ToString("yyyy-MM-dd");
            var lineNumber = line.PoLineNumber ?? 1; // manual lines are always their own single-item PO — 1 is correct even if somehow unset.
            try
            {
                var bdc = await sap.PostAsync<BdcResponse>("api/purchasing/post-goods-receipt",
                    new GoodsReceiptRequest(line.PurchaseOrder!, lineNumber, line.ShipmentRef ?? "", line.TrackingNumber ?? "",
                        Prefix2(line.DestinationCountry) + Prefix2(line.DestinationPostCode), deliveredDayStr, DateTime.UtcNow.ToString("yyyy-MM-dd"), null),
                    userId, ct: ct) ?? throw new NexusBadGatewayException("SapServer returned an empty response.");

                var succeeded = bdc.Type != "E" && bdc.Type != "A" && !string.IsNullOrWhiteSpace(bdc.DocumentNumber);
                if (succeeded)
                {
                    await connection.ExecuteAsync(new CommandDefinition("""
                        UPDATE log.ShipmentCost SET migoStatus = 1, materialDocument = @materialDocument WHERE costID = @costId
                        """, new { costId = line.CostId, materialDocument = bdc.DocumentNumber }, cancellationToken: ct));
                    results.Add(new PostMigoLineResult(line.RefId, line.Direction, line.CostId, true, line.PurchaseOrder, bdc.DocumentNumber, null));
                }
                else
                {
                    var error = string.IsNullOrEmpty(bdc.Message) ? bdc.RawMessage : bdc.Message;
                    results.Add(new PostMigoLineResult(line.RefId, line.Direction, line.CostId, false, line.PurchaseOrder,
                        null, string.IsNullOrWhiteSpace(error) ? "Goods receipt failed again — the purchase order already exists in SAP (see above); contact SAP support with this PO/item to diagnose." : error));
                }
            }
            catch (SapProxyException sapEx)
            {
                results.Add(new PostMigoLineResult(line.RefId, line.Direction, line.CostId, false, line.PurchaseOrder, null, sapEx.Message));
            }
        }

        if (freshRows.Count == 0)
            return new PostMigoResult(results, blockedCostIds, null);

        using var nexusConnection = await nexusDb.CreateConnectionAsync(ct);
        var sapCreds = await nexusConnection.QuerySingleOrDefaultAsync<SapCredentialsRow>(new CommandDefinition(
            "SELECT SapUsername, SapPasswordEncrypted FROM dbo.PortalUsers WHERE UserID = @userId", new { userId }, cancellationToken: ct));

        if (string.IsNullOrEmpty(sapCreds?.SapUsername) || string.IsNullOrEmpty(sapCreds.SapPasswordEncrypted))
        {
            var error = results.Count > 0
                ? "You need to save your SAP username and password in My Account before posting the remaining costs to SAP."
                : "You need to save your SAP username and password in My Account before posting costs to SAP.";
            return new PostMigoResult(results, blockedCostIds, error);
        }

        var sapPassword = credentialCipher.Decrypt(sapCreds.SapPasswordEncrypted);
        var today = DateTime.UtcNow.ToString("yyyy-MM-dd");

        // Sequential on purpose — matches Node's own reasoning: the elevated
        // worker pool only has a handful of slots and each call already does
        // logon->PO->commit->GR-per-line->logoff as one unit of work, so
        // there's nothing to gain from firing every group concurrently.
        foreach (var group in freshRows.GroupBy(r => (r.SourceType, r.RefId)))
        {
            var rows = group.ToList();
            var first = rows[0];
            var deliveredDayStr = (first.DeliveredDate ?? DateTime.UtcNow).ToString("yyyy-MM-dd");
            var location = Prefix2(first.DestinationCountry) + Prefix2(first.DestinationPostCode);

            List<SapCreatePoAndReceiptItem> items;
            try
            {
                items = [];
                foreach (var line in rows)
                {
                    var materialGroup = await ResolveMaterialGroupAsync(connection, line.CostType, ct);
                    items.Add(new SapCreatePoAndReceiptItem(
                        Material: null, ShortText: $"Freight - {first.Direction} shipment {first.ShipmentRef}", Quantity: 1, Unit: "EA",
                        NetPrice: line.ExpectedCost ?? 0, DeliveryDate: deliveredDayStr, AcctAssCat: "K", MaterialGroup: materialGroup,
                        GlAccount: line.CostElement, CostCenterOrOrder: line.CostCenter, Reference: first.ShipmentRef ?? "",
                        TrackingNumber: first.TrackingNumber ?? "", AddressCode: location, ShipmentCompletionDate: deliveredDayStr, PostingDate: today));
                }
            }
            catch (NexusApiException lookupEx)
            {
                foreach (var line in rows)
                    results.Add(new PostMigoLineResult(first.RefId, first.Direction, line.CostId, false, null, null, lookupEx.Message));
                continue;
            }

            try
            {
                var vendor = first.ForwarderId is null or 0 ? "" : first.ForwarderId.Value.ToString();
                var response = await sap.PostAsync<SapCreatePoAndReceiptResponse>(
                    "api/purchasing/create-po-and-receipt",
                    new SapCreatePoAndReceiptRequest(sapCreds.SapUsername, sapPassword, vendor, "GBP", today, items),
                    userId, longRunning: true, ct: ct)
                    ?? throw new NexusBadGatewayException("SapServer returned an empty response.");

                for (var i = 0; i < rows.Count; i++)
                {
                    var line = rows[i];
                    var lineResult = i < response.Lines.Count ? response.Lines[i] : null;

                    // Defensive belt-and-braces on top of the SapServer-side fix (2026-09-09, see
                    // that repo's PurchasingController.CreatePurchaseOrderAndReceipt): a real
                    // production incident (PO 4500438460) came back Success=true with
                    // DocumentNumber="" (empty, not null) for a goods receipt SAP had actually
                    // rejected — `DocumentNumber: not null` alone let that through and flipped
                    // migoStatus=1 with no real material document. Require a genuinely non-blank
                    // document number, not just non-null.
                    if (lineResult is { Success: true } && !string.IsNullOrWhiteSpace(lineResult.DocumentNumber))
                    {
                        await connection.ExecuteAsync(new CommandDefinition("""
                            UPDATE log.ShipmentCost SET migoStatus = 1, materialDocument = @materialDocument, purchaseOrder = @purchaseOrder
                            WHERE costID = @costId
                            """, new { costId = line.CostId, materialDocument = lineResult.DocumentNumber, purchaseOrder = response.PurchaseOrder }, cancellationToken: ct));
                        results.Add(new PostMigoLineResult(first.RefId, first.Direction, line.CostId, true, response.PurchaseOrder, lineResult.DocumentNumber, null));
                    }
                    else
                    {
                        var error = lineResult?.Error ?? (!response.PoSuccess ? "Purchase order creation failed" : "Goods receipt failed");

                        // The PO creation leg is confirmed successful whenever response.PoSuccess
                        // is true (SapServer only returns this shape at all once BAPI_PO_CREATE1
                        // + BAPI_TRANSACTION_COMMIT have both run) — that PO now genuinely, and
                        // permanently, exists in SAP regardless of this line's own goods-receipt
                        // outcome. Persisting it here is what lets a later retry target the
                        // existing PO instead of calling create-po-and-receipt again and creating
                        // a second, duplicate one (confirmed live: costID 66, PO 4500438488,
                        // 2026-09-09 — this exact branch left the PO completely untracked before).
                        if (response.PoSuccess)
                        {
                            await connection.ExecuteAsync(new CommandDefinition("""
                                UPDATE log.ShipmentCost SET purchaseOrder = @purchaseOrder, poLineNumber = @poLineNumber
                                WHERE costID = @costId
                                """, new { costId = line.CostId, purchaseOrder = response.PurchaseOrder, poLineNumber = i + 1 }, cancellationToken: ct));
                        }
                        results.Add(new PostMigoLineResult(first.RefId, first.Direction, line.CostId, false, response.PurchaseOrder, null, error));
                    }
                }
            }
            catch (SapProxyException sapEx)
            {
                var message = ExtractSapErrorMessage(sapEx, "Purchase order creation failed. Transaction rolled back.");
                foreach (var line in rows)
                    results.Add(new PostMigoLineResult(first.RefId, first.Direction, line.CostId, false, null, null, message));
            }
        }

        return new PostMigoResult(results, blockedCostIds, null);
    }

    internal static async Task<ReverseShipmentCostResult> ReverseAsync(INexusOperationsDb db, ISapServerClient sap, long costId, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var row = await connection.QuerySingleOrDefaultAsync<ReversibleCostRow>(new CommandDefinition(
            "SELECT costID AS CostId, migoStatus AS MigoStatus, materialDocument AS MaterialDocument FROM log.ShipmentCost WHERE costID = @costId",
            new { costId }, cancellationToken: ct))
            ?? throw new NexusNotFoundException("Cost line not found.");

        if (row.MigoStatus != true || string.IsNullOrEmpty(row.MaterialDocument))
            throw new NexusValidationException("This line has not been posted to SAP yet — nothing to reverse.");

        var bdc = await sap.PostAsync<BdcResponse>("api/purchasing/reverse-goods-receipt", new Mf41Request(row.MaterialDocument), userId, ct: ct)
            ?? throw new NexusBadGatewayException("SapServer returned an empty response.");

        var reversed = bdc.Type == "S";
        if (reversed)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "UPDATE log.ShipmentCost SET migoStatus = 0, materialDocument = NULL WHERE costID = @costId",
                new { costId }, cancellationToken: ct));
        }

        return new ReverseShipmentCostResult(reversed, string.IsNullOrEmpty(bdc.Message) ? bdc.RawMessage : bdc.Message, bdc);
    }

    private sealed class ReversibleCostRow
    {
        public long CostId { get; set; }
        public bool? MigoStatus { get; set; }
        public string? MaterialDocument { get; set; }
    }

    /// <summary>Confirms costType is a real, currently-known SAP Material Group code before it's ever sent to SAP — fail-before-SAP, matching resolveMaterialGroup's own header comment in Node.</summary>
    private static async Task<string> ResolveMaterialGroupAsync(System.Data.IDbConnection connection, string? costType, CancellationToken ct)
    {
        var value = (costType ?? "").Trim();
        if (value.Length == 0)
            throw new NexusUnprocessableEntityException(
                "This cost line has no Cost Type set — Cost Type is now the SAP Material Group, so one must be picked before it can post to SAP.");

        var found = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "SELECT typeID FROM log.CostTypes WHERE typeID = @typeId", new { typeId = value }, cancellationToken: ct));

        if (found is null)
            throw new NexusUnprocessableEntityException(
                $"Cost Type \"{value}\" is not a recognised SAP Material Group code — check it on the Cost Types list before posting.");

        return value;
    }

    /// <summary>Port of extractSapErrorMessage — SapServer's generic wrapper text plus the real SAP RETURN-table detail from PoMessages, when present.</summary>
    internal static string ExtractSapErrorMessage(SapProxyException ex, string fallback)
    {
        var baseMessage = string.IsNullOrEmpty(ex.Message) ? fallback : ex.Message;
        if (ex.ResponseData is SapCreatePoAndReceiptResponse { PoMessages.Count: > 0 } data)
        {
            var detail = string.Join("; ", data.PoMessages
                .Where(m => !string.IsNullOrEmpty(m.Message))
                .Select(m => string.IsNullOrEmpty(m.Type) ? m.Message : $"[{m.Type}] {m.Message}"));
            if (detail.Length > 0) return $"{baseMessage} {detail}";
        }
        return baseMessage;
    }

    internal static string Prefix2(string? value) =>
        string.IsNullOrEmpty(value) ? "" : (value.Length <= 2 ? value : value[..2]).ToUpperInvariant();
}
