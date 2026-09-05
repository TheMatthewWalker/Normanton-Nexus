using Dapper;
using Microsoft.Data.SqlClient;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// Drumming's entry flow — port of routes/productionnexus.js's
/// submitDrumming, backing POST /drumming/stock and /drumming/customer.
/// Unlike the CO/BR/CL/TW/EX draft→complete wizard (MetreProcessHelper),
/// Drumming has no separate draft step: the record is created already
/// COMPLETE (Status=4) in one request, immediately followed by the same
/// BOM-vs-traceability hard block, concession-covered goods-movement
/// posting, and braid-consumption auto-backflush the wizard uses — plus
/// Drumming's own two extras neither EX/CO/BR/CL/TW have: the re-drum
/// reversal check (a drum can only be re-processed once its original has
/// been reversed) and the combined ZF40N + Z_ZPRODBATCH_MAINT backflush
/// (SapServer's drumming-backflush endpoint, not plain backflush).
/// </summary>
internal static class DrummingHelper
{
    private const int MaxCoilLengths = 1000;

    /// <summary>
    /// A DR parent link means "re-drum this batch" — only allowed once the
    /// original drum has actually been reversed (prod.Drumming.IsReversed),
    /// which today only ever gets set by Warehouse/Staging's own
    /// redrumReversal.js — not yet ported (see dotnet/CLAUDE.md's soft
    /// cross-department dependency note). Mirrors Node's
    /// assertParentBatchesReversed exactly, including the message text NOT
    /// using the same hyphenated "DR-00000001" form BuildBatchRef below
    /// does — a real, preserved Node inconsistency, not a typo introduced here.
    /// </summary>
    private static async Task AssertParentBatchesReversedAsync(SqlConnection connection, IReadOnlyList<ParentBatchRef> parentBatches, CancellationToken ct)
    {
        var drParents = parentBatches.Where(pb =>
            string.Equals(pb.ProcessCode, "DR", StringComparison.OrdinalIgnoreCase) && pb.RecordId is not null);

        foreach (var pb in drParents)
        {
            var isReversed = await connection.QuerySingleOrDefaultAsync<bool?>(new CommandDefinition(
                "SELECT IsReversed FROM prod.Drumming WHERE DrummingID = @id", new { id = pb.RecordId!.Value }, cancellationToken: ct));

            if (isReversed is not true)
            {
                throw new NexusConflictException(
                    $"This drum cannot be processed, as the original drum (DR{pb.RecordId:D8}) " +
                    "has not been correctly reversed yet. Please seek advice from a supervisor.");
            }
        }
    }

