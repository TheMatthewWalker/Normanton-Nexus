using System.Globalization;
using System.Text.RegularExpressions;
using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Warehouse;

/// <summary>
/// Open Picksheets, Packaging Holding, the SAP-backed picksheet
/// materials/stock panel, linked picksheets, and link-search — port of
/// the read-only half of routes/deliverymain.js's picksheet-building
/// section. WAREHOUSE_OP is Warehouse's own widest-reaching legacy
/// permission code, kept unsplit for now (same deferred-per-tile-split
/// precedent Production's Sub-phase 6a set for PROD_SUPERVISOR) — a real
/// per-tile split is a decision for whichever later Warehouse sub-phase
/// actually needs it, not this one.
/// </summary>
internal static partial class WarehousePicksheetHelper
{
    internal const string FnOp = "WAREHOUSE_OP";

    [GeneratedRegex(@"^0+(?=\d)")]
    private static partial Regex LeadingZeros();

    [GeneratedRegex(@"^[^_]*_(\d+)_")]
    private static partial Regex PackagingInstructionCustomerRegex();

    /// <summary>SAP returns delivery numbers zero-padded to 10 digits (VBELN); the portal stores/sends them unpadded — strips leading zeros so the two can be compared directly. Mirrors Node's norm() exactly, including leaving a bare "0" alone (the regex only strips a leading zero followed by another digit).</summary>
    private static string Norm(object? v) => LeadingZeros().Replace((v?.ToString() ?? "").Trim(), "");

    /// <summary>
    /// SAP quantities (LFIMG/GESME/VERME) can come back either
    /// European-grouped ("10.875,000" = 10875) or plain invariant
    /// ("1234.56" = 1234.56) — the same per-value ambiguity SapServer's
    /// own RfcRowExtensions.ParseSapDecimal was built to resolve (see
    /// SapServer/CLAUDE.md's decimal-parsing bug writeup: a fixed-format
    /// assumption inflated real values by a power of ten). Node's own
    /// parseSapNum in deliverymain.js assumes every value is
    /// European-grouped, unconditionally stripping any period whenever no
    /// comma is present — the exact fixed-format assumption SapServer's
    /// own history already confirmed is wrong for this SAP system's
    /// mixed-format data. Deliberately NOT ported bug-compatible: this
    /// applies SapServer's already-proven-correct last-separator-wins
    /// algorithm instead, since SapServer's own PicksheetHelpers.
    /// ParseStockRows/ParseLipsRows return these same raw, unparsed
    /// strings for the exact same underlying LQUA/LIPS data (confirmed by
    /// reading that source directly) — flagged here for verification
    /// against real SAP data, same as every other "reasoned but unproven"
    /// call this migration makes without live system access.
    /// </summary>
    internal static decimal ParseSapQuantity(string? raw)
    {
        var s = (raw ?? "").Trim();
        if (s.Length == 0) return 0m;

        var lastComma = s.LastIndexOf(',');
        var lastPeriod = s.LastIndexOf('.');

        string normalized;
        if (lastComma >= 0 && lastPeriod >= 0)
        {
            normalized = lastComma > lastPeriod
                ? s.Replace(".", "").Replace(',', '.')
                : s.Replace(",", "");
        }
        else if (lastComma >= 0)
        {
            normalized = s.Replace(',', '.');
        }
        else
        {
            normalized = s;
        }

        return decimal.TryParse(normalized, NumberStyles.Any, CultureInfo.InvariantCulture, out var d) ? d : 0m;
    }

    internal static async Task<DeliveryMainRow?> GetByIdAsync(INexusOperationsDb db, long deliveryId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleOrDefaultAsync<DeliveryMainRow>(new CommandDefinition("""
            SELECT deliveryID AS DeliveryId, customerID AS CustomerId, dispatchDate AS DispatchDate, deliveryDate AS DeliveryDate,
                   completionDate AS CompletionDate, completionStatus AS CompletionStatus, operatorName AS OperatorName,
                   supervisorName AS SupervisorName, netWeight AS NetWeight, grossWeight AS GrossWeight, palletCount AS PalletCount,
                   deliveryVolume AS DeliveryVolume, picksheetComment AS PicksheetComment, deliveryCancelled AS DeliveryCancelled,
                   deliveryPriority AS DeliveryPriority, deliveryService AS DeliveryService, incoterms AS Incoterms,
                   pendingPackagingData AS PendingPackagingData, movedToHoldingAtUtc AS MovedToHoldingAtUtc
            FROM log.DeliveryMain WHERE deliveryID = @deliveryId
            """, new { deliveryId }, cancellationToken: ct));
    }

