using Dapper;
using Microsoft.Data.SqlClient;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Helpers.Warehouse;

/// <summary>
/// Re-drum reversal — automatic side effect of a batch-managed product
/// being RETURNED to SA/PTFE via ANY transfer-order path (Staging Post
/// deliveries, the warehouse Stock Transfer tool, and any future caller
/// that lands stock there). Port of lib/redrumReversal.js's
/// maybeReverseBatchManagedReturn — shared rather than duplicated
/// per-caller like Node's own trivial sapAgent/makeSapToken boilerplate,
/// since this is real business logic touching SAP financial postings,
/// warehouse management and production traceability, so it needs exactly
/// one implementation. Owned by Sub-phase 7c (see dotnet/CLAUDE.md) since
/// it's triggered from that same cluster's SAP-posting deliver endpoint —
/// resolves the cross-department dependency Production's Sub-phase 6c
/// flagged (DrummingHelper.AssertParentBatchesReversedAsync needs
/// prod.Drumming.IsReversed to ever be set).
///
/// If the batch being moved has an original backflush (movement 131) in
/// SAP, the transfer isn't a fresh material request — it's a batch-managed
/// product coming back (e.g. a rejected drum returning for re-drumming).
/// In that case: (1) reverse the original backflush via MF41, (2) tidy up
/// WM — MF41 posts outside WM, so move the stock the transfer just placed
/// at SA/PTFE into the outside-WM holding bin (type 901, bin = the
/// material's cost collector/production order number, zero-padded/
/// truncated to 10 characters), (3) if that batch was produced by this
/// system's Drumming feature, mark the job reversed (comment only — scrap
/// already happened and stands, deliberately untouched). A batch with no
/// matching 131 movement is just a normal transfer — no-op (null).
/// </summary>
internal static class RedrumReversalHelper
{
    private const string WmOutsideType = "901";

    internal sealed record Result(string Status, string? MaterialDocument, string? ReversalDocument, string? TransferOrderNumber, int? DrummingId, string? Warning, string? Error);

    internal static async Task<Result?> MaybeReverseBatchManagedReturnAsync(
        SqlConnection connection, ISapServerClient sap, IAuditLogger audit,
        string? batch, string destinationStorageType, string destinationBin, string? storageLocation,
        string? username, string? ipAddress, int userId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(batch)) return null;
        if (destinationStorageType != "SA" || destinationBin != "PTFE") return null;

        BackflushDocumentRow? doc;
        try
        {
            doc = await sap.PostAsync<BackflushDocumentRow>("api/production/find-backflush-document", new FindBackflushDocumentRequest(batch), userId, ct: ct);
        }
        catch (SapProxyException ex) when (ex.StatusCode == 400)
        {
            // No 131 movement for this batch — the normal, non-redrum case
            // for the vast majority of transfers.
            return null;
        }
        catch (Exception ex)
        {
            // Anything else is worth a note, but must never block the
            // transfer that already happened.
            await audit.LogAsync("REDRUM_LOOKUP_ERROR", username, $"Batch '{batch}' — {ex.Message}", ipAddress, ct);
            return null;
        }
        if (doc is null || string.IsNullOrEmpty(doc.MaterialDocument)) return null;

        var materialDocument = doc.MaterialDocument;

        var mainReversal = await ReverseSapMaterialDocumentAsync(sap, materialDocument, userId, ct);
        if (!mainReversal.Ok)
        {
            await audit.LogAsync("REDRUM_REVERSAL_ERROR", username, $"Batch '{batch}' MatDoc {materialDocument} — {mainReversal.Error}", ipAddress, ct);
            return new Result("failed", materialDocument, null, null, null, null, mainReversal.Error);
        }

        await audit.LogAsync("REDRUM_REVERSED", username,
            $"Batch '{batch}' MatDoc {materialDocument} reversed{(mainReversal.AlreadyReversed ? " (was already reversed)" : "")}", ipAddress, ct);

