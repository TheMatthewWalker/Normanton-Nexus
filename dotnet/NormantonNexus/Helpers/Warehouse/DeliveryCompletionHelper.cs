using Dapper;
using Microsoft.Data.SqlClient;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Warehouse;

/// <summary>
/// Delivery completion pipeline — port of routes/deliverymain.js's
/// PATCH /:deliveryId/complete, POST /:deliveryId/sync-delivery-quantities,
/// completeOneDelivery, runZdelflagMaintenance, and runGoodsIssueApproval.
/// See WarehouseSapModels.cs's header comment for the SAP-facing DTOs this
/// calls, and its SapGoodsIssueRequest/SapDeliveryChangeRequest doc
/// comments for the real, confirmed-vs-unconfirmed state of each BAPI
/// contract this depends on.
/// </summary>
internal static class DeliveryCompletionHelper
{
    private const decimal Epsilon = 0.001m;   // absorbs float rounding noise -> counts as an exact match
    private const decimal Tolerance = 0.10m;  // 10% either way, per the user's explicit instruction

    private sealed record ZdelflagPalletRow(int PalletId, string? PalletType, decimal? GrossWeight, decimal? PackagingWeight, bool IsOwned);
    private sealed record ZdelflagPackageRow(int PalletId, string? SapMaterial, decimal? SapQuantity, string? SapBatch, string? SapDeliveryItem, string? SapPackagingInstruction);

    // ── Per-item picked-vs-SAP-delivery-quantity comparison ────────────────

    /// <summary>
    /// A different question from the picking-materials panel (which answers
    /// "what's still needed, aggregated per material"). Goods Issue needs
    /// picked quantities to match SAP's own delivery quantity (LIPS-LFIMG)
    /// EXACTLY, per delivery ITEM (not material). Used by both
    /// CompleteGroupAsync's completion gate and SyncDeliveryQuantitiesAsync,
    /// which re-runs this server-side as a guard rather than trusting a
    /// frontend-cached discrepancy list. Mirrors Node's
    /// getDeliveryQuantityMatch exactly.
    /// </summary>
    internal static async Task<DeliveryQuantityMatchResult> GetDeliveryQuantityMatchAsync(SqlConnection connection, ISapServerClient sap, long deliveryId, int userId, CancellationToken ct)
    {
        var lipsRows = await sap.PostAsync<List<SapPicksheetLipsRow>>("api/warehouse/picksheet-materials",
            new SapPicksheetLipsRequest([deliveryId.ToString()]), userId, ct: ct) ?? [];

        var pickedRows = await connection.QueryAsync<(string ItemNumber, decimal PickedQty)>(new CommandDefinition("""
            SELECT pp.sapDeliveryItem AS ItemNumber, SUM(pp.sapQuantity) AS PickedQty
            FROM log.PalletPackages pp
            JOIN log.PalletMain pm ON pm.palletID = pp.palletID
            WHERE pp.sapDelivery = @sapDelivery AND pp.sapMaterial IS NOT NULL AND pm.palletRemoved = 0
            GROUP BY pp.sapDeliveryItem
            """, new { sapDelivery = deliveryId.ToString() }, cancellationToken: ct));
        var pickedByItem = pickedRows.Where(r => !string.IsNullOrWhiteSpace(r.ItemNumber))
            .ToDictionary(r => r.ItemNumber.Trim(), r => r.PickedQty);

        var items = lipsRows.Select(r =>
        {
            var itemNumber = (r.ItemNumber ?? "").Trim();
            var material = (r.MaterialNumber ?? "").Trim();
            var requiredQty = WarehousePicksheetHelper.ParseSapQuantity(r.Quantity);
            var pickedQty = pickedByItem.GetValueOrDefault(itemNumber);
            var diffQty = pickedQty - requiredQty;
            var pctDiff = requiredQty > 0 ? Math.Abs(diffQty) / requiredQty : (pickedQty > 0 ? decimal.MaxValue : 0);
            var status = Math.Abs(diffQty) < Epsilon ? "exact"
                : pctDiff <= Tolerance ? "within-tolerance"
                : "exceeds-tolerance";
            return new DeliveryQuantityMatchItem(itemNumber, material, requiredQty, pickedQty, diffQty, pctDiff, status);
        }).ToList();

        return new DeliveryQuantityMatchResult(items, items.All(i => i.Status == "exact"), items.Any(i => i.Status == "exceeds-tolerance"));
    }

