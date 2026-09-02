using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Production;

/// <summary>
/// Mixing entry — port of POST /mixing/entry in routes/productionnexus.js.
/// Each tub posts its own independent SAP backflush (mix materials are not
/// batch-managed in SAP — all tub-level traceability lives only in
/// Normanton-Nexus), so a partial failure across a multi-tub submission is
/// a real, expected outcome: the Mixing parent record is marked SAP_FAILED
/// (status 6) if ANY tub failed, even though the other tubs in the same
/// submission already have real SAP material documents — see
/// dotnet/CLAUDE.md's Phase 6 notes. The Failed Backflush retry path (Sub-
/// phase 6c) must only re-attempt the specific tubs still marked
/// unsuccessful, never the whole record.
/// </summary>
internal static class MixingHelper
{
    private const decimal MaxTubWeightKg = 38m;

    /// <summary>notify() is deliberately not called here (SAP-failure alert to PROD_SUPERVISOR) — same reasoning as Quality's Phase 3 concession review: depends on the Notifications feature deferred since Phase 1, not built yet in this migration. writeEvent/prod.EventLog IS written for real (see ProductionEventLogHelper) — Sub-phase 6b treats that as load-bearing infrastructure, unlike notify().</summary>
    internal static async Task<MixingEntryResult> EnterAsync(
        INexusOperationsDb db, ISapServerClient sap, IAuditLogger audit,
        MixingEntryRequest body, string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        var mixCode = body.MixCode?.Trim();
        var supplierBatch = (body.SupplierBatchNo ?? "").Trim();
        var supplierTub = (body.SupplierTubNo ?? "").Trim();

        if (string.IsNullOrWhiteSpace(mixCode) || body.Tubs is not { Count: > 0 })
        {
            throw new NexusValidationException("mixCode and at least one tub are required.");
        }
        if (supplierBatch.Length == 0 || supplierTub.Length == 0)
        {
            throw new NexusValidationException("Supplier batch number and supplier tub number are required.");
        }
        if (body.Tubs.Any(t => t.WeightKg <= 0 || t.WeightKg > MaxTubWeightKg))
        {
            throw new NexusValidationException($"Each tub weight must be greater than 0 and no more than {MaxTubWeightKg} KG.");
        }

        using var connection = await db.CreateConnectionAsync(ct);
        var shiftId = ProductionSapHelpers.CurrentShiftId();
        var totalWeightKg = body.Tubs.Sum(t => t.WeightKg);

        var duplicate = await connection.QuerySingleOrDefaultAsync<(int MixingId, string? MixRef)?>(new CommandDefinition("""
            SELECT TOP 1 MixingID, MixRef FROM prod.Mixing
            WHERE LTRIM(RTRIM(SupplierBatchNo)) = @supplierBatch AND LTRIM(RTRIM(SupplierTubNo)) = @supplierTub
            ORDER BY MixingID DESC
            """, new { supplierBatch, supplierTub }, cancellationToken: ct));
        if (duplicate is not null)
        {
            var (dupId, dupRef) = duplicate.Value;
            var reference = dupRef ?? $"MX{dupId:D8}";
            throw new NexusConflictException(
                $"Backflush aborted. Supplier batch {supplierBatch} and tub {supplierTub} have already been used on {reference}. Please check the tub details.");
        }

        await ProductionSapHelpers.AssertProfitCentreAsync(sap, "MX", mixCode, userId, ct);

        var mixingId = await connection.QuerySingleAsync<int>(new CommandDefinition("""
            INSERT INTO prod.Mixing (ShiftID, Material, MixCode, TotalWeightKG, SupplierBatchNo, SupplierTubNo, Status, StartedAt, CompletedAt, CreatedByUserID, Notes)
            OUTPUT INSERTED.MixingID
            VALUES (@shiftId, @mixCode, @mixCode, @totalWeightKg, @supplierBatch, @supplierTub, 4, GETDATE(), GETDATE(), @userId, @notes)
            """, new { shiftId, mixCode, totalWeightKg, supplierBatch, supplierTub, userId, notes = body.Notes }, cancellationToken: ct));

        await connection.ExecuteAsync(new CommandDefinition(
            "INSERT INTO prod.BatchOperators (ProcessCode, ProcessRecordID, UserID, IsPrimary, AssignedByUserID) VALUES ('MX', @mixingId, @userId, 1, @userId)",
            new { mixingId, userId }, cancellationToken: ct));

        await ProductionEventLogHelper.WriteEventAsync(connection, "MX", mixingId, "STARTED",
            $"Mixing record created: {mixCode} — {totalWeightKg:F3} KG across {body.Tubs.Count} tub(s)", 0, userId, ct);

        var mixRef = $"MX{mixingId:D8}";
        var anyFailed = false;
        var tubResults = new List<MixingTubResult>();

        for (var i = 0; i < body.Tubs.Count; i++)
        {
            var tub = body.Tubs[i];
            var tubSeq = i + 1;

            var tubId = await connection.QuerySingleAsync<int>(new CommandDefinition("""
                INSERT INTO prod.MixingTubs (MixingID, TubSeq, SupplierTubNo, TubWeightKG)
                OUTPUT INSERTED.TubID VALUES (@mixingId, @tubSeq, @supplierTub, @weightKg)
                """, new { mixingId, tubSeq, supplierTub, weightKg = tub.WeightKg }, cancellationToken: ct));

            try
            {
                var sapResponse = await sap.PostAsync<BdcResponse>("api/production/backflush", new Zf40nRequest(
                    Material: mixCode, Quantity: tub.WeightKg, Header: mixRef, Packaging: "", Charge: supplierBatch, Customer: ""), userId, ct: ct)
                    ?? throw new NexusBadGatewayException("SapServer returned no backflush result.");

                var sapMatDoc = ProductionSapHelpers.ParseSapBackflush(sapResponse);
                await audit.LogAsync("SAP_OK", username, $"'{mixRef}' BACKFLUSHED - Material Document = '{sapMatDoc}'", ipAddress, ct);

                if (sapResponse.MessageNumber == "190")
                {
                    await ProductionSapHelpers.LogBackflushAlertAsync(connection, "MX", mixingId, mixRef, sapMatDoc, sapResponse.MessageNumber, sapResponse.Message, ct);
                    await ProductionEventLogHelper.WriteEventAsync(connection, "MX", mixingId, "NOTE",
                        $"SAP 190 tub {tubSeq}: No component consumption — MatDoc: {sapMatDoc}. Flagged for data review.", 1, userId, ct);
                }

                await connection.ExecuteAsync(new CommandDefinition(
                    "UPDATE prod.MixingTubs SET MaterialDocumentSAP = @sapMatDoc, SAPSuccess = 1 WHERE TubID = @tubId",
                    new { sapMatDoc, tubId }, cancellationToken: ct));

                await connection.ExecuteAsync(new CommandDefinition("""
                    INSERT INTO prod.SAPPostings (ProcessCode, ProcessRecordID, PostingType, Quantity, UnitOfMeasure, MaterialDocumentSAP, IsSuccess, PostedByUserID)
                    VALUES ('MX', @mixingId, 'BACKFLUSH', @weightKg, 'KG', @sapMatDoc, 1, @userId)
                    """, new { mixingId, weightKg = tub.WeightKg, sapMatDoc, userId }, cancellationToken: ct));

                await ProductionEventLogHelper.WriteEventAsync(connection, "MX", mixingId, "SAP_POST",
                    $"Tub {tubSeq} posted — MatDoc: {sapMatDoc} — {tub.WeightKg} KG{(sapResponse.MessageNumber == "190" ? " (190: no components consumed)" : "")}", 0, userId, ct);

                tubResults.Add(new MixingTubResult(tubId, tubSeq, supplierTub, tub.WeightKg, sapMatDoc, null, true));
            }
            catch (Exception sapErr) when (sapErr is not NexusValidationException and not NexusConflictException)
            {
                anyFailed = true;
                var errMsg = sapErr.Message;

                await connection.ExecuteAsync(new CommandDefinition(
                    "UPDATE prod.MixingTubs SET SAPSuccess = 0, SAPErrorMessage = @errMsg WHERE TubID = @tubId",
                    new { errMsg, tubId }, cancellationToken: ct));

                await connection.ExecuteAsync(new CommandDefinition("""
                    INSERT INTO prod.SAPPostings (ProcessCode, ProcessRecordID, PostingType, Quantity, UnitOfMeasure, IsSuccess, ErrorMessage, PostedByUserID)
                    VALUES ('MX', @mixingId, 'BACKFLUSH', @weightKg, 'KG', 0, @errMsg, @userId)
                    """, new { mixingId, weightKg = tub.WeightKg, errMsg, userId }, cancellationToken: ct));

                await audit.LogAsync("SAP_ERROR", username, $"'{mixRef}' FAILED - Message = \"{errMsg}\"", ipAddress, ct);
                await ProductionEventLogHelper.WriteEventAsync(connection, "MX", mixingId, "SAP_FAIL",
                    $"Tub {tubSeq} ({supplierTub}) SAP failed: {errMsg}", 2, userId, ct);

                tubResults.Add(new MixingTubResult(tubId, tubSeq, supplierTub, tub.WeightKg, null, errMsg, false));
            }
        }

        if (anyFailed)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "UPDATE prod.Mixing SET Status = 6 WHERE MixingID = @mixingId", new { mixingId }, cancellationToken: ct));
        }

        return new MixingEntryResult(
            RecordId: mixingId, MixingId: mixingId, BatchRef: mixRef,
            Status: anyFailed ? "SAP_FAILED" : "COMPLETE", TotalWeightKg: totalWeightKg, Tubs: tubResults,
            Warning: anyFailed ? "Some tubs failed SAP posting. See failed backflush queue." : null);
    }
}