        // WM tidy-up — move the returned stock out of SA/PTFE into the
        // outside-WM holding bin now the backflush behind it has been
        // reversed. Destination bin is the material's cost collector
        // (production order) number, zero-padded/truncated to 10
        // characters — not a fixed bin.
        string? transferOrderNumber = null;
        string? warning = null;
        string? destinationBinNumber = null;
        try
        {
            destinationBinNumber = await FindCostCollectorBinAsync(sap, doc.Material, userId, ct);
        }
        catch (Exception ex)
        {
            warning = $"Reversed in SAP, but could not find the cost collector for material '{doc.Material}' — {ex.Message}. Move the stock manually to bin type {WmOutsideType}.";
            await audit.LogAsync("REDRUM_WM_TIDYUP_ERROR", username, $"Batch '{batch}' MatDoc {materialDocument} — cost collector lookup failed: {ex.Message}", ipAddress, ct);
        }

        if (destinationBinNumber is not null)
        {
            try
            {
                var to = await sap.PostAsync<CreateTransferOrderResponse>("api/warehouse/transfer-order", new CreateTransferOrderRequest(
                    StorageLocation: doc.StorageLocation is { Length: > 0 } ? doc.StorageLocation : storageLocation ?? "",
                    Material: doc.Material,
                    Quantity: doc.Quantity,
                    SourceType: "SA",
                    SourceBin: "PTFE",
                    DestinationType: WmOutsideType,
                    DestinationBin: destinationBinNumber,
                    Batch: batch), userId, ct: ct);
                transferOrderNumber = to?.TransferOrderNumber is { Length: > 0 } t ? t : null;
            }
            catch (Exception ex)
            {
                warning = $"Reversed in SAP, but the warehouse tidy-up (SA/PTFE -> {WmOutsideType}/{destinationBinNumber}) failed: {ex.Message}. Move the stock manually.";
                await audit.LogAsync("REDRUM_WM_TIDYUP_ERROR", username, $"Batch '{batch}' MatDoc {materialDocument} — {ex.Message}", ipAddress, ct);
            }
        }

        // Mark the job reversed if it was made by this system's Drumming
        // feature. Deliberately does NOT touch scrap — the scrap already
        // happened and stands.
        int? drummingId = null;
        try
        {
            var processRecordId = await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition("""
                SELECT TOP 1 ProcessRecordID FROM prod.SAPPostings
                WHERE MaterialDocumentSAP=@doc AND ProcessCode='DR' AND IsSuccess=1
                """, new { doc = materialDocument }, cancellationToken: ct));