    // ── ZDELFLAG/ZDELPACK maintenance (transaction ZPIL9) ───────────────────

    /// <summary>
    /// Confirms all materials/packaging assigned to a delivery in SAP's own
    /// ZDELFLAG/ZDELPACK tables via Z_MAINT_ZDELFLAG_ZDELPACK. Never throws
    /// — always resolves to a ZdelflagRunResult and writes exactly one row
    /// to log.DeliveryZdelflagRun, so a SAP-side failure here can be
    /// surfaced as a warning (with a reprocess option) rather than blocking
    /// whatever called it. Mirrors Node's runZdelflagMaintenance exactly.
    /// </summary>
    internal static async Task<ZdelflagRunResult> RunZdelflagMaintenanceAsync(SqlConnection connection, ISapServerClient sap, long deliveryId, int? userId, CancellationToken ct)
    {
        async Task<ZdelflagRunResult> RecordRunAsync(string status, List<SapReturnMessage> messages)
        {
            try
            {
                await connection.ExecuteAsync(new CommandDefinition("""
                    INSERT INTO log.DeliveryZdelflagRun (deliveryID, status, messages, ranByUserID)
                    VALUES (@deliveryId, @status, @messages, @ranByUserId)
                    """, new
                {
                    deliveryId = deliveryId.ToString(),
                    status,
                    messages = System.Text.Json.JsonSerializer.Serialize(messages),
                    ranByUserId = userId
                }, cancellationToken: ct));
            }
            catch (Exception err)
            {
                Console.Error.WriteLine($"Failed to record DeliveryZdelflagRun for delivery {deliveryId}: {err.Message}");
            }
            return new ZdelflagRunResult(status, messages);
        }

        var sapUserId = userId ?? 0;
        try
        {
            var customerId = (await connection.QuerySingleOrDefaultAsync<long?>(new CommandDefinition(
                "SELECT customerID FROM log.DeliveryMain WHERE deliveryID = @deliveryId", new { deliveryId }, cancellationToken: ct)))?.ToString() ?? "";

            // Widened the same way GET /:deliveryId/pallets is, to also pick
            // up pallets OWNED by a linked picksheet — IsOwned tells the
            // row-building loop below whether THIS delivery should send the
            // pallet's header row (a pallet borrowed from a linked
            // picksheet still contributes its own package rows, but the
            // pallet's weight/box-count header is the owning delivery's
            // sibling ZDELFLAG call's responsibility, not this one's —
            // sending it twice would double-post that pallet's weight to
            // SAP under two different VBELNs).
            var pallets = (await connection.QueryAsync<ZdelflagPalletRow>(new CommandDefinition("""
                SELECT pm.palletID AS PalletId, pm.palletType AS PalletType, pm.grossWeight AS GrossWeight, pm.packagingWeight AS PackagingWeight,
                       CASE WHEN dl.deliveryID = @deliveryId THEN 1 ELSE 0 END AS IsOwned
                FROM log.PalletMain pm
                INNER JOIN log.DeliveryLink dl ON pm.palletID = dl.palletID
                WHERE pm.palletRemoved = 0
                  AND (dl.deliveryID = @deliveryId
                       OR dl.deliveryID IN (SELECT linkedDeliveryID FROM log.DeliveryPicksheetLink WHERE deliveryID = @deliveryId))
                ORDER BY pm.palletID ASC
                """, new { deliveryId }, cancellationToken: ct))).ToList();

            if (pallets.Count == 0)
            {
                return await RecordRunAsync("Failed", [new SapReturnMessage("E", "No pallets found for this delivery.")]);
            }

            var packages = (await connection.QueryAsync<ZdelflagPackageRow>(new CommandDefinition("""
                SELECT palletID AS PalletId, sapMaterial AS SapMaterial, sapQuantity AS SapQuantity, sapBatch AS SapBatch,
                       sapDeliveryItem AS SapDeliveryItem, sapPackagingInstruction AS SapPackagingInstruction
                FROM log.PalletPackages
                WHERE sapDelivery = @sapDelivery
                ORDER BY palletID ASC, palletItemID ASC
                """, new { sapDelivery = deliveryId.ToString() }, cancellationToken: ct))).ToList();

            var missingBatch = packages.FirstOrDefault(p => !string.IsNullOrEmpty(p.SapMaterial) && string.IsNullOrEmpty(p.SapBatch));
            if (missingBatch is not null)
            {
                var msg = $"Package for material {missingBatch.SapMaterial} on pallet {missingBatch.PalletId} has no batch recorded — cannot maintain ZDELFLAG/ZDELPACK.";
                return await RecordRunAsync("Failed", [new SapReturnMessage("E", msg)]);
            }

            var packagesByPallet = packages.Where(p => !string.IsNullOrEmpty(p.SapMaterial)).ToLookup(p => p.PalletId);

            // SAP lookups needed to fill in the rows.
            var abladResult = await sap.GetAsync<string>($"api/warehouse/zdelflag/likp-ablad/{Uri.EscapeDataString(deliveryId.ToString())}", sapUserId, ct: ct);
            var empst = abladResult ?? "";

            var lipsItemsResult = await sap.GetAsync<List<SapZdelflagLipsItemRow>>($"api/warehouse/zdelflag/lips-items/{Uri.EscapeDataString(deliveryId.ToString())}", sapUserId, ct: ct) ?? [];
            var lipsByPosnr = lipsItemsResult
                .Where(r => !string.IsNullOrWhiteSpace(r.ItemNumber))
                .ToDictionary(r => r.ItemNumber.Trim(), r => r);

            var eikto = "";
            if (customerId.Length > 0)
            {
                eikto = await sap.GetAsync<string>($"api/warehouse/zdelflag/eikto/{Uri.EscapeDataString(customerId)}", sapUserId, ct: ct) ?? "";
            }

            var instructions = packages.Select(p => (p.SapPackagingInstruction ?? "").Trim()).Where(i => i.Length > 0).Distinct().ToList();
            var zbomRows = instructions.Count > 0
                ? await sap.PostAsync<List<SapZbomInfoRow>>("api/warehouse/zdelflag/zbom-info", new SapZbomInfoRequest(instructions), sapUserId, ct: ct) ?? []
                : [];
            var idnrksByInstruction = zbomRows
                .GroupBy(r => r.PackagingInstruction)
                .ToDictionary(g => g.Key, g => g.Select(r => r.ComponentMaterial).ToList());

            // Packaging component weights (T_DELPACK~TAREWEI), keyed by packMaterial (the SAP material number, same as ZBOM_INFO~IDNRK).
            var allIdnrks = idnrksByInstruction.Values.SelectMany(v => v).Distinct().ToList();
            var weightByIdnrk = new Dictionary<string, decimal>();
            if (allIdnrks.Count > 0)
            {
                var pdRows = await connection.QueryAsync<(string PackMaterial, decimal? PackWeight)>(new CommandDefinition(
                    "SELECT packMaterial AS PackMaterial, packWeight AS PackWeight FROM log.PackagingData WHERE packMaterial IS NOT NULL", cancellationToken: ct));
                foreach (var r in pdRows)
                {
                    weightByIdnrk[r.PackMaterial.Trim()] = r.PackWeight ?? 0;
                }
            }

            var budat = DateTime.Now.ToString("yyyyMMdd");
            var (delflagRows, delpackRows, delpackWarnings) = BuildDelflagRows(
                pallets, packagesByPallet, deliveryId, customerId, empst, eikto, lipsByPosnr, idnrksByInstruction, weightByIdnrk, budat);

            var maintainResponse = await sap.PostAsync<SapMaintainZdelflagResponse>("api/warehouse/zdelflag/maintain",
                new SapMaintainZdelflagRequest(delflagRows, delpackRows), sapUserId, ct: ct);

            var messages = maintainResponse?.Messages ?? [];
            var hasBlocker = messages.Any(m => m.Type is "E" or "A");
            if (hasBlocker) return await RecordRunAsync("Failed", messages);

            // SAP's ZDELFLAG/ZDELPACK maintenance BAPI has no per-message
            // severity at all — every successful run echoes back one
            // informational confirmation line, typed 'S', not a real
            // problem. So SAP's own non-blocking messages must NOT push the
            // run into "Warning" — only delpackWarnings (this app's own
            // data-quality checks; SAP itself won't complain about an empty
            // T_DELPACK) should do that.
            if (delpackWarnings.Count > 0)
            {
                var allWarnings = messages.Concat(delpackWarnings.Select(w => new SapReturnMessage("W", w))).ToList();
                return await RecordRunAsync("Warning", allWarnings);
            }
            return await RecordRunAsync("Success", messages);
        }
        catch (Exception err)
        {
            return await RecordRunAsync("Failed", [new SapReturnMessage("E", err.Message)]);
        }
    }