    /// <summary>Mirrors Node's resolveTraceabilityMaterials — the real Material each linked traceability parent's own record carries, for SapServer's drumming-backflush BOM-mismatch check (which has no access to prod.ProductionTrace itself). Also reused directly by FailedBackflushHelper's DR retry branch.</summary>
    internal static async Task<List<string>> ResolveTraceabilityMaterialsAsync(SqlConnection connection, IReadOnlyList<ParentBatchRef> parentBatches, CancellationToken ct)
    {
        var materials = new HashSet<string>();
        foreach (var pb in parentBatches)
        {
            if (string.IsNullOrWhiteSpace(pb.ProcessCode) || pb.RecordId is null) continue;
            if (!ProductionSapHelpers.Process.TryGetValue(pb.ProcessCode, out var cfg)) continue;

            var mat = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
                $"SELECT Material FROM {cfg.Table} WHERE {cfg.Pk} = @id", new { id = pb.RecordId.Value }, cancellationToken: ct));
            if (mat is not null) materials.Add(mat);
        }
        return materials.ToList();
    }

    /// <summary>
    /// Braiding never posts its own SAP backflush (the braiding work
    /// centre's own raw-material BOM data is unreliable), so a braided
    /// semi-finished material never actually lands in SAP stock — this
    /// backflushes it on demand, for exactly the quantity this drum's own
    /// BOM calls for, before the drum's own backflush runs. Returns []
    /// with no SAP calls when there are no BR parents (the common case).
    /// Throws on a real SAP posting failure (a raw-material consumption
    /// failure here should fail the whole drum submission, not pass
    /// silently and leave SAP stock wrong) — never on a braid material
    /// simply not being a BOM component of this drum, which is logged and
    /// skipped instead. Mirrors Node's backflushBraidedComponents exactly.
    /// </summary>
    private static async Task<List<BraidConsumptionResult>> BackflushBraidedComponentsAsync(
        SqlConnection connection, ISapServerClient sap, string material, decimal totalLength,
        IReadOnlyList<ParentBatchRef> parentBatches, int userId, CancellationToken ct)
    {
        var braidParents = parentBatches
            .Where(pb => string.Equals(pb.ProcessCode, "BR", StringComparison.OrdinalIgnoreCase) && pb.RecordId is not null)
            .ToList();
        if (braidParents.Count == 0) return [];

        var results = new List<BraidConsumptionResult>();
        var bomCache = new Dictionary<string, SapBomRow?>();

        foreach (var pb in braidParents)
        {
            var braidingId = pb.RecordId!.Value;

            var braid = await connection.QuerySingleOrDefaultAsync<(string BraidRef, string Material, bool IsReversed)?>(new CommandDefinition(
                "SELECT BraidRef, Material, IsReversed FROM prod.Braiding WHERE BraidingID = @id", new { id = braidingId }, cancellationToken: ct));
            if (braid is null) continue; // unresolvable parent — nothing to backflush or log against

            if (braid.Value.IsReversed)
            {
                await ProductionEventLogHelper.WriteEventAsync(connection, "BR", braidingId, "NOTE",
                    $"Drum for {material} traced to this braid batch after it was reversed — skipped, no braid backflush posted.", 2, userId, ct);
                continue;
            }

            var braidMaterial = braid.Value.Material;

            if (!bomCache.TryGetValue(braidMaterial, out var bomRow))
            {
                try
                {
                    var rows = await sap.GetAsync<List<SapBomRow>>("api/production/bom", userId, new SapBomQuery(material, braidMaterial), ct: ct) ?? [];
                    bomRow = rows.FirstOrDefault();
                }
                catch
                {
                    bomRow = null;
                }
                bomCache[braidMaterial] = bomRow;
            }

            if (bomRow is null || bomRow.ComponentQty <= 0)
            {
                await ProductionEventLogHelper.WriteEventAsync(connection, "BR", braidingId, "NOTE",
                    $"Drum for {material} traces to this braid batch, but {braidMaterial} isn't a BOM component of {material} (or has a zero quantity) — no braid backflush posted.", 1, userId, ct);
                continue;
            }

            var qty = Math.Round(bomRow.ComponentQty * totalLength, 3);
            if (qty <= 0) continue;

            BdcResponse sapRaw;
            try
            {
                sapRaw = await sap.PostAsync<BdcResponse>("api/production/backflush",
                    new Zf40nRequest(braidMaterial, qty, braid.Value.BraidRef, "", "", ""), userId, ct: ct)
                    ?? throw new InvalidOperationException("SapServer returned no backflush result.");
            }
            catch (Exception err)
            {
                throw new NexusBadGatewayException($"Braid consumption backflush failed for {braidMaterial} (batch {braid.Value.BraidRef}, {qty:F3} M): {err.Message}");
            }

            string sapMatDoc;
            try
            {
                sapMatDoc = ProductionSapHelpers.ParseSapBackflush(sapRaw);
            }
            catch (Exception err)
            {
                throw new NexusBadGatewayException($"Braid consumption backflush rejected for {braidMaterial} (batch {braid.Value.BraidRef}, {qty:F3} M): {err.Message}");
            }

            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,IsSuccess,PostedByUserID)
                VALUES ('BR',@braidingId,'BACKFLUSH',@qty,'M',@sapMatDoc,1,@userId)
                """, new { braidingId, qty, sapMatDoc, userId }, cancellationToken: ct));

            await ProductionEventLogHelper.WriteEventAsync(connection, "BR", braidingId, "SAP_POST",
                $"Backflushed {qty:F3} M against {braid.Value.BraidRef} — consumed by a drum of {material} (BOM ratio {bomRow.ComponentQty} {bomRow.ComponentUnit ?? "M"} per unit). MatDoc: {sapMatDoc}.", 0, userId, ct);

            results.Add(new BraidConsumptionResult(braidingId, braid.Value.BraidRef, braidMaterial, qty, sapMatDoc));
        }

        return results;
    }

    /// <summary>POST /drumming/stock or /drumming/customer — entryType comes from which literal route was called, not the request body. Mirrors Node's submitDrumming exactly.</summary>
    internal static async Task<DrummingSubmitResult> SubmitAsync(
        INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit,
        string entryType, DrummingSubmitRequest body, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        var coilLengths = body.CoilLengths ?? [];
        if (coilLengths.Count == 0 || coilLengths.Count > MaxCoilLengths)
        {
            throw new NexusValidationException($"coilLengths must contain between 1 and {MaxCoilLengths} items.");
        }

        var material = body.Material?.Trim();
        if (string.IsNullOrWhiteSpace(material) || string.IsNullOrWhiteSpace(body.PackagingId) || body.WeightKg is not (> 0))
        {
            throw new NexusValidationException("material, packagingId, weightKg and at least one coilLength are required.");
        }
        var weightKg = body.WeightKg.Value;

        var parentBatches = body.ParentBatches ?? [];
        var rawMaterialBatches = body.RawMaterialBatches ?? [];

        using var connection = await db.CreateConnectionAsync(ct);

        await AssertParentBatchesReversedAsync(connection, parentBatches, ct);
        await ProductionSapHelpers.AssertProfitCentreAsync(sap, "DR", material, userId, ct);

        var shiftId = body.ShiftId ?? ProductionSapHelpers.CurrentShiftId();
        var totalLength = coilLengths.Sum();

        var drummingId = await connection.QuerySingleAsync<int>(new CommandDefinition("""
            INSERT INTO prod.Drumming
                (ShiftID,Material,LengthMetres,WeightKG,PackagingType,CustomerID,SalesOrderSAP,OrderItem,
                 EntryType,Status,StartedAt,CompletedAt,CreatedByUserID,Notes)
            OUTPUT INSERTED.DrummingID
            VALUES (@shiftId,@material,@totalLength,@weightKg,@packagingId,@customerNumber,@orderNumber,@orderItem,
                    @entryType,4,GETDATE(),GETDATE(),@userId,@comments)
            """, new
        {
            shiftId,
            material,
            totalLength,
            weightKg,
            packagingId = body.PackagingId,
            customerNumber = string.IsNullOrWhiteSpace(body.CustomerNumber) ? null : body.CustomerNumber,
            orderNumber = string.IsNullOrWhiteSpace(body.OrderNumber) ? null : body.OrderNumber,
            orderItem = string.IsNullOrWhiteSpace(body.OrderItem) ? null : body.OrderItem,
            entryType,
            userId,
            comments = body.Comments
        }, cancellationToken: ct));

        // Download and save the BOM into the job the moment its material is
        // known (Drumming has no separate draft step — this is the earliest
        // point a record/recordID exists to save it against). A failed
        // lookup here isn't fatal to record creation — it just means the
        // pre-backflush hard block below treats every traceability link as
        // unverifiable and blocks on it, same as any other BOM-lookup failure.
        List<BomRow> drBomRows = [];
        try
        {
            drBomRows = (await BomHelper.FetchBomAsync(sap, material, userId, ct)).ToList();
            await BomHelper.PersistBomSnapshotAsync(connection, "DR", drummingId, material, drBomRows, ct);
        }
        catch (Exception ex)
        {
            await ProductionEventLogHelper.WriteEventAsync(connection, "DR", drummingId, "NOTE", $"BOM download failed: {ex.Message}", 1, userId, ct);
        }

        for (var i = 0; i < coilLengths.Count; i++)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "INSERT INTO prod.DrummingCoils (DrummingID,CoilSeq,LengthM) VALUES (@drummingId,@seq,@length)",
                new { drummingId, seq = i + 1, length = coilLengths[i] }, cancellationToken: ct));
        }

        await connection.ExecuteAsync(new CommandDefinition(
            "INSERT INTO prod.BatchOperators (ProcessCode,ProcessRecordID,UserID,IsPrimary,AssignedByUserID) VALUES ('DR',@drummingId,@userId,1,@userId)",
            new { drummingId, userId }, cancellationToken: ct));

        foreach (var pb in parentBatches)
        {
            if (string.IsNullOrWhiteSpace(pb.ProcessCode) || pb.RecordId is null) continue;
            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO prod.ProductionTrace (ChildProcessCode,ChildRecordID,ParentProcessCode,ParentRecordID,LinkedByUserID)
                VALUES ('DR',@drummingId,@parentCode,@parentRecordId,@userId)
                """, new { drummingId, parentCode = pb.ProcessCode.ToUpperInvariant(), parentRecordId = pb.RecordId.Value, userId }, cancellationToken: ct));
        }

        await BomHelper.PersistRawMaterialBatchesAsync(connection, "DR", drummingId, userId, rawMaterialBatches, ct);

        if (body.HasScrap && body.ScrapReasons is { Count: > 0 })
        {
            await MetreProcessHelper.RecordScrapAsync(connection, "DR", drummingId, body.ScrapTotalKg, body.ScrapReasons, userId, ct);
        }

        await ProductionEventLogHelper.WriteEventAsync(connection, "DR", drummingId, "STARTED",
            $"Drumming ({entryType}) created: {material} {totalLength:F3} M {weightKg} KG", 0, userId, ct);

        var drumRef = $"DR-{drummingId:D8}";

        // BOM-vs-traceability hard block — checked BEFORE any SAP posting at
        // all (including the braid-consumption backflush below), so a
        // blocked submission never partially posts to SAP. Uses the BOM
        // rows just downloaded above (or [] if that failed), not a fresh
        // re-read — mirrors Node exactly.
        var drTraceRows = (await connection.QueryAsync<ParentBatchLink>(new CommandDefinition(
            "SELECT ParentProcessCode AS ProcessCode, ParentRecordID AS RecordId FROM prod.ProductionTrace WHERE ChildProcessCode = 'DR' AND ChildRecordID = @drummingId",
            new { drummingId }, cancellationToken: ct))).ToList();

        var drProblems = await BomHelper.ValidateTraceabilityAgainstBomAsync(connection, drTraceRows, drBomRows, ct);
        var drBlocking = await BomHelper.UnresolvedProblemsAsync(connection, "DR", drummingId, drProblems, ct);
        var drRawProblems = await BomHelper.ValidateRawMaterialBatchesAsync(connection, "DR", drummingId, drBomRows, ct);

        if (drBlocking.Count > 0 || drRawProblems.Count > 0)
        {
            var suffix = drBlocking.Count > 0
                ? " Raise a concession from the traceability screen, or use \"Refresh BOM\" if SAP's BOM has since been corrected."
                : "";
            var errMsg = $"Blocked: {string.Join(" ", drBlocking.Concat(drRawProblems).Select(p => p.Reason))}{suffix}";

            await connection.ExecuteAsync(new CommandDefinition(
                "UPDATE prod.Drumming SET Status = 6 WHERE DrummingID = @drummingId", new { drummingId }, cancellationToken: ct));
            await ProductionEventLogHelper.WriteEventAsync(connection, "DR", drummingId, "SAP_FAIL", errMsg, 2, userId, ct);

            return new DrummingSubmitResult(drummingId, drumRef, null, null, false, "BLOCKED", false, null, errMsg);
        }

        var drConcessions = drProblems.Count > 0
            ? await BomHelper.ApprovedConcessionsAsync(connection, "DR", drummingId, ct)
            : [];

        try
        {
            // Resolve what each traceability link the operator entered
            // actually points at — SapServer needs the real materials to
            // check against this drum's BOM, not the portal process-
            // code/record-id references stored in prod.ProductionTrace.
            var traceMaterials = await ResolveTraceabilityMaterialsAsync(connection, parentBatches, ct);

            // Backflush any braided (BR) traceability parents FIRST —
            // braiding never posts its own SAP backflush, so this drum's
            // own backflush below can't rely on that stock already
            // existing. A failure here throws, caught by the same catch
            // block below as a drumming-backflush failure — deliberately:
            // don't post the drum's own backflush if the raw material it
            // consumed couldn't be accounted for in SAP.
            var braidConsumption = await BackflushBraidedComponentsAsync(connection, sap, material, totalLength, parentBatches, userId, ct);
            if (braidConsumption.Count > 0)
            {
                var summary = string.Join(", ", braidConsumption.Select(b => $"{b.BraidRef} ({b.Quantity:F3} M, MatDoc {b.DocumentNumber})"));
                await ProductionEventLogHelper.WriteEventAsync(connection, "DR", drummingId, "NOTE",
                    $"Backflushed braided component(s) before drum backflush: {summary}.", 0, userId, ct);

                foreach (var b in braidConsumption)
                {
                    await connection.ExecuteAsync(new CommandDefinition("""
                        UPDATE prod.ProductionTrace SET QuantityConsumed = @qty, UnitOfMeasure = 'M', MaterialDocumentSAP = @doc
                        WHERE ChildProcessCode = 'DR' AND ChildRecordID = @drummingId AND ParentProcessCode = 'BR' AND ParentRecordID = @braidingId
                        """, new { qty = b.Quantity, doc = b.DocumentNumber, drummingId, braidingId = b.BraidingId }, cancellationToken: ct));
                }
            }

            string? sapMatDoc, sapBatch = null;
            string? messageNumber = null;
            bool bomMismatch = false;
            string[] expectedComponents = [], actualComponents = [];
            bool concessionApplied = false;

            if (drConcessions.Count > 0)
            {
                // Concession-covered — bypass the normal automatic BOM-driven
                // backflush entirely and post every component explicitly
                // instead (correct ones included) so the automatic backflush
                // can't also silently consume the original wrong material on
                // top of this explicit posting.
                var components = BomHelper.BuildActualComponentList(drBomRows, drConcessions, totalLength);
                var sapComponents = components.Select(c => new SapGoodsMovementComponent(c.Material, c.Quantity, c.Unit, c.StorageLocation)).ToList();

                var gmResponse = await sap.PostAsync<SapGoodsMovementResponse>("api/production/goods-movement-backflush",
                    new SapGoodsMovementRequest(material, drumRef, sapComponents), userId, ct: ct);

                if (gmResponse is null || !gmResponse.Success || string.IsNullOrEmpty(gmResponse.MaterialDocument))
                {
                    var msg = gmResponse?.Messages is { Count: > 0 } msgs
                        ? string.Join(" ", msgs.Select(m => m.Message).Where(m => !string.IsNullOrEmpty(m)))
                        : "";
                    throw new InvalidOperationException(string.IsNullOrEmpty(msg) ? "Goods movement rejected — no material document returned." : msg);
                }

                sapMatDoc = gmResponse.MaterialDocument;
                concessionApplied = true;
                await audit.LogAsync("SAP_OK", username, $"'{drumRef}' BACKFLUSHED (concession, goods movement) - Material Document = '{sapMatDoc}'", ipAddress, ct);

                await connection.ExecuteAsync(new CommandDefinition("""
                    INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,IsSuccess,PostedByUserID)
                    VALUES ('DR',@drummingId,'BACKFLUSH',@totalLength,'M',@sapMatDoc,1,@userId)
                    """, new { drummingId, totalLength, sapMatDoc, userId }, cancellationToken: ct));

                var componentsDesc = string.Join(", ", components.Select(c => $"{c.Material} x{c.Quantity}"));
                await ProductionEventLogHelper.WriteEventAsync(connection, "DR", drummingId, "SAP_POST",
                    $"Backflush posted via concession goods movement — MatDoc: {sapMatDoc}. Components: {componentsDesc}.", 0, userId, ct);

                foreach (var c in drConcessions)
                {
                    await connection.ExecuteAsync(new CommandDefinition(
                        "UPDATE prod.TraceabilityConcessions SET AppliedAt = GETDATE(), MaterialDocumentSAP = @sapMatDoc WHERE ConcessionID = @concessionId",
                        new { sapMatDoc, concessionId = c.ConcessionId }, cancellationToken: ct));
                }
            }
            else
            {
                var sapResponse = await sap.PostAsync<SapDrumBackflushResponse>("api/production/drumming-backflush",
                    new SapDrumBackflushRequest(material, totalLength, drumRef, body.CustomerNumber ?? "", body.PackagingId, weightKg, traceMaterials), userId, ct: ct)
                    ?? throw new InvalidOperationException("SapServer returned no backflush result.");

                var zf = sapResponse.Backflush;
                if (!(zf.Type == "S" && zf.MessageClass == "RM" && zf.MessageNumber is "190" or "191"))
                {
                    throw new InvalidOperationException(zf.Message is { Length: > 0 } m ? m : $"SAP backflush rejected: {zf.Type} {zf.MessageClass} {zf.MessageNumber}");
                }

                sapMatDoc = sapResponse.MaterialDocument is { Length: > 0 } ? sapResponse.MaterialDocument : zf.DocumentNumber;
                sapBatch = string.IsNullOrEmpty(sapResponse.Batch) ? null : sapResponse.Batch;
                messageNumber = zf.MessageNumber;
                bomMismatch = sapResponse.BomMismatch;
                expectedComponents = sapResponse.ExpectedComponents;
                actualComponents = sapResponse.ActualComponents;

                await audit.LogAsync("SAP_OK", username,
                    $"'{drumRef}' BACKFLUSHED - Material Document = '{sapMatDoc}'{(sapBatch is not null ? $" - Batch = '{sapBatch}'" : "")}", ipAddress, ct);

                if (messageNumber == "190")
                {
                    await ProductionSapHelpers.LogBackflushAlertAsync(connection, "DR", drummingId, drumRef, sapMatDoc, messageNumber, zf.Message, ct);
                    await ProductionEventLogHelper.WriteEventAsync(connection, "DR", drummingId, "NOTE",
                        $"SAP 190: No component consumption — MatDoc: {sapMatDoc}. Flagged for data review.", 1, userId, ct);
                }

                await connection.ExecuteAsync(new CommandDefinition("""
                    INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,MaterialDocumentSAP,SAPBatchNumber,IsSuccess,PostedByUserID)
                    VALUES ('DR',@drummingId,'BACKFLUSH',@totalLength,'M',@sapMatDoc,@sapBatch,1,@userId)
                    """, new { drummingId, totalLength, sapMatDoc, sapBatch, userId }, cancellationToken: ct));

                var rcSuffix = (sapResponse.RcBatch is { Length: > 0 } rcb && rcb != "0" ? $" — Z_ZPRODBATCH_MAINT RC_BATCH={rcb}" : "")
                             + (sapResponse.RcPack is { Length: > 0 } rcp && rcp != "0" ? $" RC_PACK={rcp}" : "");
                await ProductionEventLogHelper.WriteEventAsync(connection, "DR", drummingId, "SAP_POST",
                    $"Backflush posted — MatDoc: {sapMatDoc}{(sapBatch is not null ? $", Batch: {sapBatch}" : "")}{(messageNumber == "190" ? " (190: no components consumed)" : "")}{rcSuffix}", 0, userId, ct);
            }

            // BOM vs traceability mismatch — defense-in-depth only now that
            // the pre-backflush hard block above catches this before SAP is
            // ever called; kept here (never blocks) in case SapServer's own
            // internal check catches something this portal-side check
            // couldn't. Never fires for the concession path above, which
            // doesn't call drumming-backflush (and therefore SapServer's own
            // internal check) at all.
            string? bomWarning = null;
            if (bomMismatch)
            {
                var expectedText = expectedComponents.Length > 0 ? string.Join(", ", expectedComponents) : "(no components found)";
                var actualText = actualComponents.Length > 0 ? string.Join(", ", actualComponents) : "(none)";
                bomWarning = $"Traceability does not match this material's BOM — expected {expectedText}, traceability shows {actualText}.";

                await ProductionEventLogHelper.WriteEventAsync(connection, "DR", drummingId, "NOTE",
                    $"BOM mismatch: backflushed {material}, BOM expects {expectedText}, traceability shows {actualText} (entered by {username ?? $"user #{userId}"}).", 2, userId, ct);
            }

            // Locally patch the AgreementSnapshot row's dock-stock figure so
            // the Required quantity operators see on Order Lookup / the
            // Production Schedule report reflects this drum immediately,
            // rather than waiting for the next 30-min sync. Self-healing
            // regardless of outcome — the next sync overwrites this row
            // with fresh SAP truth either way, so a failure here is only a
            // warning, never a reason to fail the whole submission.
            string? stockSyncWarning = null;
            if (entryType == "customer" && !string.IsNullOrWhiteSpace(body.OrderNumber) && !string.IsNullOrWhiteSpace(body.OrderItem))
            {
                try
                {
                    await connection.ExecuteAsync(new CommandDefinition("""
                        UPDATE log.AgreementSnapshot
                        SET DockStockAllocated = ISNULL(DockStockAllocated,0) + @totalLength
                        WHERE OriginalDoc = @orderNumber AND OriginalDocItem = @orderItem
                        """, new { totalLength, orderNumber = body.OrderNumber, orderItem = body.OrderItem }, cancellationToken: ct));
                }
                catch
                {
                    stockSyncWarning = "Drum posted successfully, but the live order-schedule figure could not be refreshed immediately (it will catch up on the next sync).";
                }
            }

            var sapWarning = messageNumber == "190" ? "SAP 190: posted but no components consumed — flagged for data review." : null;
            var warning = string.Join(" ", new[] { sapWarning, bomWarning, stockSyncWarning }.Where(w => !string.IsNullOrEmpty(w)));

            return new DrummingSubmitResult(drummingId, drumRef, sapMatDoc, sapBatch, bomMismatch, "COMPLETE", concessionApplied,
                warning.Length > 0 ? warning : null, null);
        }
        catch (Exception sapErr) when (sapErr is not NexusApiException)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "UPDATE prod.Drumming SET Status = 6 WHERE DrummingID = @drummingId", new { drummingId }, cancellationToken: ct));

            var errMsg = sapErr.Message;
            await audit.LogAsync("SAP_ERROR", username, $"'{drumRef}' FAILED - Message = \"{errMsg}\"", ipAddress, ct);

            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO prod.SAPPostings (ProcessCode,ProcessRecordID,PostingType,Quantity,UnitOfMeasure,IsSuccess,ErrorMessage,PostedByUserID)
                VALUES ('DR',@drummingId,'BACKFLUSH',@totalLength,'M',0,@errMsg,@userId)
                """, new { drummingId, totalLength, errMsg, userId }, cancellationToken: ct));

            await ProductionEventLogHelper.WriteEventAsync(connection, "DR", drummingId, "SAP_FAIL", $"SAP backflush failed: {errMsg}", 2, userId, ct);

            return new DrummingSubmitResult(drummingId, drumRef, null, null, false, "SAP_FAILED",
                false, "Record saved but SAP backflush failed. See failed backflush queue.", errMsg);
        }
    }

    internal static async Task<IReadOnlyList<DrummingCoilRow>> GetCoilsAsync(INexusOperationsDb db, int drummingId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<DrummingCoilRow>(new CommandDefinition(
            "SELECT CoilID AS CoilId, CoilSeq, LengthM FROM prod.DrummingCoils WHERE DrummingID = @drummingId ORDER BY CoilSeq",
            new { drummingId }, cancellationToken: ct));
        return rows.ToArray();
    }

    /// <summary>Quick check for the traceability safeguard's instant client-side feedback — the authoritative server-side check is AssertParentBatchesReversedAsync above, applied at submission time.</summary>
    internal static async Task<DrummingReversalStatusResult> GetReversalStatusAsync(INexusOperationsDb db, int drummingId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var isReversed = await connection.QuerySingleOrDefaultAsync<bool?>(new CommandDefinition(
            "SELECT IsReversed FROM prod.Drumming WHERE DrummingID = @drummingId", new { drummingId }, cancellationToken: ct));

        if (isReversed is null) throw new NexusNotFoundException("Drumming record not found.");
        return new DrummingReversalStatusResult(isReversed.Value);
    }

    /// <summary>GET drumming/data — filtered query for analysts, same shape/precedent as MetreProcessHelper.GetDataAsync.</summary>
    internal static async Task<IReadOnlyList<DrummingDataRow>> GetDataAsync(INexusOperationsDb db, DrummingDataQuery query, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<DrummingDataRow>(new CommandDefinition("""
            SELECT d.DrummingID AS DrummingId, d.DrumRef, d.ShiftID AS ShiftId, s.ShiftName,
                   d.Material, d.LengthMetres, d.PackagingType, d.TestPressurePSI AS TestPressurePsi,
                   d.SalesOrderSAP AS SalesOrderSap, d.CustomerID AS CustomerId, d.CustomerOrderNo,
                   d.Status, d.IsReversed, sc.StatusName, d.StartedAt, d.CompletedAt, d.Notes,
                   pu.Username AS CreatedBy
            FROM prod.Drumming d
            LEFT JOIN prod.Shifts s ON s.ShiftID = d.ShiftID
            LEFT JOIN prod.StatusCodes sc ON sc.StatusID = d.Status
            LEFT JOIN Nexus.dbo.PortalUsers pu ON pu.UserID = d.CreatedByUserID
            WHERE (@mat IS NULL OR d.Material LIKE @mat)
              AND (@from IS NULL OR d.StartedAt >= @from)
              AND (@to IS NULL OR d.StartedAt <= @to)
              AND (@cust IS NULL OR d.CustomerID LIKE @cust)
              AND (@so IS NULL OR d.SalesOrderSAP LIKE @so)
            ORDER BY d.StartedAt DESC
            """, new
        {
            mat = string.IsNullOrWhiteSpace(query.Material) ? null : $"%{query.Material}%",
            from = DateTime.TryParse(query.DateFrom, out var from) ? from : (DateTime?)null,
            to = DateTime.TryParse(query.DateTo, out var to) ? to : (DateTime?)null,
            cust = string.IsNullOrWhiteSpace(query.CustomerId) ? null : $"%{query.CustomerId}%",
            so = string.IsNullOrWhiteSpace(query.SalesOrderSap) ? null : $"%{query.SalesOrderSap}%",
        }, cancellationToken: ct));
        return rows.ToArray();
    }
}
