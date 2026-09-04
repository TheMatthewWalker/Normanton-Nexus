using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Vendor Consignment Tracker — Logistics Sub-phase 8e.1 (DB/algorithm
/// core). Port of routes/consignmentsql.js. Replaces three manually-
/// maintained vendor consignment workbooks (Chemours, Fothergill/FCF,
/// Raaj) with SQL-backed delivery/declaration tracking for vendor-owned
/// stock physically on-site (SOBKZ=K goods receipt).
///
/// **Schema note**: `sql/migrate_consignment_tracker.sql` describes an
/// EARLIER, superseded design — `dbo.*` tables in a separate "kongsberg"
/// database. The REAL, currently-deployed schema (confirmed against
/// `migrations/nexus_operations/20260804120000_initial_schema.cjs` and
/// `.../20260827150000_consignment_reversal_tracking.cjs`, and matching
/// every query `routes/consignmentsql.js` actually runs) is `log.*` in the
/// NexusOperations database — the same "a .sql migration file goes stale
/// relative to the real deployed schema" pattern already confirmed
/// elsewhere in this migration (SapServer's CostElements/CostCenters
/// IDENTITY mismatch). Ported against the real `log.*` schema, not the
/// stale draft.
///
/// Deliberately excludes (Sub-phase 8e.2): the SAP GR sync
/// (fetchSapVendorGr/mapGrRows, POST /vendors/:id/sync + the daily cron
/// entry point), the live-stock refresh (fetchSapConsignmentStock, POST
/// /stock/refresh — this Helper only reads the already-populated
/// snapshot cache, not writes it), and the declaration PDF (GET
/// /declarations/:id/pdf) — all genuinely external-integration/PDF work,
/// same "core DB/algorithm logic first, external I/O second" split this
/// migration already used for Shipping's own Sub-phase 8a.5 breakdown.
///
/// `BuildReassignmentPlanForVendorAsync`/`ApplyReassignmentPlanAsync` are
/// ported faithfully even though **no route in Node calls them at all** —
/// confirmed by grep across the whole repo, they're only reachable from
/// Node's own unit tests (test/unit/consignmentsql.test.js). Real,
/// deliberately-built, unit-tested recovery logic (reassigning a
/// declaration's allocation off stock that turned out to be
/// SAP-cancelled), just never wired to an HTTP route in the original app
/// either — kept available here the same way, not exposed via
/// `ConsignmentTrackerController` since Node's own controller doesn't
/// expose it.
/// </summary>
internal static class ConsignmentTrackerHelper
{
    // ── Vendors + config ─────────────────────────────────────────────────

    internal static async Task<IReadOnlyList<ConsignmentVendorRow>> ListVendorsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ConsignmentVendorRow>(new CommandDefinition("""
            SELECT v.VendorId, v.VendorName, v.SapVendorNumber, v.Currency,
                ISNULL(cvc.TrackExpiry, 0) AS TrackExpiry, cvc.ExpiryWarningDays, cvc.ExpiryDays,
                ISNULL(cvc.DefaultAllocationMethod, 'FIFO') AS DefaultAllocationMethod,
                ISNULL(cvc.Active, 1) AS Active, cvc.Notes, cvc.UpdatedAtUtc, cvc.UpdatedByUsername
            FROM log.ConsignmentVendorConfig cvc
            JOIN log.Vendor v ON v.VendorId = cvc.VendorId
            ORDER BY v.VendorName
            """, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<ConsignmentVendorRow?> GetVendorAsync(INexusOperationsDb db, long vendorId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await GetVendorAsync(connection, vendorId, ct);
    }

    private static Task<ConsignmentVendorRow?> GetVendorAsync(System.Data.IDbConnection connection, long vendorId, CancellationToken ct) =>
        connection.QuerySingleOrDefaultAsync<ConsignmentVendorRow?>(new CommandDefinition("""
            SELECT v.VendorId, v.VendorName, v.SapVendorNumber, v.Currency,
                ISNULL(cvc.TrackExpiry, 0) AS TrackExpiry, cvc.ExpiryWarningDays, cvc.ExpiryDays,
                ISNULL(cvc.DefaultAllocationMethod, 'FIFO') AS DefaultAllocationMethod,
                ISNULL(cvc.Active, 1) AS Active, cvc.Notes
            FROM log.Vendor v
            LEFT JOIN log.ConsignmentVendorConfig cvc ON cvc.VendorId = v.VendorId
            WHERE v.VendorId = @vendorId
            """, new { vendorId }, cancellationToken: ct));

    internal static async Task<ConsignmentVendorDetail?> GetVendorDetailAsync(INexusOperationsDb db, long vendorId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var vendor = await GetVendorAsync(connection, vendorId, ct);
        if (vendor is null) return null;

        var materials = await connection.QueryAsync<VendorMaterialRow>(new CommandDefinition(
            "SELECT VendorMaterialId, Material, ScheduleAgreement FROM log.VendorMaterial WHERE VendorId = @vendorId ORDER BY Material",
            new { vendorId }, cancellationToken: ct));
        return new ConsignmentVendorDetail(vendor, materials.AsList());
    }

    internal static async Task<ConsignmentVendorRow> UpsertVendorConfigAsync(INexusOperationsDb db, long vendorId, UpsertConsignmentVendorConfigRequest body, string? username, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var exists = await connection.ExecuteScalarAsync<int?>(new CommandDefinition(
            "SELECT 1 FROM log.ConsignmentVendorConfig WHERE VendorId = @vendorId", new { vendorId }, cancellationToken: ct));

        var parameters = new
        {
            vendorId,
            trackExpiry = body.TrackExpiry ?? false,
            expiryWarningDays = body.ExpiryWarningDays,
            expiryDays = body.ExpiryDays,
            defaultAllocationMethod = string.IsNullOrWhiteSpace(body.DefaultAllocationMethod) ? "FIFO" : body.DefaultAllocationMethod,
            active = body.Active ?? true,
            notes = string.IsNullOrWhiteSpace(body.Notes) ? null : body.Notes,
            username,
        };

        if (exists is not null)
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE log.ConsignmentVendorConfig SET
                    TrackExpiry = @trackExpiry, ExpiryWarningDays = @expiryWarningDays, ExpiryDays = @expiryDays,
                    DefaultAllocationMethod = @defaultAllocationMethod, Active = @active,
                    Notes = @notes, UpdatedAtUtc = GETUTCDATE(), UpdatedByUsername = @username
                WHERE VendorId = @vendorId
                """, parameters, cancellationToken: ct));
        }
        else
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO log.ConsignmentVendorConfig
                    (VendorId, TrackExpiry, ExpiryWarningDays, ExpiryDays, DefaultAllocationMethod, Active, Notes, UpdatedByUsername)
                VALUES
                    (@vendorId, @trackExpiry, @expiryWarningDays, @expiryDays, @defaultAllocationMethod, @active, @notes, @username)
                """, parameters, cancellationToken: ct));
        }

        return await GetVendorAsync(connection, vendorId, ct) ?? throw new NexusNotFoundException($"Vendor {vendorId} vanished immediately after config upsert.");
    }

    // ── Deliveries (GR lines) ────────────────────────────────────────────

    private const string DeliveryColumns = """
        d.DeliveryId, d.VendorId, d.Material, d.MaterialDocument, d.MaterialDocItem,
        d.Quantity, d.Uom, d.Container, d.BillOfLading, d.InvoiceNumber,
        d.DocumentDate, d.PostingDate, d.RemainingQty, d.Source, d.CreatedAtUtc, d.CreatedByUsername,
        d.ReversalOfMaterialDocument, d.ReversalOfMaterialDocItem,
        ISNULL(d.ExpiryDate,
               CASE WHEN cvc.ExpiryDays IS NOT NULL AND d.PostingDate IS NOT NULL
                    THEN DATEADD(day, cvc.ExpiryDays, d.PostingDate) END) AS ExpiryDate
        """;

    internal static async Task<IReadOnlyList<ConsignmentDeliveryRow>> ListDeliveriesAsync(INexusOperationsDb db, long vendorId, string? material, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await ListDeliveriesAsync(connection, vendorId, material, ct);
    }

    private static async Task<IReadOnlyList<ConsignmentDeliveryRow>> ListDeliveriesAsync(System.Data.IDbConnection connection, long vendorId, string? material, CancellationToken ct)
    {
        var where = "WHERE d.VendorId = @vendorId" + (material is not null ? " AND d.Material = @material" : "");
        var rows = await connection.QueryAsync<ConsignmentDeliveryRow>(new CommandDefinition($"""
            SELECT {DeliveryColumns}
            FROM log.ConsignmentDelivery d
            LEFT JOIN log.ConsignmentVendorConfig cvc ON cvc.VendorId = d.VendorId
            {where}
            ORDER BY d.Material, COALESCE(d.ExpiryDate,
                                           CASE WHEN cvc.ExpiryDays IS NOT NULL AND d.PostingDate IS NOT NULL
                                                THEN DATEADD(day, cvc.ExpiryDays, d.PostingDate) END,
                                           '9999-12-31'),
                     d.DocumentDate
            """, new { vendorId, material }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<long> AddManualDeliveryAsync(INexusOperationsDb db, long vendorId, AddManualConsignmentDeliveryRequest body, string? username, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleAsync<long>(new CommandDefinition("""
            INSERT INTO log.ConsignmentDelivery
                (VendorId, Material, MaterialDocument, MaterialDocItem, Quantity, Uom,
                 Container, BillOfLading, InvoiceNumber, DocumentDate, PostingDate, ExpiryDate,
                 RemainingQty, Source, CreatedByUsername)
            OUTPUT INSERTED.DeliveryId
            VALUES
                (@vendorId, @material, @materialDocument, @materialDocItem, @quantity, @uom,
                 @container, @billOfLading, @invoiceNumber, @documentDate, @postingDate, @expiryDate,
                 @quantity, @source, @username)
            """, new
        {
            vendorId,
            material = body.Material,
            materialDocument = string.IsNullOrWhiteSpace(body.MaterialDocument) ? $"MANUAL-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}" : body.MaterialDocument,
            materialDocItem = string.IsNullOrWhiteSpace(body.MaterialDocItem) ? "0001" : body.MaterialDocItem,
            quantity = body.Quantity,
            uom = body.Uom,
            container = body.Container,
            billOfLading = body.BillOfLading,
            invoiceNumber = body.InvoiceNumber,
            documentDate = body.DocumentDate,
            postingDate = body.PostingDate,
            expiryDate = body.ExpiryDate,
            source = body.Source == "CSV" ? "CSV" : "MANUAL",
            username,
        }, cancellationToken: ct));
    }

    internal static async Task<CsvImportResult> ImportDeliveriesCsvAsync(INexusOperationsDb db, long vendorId, CsvImportDeliveriesRequest body, string? username, CancellationToken ct)
    {
        if (body.Rows.Count == 0)
            throw new NexusValidationException("rows array is required.");

        var imported = 0;
        foreach (var row in body.Rows)
        {
            if (string.IsNullOrWhiteSpace(row.Material) || row.Quantity == 0) continue;
            await AddManualDeliveryAsync(db, vendorId, row with { Source = "CSV" }, username, ct);
            imported++;
        }
        return new CsvImportResult(imported, body.Rows.Count - imported);
    }

    internal static async Task UpdateDeliveryAsync(INexusOperationsDb db, long deliveryId, UpdateConsignmentDeliveryRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.ConsignmentDelivery SET
                InvoiceNumber = @invoiceNumber, Container = @container, BillOfLading = @billOfLading, ExpiryDate = @expiryDate
            WHERE DeliveryId = @deliveryId
            """, new { deliveryId, invoiceNumber = body.InvoiceNumber, container = body.Container, billOfLading = body.BillOfLading, expiryDate = body.ExpiryDate }, cancellationToken: ct));
    }

    // ── Reversal-chain cancellation ──────────────────────────────────────
    //
    // A goods receipt line cancelled in SAP (transaction MBST) doesn't
    // disappear — it gets a second MSEG line whose SMBLN/SMBLP point back
    // at the document+item it reverses. The aggregate Delivered/Undeclared
    // balance already nets these correctly (it just sums signed Quantity),
    // but RemainingQty is tracked per delivery LINE, and nothing ever
    // zeroed it out for a cancelled line — a cancelled line's full original
    // quantity sat there forever, eventually aging past ExpiryDays and
    // firing a false "overdue" warning for material that was never
    // physically outstanding. Confirmed for real: Raaj Ratna doc 5005206623
    // (cancelled same-day by 5005206624/MBST) and the chain 5005174284 →
    // 5005203102 (cancels it) → 5005203103 (cancels THAT cancellation,
    // MBST) were both showing as overdue.
    //
    // Pure parity-walk: build each cancellation chain via
    // ReversalOfMaterialDocument/Item (root = a row nothing else's SMBLN
    // can walk past), walk forward from the root assigning alternating
    // live/cancelled state (root starts live), and the chain's final state
    // determines whether the ROOT ends up live or cancelled — an even
    // total chain length cancels the root, odd length restores it. Every
    // non-root row in a chain is always cancelled regardless of parity — it
    // only ever existed as a paperwork correction, never independent stock.
    //
    // A row is only ever actually zeroed if RemainingQty still exactly
    // equals its own Quantity (nothing has genuinely declared against it
    // yet) — a row a real Nexus declaration already touched is left alone
    // and reported in NeedsReview instead of silently overwritten.
    internal static ReversalCancellationResult ComputeReversalCancellations(IReadOnlyList<ReversalWalkRow> rows)
    {
        static string Key(string doc, string item) => $"{doc}|{item}";

        var byKey = new Dictionary<string, ReversalWalkRow>();
        foreach (var r in rows) byKey[Key(r.MaterialDocument, r.MaterialDocItem)] = r;

        var reverseLookup = new Dictionary<string, List<ReversalWalkRow>>();
        foreach (var r in rows)
        {
            if (string.IsNullOrEmpty(r.ReversalOfMaterialDocument)) continue;
            var targetKey = Key(r.ReversalOfMaterialDocument, r.ReversalOfMaterialDocItem ?? "");
            if (!byKey.ContainsKey(targetKey)) continue;
            if (!reverseLookup.TryGetValue(targetKey, out var list)) { list = []; reverseLookup[targetKey] = list; }
            list.Add(r);
        }

        bool IsRoot(ReversalWalkRow r) =>
            string.IsNullOrEmpty(r.ReversalOfMaterialDocument) || !byKey.ContainsKey(Key(r.ReversalOfMaterialDocument, r.ReversalOfMaterialDocItem ?? ""));

        var toZero = new List<ReversalWalkRow>();
        var needsReview = new List<(ReversalWalkRow Row, string Reason)>();
        var visited = new HashSet<string>();

        foreach (var root in rows)
        {
            var rootKey = Key(root.MaterialDocument, root.MaterialDocItem);
            if (visited.Contains(rootKey) || !IsRoot(root)) continue;

            var chain = new List<ReversalWalkRow> { root };
            visited.Add(rootKey);
            var current = root;
            for (var hops = 0; hops < rows.Count; hops++)
            {
                var key = Key(current.MaterialDocument, current.MaterialDocItem);
                if (!reverseLookup.TryGetValue(key, out var reversers) || reversers.Count == 0) break;
                var next = reversers[0];
                for (var i = 1; i < reversers.Count; i++)
                    needsReview.Add((reversers[i], "multiple documents reverse the same target"));
                var nextKey = Key(next.MaterialDocument, next.MaterialDocItem);
                if (visited.Contains(nextKey)) break;
                visited.Add(nextKey);
                chain.Add(next);
                current = next;
            }

            if (chain.Count == 1) continue;

            var rootLive = chain.Count % 2 == 1;
            for (var i = 0; i < chain.Count; i++)
            {
                if (i == 0 && rootLive) continue;
                var row = chain[i];
                var untouched = Math.Abs(row.RemainingQty - row.Quantity) < 0.001m;
                if (untouched) toZero.Add(row);
                else needsReview.Add((row, "reversal-chain says cancelled, but RemainingQty already differs from Quantity (a declaration was made against it)"));
            }
        }

        return new ReversalCancellationResult(
            toZero.Select(r => new ReversalCancellationZeroedRow(r.DeliveryId, r.Material, r.MaterialDocument, r.MaterialDocItem, r.Quantity)).ToList(),
            needsReview.Select(n => new ReversalCancellationReviewRow(n.Row.DeliveryId, n.Row.Material, n.Row.MaterialDocument, n.Row.MaterialDocItem, n.Row.Quantity, n.Row.RemainingQty, n.Reason)).ToList());
    }

    /// <summary>Applies ComputeReversalCancellations for one vendor's current delivery rows. Idempotent — safe to re-run any time.</summary>
    internal static async Task<ReversalCancellationResult> ApplyReversalCancellationsAsync(INexusOperationsDb db, long vendorId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await ApplyReversalCancellationsAsync(connection, vendorId, ct);
    }

    private static async Task<ReversalCancellationResult> ApplyReversalCancellationsAsync(System.Data.IDbConnection connection, long vendorId, CancellationToken ct)
    {
        var rows = (await connection.QueryAsync<ReversalWalkRow>(new CommandDefinition("""
            SELECT DeliveryId, Material, MaterialDocument, MaterialDocItem, Quantity, RemainingQty,
                ReversalOfMaterialDocument, ReversalOfMaterialDocItem
            FROM log.ConsignmentDelivery WHERE VendorId = @vendorId
            """, new { vendorId }, cancellationToken: ct))).AsList();

        var result = ComputeReversalCancellations(rows);

        foreach (var row in result.Zeroed)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "UPDATE log.ConsignmentDelivery SET RemainingQty = 0 WHERE DeliveryId = @deliveryId",
                new { deliveryId = row.DeliveryId }, cancellationToken: ct));
        }

        return result;
    }

    // ── Stock snapshot cache (read side — see Sub-phase 8e.2 for the write side) ──

    internal static async Task<IReadOnlyDictionary<string, decimal>> GetStockSnapshotAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<(string Material, decimal Qty)>(new CommandDefinition(
            "SELECT Material, Qty FROM log.ConsignmentStockSnapshot", cancellationToken: ct));
        return rows.ToDictionary(r => r.Material, r => r.Qty);
    }

    internal static async Task<ConsignmentStockSnapshotMeta> GetStockSnapshotMetaAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await GetStockSnapshotMetaAsync(connection, ct);
    }

    private static async Task<ConsignmentStockSnapshotMeta> GetStockSnapshotMetaAsync(System.Data.IDbConnection connection, CancellationToken ct)
    {
        var row = await connection.QuerySingleAsync<(int MaterialCount, DateTime? LastSnapshotAtUtc)>(new CommandDefinition(
            "SELECT COUNT(*) AS MaterialCount, MAX(SnapshotAtUtc) AS LastSnapshotAtUtc FROM log.ConsignmentStockSnapshot", cancellationToken: ct));
        return new ConsignmentStockSnapshotMeta(row.MaterialCount, row.LastSnapshotAtUtc);
    }

    // ── Balance calc ("undeclared consumption") ──────────────────────────
    //
    // Undeclared (per vendor+material) = Delivered − live SAP consignment
    // stock (cached snapshot) − Declared (Confirmed declarations only) —
    // a balance, not a raw SAP consumption-movement pull, mirroring exactly
    // what the original vendor workbooks already did by hand.
    internal static async Task<VendorBalanceResult?> GetVendorBalanceAsync(INexusOperationsDb db, long vendorId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var vendor = await GetVendorAsync(connection, vendorId, ct);
        if (vendor is null) return null;

        var totals = await connection.QueryAsync<(string Material, decimal Delivered, decimal Declared)>(new CommandDefinition("""
            SELECT
                d.Material,
                SUM(d.Quantity) AS Delivered,
                ISNULL((
                    SELECT SUM(dl.QtyAllocated)
                    FROM log.ConsignmentDeclarationLine dl
                    JOIN log.ConsignmentDeclaration dec ON dec.DeclarationId = dl.DeclarationId
                    WHERE dec.Status = 'Confirmed' AND dl.Material = d.Material AND dec.VendorId = @vendorId
                ), 0) AS Declared
            FROM log.ConsignmentDelivery d
            WHERE d.VendorId = @vendorId
            GROUP BY d.Material
            """, new { vendorId }, cancellationToken: ct));

        var stockByMaterial = await GetStockSnapshotAsync(db, ct);
        var stockSnapshot = await GetStockSnapshotMetaAsync(connection, ct);

        var materials = totals.Select(t =>
        {
            // MKOL's per-material key strips leading zeros on purely-numeric
            // materials — try both forms defensively (matches Node exactly).
            var stock = stockByMaterial.GetValueOrDefault(t.Material, stockByMaterial.GetValueOrDefault(t.Material.TrimStart('0'), 0m));
            var undeclared = Math.Round(t.Delivered - stock - t.Declared, 3);
            return new VendorBalanceMaterialRow(t.Material, t.Delivered, stock, t.Declared, Math.Max(0, undeclared));
        }).ToList();

        IReadOnlyList<ConsignmentDeliveryRow> expiryWarnings = [];
        if (vendor.TrackExpiry)
        {
            var warningDays = vendor.ExpiryWarningDays ?? 30;
            var horizon = DateTime.UtcNow.AddDays(warningDays);
            var allDeliveries = await ListDeliveriesAsync(connection, vendorId, null, ct);
            expiryWarnings = allDeliveries.Where(d => d.RemainingQty > 0 && d.ExpiryDate is not null && d.ExpiryDate <= horizon).ToList();
        }

        return new VendorBalanceResult(vendor, materials, expiryWarnings, stockSnapshot);
    }

    // ── FEFO/FIFO/manual allocation proposal ─────────────────────────────
    //
    // Greedily walks open delivery lines (RemainingQty > 0) for one
    // material, ordered by the caller per allocationMethod (FEFO =
    // ExpiryDate ascending, FIFO = DocumentDate ascending — ListDeliveries'
    // own ORDER BY already sorts FEFO-first, which also correctly falls
    // through to DocumentDate ordering for FIFO-only vendors that never
    // set ExpiryDate), consuming qtyToDeclare across them.
    internal static AllocationProposal BuildAllocationProposal(IReadOnlyList<AllocatableDeliveryRow> deliveryRows, decimal qtyToDeclare)
    {
        var lines = new List<AllocationProposalLine>();
        var remaining = qtyToDeclare;
        foreach (var row in deliveryRows)
        {
            if (remaining <= 0) break;
            if (row.RemainingQty <= 0) continue;
            var take = Math.Min(row.RemainingQty, remaining);
            lines.Add(new AllocationProposalLine(row.DeliveryId, row.Material, Math.Round(take, 3), row.InvoiceNumber, row.ExpiryDate, row.DocumentDate, row.RemainingQty));
            remaining -= take;
        }
        return new AllocationProposal(lines, Math.Round(remaining, 3));
    }

    internal static async Task<AllocationProposalResult> ProposeDeclarationAsync(INexusOperationsDb db, long vendorId, ProposeDeclarationRequest body, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.Material) || body.QtyToDeclare == 0)
            throw new NexusValidationException("material and qtyToDeclare are required.");

        var vendor = await GetVendorAsync(db, vendorId, ct) ?? throw new NexusNotFoundException("Vendor not found.");
        var effectiveMethod = string.IsNullOrWhiteSpace(body.Method) ? (vendor.DefaultAllocationMethod ?? "FIFO") : body.Method;

        var openLines = (await ListDeliveriesAsync(db, vendorId, body.Material, ct)).Where(d => d.RemainingQty > 0).ToList();

        if (effectiveMethod == "MANUAL")
            return new AllocationProposalResult(effectiveMethod, [], body.QtyToDeclare, openLines);

        var allocatable = openLines.Select(d => new AllocatableDeliveryRow(d.DeliveryId, d.Material, d.RemainingQty, d.InvoiceNumber, d.ExpiryDate, d.DocumentDate)).ToList();
        var proposal = BuildAllocationProposal(allocatable, body.QtyToDeclare);
        return new AllocationProposalResult(effectiveMethod, proposal.Lines, proposal.UnallocatedQty, openLines);
    }

    // ── Declarations ──────────────────────────────────────────────────────

    internal static async Task<long> CreateDeclarationAsync(INexusOperationsDb db, long vendorId, CreateDeclarationRequest body, string? username, CancellationToken ct)
    {
        if (body.Lines.Count == 0)
            throw new NexusValidationException("lines array is required.");

        using var connection = await db.CreateConnectionAsync(ct);
        using var transaction = connection.BeginTransaction();
        try
        {
            var totalQty = body.Lines.Sum(l => l.QtyAllocated);
            var declarationId = await connection.QuerySingleAsync<long>(new CommandDefinition("""
                INSERT INTO log.ConsignmentDeclaration (VendorId, Status, AllocationMethod, TotalQty, CreatedByUsername)
                OUTPUT INSERTED.DeclarationId
                VALUES (@vendorId, 'Draft', @allocationMethod, @totalQty, @username)
                """, new { vendorId, allocationMethod = string.IsNullOrWhiteSpace(body.AllocationMethod) ? "MANUAL" : body.AllocationMethod, totalQty, username },
                transaction, cancellationToken: ct));

            await InsertDeclarationLinesAsync(connection, transaction, declarationId, body.Lines, ct);

            transaction.Commit();
            return declarationId;
        }
        catch
        {
            transaction.Rollback();
            throw;
        }
    }

    /// <summary>Replaces every line on a still-Draft declaration — backs the editable matrix preview (adjust the FEFO proposal by hand before confirming).</summary>
    internal static async Task SetDeclarationLinesAsync(INexusOperationsDb db, long declarationId, SetDeclarationLinesRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        using var transaction = connection.BeginTransaction();
        try
        {
            var status = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
                "SELECT Status FROM log.ConsignmentDeclaration WHERE DeclarationId = @declarationId", new { declarationId }, transaction, cancellationToken: ct));
            if (status is null) throw new NexusNotFoundException("Declaration not found.");
            if (status != "Draft") throw new NexusValidationException("Only a Draft declaration can have its lines edited.");

            await connection.ExecuteAsync(new CommandDefinition(
                "DELETE FROM log.ConsignmentDeclarationLine WHERE DeclarationId = @declarationId", new { declarationId }, transaction, cancellationToken: ct));

            await InsertDeclarationLinesAsync(connection, transaction, declarationId, body.Lines, ct);

            var totalQty = body.Lines.Sum(l => l.QtyAllocated);
            await connection.ExecuteAsync(new CommandDefinition(
                "UPDATE log.ConsignmentDeclaration SET TotalQty = @totalQty WHERE DeclarationId = @declarationId",
                new { declarationId, totalQty }, transaction, cancellationToken: ct));

            transaction.Commit();
        }
        catch
        {
            transaction.Rollback();
            throw;
        }
    }

    private static async Task InsertDeclarationLinesAsync(System.Data.IDbConnection connection, System.Data.IDbTransaction transaction, long declarationId, IReadOnlyList<CreateDeclarationLineRequest> lines, CancellationToken ct)
    {
        foreach (var line in lines)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "INSERT INTO log.ConsignmentDeclarationLine (DeclarationId, DeliveryId, Material, QtyAllocated) VALUES (@declarationId, @deliveryId, @material, @qtyAllocated)",
                new { declarationId, deliveryId = line.DeliveryId, material = line.Material, qtyAllocated = line.QtyAllocated }, transaction, cancellationToken: ct));
        }
    }

    internal static async Task<ConsignmentDeclarationDetail?> GetDeclarationAsync(INexusOperationsDb db, long declarationId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await GetDeclarationAsync(connection, declarationId, ct);
    }

    private static async Task<ConsignmentDeclarationDetail?> GetDeclarationAsync(System.Data.IDbConnection connection, long declarationId, CancellationToken ct)
    {
        var header = await connection.QuerySingleOrDefaultAsync<ConsignmentDeclarationSummaryRow?>(new CommandDefinition("""
            SELECT dec.DeclarationId, dec.VendorId, v.VendorName, dec.Status, dec.AllocationMethod, dec.TotalQty,
                dec.CreatedAtUtc, dec.CreatedByUsername, dec.ConfirmedAtUtc, dec.ConfirmedByUsername,
                dec.SettlementDocumentNumber, dec.SettlementReconciledQty, dec.Notes
            FROM log.ConsignmentDeclaration dec
            JOIN log.Vendor v ON v.VendorId = dec.VendorId
            WHERE dec.DeclarationId = @declarationId
            """, new { declarationId }, cancellationToken: ct));
        if (header is null) return null;

        // ExpiryDate is the same calculated-fallback expression as ListDeliveriesAsync,
        // computed fresh on every read so a later ExpiryDays config change is
        // reflected on a still-open Draft declaration too.
        var lines = await connection.QueryAsync<ConsignmentDeclarationLineRow>(new CommandDefinition("""
            SELECT dl.DeclarationLineId, dl.DeliveryId, dl.Material, dl.QtyAllocated,
                d.InvoiceNumber, d.MaterialDocument, d.DocumentDate, d.Uom,
                ISNULL(d.ExpiryDate,
                       CASE WHEN cvc.ExpiryDays IS NOT NULL AND d.PostingDate IS NOT NULL
                            THEN DATEADD(day, cvc.ExpiryDays, d.PostingDate) END) AS ExpiryDate
            FROM log.ConsignmentDeclarationLine dl
            JOIN log.ConsignmentDelivery d ON d.DeliveryId = dl.DeliveryId
            LEFT JOIN log.ConsignmentVendorConfig cvc ON cvc.VendorId = d.VendorId
            WHERE dl.DeclarationId = @declarationId
            ORDER BY dl.Material, COALESCE(d.ExpiryDate,
                                            CASE WHEN cvc.ExpiryDays IS NOT NULL AND d.PostingDate IS NOT NULL
                                                 THEN DATEADD(day, cvc.ExpiryDays, d.PostingDate) END,
                                            '9999-12-31')
            """, new { declarationId }, cancellationToken: ct));

        return new ConsignmentDeclarationDetail(header, lines.AsList());
    }

    internal static async Task<IReadOnlyList<ConsignmentDeclarationSummaryRow>> ListDeclarationsAsync(INexusOperationsDb db, long? vendorId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var where = vendorId is not null ? "WHERE dec.VendorId = @vendorId" : "";
        var rows = await connection.QueryAsync<ConsignmentDeclarationSummaryRow>(new CommandDefinition($"""
            SELECT dec.DeclarationId, dec.VendorId, v.VendorName, dec.Status, dec.AllocationMethod, dec.TotalQty,
                dec.CreatedAtUtc, dec.CreatedByUsername, dec.ConfirmedAtUtc, dec.ConfirmedByUsername,
                dec.SettlementDocumentNumber, dec.SettlementReconciledQty, dec.Notes
            FROM log.ConsignmentDeclaration dec
            JOIN log.Vendor v ON v.VendorId = dec.VendorId
            {where}
            ORDER BY dec.CreatedAtUtc DESC
            """, new { vendorId }, cancellationToken: ct));
        return rows.AsList();
    }

    /// <summary>
    /// Confirms a Draft declaration and decrements RemainingQty on every
    /// delivery line it allocates against — the "commit" moment the
    /// VENDOR_CONSIGNMENT permission gates (matching the "elevated user
    /// permission to run SAP transaction MRKO" requirement — MRKO itself
    /// stays a manual SAP GUI step this phase; settlementDocumentNumber is
    /// what the user pastes back from it).
    /// </summary>
    internal static async Task<ConsignmentDeclarationDetail> ConfirmDeclarationAsync(INexusOperationsDb db, long declarationId, ConfirmDeclarationRequest body, string? username, CancellationToken ct)
    {
        var trimmedDoc = (body.SettlementDocumentNumber ?? "").Trim();
        if (trimmedDoc.Length > 0 && !System.Text.RegularExpressions.Regex.IsMatch(trimmedDoc, @"^\d{1,10}$"))
            throw new NexusValidationException(
                $"\"{body.SettlementDocumentNumber}\" isn't a valid settlement document number — SAP MRKO settlement documents are numeric, up to 10 digits (e.g. 1700003535).");

        using var connection = await db.CreateConnectionAsync(ct);
        using var transaction = connection.BeginTransaction();
        try
        {
            var status = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
                "SELECT Status FROM log.ConsignmentDeclaration WHERE DeclarationId = @declarationId", new { declarationId }, transaction, cancellationToken: ct));
            if (status is null) throw new NexusNotFoundException("Declaration not found.");
            if (status != "Draft") throw new NexusValidationException($"Declaration is already {status}, not Draft.");

            var lines = await connection.QueryAsync<(long DeliveryId, decimal QtyAllocated)>(new CommandDefinition(
                "SELECT DeliveryId, QtyAllocated FROM log.ConsignmentDeclarationLine WHERE DeclarationId = @declarationId",
                new { declarationId }, transaction, cancellationToken: ct));

            foreach (var (deliveryId, qty) in lines)
            {
                var updated = await connection.ExecuteAsync(new CommandDefinition("""
                    UPDATE log.ConsignmentDelivery SET RemainingQty = RemainingQty - @qty
                    WHERE DeliveryId = @deliveryId AND RemainingQty >= @qty
                    """, new { deliveryId, qty }, transaction, cancellationToken: ct));
                if (updated == 0)
                    throw new NexusValidationException(
                        $"Delivery line {deliveryId} no longer has enough remaining balance — someone else may have declared against it since this draft was built. Rebuild the declaration and try again.");
            }

            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE log.ConsignmentDeclaration SET
                    Status = 'Confirmed', ConfirmedAtUtc = GETUTCDATE(), ConfirmedByUsername = @username,
                    SettlementDocumentNumber = @settlementDocumentNumber, SettlementReconciledQty = @settlementReconciledQty
                WHERE DeclarationId = @declarationId
                """, new { declarationId, username, settlementDocumentNumber = trimmedDoc.Length > 0 ? trimmedDoc : null, settlementReconciledQty = body.SettlementReconciledQty },
                transaction, cancellationToken: ct));

            transaction.Commit();
        }
        catch
        {
            transaction.Rollback();
            throw;
        }

        return await GetDeclarationAsync(connection, declarationId, ct) ?? throw new NexusNotFoundException("Declaration vanished immediately after confirmation.");
    }

    internal static async Task CancelDeclarationAsync(INexusOperationsDb db, long declarationId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var updated = await connection.ExecuteAsync(new CommandDefinition(
            "UPDATE log.ConsignmentDeclaration SET Status = 'Cancelled' WHERE DeclarationId = @declarationId AND Status = 'Draft'",
            new { declarationId }, cancellationToken: ct));
        if (updated == 0)
            throw new NexusValidationException("Only a Draft declaration can be cancelled (Confirmed declarations already adjusted delivery balances).");
    }

    /// <summary>Per-material Starting Stock / Deliveries for one declaration's printable header — see Sub-phase 8e.2's PDF generation. Starting Stock = Delivered(all-time) minus Declared(Confirmed, all-time, excluding this declaration); Ending Stock is derived by the caller from the declaration's own QtyAllocated.</summary>
    internal static async Task<IReadOnlyDictionary<string, (decimal StartingStock, decimal Deliveries)>> GetDeclarationStockSummaryAsync(
        INexusOperationsDb db, long vendorId, long declarationId, IReadOnlyList<string> materials, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var result = new Dictionary<string, (decimal, decimal)>();
        foreach (var material in materials)
        {
            var row = await connection.QuerySingleAsync<(decimal DeliveredTotal, decimal DeliveredSinceLastDecl, decimal DeclaredConfirmedExcludingThis)>(new CommandDefinition("""
                DECLARE @prevDeclDate DATETIME = (
                    SELECT TOP 1 dec.CreatedAtUtc
                    FROM log.ConsignmentDeclaration dec
                    JOIN log.ConsignmentDeclarationLine dl ON dl.DeclarationId = dec.DeclarationId
                    WHERE dec.VendorId = @vendorId AND dl.Material = @material
                        AND dec.Status = 'Confirmed' AND dec.DeclarationId <> @declarationId
                    ORDER BY dec.CreatedAtUtc DESC
                );

                SELECT
                    ISNULL(SUM(d.Quantity), 0) AS DeliveredTotal,
                    ISNULL(SUM(CASE WHEN @prevDeclDate IS NULL
                                         OR ISNULL(d.PostingDate, ISNULL(d.DocumentDate, d.CreatedAtUtc)) > @prevDeclDate
                                     THEN d.Quantity ELSE 0 END), 0) AS DeliveredSinceLastDecl,
                    (SELECT ISNULL(SUM(dl2.QtyAllocated), 0)
                     FROM log.ConsignmentDeclarationLine dl2
                     JOIN log.ConsignmentDeclaration dec2 ON dec2.DeclarationId = dl2.DeclarationId
                     WHERE dec2.Status = 'Confirmed' AND dl2.Material = @material AND dec2.VendorId = @vendorId
                         AND dec2.DeclarationId <> @declarationId) AS DeclaredConfirmedExcludingThis
                FROM log.ConsignmentDelivery d
                WHERE d.VendorId = @vendorId AND d.Material = @material
                """, new { vendorId, declarationId, material }, cancellationToken: ct));

            result[material] = (row.DeliveredTotal - row.DeclaredConfirmedExcludingThis, row.DeliveredSinceLastDecl);
        }
        return result;
    }

    // ── Reassigning declarations off cancelled stock (see this class's own
    // header comment — real, unit-tested logic, but not wired to any route
    // in Node either) ────────────────────────────────────────────────────

    internal static IReadOnlyList<ReassignmentPlanItem> ComputeReassignmentPlan(IReadOnlyList<CancelledDeclarationLine> cancelledLines, IReadOnlyList<OpenDeliveryForReassignment> openDeliveryRows)
    {
        var byMaterial = new Dictionary<string, List<OpenDeliveryForReassignment>>();
        foreach (var row in openDeliveryRows)
        {
            if (!byMaterial.TryGetValue(row.Material, out var list)) { list = []; byMaterial[row.Material] = list; }
            list.Add(row);
        }
        foreach (var list in byMaterial.Values)
        {
            list.Sort((a, b) =>
            {
                var cmp = (a.ExpiryDate ?? DateTime.MaxValue).CompareTo(b.ExpiryDate ?? DateTime.MaxValue);
                return cmp != 0 ? cmp : (a.DocumentDate ?? DateTime.MaxValue).CompareTo(b.DocumentDate ?? DateTime.MaxValue);
            });
        }

        var remainingByDeliveryId = openDeliveryRows.ToDictionary(r => r.DeliveryId, r => r.RemainingQty);
        var ordered = cancelledLines.OrderBy(l => l.DeclarationId).ThenBy(l => l.DeclarationLineId).ToList();

        var result = new List<ReassignmentPlanItem>();
        foreach (var line in ordered)
        {
            var pool = byMaterial.GetValueOrDefault(line.Material) ?? [];
            var allocatable = pool.Select(r => new AllocatableDeliveryRow(r.DeliveryId, r.Material, remainingByDeliveryId.GetValueOrDefault(r.DeliveryId), null, r.ExpiryDate, r.DocumentDate)).ToList();
            var proposal = BuildAllocationProposal(allocatable, line.QtyAllocated);
            foreach (var split in proposal.Lines)
                remainingByDeliveryId[split.DeliveryId] -= split.QtyAllocated;

            result.Add(new ReassignmentPlanItem(
                line.DeclarationLineId, line.DeclarationId, line.Material, line.CancelledDeliveryId, Math.Round(line.QtyAllocated, 3),
                proposal.Lines.Select(l => new ReassignmentSplit(l.DeliveryId, l.QtyAllocated)).ToList(), proposal.UnallocatedQty));
        }
        return result;
    }

    internal static async Task<IReadOnlyList<ReassignmentPlanItem>> BuildReassignmentPlanForVendorAsync(INexusOperationsDb db, long vendorId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var allRows = (await connection.QueryAsync<ReversalWalkRow>(new CommandDefinition("""
            SELECT DeliveryId, Material, MaterialDocument, MaterialDocItem, Quantity, RemainingQty,
                ReversalOfMaterialDocument, ReversalOfMaterialDocItem
            FROM log.ConsignmentDelivery WHERE VendorId = @vendorId
            """, new { vendorId }, cancellationToken: ct))).AsList();

        var needsReview = ComputeReversalCancellations(allRows).NeedsReview;
        var cancelledDeliveryIds = needsReview.Where(n => n.Quantity > 0).Select(n => n.DeliveryId).ToList();
        if (cancelledDeliveryIds.Count == 0) return [];

        var lines = (await connection.QueryAsync<CancelledDeclarationLine>(new CommandDefinition("""
            SELECT dl.DeclarationLineId, dl.DeclarationId, dl.DeliveryId AS CancelledDeliveryId, dl.Material, dl.QtyAllocated
            FROM log.ConsignmentDeclarationLine dl
            WHERE dl.DeliveryId IN @cancelledDeliveryIds
            """, new { cancelledDeliveryIds }, cancellationToken: ct))).AsList();
        if (lines.Count == 0) return [];

        var openRows = (await connection.QueryAsync<OpenDeliveryForReassignment>(new CommandDefinition("""
            SELECT d.DeliveryId, d.Material, d.RemainingQty,
                ISNULL(d.ExpiryDate,
                       CASE WHEN cvc.ExpiryDays IS NOT NULL AND d.PostingDate IS NOT NULL
                            THEN DATEADD(day, cvc.ExpiryDays, d.PostingDate) END) AS ExpiryDate,
                d.DocumentDate
            FROM log.ConsignmentDelivery d
            LEFT JOIN log.ConsignmentVendorConfig cvc ON cvc.VendorId = d.VendorId
            WHERE d.VendorId = @vendorId AND d.RemainingQty > 0
            """, new { vendorId }, cancellationToken: ct))).AsList();

        return ComputeReassignmentPlan(lines, openRows);
    }

    /// <summary>Skips (does not write) any item with a shortfall — real open stock ran out before the declared quantity was fully covered — rather than partially reassigning it.</summary>
    internal static async Task<ReassignmentApplyResult> ApplyReassignmentPlanAsync(INexusOperationsDb db, IReadOnlyList<ReassignmentPlanItem> plan, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var applied = new List<ReassignmentPlanItem>();
        var skipped = new List<ReassignmentPlanItem>();

        foreach (var item in plan)
        {
            if (item.Shortfall > 0.001m) { skipped.Add(item); continue; }

            using var transaction = connection.BeginTransaction();
            try
            {
                if (item.Splits.Count == 1)
                {
                    await connection.ExecuteAsync(new CommandDefinition(
                        "UPDATE log.ConsignmentDeclarationLine SET DeliveryId = @deliveryId WHERE DeclarationLineId = @declarationLineId",
                        new { declarationLineId = item.DeclarationLineId, deliveryId = item.Splits[0].DeliveryId }, transaction, cancellationToken: ct));
                }
                else
                {
                    await connection.ExecuteAsync(new CommandDefinition(
                        "DELETE FROM log.ConsignmentDeclarationLine WHERE DeclarationLineId = @declarationLineId",
                        new { declarationLineId = item.DeclarationLineId }, transaction, cancellationToken: ct));
                    foreach (var split in item.Splits)
                    {
                        await connection.ExecuteAsync(new CommandDefinition(
                            "INSERT INTO log.ConsignmentDeclarationLine (DeclarationId, DeliveryId, Material, QtyAllocated) VALUES (@declarationId, @deliveryId, @material, @qtyAllocated)",
                            new { declarationId = item.DeclarationId, deliveryId = split.DeliveryId, material = item.Material, qtyAllocated = split.Qty }, transaction, cancellationToken: ct));
                    }
                }

                foreach (var split in item.Splits)
                {
                    await connection.ExecuteAsync(new CommandDefinition(
                        "UPDATE log.ConsignmentDelivery SET RemainingQty = RemainingQty - @qty WHERE DeliveryId = @deliveryId",
                        new { deliveryId = split.DeliveryId, qty = split.Qty }, transaction, cancellationToken: ct));
                }

                transaction.Commit();
                applied.Add(item);
            }
            catch
            {
                transaction.Rollback();
                throw;
            }
        }

        return new ReassignmentApplyResult(applied, skipped);
    }
}

/// <summary>Minimal shape ComputeReversalCancellations actually needs — a subset of ConsignmentDeliveryRow's columns.</summary>
internal sealed record ReversalWalkRow(long DeliveryId, string Material, string MaterialDocument, string MaterialDocItem, decimal Quantity, decimal RemainingQty, string? ReversalOfMaterialDocument, string? ReversalOfMaterialDocItem);

/// <summary>Minimal shape BuildAllocationProposal actually needs.</summary>
internal sealed record AllocatableDeliveryRow(long DeliveryId, string Material, decimal RemainingQty, string? InvoiceNumber, DateTime? ExpiryDate, DateTime? DocumentDate);

internal sealed record AllocationProposal(IReadOnlyList<AllocationProposalLine> Lines, decimal UnallocatedQty);