    private static (List<SapDelflagRowRequest> DelflagRows, List<SapDelpackRowRequest> DelpackRows, List<string> DelpackWarnings) BuildDelflagRows(
        IReadOnlyList<ZdelflagPalletRow> pallets, ILookup<int, ZdelflagPackageRow> packagesByPallet,
        long deliveryId, string customerId, string empst, string eikto,
        Dictionary<string, SapZdelflagLipsItemRow> lipsByPosnr, Dictionary<string, List<string>> idnrksByInstruction,
        Dictionary<string, decimal> weightByIdnrk, string budat)
    {
        var delflagRows = new List<SapDelflagRowRequest>();
        var delpackRows = new List<SapDelpackRowRequest>();
        var delpackWarnings = new List<string>();

        foreach (var pallet in pallets)
        {
            var packages = packagesByPallet[pallet.PalletId].ToList();
            var hasType = !string.IsNullOrWhiteSpace(pallet.PalletType);
            var palletFlag = hasType ? "G" : "S";
            var headerPackid = pallet.PalletId * 1000;
            var netWeight = (pallet.GrossWeight ?? 0) - (pallet.PackagingWeight ?? 0);

            if (pallet.IsOwned)
            {
                var firstInstruction = packages.FirstOrDefault(p => !string.IsNullOrEmpty(p.SapPackagingInstruction))?.SapPackagingInstruction ?? "";
                delflagRows.Add(new SapDelflagRowRequest(
                    Vbeln: deliveryId.ToString(), Posnr: "", Charg: "",
                    Kunnr: customerId, Empst: empst, Werks: "3012",
                    Ntgew: netWeight, Brgew: pallet.GrossWeight ?? 0,
                    Kdmat: "", Lfimg: 0, Eikto: eikto, Arktx: "", Matnr: "",
                    Budat: budat, Packid: headerPackid.ToString(), Boxes: packages.Count.ToString(),
                    Pallet: palletFlag, Vhart: "PALL",
                    SmbxMatnr: firstInstruction, PallMatnr: "PALLET", Mtart: "", Smbxhu: "", Done: "X",
                    PrintPalletLabel: true, PrintBoxLabel: false));
            }

            for (var idx = 0; idx < packages.Count; idx++)
            {
                var pkg = packages[idx];
                var packid = (headerPackid + idx + 1).ToString();
                var posnr = (pkg.SapDeliveryItem ?? "").Trim();
                lipsByPosnr.TryGetValue(posnr, out var lipsRow);
                var instr = (pkg.SapPackagingInstruction ?? "").Trim();

                delflagRows.Add(new SapDelflagRowRequest(
                    Vbeln: deliveryId.ToString(), Posnr: posnr, Charg: pkg.SapBatch ?? "",
                    Kunnr: customerId, Empst: empst, Werks: "3012",
                    Ntgew: 0, Brgew: 0,
                    Kdmat: lipsRow?.CustomerMaterial ?? "", Lfimg: pkg.SapQuantity ?? 0,
                    Eikto: eikto, Arktx: lipsRow?.Description ?? "", Matnr: pkg.SapMaterial ?? "",
                    Budat: budat, Packid: packid, Boxes: "1", Pallet: palletFlag, Vhart: "SMBX",
                    SmbxMatnr: instr, PallMatnr: "PALLET", Mtart: "", Smbxhu: packid, Done: "X",
                    PrintPalletLabel: false, PrintBoxLabel: false));

                if (instr.Length == 0)
                {
                    delpackWarnings.Add($"Material {pkg.SapMaterial ?? "?"} on pallet {pallet.PalletId} has no packaging instruction recorded — no ZDELPACK row was created for it.");
                }
                else
                {
                    var idnrks = idnrksByInstruction.GetValueOrDefault(instr) ?? [];
                    if (idnrks.Count == 0)
                    {
                        delpackWarnings.Add($"No ZBOM_INFO packaging components found for instruction \"{instr}\" (material {pkg.SapMaterial ?? "?"} on pallet {pallet.PalletId}) — no ZDELPACK row was created for it.");
                    }
                    foreach (var idnrk in idnrks)
                    {
                        delpackRows.Add(new SapDelpackRowRequest(packid, idnrk, 1m, "EA", weightByIdnrk.GetValueOrDefault(idnrk), "KG"));
                    }
                }
            }
        }

        return (delflagRows, delpackRows, delpackWarnings);
    }