    internal static async Task<IReadOnlyList<OpenPicksheetRow>> GetOpenPicksheetsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<OpenPicksheetRow>(new CommandDefinition("""
            SELECT dm.deliveryID AS DeliveryId, dm.customerID AS CustomerId, d.destinationName AS DestinationName, dm.dispatchDate AS DispatchDate,
                   dm.deliveryService AS DeliveryService, dm.picksheetComment AS PicksheetComment, dm.deliveryPriority AS DeliveryPriority,
                   dm.incoterms AS Incoterms
            FROM log.DeliveryMain dm
            LEFT JOIN log.Destinations d ON dm.customerID = d.destinationID
            WHERE dm.completionStatus = 0 AND dm.deliveryCancelled = 0
            ORDER BY dm.deliveryPriority DESC, dm.dispatchDate ASC
            """, cancellationToken: ct));
        return rows.ToArray();
    }

    internal static async Task<IReadOnlyList<PackagingHoldingRow>> GetPackagingHoldingAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<PackagingHoldingRow>(new CommandDefinition("""
            SELECT dm.deliveryID AS DeliveryId, dm.customerID AS CustomerId, d.destinationName AS DestinationName, dm.dispatchDate AS DispatchDate,
                   dm.deliveryService AS DeliveryService, dm.picksheetComment AS PicksheetComment, dm.deliveryPriority AS DeliveryPriority,
                   dm.incoterms AS Incoterms, dm.movedToHoldingAtUtc AS MovedToHoldingAtUtc
            FROM log.DeliveryMain dm
            LEFT JOIN log.Destinations d ON dm.customerID = d.destinationID
            WHERE dm.completionStatus = 1 AND dm.pendingPackagingData = 1 AND ISNULL(dm.deliveryCancelled, 0) = 0
            ORDER BY dm.movedToHoldingAtUtc DESC
            """, cancellationToken: ct));
        return rows.ToArray();
    }

    internal static async Task<IReadOnlyList<LinkedPicksheetRow>> GetLinkedPicksheetsAsync(INexusOperationsDb db, long deliveryId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<LinkedPicksheetRow>(new CommandDefinition("""
            SELECT lk.linkedDeliveryID AS DeliveryId, dm.customerID AS CustomerId, d.destinationName AS DestinationName,
                   dm.completionStatus AS CompletionStatus, dm.dispatchDate AS DispatchDate
            FROM log.DeliveryPicksheetLink lk
            INNER JOIN log.DeliveryMain dm ON dm.deliveryID = lk.linkedDeliveryID
            LEFT JOIN log.Destinations d ON d.destinationID = dm.customerID
            WHERE lk.deliveryID = @deliveryId
            ORDER BY lk.linkedDeliveryID ASC
            """, new { deliveryId }, cancellationToken: ct));
        return rows.ToArray();
    }

    /// <summary>Same open/not-cancelled scoping as GetOpenPicksheetsAsync, restricted to excludeDeliveryId's own customer (a shared pallet is one physical unit for one destination) and excluding whatever's already linked to it.</summary>
    internal static async Task<IReadOnlyList<LinkSearchRow>> LinkSearchAsync(INexusOperationsDb db, long? excludeDeliveryId, string? q, CancellationToken ct)
    {
        if (excludeDeliveryId is null)
        {
            throw new NexusValidationException("excludeDeliveryId required");
        }

        using var connection = await db.CreateConnectionAsync(ct);

        var customerId = await connection.QuerySingleOrDefaultAsync<long?>(new CommandDefinition(
            "SELECT customerID FROM log.DeliveryMain WHERE deliveryID = @excludeDeliveryId", new { excludeDeliveryId }, cancellationToken: ct));
        if (customerId is null)
        {
            throw new NexusNotFoundException("Delivery not found");
        }

        var qTrimmed = (q ?? "").Trim();
        var rows = await connection.QueryAsync<LinkSearchRow>(new CommandDefinition("""
            SELECT TOP 50 dm.deliveryID AS DeliveryId, dm.customerID AS CustomerId, d.destinationName AS DestinationName, dm.dispatchDate AS DispatchDate
            FROM log.DeliveryMain dm
            LEFT JOIN log.Destinations d ON d.destinationID = dm.customerID
            WHERE dm.completionStatus = 0 AND ISNULL(dm.deliveryCancelled, 0) = 0
              AND dm.customerID = @customerId
              AND dm.deliveryID <> @excludeDeliveryId
              AND NOT EXISTS (
                  SELECT 1 FROM log.DeliveryPicksheetLink lk
                  WHERE lk.deliveryID = @excludeDeliveryId AND lk.linkedDeliveryID = dm.deliveryID
              )
              AND (@q IS NULL OR CAST(dm.deliveryID AS NVARCHAR(20)) LIKE @q OR d.destinationName LIKE @q)
            ORDER BY dm.dispatchDate ASC
            """, new { excludeDeliveryId, customerId, q = qTrimmed.Length > 0 ? $"%{qTrimmed}%" : null }, cancellationToken: ct));
        return rows.ToArray();
    }

    /// <summary>
    /// Orchestrates: LIPS (materials required for this delivery) →
    /// picksheet-stock (LQUA+ZPRODBATCH batches for those materials) →
    /// LIKP (customer on any delivery a batch is already tagged against).
    /// Calls SapServer directly (not proxied through this app's own HTTP
    /// layer) via ISapServerClient, same as every other SAP-facing Helper
    /// in this migration. Mirrors Node's getRemainingRequiredMaterials
    /// exactly, aside from the decimal-parsing fix documented on
    /// ParseSapQuantity above.
    /// </summary>
    internal static async Task<PicksheetMaterialsResult> GetPicksheetMaterialsAsync(INexusOperationsDb db, ISapServerClient sap, long deliveryId, int userId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);

        var customerId = await connection.QuerySingleOrDefaultAsync<long?>(new CommandDefinition(
            "SELECT customerID FROM log.DeliveryMain WHERE deliveryID = @deliveryId", new { deliveryId }, cancellationToken: ct));

        // 1. What material(s) and quantity does this delivery need?
        var lipsRows = await sap.PostAsync<List<SapPicksheetLipsRow>>("api/warehouse/picksheet-materials",
            new SapPicksheetLipsRequest([deliveryId.ToString()]), userId, ct: ct) ?? [];

        var materials = lipsRows.Select(r => (r.MaterialNumber ?? "").Trim()).Where(m => m.Length > 0).Distinct().ToList();
        if (materials.Count == 0)
        {
            return new PicksheetMaterialsResult(customerId, []);
        }

        // 2. Where is that material physically sitting, and is any of it already tagged against another delivery?
        var batchRows = await sap.PostAsync<List<SapPicksheetBatchRow>>("api/warehouse/picksheet-stock",
            new SapPicksheetStockRequest(materials), userId, ct: ct) ?? [];

        // 2b. Profit centre per material — materials on profit centre 2007
        // are packed differently (each batch sits inside a C2 box, the
        // pallet itself is one MB holding all of those C2s). Best-effort
        // per material, matching Node's Promise.all + swallowed catch —
        // a lookup failure just leaves that material's profit centre
        // undetermined rather than failing the whole picksheet load.
        const string containerProfitCentre = "2007";
        var profitCentreResults = await Task.WhenAll(materials.Select(async mat =>
        {
            try
            {
                var raw = await sap.GetAsync<string>("api/production/check-profit-centre", userId, new ProfitCentreRequest(mat), ct: ct);
                return (Material: mat, ProfitCentre: (string?)Norm((raw ?? "").Trim()));
            }
            catch
            {
                return (Material: mat, ProfitCentre: (string?)null);
            }
        }));
        var profitCentreByMaterial = profitCentreResults.Where(r => r.ProfitCentre is not null).ToDictionary(r => r.Material, r => r.ProfitCentre!);

        // 3. For any batch allocated elsewhere, whose customer is that delivery?
        // A batch sitting in storage type 916 (the picksheet-staging area)
        // is allocated to whichever delivery its bin is named after (the
        // bin IS that delivery's own number, zero-padded to 10 digits) —
        // that's a live signal the transfer order itself produces, unlike
        // the older ZPRODBATCH~VBELN tagging field, so it's preferred
        // whenever the batch is actually sitting in a 916 bin.
        const string stagingStorageType = "916";
        string DeriveAllocDelivery(SapPicksheetBatchRow b)
        {
            var bin = (b.StorageType ?? "").Trim() == stagingStorageType ? (b.Bin ?? "").Trim() : "";
            return bin.Length > 0 && bin.All(char.IsDigit) ? Norm(bin) : Norm(b.AllocatedDelivery);
        }

        var deliveryIdNorm = Norm(deliveryId.ToString());
        var conflictDeliveries = batchRows.Select(DeriveAllocDelivery).Where(v => v.Length > 0 && v != deliveryIdNorm).Distinct().ToList();

        var customerByDelivery = new Dictionary<string, string>();
        if (conflictDeliveries.Count > 0)
        {
            try
            {
                var likpRows = await sap.PostAsync<List<SapLikpRow>>("api/customs/likp", new SapLikpRequest(conflictDeliveries), userId, ct: ct) ?? [];
                foreach (var r in likpRows)
                {
                    customerByDelivery[Norm(r.DeliveryNumber)] = Norm(r.ConsigneeCode);
                }
            }
            catch
            {
                // LIKP lookup failing is a SAP-availability problem for the
                // allocation-conflict detail only — the batches themselves
                // are still shown, just without a resolved conflicting
                // customer, matching Node's own `if (likpBody?.success !== false)` guard.
            }
        }

        // 4. Assemble: one entry per required material.
        var byMaterial = new Dictionary<string, PicksheetRequiredMaterialBuilder>();
        foreach (var r in lipsRows)
        {
            var mat = (r.MaterialNumber ?? "").Trim();
            if (mat.Length == 0) continue;
            if (!byMaterial.TryGetValue(mat, out var entry))
            {
                entry = new PicksheetRequiredMaterialBuilder(mat, r.ItemNumber);
                byMaterial[mat] = entry;
            }
            entry.RequiredQty += ParseSapQuantity(r.Quantity);
        }

        // SAP's LIPS open quantity only drops at goods issue, so on its own
        // requiredQty is "not yet at all dispatched," not "not yet
        // picked." Subtract what's already in log.PalletPackages for this
        // delivery (every pallet, not just whichever one is currently
        // open, and excluding removed pallets — a deleted pallet reverses
        // its packages' SAP staging but deliberately leaves the
        // PalletPackages rows in place for history) so the panel reflects
        // what's actually still left to pick.
        var pickedRows = await connection.QueryAsync<(string SapMaterial, decimal PickedQty)>(new CommandDefinition("""
            SELECT pp.sapMaterial AS SapMaterial, SUM(pp.sapQuantity) AS PickedQty
            FROM log.PalletPackages pp
            JOIN log.PalletMain pm ON pm.palletID = pp.palletID
            WHERE pp.sapDelivery = @sapDelivery AND pp.sapMaterial IS NOT NULL AND pm.palletRemoved = 0
            GROUP BY pp.sapMaterial
            """, new { sapDelivery = deliveryId.ToString() }, cancellationToken: ct));

        foreach (var row in pickedRows)
        {
            var mat = row.SapMaterial.Trim();
            if (mat.Length == 0 || !byMaterial.TryGetValue(mat, out var entry)) continue;
            entry.RequiredQty = Math.Max(0, entry.RequiredQty - row.PickedQty);
        }

        // Packaging instruction (ZPRODBATCH~PALL_MATNR) encodes the
        // customer it was built for as its middle underscore-delimited
        // segment, e.g. "IB_363660_C2" -> customer 363660. A batch built
        // for a different customer than this delivery's is still shown
        // (so the operator can see the stock exists) but grouped and
        // locked out like an allocation conflict, just under its own
        // "wrongCustomer" reason. A blank/unparseable instruction isn't a
        // mismatch — grouped separately ("unassigned") for visibility.
        string? PackagingInstructionCustomer(string? packagingMaterial)
        {
            var match = PackagingInstructionCustomerRegex().Match(packagingMaterial ?? "");
            return match.Success ? Norm(match.Groups[1].Value) : null;
        }

        var customerIdNorm = Norm(customerId?.ToString());
        foreach (var b in batchRows)
        {
            var mat = (b.Material ?? "").Trim();
            if (mat.Length == 0) continue;
            if (!byMaterial.TryGetValue(mat, out var entry))
            {
                entry = new PicksheetRequiredMaterialBuilder(mat, null);
                byMaterial[mat] = entry;
            }

            var allocDelivery = DeriveAllocDelivery(b);
            var stagedViaBin = (b.StorageType ?? "").Trim() == stagingStorageType && allocDelivery.Length > 0 && Norm(b.Bin) == allocDelivery;
            // A batch sitting in THIS delivery's own 916 bin was staged
            // there by this app's own picksheet-stage-batch call — it's
            // already picked, and needs to drop out of the available list
            // just like a batch staged to a different delivery's bin does.
            var stagedToThisDelivery = stagedViaBin && allocDelivery == deliveryIdNorm;
            var isOwnOrUnassigned = allocDelivery.Length == 0 || (allocDelivery == deliveryIdNorm && !stagedToThisDelivery);
            var allocCustomer = allocDelivery.Length > 0 && customerByDelivery.TryGetValue(allocDelivery, out var ac) ? ac : null;
            var sameCustomer = allocCustomer is null || allocCustomer == customerIdNorm;
            var allocationAllowed = isOwnOrUnassigned || sameCustomer;

            var packagingCustomer = PackagingInstructionCustomer(b.PackagingMaterial);
            var packagingMismatch = packagingCustomer is not null && packagingCustomer != customerIdNorm;
            var packagingCustomerUnknown = packagingCustomer is null;
            var allowed = allocationAllowed && !packagingMismatch && !stagedToThisDelivery;

            // Precedence: wrong-customer packaging blocks first (strongest
            // reason), then already-picked-on-this-delivery, then existing
            // allocation conflicts, then "we simply don't know."
            string group;
            string? reason;
            if (packagingMismatch)
            {
                group = "wrongCustomer";
                reason = $"Packaged for customer {packagingCustomer}, not {(customerIdNorm.Length > 0 ? customerIdNorm : "this delivery")}";
            }
            else if (stagedToThisDelivery)
            {
                group = "restricted";
                reason = "Already picked to a pallet on this delivery";
            }
            else if (!allocationAllowed)
            {
                group = "restricted";
                reason = stagedViaBin
                    ? $"Already staged to delivery {allocDelivery}'s bin{(allocCustomer is not null ? $" (customer {allocCustomer})" : "")}"
                    : $"Already allocated to delivery {allocDelivery}{(allocCustomer is not null ? $" (customer {allocCustomer})" : "")}";
            }
            else if (packagingCustomerUnknown)
            {
                group = "unassigned";
                reason = null;
            }
            else
            {
                group = "available";
                reason = null;
            }

            entry.Batches.Add(new PicksheetMaterialBatch(
                Batch: (b.Batch ?? "").Trim(),
                StorageType: b.StorageType,
                Bin: b.Bin,
                TotalQty: ParseSapQuantity(b.TotalQty),
                AvailableQty: ParseSapQuantity(b.AvailableQty),
                StockCategory: b.StockCategory,
                PackagingMaterial: b.PackagingMaterial,
                AllocatedDelivery: isOwnOrUnassigned ? null : allocDelivery,
                Allowed: allowed,
                Group: group,
                Reason: reason));
        }

        var result = byMaterial.Values.Select(m =>
        {
            var profitCentre = profitCentreByMaterial.GetValueOrDefault(m.Material);
            return new PicksheetRequiredMaterial(m.Material, m.RequiredQty, m.DeliveryItem, m.Batches, profitCentre, profitCentre == containerProfitCentre);
        }).ToList();

        return new PicksheetMaterialsResult(customerId, result);
    }

    /// <summary>Mutable accumulator for one material's requiredQty/batches while GetPicksheetMaterialsAsync builds the result — mirrors Node's own byMaterial[mat] object being mutated in place across two separate forEach passes (lipsRows, then batchRows).</summary>
    private sealed class PicksheetRequiredMaterialBuilder(string material, string? deliveryItem)
    {
        internal string Material { get; } = material;
        internal string? DeliveryItem { get; } = deliveryItem;
        internal decimal RequiredQty { get; set; }
        internal List<PicksheetMaterialBatch> Batches { get; } = [];
    }
}