            if (processRecordId is not null)
            {
                drummingId = processRecordId.Value;

                // IsReversed=0 guard makes this update — and everything
                // gated on its affected-row count below — a one-shot: if
                // this method somehow runs twice for the same drum, the
                // second call updates nothing and skips the stock
                // correction rather than double-counting it.
                var drum = await connection.QuerySingleOrDefaultAsync<(string EntryType, string? SalesOrderSap, string? OrderItem, decimal LengthMetres)?>(new CommandDefinition("""
                    UPDATE prod.Drumming SET
                        IsReversed = 1, ReversedAt = GETDATE(), ReversedByUserID = @userId,
                        Notes = CASE WHEN Notes IS NULL OR Notes = '' THEN @cmt ELSE Notes + CHAR(13)+CHAR(10) + @cmt END
                    OUTPUT INSERTED.EntryType, INSERTED.SalesOrderSAP, INSERTED.OrderItem, INSERTED.LengthMetres
                    WHERE DrummingID = @id AND IsReversed = 0
                    """, new { id = drummingId.Value, userId, cmt = "reversed to re-drum" }, cancellationToken: ct));

                // The original backflush added its metres to the order's
                // DockStockAllocated (see DrummingHelper.SubmitAsync) —
                // undo that here so the order-schedule figure doesn't stay
                // inflated by stock that's actually just come back for
                // re-drumming. Only customer-order drums touched that
                // figure in the first place; stock drums never did.
                //
                // DEVIATION, deliberate: Node's own lib/redrumReversal.js
                // decrements this using `WHERE ReferenceDocument = @ref
                // AND Item = @item` — but Node's own submitDrumming
                // increment (routes/productionnexus.js, and this port's
                // DrummingHelper.SubmitAsync) explicitly uses `OriginalDoc`/
                // `OriginalDocItem` instead, with a comment explaining why:
                // ReferenceDocument/Item "may already have flipped to a
                // delivery number for this line by the time the drum is
                // posted." That reasoning applies just as much to the
                // reversal as to the original increment — matching the
                // increment's own columns is what actually finds the same
                // row back, so this port uses OriginalDoc/OriginalDocItem
                // here too rather than porting Node's mismatched pairing
                // bug-compatible. Low risk either way (this only affects a
                // local dock-stock display figure, self-heals on the next
                // 30-min sync, and a miss here only produces a warning,
                // never a hard failure) — Node's own lib/redrumReversal.js
                // was NOT changed to match, since this wasn't confirmed via
                // a live test the way the Goods Issue Items fix was;
                // flagged here for a deliberate decision on whether to
                // backport the same fix to Node.
                if (drum is not null && drum.Value.EntryType == "customer" && !string.IsNullOrEmpty(drum.Value.SalesOrderSap) && !string.IsNullOrEmpty(drum.Value.OrderItem))
                {
                    try
                    {
                        await connection.ExecuteAsync(new CommandDefinition("""
                            UPDATE log.AgreementSnapshot
                            SET DockStockAllocated = ISNULL(DockStockAllocated,0) - @qty
                            WHERE OriginalDoc = @refDoc AND OriginalDocItem = @item
                            """, new { qty = drum.Value.LengthMetres, refDoc = drum.Value.SalesOrderSap, item = drum.Value.OrderItem }, cancellationToken: ct));
                    }
                    catch (Exception ex)
                    {
                        warning = AppendWarning(warning, $"Reversed, but the live order-schedule figure could not be corrected immediately (it will catch up on the next sync): {ex.Message}");
                    }
                }

                // Reverse any braided-component backflushes this drum
                // triggered (see DrummingHelper.BackflushBraidedComponentsAsync)
                // — those consumed real SAP stock against the braid batch's
                // own reference, same as the drum's own backflush just
                // reversed above, so leaving them in place would understate
                // what's actually still in stock. Gated on `drum` only, not
                // the customer-order check above — applies to both customer
                // and stock drums.
                if (drum is not null)
                {
                    try
                    {
                        var braidDocs = await connection.QueryAsync<(int ParentRecordId, string MaterialDocumentSap)>(new CommandDefinition("""
                            SELECT ParentRecordID, MaterialDocumentSAP FROM prod.ProductionTrace
                            WHERE ChildProcessCode='DR' AND ChildRecordID=@cr AND ParentProcessCode='BR' AND MaterialDocumentSAP IS NOT NULL
                            """, new { cr = drummingId.Value }, cancellationToken: ct));

                        foreach (var row in braidDocs)
                        {
                            var braidReversal = await ReverseSapMaterialDocumentAsync(sap, row.MaterialDocumentSap, userId, ct);
                            if (!braidReversal.Ok)
                            {
                                warning = AppendWarning(warning, $"Braid component backflush {row.MaterialDocumentSap} could not be reversed: {braidReversal.Error}.");
                                await audit.LogAsync("REDRUM_REVERSAL_ERROR", username, $"Braid batch #{row.ParentRecordId} MatDoc {row.MaterialDocumentSap} — {braidReversal.Error}", ipAddress, ct);
                                continue;
                            }

                            await connection.ExecuteAsync(new CommandDefinition("""
                                UPDATE prod.SAPPostings SET
                                    IsReversed = 1, ReversalDocumentSAP = @rdoc, ReversedAt = GETDATE(), ReversedByUserID = @userId
                                WHERE ProcessCode='BR' AND MaterialDocumentSAP=@doc AND IsSuccess=1 AND IsReversed=0
                                """, new { doc = row.MaterialDocumentSap, rdoc = braidReversal.ReversalDocument, userId }, cancellationToken: ct));

                            await audit.LogAsync("REDRUM_REVERSED", username,
                                $"Braid batch #{row.ParentRecordId} MatDoc {row.MaterialDocumentSap} reversed{(braidReversal.AlreadyReversed ? " (was already reversed)" : "")} (consumed by drum #{drummingId})", ipAddress, ct);
                        }
                    }
                    catch (Exception ex)
                    {
                        warning = AppendWarning(warning, $"Could not reverse braid component backflush(es): {ex.Message}");
                    }
                }
            }
        }
        catch (Exception ex)
        {
            warning = AppendWarning(warning, $"Could not update the Drumming record: {ex.Message}");
        }

        return new Result("reversed", materialDocument, mainReversal.ReversalDocument, transferOrderNumber, drummingId, warning, null);
    }

    private static string AppendWarning(string? existing, string addition) =>
        existing is null ? addition : $"{existing} {addition}";

    // Posts an MF41 reversal for one material document and interprets
    // SAP's response — shared by the drum's own backflush reversal above
    // and the braid-component backflush reversal loop (a drum can have
    // zero, one or several of those). Never throws — the caller decides
    // what a failure here should mean for the rest of the reversal.
    private static async Task<(bool Ok, bool AlreadyReversed, string? ReversalDocument, string? Error)> ReverseSapMaterialDocumentAsync(ISapServerClient sap, string materialDocument, int userId, CancellationToken ct)
    {
        BdcResponse? mf41;
        try
        {
            mf41 = await sap.PostAsync<BdcResponse>("api/production/reverse-backflush", new Mf41Request(materialDocument), userId, ct: ct);
        }
        catch (Exception ex)
        {
            return (false, false, null, ex.Message);
        }

        if (mf41 is null) return (false, false, null, "SAP server error");

        var alreadyReversed = mf41.Type == "E" && mf41.MessageClass == "RM" && mf41.MessageNumber == "210";
        var ok = (mf41.Type == "S" && mf41.MessageClass == "RM" && mf41.MessageNumber == "196") || alreadyReversed;

        if (!ok)
            return (false, false, null, mf41.Message is { Length: > 0 } m ? m : $"SAP rejected the reversal: {mf41.Type} {mf41.MessageClass} {mf41.MessageNumber}");

        return (true, alreadyReversed, string.IsNullOrEmpty(mf41.DocumentNumber) ? null : mf41.DocumentNumber, null);
    }

    // Mirrors the existing get_CC() VB helper exactly: table AFKO, filtered
    // on PLNBEZ = the padded material, returns AUFNR (the cost collector /
    // repetitive manufacturing production order number), then Right(x, 10)
    // — take the last 10 characters if longer. Per Node's own comment,
    // values under 10 characters are zero-padded on the left.
    internal static string PadCostCollectorBin(string costCollector)
    {
        var raw = costCollector.Trim();
        return raw.Length > 10 ? raw[^10..] : raw.PadLeft(10, '0');
    }

    // SapServer's find-cost-collector endpoint is declared [HttpGet]
    // (matching the existing check-profit-centre precedent) despite taking
    // a JSON body — GetAsync's `body` parameter handles that the same way
    // Node's own sapGetWithBody does.
    private static async Task<string> FindCostCollectorBinAsync(ISapServerClient sap, string material, int userId, CancellationToken ct)
    {
        var raw = await sap.GetAsync<string>("api/production/find-cost-collector", userId, new ProfitCentreRequest(material), ct: ct);
        if (string.IsNullOrWhiteSpace(raw)) throw new InvalidOperationException("SapServer returned no cost collector");
        return PadCostCollectorBin(raw);
    }
}