    // ── Goods Issue posting (BAPI_OUTB_DELIVERY_CONFIRM_DEC) ───────────────

    /// <summary>
    /// Fired automatically right after RunZdelflagMaintenanceAsync records
    /// "Success" — no manual approval step. See SapGoodsIssueRequest's doc
    /// comment for why Items (each real delivery item's picked quantity)
    /// is required, confirmed live 2026-08-28 — this was a real, confirmed
    /// gap in Node's own integration, fixed here and in Node together (not
    /// ported bug-compatible).
    /// </summary>
    internal static async Task<GoodsIssueRunResult> RunGoodsIssueApprovalAsync(SqlConnection connection, ISapServerClient sap, long deliveryId, int userId, CancellationToken ct)
    {
        async Task<GoodsIssueRunResult> RecordRunAsync(string status, List<SapReturnMessage> messages)
        {
            try
            {
                await connection.ExecuteAsync(new CommandDefinition("""
                    INSERT INTO log.DeliveryGoodsIssueRun (deliveryID, status, messages)
                    VALUES (@deliveryId, @status, @messages)
                    """, new { deliveryId = deliveryId.ToString(), status, messages = System.Text.Json.JsonSerializer.Serialize(messages) }, cancellationToken: ct));
            }
            catch (Exception err)
            {
                Console.Error.WriteLine($"Failed to record DeliveryGoodsIssueRun for delivery {deliveryId}: {err.Message}");
            }
            return new GoodsIssueRunResult(status, messages);
        }

        try
        {
            var itemRows = await connection.QueryAsync<(string ItemNumber, decimal PickedQty)>(new CommandDefinition("""
                SELECT sapDeliveryItem AS ItemNumber, SUM(sapQuantity) AS PickedQty
                FROM log.PalletPackages
                WHERE sapDelivery = @sapDelivery AND sapMaterial IS NOT NULL
                GROUP BY sapDeliveryItem
                """, new { sapDelivery = deliveryId.ToString() }, cancellationToken: ct));
            var items = itemRows.Where(r => !string.IsNullOrWhiteSpace(r.ItemNumber))
                .Select(r => new SapGoodsIssueItem(r.ItemNumber.Trim(), r.PickedQty))
                .ToList();

            var response = await sap.PostAsync<SapGoodsIssueResponse>("api/warehouse/goods-issue",
                new SapGoodsIssueRequest(deliveryId.ToString(), items), userId, ct: ct);

            var messages = response?.Messages ?? [];
            if (response is null || !response.Success) return await RecordRunAsync("Failed", messages);
            return await RecordRunAsync("Success", messages);
        }
        catch (Exception err)
        {
            return await RecordRunAsync("Failed", [new SapReturnMessage("E", err.Message)]);
        }
    }

    // ── Mark delivery as complete ────────────────────────────────────────

    /// <summary>
    /// Rolls up pallet weights/volume/count, pushes ZDEL, then runs
    /// ZDELFLAG/ZDELPACK maintenance and (only if that succeeds) Goods
    /// Issue — all three best-effort, never blocking completion, each
    /// surfaced as its own warning. If this delivery was sitting in the
    /// packaging holding area (pendingPackagingData=1 — SAP already closed
    /// it outside Nexus), both SAP calls are skipped entirely; completing
    /// here just records the real packaging data locally and clears
    /// pendingPackagingData. Mirrors Node's completeOneDelivery exactly.
    /// </summary>
    internal static async Task<CompleteDeliveryResult> CompleteOneDeliveryAsync(SqlConnection connection, ISapServerClient sap, long deliveryId, int userId, CancellationToken ct)
    {
        var wasHeldForPackaging = await connection.QuerySingleOrDefaultAsync<bool?>(new CommandDefinition(
            "SELECT ISNULL(pendingPackagingData, 0) FROM log.DeliveryMain WHERE deliveryID = @deliveryId", new { deliveryId }, cancellationToken: ct)) == true;

        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.DeliveryMain
            SET completionStatus = 1,
                completionDate   = GETDATE(),
                pendingPackagingData = 0,
                palletCount = (
                    SELECT COUNT(*) FROM log.PalletMain pm INNER JOIN log.DeliveryLink dl ON pm.palletID = dl.palletID
                    WHERE dl.deliveryID = @deliveryId AND pm.palletRemoved = 0),
                grossWeight = (
                    SELECT ISNULL(SUM(pm.grossWeight), 0) FROM log.PalletMain pm INNER JOIN log.DeliveryLink dl ON pm.palletID = dl.palletID
                    WHERE dl.deliveryID = @deliveryId AND pm.palletRemoved = 0),
                netWeight = (
                    SELECT ISNULL(SUM(pm.grossWeight - ISNULL(pm.packagingWeight, 0)), 0) FROM log.PalletMain pm INNER JOIN log.DeliveryLink dl ON pm.palletID = dl.palletID
                    WHERE dl.deliveryID = @deliveryId AND pm.palletRemoved = 0),
                deliveryVolume = (
                    SELECT ISNULL(SUM(pm.palletVolume), 0) FROM log.PalletMain pm INNER JOIN log.DeliveryLink dl ON pm.palletID = dl.palletID
                    WHERE dl.deliveryID = @deliveryId AND pm.palletRemoved = 0)
            WHERE deliveryID = @deliveryId
            """, new { deliveryId }, cancellationToken: ct));

        var totals = await connection.QuerySingleAsync<(int PalletCount, decimal GrossWeight, decimal NetWeight)>(new CommandDefinition(
            "SELECT palletCount AS PalletCount, grossWeight AS GrossWeight, netWeight AS NetWeight FROM log.DeliveryMain WHERE deliveryID = @deliveryId",
            new { deliveryId }, cancellationToken: ct));

        string? sapWarning = null, zdelflagWarning = null, goodsIssueWarning = null, note = null;

        if (wasHeldForPackaging)
        {
            note = "This delivery was already completed in SAP outside Nexus — packaging data has been recorded locally and it's now available for shipment creation. ZDEL and ZDELFLAG/ZDELPACK were not re-sent to SAP.";
        }
        else
        {
            try
            {
                var response = await sap.PostAsync<SapSetDeliveryWeightResponse>("api/warehouse/set-delivery-weight",
                    new SapSetDeliveryWeightRequest(deliveryId.ToString(), totals.GrossWeight, totals.NetWeight, totals.PalletCount), userId, ct: ct);
                if (response is null)
                {
                    sapWarning = "SAP rejected the ZDEL weight update.";
                }
            }
            catch (Exception sapErr)
            {
                sapWarning = $"Could not update SAP (ZDEL) with the actual weights/pallet count: {sapErr.Message}. Update LIKP manually.";
            }

            var zdelflagResult = await RunZdelflagMaintenanceAsync(connection, sap, deliveryId, null, ct);
            if (zdelflagResult.Status != "Success")
            {
                var joined = string.Join("; ", zdelflagResult.Messages.Select(m => m.Message).Where(m => !string.IsNullOrEmpty(m)));
                zdelflagWarning = joined.Length > 0 ? joined : $"ZDELFLAG/ZDELPACK maintenance did not complete successfully ({zdelflagResult.Status}).";
            }
            else
            {
                // Goods Issue only fires once ZDELFLAG/ZDELPACK maintenance
                // itself succeeded — posting GI for a delivery whose
                // packaging never made it into SAP would be posting
                // against incomplete data.
                var goodsIssueResult = await RunGoodsIssueApprovalAsync(connection, sap, deliveryId, userId, ct);
                if (goodsIssueResult.Status != "Success")
                {
                    var joined = string.Join("; ", goodsIssueResult.Messages.Select(m => m.Message).Where(m => !string.IsNullOrEmpty(m)));
                    goodsIssueWarning = joined.Length > 0 ? joined : $"Goods Issue posting did not complete successfully ({goodsIssueResult.Status}).";
                }
            }
        }

        return new CompleteDeliveryResult(totals.PalletCount, totals.GrossWeight, totals.NetWeight, sapWarning, zdelflagWarning, goodsIssueWarning, note, wasHeldForPackaging);
    }

    /// <summary>
    /// PATCH /:deliveryId/complete — resolves the linked group (this
    /// delivery + everything currently linked to it), requires every
    /// member's picked quantities to match SAP's own delivery quantities
    /// EXACTLY (skipped for a member already sitting in packaging holding —
    /// SAP already closed it outside Nexus), then completes every member
    /// in owner-first order (whichever delivery owns a shared pallet must
    /// run its own ZDELFLAG call before a member merely borrowing that
    /// pallet). Mirrors Node's route handler exactly.
    /// </summary>
    internal static async Task<CompleteDeliveryGroupResult> CompleteGroupAsync(INexusOperationsDb db, ISapServerClient sap, long deliveryId, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var linkedIds = (await connection.QueryAsync<long>(new CommandDefinition(
            "SELECT linkedDeliveryID FROM log.DeliveryPicksheetLink WHERE deliveryID = @deliveryId", new { deliveryId }, cancellationToken: ct))).ToList();
        var groupIds = new List<long> { deliveryId };
        groupIds.AddRange(linkedIds);

        var exceeding = new List<DeliveryQuantityOutstanding>();
        var withinTol = new List<DeliveryQuantityOutstanding>();
        foreach (var id in groupIds)
        {
            var isHeld = await connection.QuerySingleOrDefaultAsync<bool?>(new CommandDefinition(
                "SELECT ISNULL(pendingPackagingData, 0) FROM log.DeliveryMain WHERE deliveryID = @id", new { id }, cancellationToken: ct));
            if (isHeld == true) continue;

            var match = await GetDeliveryQuantityMatchAsync(connection, sap, id, userId, ct);
            var bad = match.Items.Where(i => i.Status == "exceeds-tolerance").ToList();
            var soft = match.Items.Where(i => i.Status == "within-tolerance").ToList();
            if (bad.Count > 0) exceeding.Add(new DeliveryQuantityOutstanding(id.ToString(), bad));
            if (soft.Count > 0) withinTol.Add(new DeliveryQuantityOutstanding(id.ToString(), soft));
        }

        if (exceeding.Count > 0)
        {
            var error = groupIds.Count > 1
                ? "Cannot complete — one or more linked picksheets have items more than 10% off the SAP delivery quantity."
                : "Cannot complete — one or more items are more than 10% off the SAP delivery quantity.";
            return new CompleteDeliveryGroupResult("BLOCKED", "exceeds-tolerance", error, exceeding, null, null);
        }
        if (withinTol.Count > 0)
        {
            return new CompleteDeliveryGroupResult("BLOCKED", "within-tolerance",
                "Picked quantities don't exactly match SAP's delivery quantities, but are within 10% — update SAP automatically?", withinTol, null, null);
        }

        // Owner-first ordering: for every pallet any group member has,
        // whichever delivery actually OWNS it (log.DeliveryLink) must run
        // its ZDELFLAG call before any group member merely borrowing that
        // pallet runs its own package-only call.
        var ownerIds = (await connection.QueryAsync<long>(new CommandDefinition($"""
            SELECT DISTINCT dl.deliveryID
            FROM log.DeliveryLink dl
            JOIN log.PalletMain pm ON pm.palletID = dl.palletID
            WHERE pm.palletRemoved = 0 AND dl.deliveryID IN @groupIds
            """, new { groupIds }, cancellationToken: ct))).ToHashSet();
        var orderedGroupIds = groupIds.Where(id => ownerIds.Contains(id)).Concat(groupIds.Where(id => !ownerIds.Contains(id))).ToList();

        var results = new Dictionary<string, CompleteDeliveryResult>();
        foreach (var id in orderedGroupIds)
        {
            results[id.ToString()] = await CompleteOneDeliveryAsync(connection, sap, id, userId, ct);
        }

        return new CompleteDeliveryGroupResult("COMPLETE", null, null, null,
            results[deliveryId.ToString()], groupIds.Count > 1 ? results : null);
    }

    /// <summary>
    /// POST /:deliveryId/sync-delivery-quantities — applies an automatic
    /// SAP delivery-quantity correction (BAPI_OUTB_DELIVERY_CHANGE) for
    /// every within-tolerance item across the linked group, one SAP call
    /// per delivery. Re-derives the group and re-runs the quantity match
    /// itself (defense in depth — the frontend's discrepancy list could be
    /// stale). Deliberately does NOT call CompleteOneDeliveryAsync itself —
    /// the frontend re-calls complete after this succeeds. Mirrors Node's
    /// route handler exactly, including auditing every outcome.
    /// </summary>
    internal static async Task<SyncDeliveryQuantitiesResult> SyncDeliveryQuantitiesAsync(
        INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit, long deliveryId, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var linkedIds = (await connection.QueryAsync<long>(new CommandDefinition(
            "SELECT linkedDeliveryID FROM log.DeliveryPicksheetLink WHERE deliveryID = @deliveryId", new { deliveryId }, cancellationToken: ct))).ToList();
        var groupIds = new List<long> { deliveryId };
        groupIds.AddRange(linkedIds);

        var corrections = new List<(long DeliveryId, List<DeliveryQuantityMatchItem> Items)>();
        foreach (var id in groupIds)
        {
            var match = await GetDeliveryQuantityMatchAsync(connection, sap, id, userId, ct);
            if (match.AnyExceedsTolerance)
            {
                return new SyncDeliveryQuantitiesResult(false, 409,
                    $"Delivery #{id} now has an item more than 10% off the SAP delivery quantity — check picking before retrying.");
            }
            var soft = match.Items.Where(i => i.Status == "within-tolerance").ToList();
            if (soft.Count > 0) corrections.Add((id, soft));
        }

        if (corrections.Count == 0)
        {
            return new SyncDeliveryQuantitiesResult(false, 409, "Nothing needs correcting — picked quantities already match SAP exactly.");
        }

        foreach (var (id, items) in corrections)
        {
            var sapItems = items.Select(i => new SapDeliveryChangeItem(i.ItemNumber, i.Material, i.PickedQty)).ToList();

            SapDeliveryChangeResponse? response;
            try
            {
                response = await sap.PostAsync<SapDeliveryChangeResponse>("api/warehouse/delivery-change",
                    new SapDeliveryChangeRequest(id.ToString(), sapItems), userId, ct: ct);
            }
            catch (Exception err)
            {
                await audit.LogAsync("SAP_ERROR", username, $"Delivery #{id} sync-delivery-quantities failed - {err.Message}", ipAddress, ct);
                return new SyncDeliveryQuantitiesResult(false, 422, $"Delivery #{id}: {err.Message}");
            }

            if (response is null || !response.Success)
            {
                var message = response?.Messages is { Count: > 0 } msgs
                    ? string.Join("; ", msgs.Select(m => m.Message).Where(m => !string.IsNullOrEmpty(m)))
                    : "SAP rejected the delivery quantity change.";
                await audit.LogAsync("SAP_ERROR", username, $"Delivery #{id} sync-delivery-quantities failed - {message}", ipAddress, ct);
                return new SyncDeliveryQuantitiesResult(false, 422, $"Delivery #{id}: {message}");
            }

            await audit.LogAsync("SAP_OK", username, $"Delivery #{id} sync-delivery-quantities succeeded ({items.Count} item(s))", ipAddress, ct);
        }

        return new SyncDeliveryQuantitiesResult(true, 200, null);
    }
}
