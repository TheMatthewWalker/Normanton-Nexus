using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Logistics reference data — Sub-phase 8d. Port of routes/costtypes.js,
/// costelements.js, costcenters.js, forwarders.js, forwarderapproval.js,
/// forwardermodemapping.js, incoterms.js, rateskn.js, ratestpn.js,
/// assignmenttpn.js, deliveryroutes.js — ~11 small, largely uniform CRUD
/// tiles against simple log.* reference tables (NexusOperations database).
/// See LogisticsReferenceController for the exact route-per-file mapping.
///
/// Every response is standardized on this app's ApiResponse&lt;T&gt; envelope
/// — several of these Node files return a bare `res.json(result.recordset)`
/// array or `{error: msg}` instead of the `{success,data,error}` shape most
/// of the rest of the app already uses; this port doesn't perpetuate that
/// per-file inconsistency, matching how every other department here has
/// already standardized regardless of which raw shape Node's own file used.
///
/// Permission gates are ported exactly per resource, including a real,
/// confirmed asymmetry in Node itself: CostTypes/ForwarderApproval/
/// Incoterms/RatesKN/RatesTPN/AssignmentTPN have NO gate on writes at all
/// (any logged-in user can create a row); CostElements/CostCenters/
/// Forwarders/DeliveryRoutes/MaterialRequestUnits gate writes with
/// LOG_ADMIN; ForwarderModeMapping is the only one gated LOG_ADMIN even on
/// its GET actions. Confirmed by reading every route handler directly, not
/// assumed uniform.
/// </summary>
internal static class LogisticsReferenceHelper
{
    // ── Cost Types (log.CostTypes) — no write gate in Node ──────────────

    internal static async Task<IReadOnlyList<CostTypeRow>> ListCostTypesAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<CostTypeRow>(new CommandDefinition("SELECT typeID AS TypeId, typeDescription AS TypeDescription FROM log.CostTypes", cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<CostTypeRow?> GetCostTypeAsync(INexusOperationsDb db, long typeId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleOrDefaultAsync<CostTypeRow>(new CommandDefinition(
            "SELECT typeID AS TypeId, typeDescription AS TypeDescription FROM log.CostTypes WHERE typeID = @typeId", new { typeId }, cancellationToken: ct));
    }

    internal static async Task CreateCostTypeAsync(INexusOperationsDb db, CreateCostTypeRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "INSERT INTO log.CostTypes (typeID, typeDescription) VALUES (@TypeId, @TypeDescription)", body, cancellationToken: ct));
    }

    // ── Cost Elements (log.CostElements) — LOG_ADMIN writes ─────────────
    // elementID is a legacy identity-style column populated by the
    // database (per Node's own comment) — this port's insert also omits
    // it and reads back INSERTED.elementID, matching that behavior exactly
    // even though the captured schema shows a plain nullable BIGINT with
    // no IDENTITY property (see dotnet/CLAUDE.md's flagged note on this).

    internal static async Task<IReadOnlyList<CostElementRow>> ListCostElementsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<CostElementRow>(new CommandDefinition(
            "SELECT elementID AS ElementId, elementDescription AS ElementDescription, elementCode AS ElementCode, direction AS Direction, tier AS Tier FROM log.CostElements", cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<CostElementRow?> GetCostElementAsync(INexusOperationsDb db, long elementId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleOrDefaultAsync<CostElementRow>(new CommandDefinition(
            "SELECT elementID AS ElementId, elementDescription AS ElementDescription, elementCode AS ElementCode, direction AS Direction, tier AS Tier FROM log.CostElements WHERE elementID = @elementId", new { elementId }, cancellationToken: ct));
    }

    internal static async Task<long?> CreateCostElementAsync(INexusOperationsDb db, CreateCostElementRequest body, CancellationToken ct)
    {
        ValidateCodeAndDescription(body.ElementCode, "elementCode", body.ElementDescription, "elementDescription");
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleAsync<long?>(new CommandDefinition("""
            INSERT INTO log.CostElements (elementCode, elementDescription, direction, tier)
            OUTPUT INSERTED.elementID
            VALUES (@elementCode, @elementDescription, @direction, @tier)
            """, new { elementCode = body.ElementCode.Trim(), elementDescription = body.ElementDescription.Trim(), direction = body.Direction, tier = body.Tier }, cancellationToken: ct));
    }

    internal static async Task UpdateCostElementAsync(INexusOperationsDb db, long elementId, CreateCostElementRequest body, CancellationToken ct)
    {
        ValidateCodeAndDescription(body.ElementCode, "elementCode", body.ElementDescription, "elementDescription");
        using var connection = await db.CreateConnectionAsync(ct);
        var rowsAffected = await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.CostElements
            SET elementCode = @elementCode, elementDescription = @elementDescription, direction = @direction, tier = @tier
            WHERE elementID = @elementId
            """, new { elementId, elementCode = body.ElementCode.Trim(), elementDescription = body.ElementDescription.Trim(), direction = body.Direction, tier = body.Tier }, cancellationToken: ct));

        if (rowsAffected == 0)
            throw new NexusNotFoundException("GL account not found.");
    }

    internal static async Task DeleteCostElementAsync(INexusOperationsDb db, long elementId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("DELETE FROM log.CostElements WHERE elementID = @elementId", new { elementId }, cancellationToken: ct));
    }

    // ── Cost Centers (log.CostCenters) — LOG_ADMIN writes ────────────────

    internal static async Task<IReadOnlyList<CostCenterRow>> ListCostCentersAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<CostCenterRow>(new CommandDefinition(
            "SELECT centerID AS CenterId, centerDescription AS CenterDescription, centerCode AS CenterCode FROM log.CostCenters", cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<CostCenterRow?> GetCostCenterAsync(INexusOperationsDb db, long centerId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleOrDefaultAsync<CostCenterRow>(new CommandDefinition(
            "SELECT centerID AS CenterId, centerDescription AS CenterDescription, centerCode AS CenterCode FROM log.CostCenters WHERE centerID = @centerId", new { centerId }, cancellationToken: ct));
    }

    internal static async Task<long?> CreateCostCenterAsync(INexusOperationsDb db, CreateCostCenterRequest body, CancellationToken ct)
    {
        ValidateCodeAndDescription(body.CenterCode, "centerCode", body.CenterDescription, "centerDescription");
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleAsync<long?>(new CommandDefinition("""
            INSERT INTO log.CostCenters (centerCode, centerDescription)
            OUTPUT INSERTED.centerID
            VALUES (@centerCode, @centerDescription)
            """, new { centerCode = body.CenterCode.Trim(), centerDescription = body.CenterDescription.Trim() }, cancellationToken: ct));
    }

    internal static async Task UpdateCostCenterAsync(INexusOperationsDb db, long centerId, CreateCostCenterRequest body, CancellationToken ct)
    {
        ValidateCodeAndDescription(body.CenterCode, "centerCode", body.CenterDescription, "centerDescription");
        using var connection = await db.CreateConnectionAsync(ct);
        var rowsAffected = await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.CostCenters SET centerCode = @centerCode, centerDescription = @centerDescription WHERE centerID = @centerId
            """, new { centerId, centerCode = body.CenterCode.Trim(), centerDescription = body.CenterDescription.Trim() }, cancellationToken: ct));

        if (rowsAffected == 0)
            throw new NexusNotFoundException("Cost centre not found.");
    }

    internal static async Task DeleteCostCenterAsync(INexusOperationsDb db, long centerId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("DELETE FROM log.CostCenters WHERE centerID = @centerId", new { centerId }, cancellationToken: ct));
    }

    // ── Forwarders (log.Forwarders) — LOG_ADMIN writes, no DELETE route ──

    internal static async Task<IReadOnlyList<ForwarderRow>> ListForwardersAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ForwarderRow>(new CommandDefinition(
            "SELECT forwarderID AS ForwarderId, forwarderName AS ForwarderName, forwarderApproval AS ForwarderApproval, forwarderMode AS ForwarderMode FROM log.Forwarders", cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<ForwarderRow?> GetForwarderAsync(INexusOperationsDb db, long forwarderId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleOrDefaultAsync<ForwarderRow>(new CommandDefinition(
            "SELECT forwarderID AS ForwarderId, forwarderName AS ForwarderName, forwarderApproval AS ForwarderApproval, forwarderMode AS ForwarderMode FROM log.Forwarders WHERE forwarderID = @forwarderId", new { forwarderId }, cancellationToken: ct));
    }

    /// <summary>ForwarderMode included alongside id/name so a caller offering a choice of transport mode per haulier — the same haulier name can have several rows, one per mode — can group by name and still tell the rows apart.</summary>
    internal static async Task<IReadOnlyList<ApprovedForwarderRow>> ListApprovedForwardersAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ApprovedForwarderRow>(new CommandDefinition(
            "SELECT forwarderID AS ForwarderId, forwarderName AS ForwarderName, forwarderMode AS ForwarderMode FROM log.Forwarders WHERE forwarderApproval = 1 ORDER BY forwarderName, forwarderMode", cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<string>> ListForwarderModesAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<string>(new CommandDefinition(
            "SELECT DISTINCT forwarderMode FROM log.Forwarders WHERE forwarderApproval = 1 AND forwarderMode IS NOT NULL ORDER BY forwarderMode", cancellationToken: ct));
        return rows.AsList();
    }

    /// <summary>forwarderID doubles as the SAP vendor code (confirmed with the user — no separate mapping column), so it's entered manually rather than left to an identity column.</summary>
    internal static async Task CreateForwarderAsync(INexusOperationsDb db, CreateForwarderRequest body, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.ForwarderName))
            throw new NexusValidationException("forwarderID and forwarderName are required.");

        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO log.Forwarders (forwarderID, forwarderName, forwarderApproval, forwarderMode)
            VALUES (@forwarderId, @forwarderName, @forwarderApproval, @forwarderMode)
            """, new { body.ForwarderId, forwarderName = body.ForwarderName, forwarderApproval = body.ForwarderApproval, forwarderMode = body.ForwarderMode }, cancellationToken: ct));
    }

    /// <summary>forwarderID is NOT unique on its own — scoped by the row's CURRENT ForwarderMode (OriginalMode) too, so an update never silently overwrites every sibling mode-row for that vendor.</summary>
    internal static async Task UpdateForwarderAsync(INexusOperationsDb db, long forwarderId, UpdateForwarderRequest body, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.ForwarderName))
            throw new NexusValidationException("forwarderName is required.");

        using var connection = await db.CreateConnectionAsync(ct);
        var rowsAffected = await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.Forwarders
            SET forwarderName = @forwarderName, forwarderApproval = @forwarderApproval, forwarderMode = @forwarderMode
            WHERE forwarderID = @forwarderId
              AND (forwarderMode = @originalMode OR (forwarderMode IS NULL AND @originalMode IS NULL))
            """, new { forwarderId, forwarderName = body.ForwarderName, forwarderApproval = body.ForwarderApproval, forwarderMode = body.ForwarderMode, originalMode = body.OriginalMode }, cancellationToken: ct));

        if (rowsAffected == 0)
            throw new NexusNotFoundException("Row not found — it may have been changed by someone else. Reload and try again.");
    }

    // ── Forwarder Approval (log.ForwarderApproval) — no write gate ──────

    internal static async Task<IReadOnlyList<ForwarderApprovalRow>> ListForwarderApprovalsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ForwarderApprovalRow>(new CommandDefinition(
            "SELECT forwarderID AS ForwarderId, ratesAgreed AS RatesAgreed, usageAgreed AS UsageAgreed FROM log.ForwarderApproval", cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<ForwarderApprovalRow?> GetForwarderApprovalAsync(INexusOperationsDb db, long forwarderId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleOrDefaultAsync<ForwarderApprovalRow>(new CommandDefinition(
            "SELECT forwarderID AS ForwarderId, ratesAgreed AS RatesAgreed, usageAgreed AS UsageAgreed FROM log.ForwarderApproval WHERE forwarderID = @forwarderId", new { forwarderId }, cancellationToken: ct));
    }

    internal static async Task CreateForwarderApprovalAsync(INexusOperationsDb db, CreateForwarderApprovalRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "INSERT INTO log.ForwarderApproval (forwarderID, ratesAgreed, usageAgreed) VALUES (@ForwarderId, @RatesAgreed, @UsageAgreed)", body, cancellationToken: ct));
    }

    // ── Forwarder Mode Mapping (log.ForwarderModeMapping) — LOG_ADMIN, including GET ──

    internal static async Task<IReadOnlyList<ForwarderModeMappingRow>> ListForwarderModeMappingsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<ForwarderModeMappingRow>(new CommandDefinition("""
            SELECT MappingId, ForwarderMode, ModeOfTransport, Description, CreatedAtUtc, UpdatedAtUtc
            FROM log.ForwarderModeMapping ORDER BY ForwarderMode
            """, cancellationToken: ct));
        return rows.AsList();
    }

    /// <summary>Distinct forwarderMode values actually in use on log.Forwarders — the Add/Edit Mapping modal's Forwarder Type field is populated from this rather than free text, so a mapping can only ever be created for a mode genuinely set on a real forwarder.</summary>
    internal static async Task<IReadOnlyList<string>> ListForwarderModeMappingTypesAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<string>(new CommandDefinition(
            "SELECT DISTINCT forwarderMode FROM log.Forwarders WHERE forwarderMode IS NOT NULL AND LTRIM(RTRIM(forwarderMode)) <> ''  ORDER BY forwarderMode", cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<int> CreateForwarderModeMappingAsync(INexusOperationsDb db, CreateForwarderModeMappingRequest body, CancellationToken ct)
    {
        ValidateForwarderModeMapping(body);
        using var connection = await db.CreateConnectionAsync(ct);
        try
        {
            return await connection.QuerySingleAsync<int>(new CommandDefinition("""
                INSERT INTO log.ForwarderModeMapping (ForwarderMode, ModeOfTransport, Description)
                OUTPUT INSERTED.MappingId
                VALUES (@forwarderMode, @modeOfTransport, @description)
                """, new { forwarderMode = body.ForwarderMode.Trim(), modeOfTransport = body.ModeOfTransport.Trim(), description = body.Description }, cancellationToken: ct));
        }
        catch (Exception ex) when (IsForwarderModeMappingDuplicate(ex))
        {
            throw new NexusValidationException($"A mapping for Forwarder Type \"{body.ForwarderMode}\" already exists.");
        }
    }

    internal static async Task UpdateForwarderModeMappingAsync(INexusOperationsDb db, int mappingId, CreateForwarderModeMappingRequest body, CancellationToken ct)
    {
        ValidateForwarderModeMapping(body);
        using var connection = await db.CreateConnectionAsync(ct);
        try
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE log.ForwarderModeMapping SET
                    ForwarderMode = @forwarderMode, ModeOfTransport = @modeOfTransport,
                    Description = @description, UpdatedAtUtc = GETUTCDATE()
                WHERE MappingId = @mappingId
                """, new { mappingId, forwarderMode = body.ForwarderMode.Trim(), modeOfTransport = body.ModeOfTransport.Trim(), description = body.Description }, cancellationToken: ct));
        }
        catch (Exception ex) when (IsForwarderModeMappingDuplicate(ex))
        {
            throw new NexusValidationException($"A mapping for Forwarder Type \"{body.ForwarderMode}\" already exists.");
        }
    }

    internal static async Task DeleteForwarderModeMappingAsync(INexusOperationsDb db, int mappingId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("DELETE FROM log.ForwarderModeMapping WHERE MappingId = @mappingId", new { mappingId }, cancellationToken: ct));
    }

    /// <summary>Called directly (in-process, not over HTTP) from routes/shipmentmain.js's mark-booked when building each ShipmentCost row — reused the same way here once Shipping (Sub-phase 8a) needs it. Unlike GetConversionQtyAsync, this never throws — a missing mapping just means the raw forwarderMode value is used as-is (best-effort metadata, not a hard SAP requirement); no forwarderMode at all resolves to null.</summary>
    internal static async Task<string?> LookupModeOfTransportAsync(INexusOperationsDb db, string? forwarderMode, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(forwarderMode)) return null;
        try
        {
            using var connection = await db.CreateConnectionAsync(ct);
            var mode = await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
                "SELECT TOP 1 ModeOfTransport FROM log.ForwarderModeMapping WHERE ForwarderMode = @forwarderMode", new { forwarderMode }, cancellationToken: ct));
            return mode ?? forwarderMode;
        }
        catch
        {
            return forwarderMode;
        }
    }

    private static void ValidateForwarderModeMapping(CreateForwarderModeMappingRequest body)
    {
        if (string.IsNullOrWhiteSpace(body.ForwarderMode))
            throw new NexusValidationException("forwarderMode is required.");
        if (string.IsNullOrWhiteSpace(body.ModeOfTransport))
            throw new NexusValidationException("modeOfTransport is required.");
    }

    private static bool IsForwarderModeMappingDuplicate(Exception ex) =>
        ex.Message.Contains("UQ_ForwarderModeMapping_ForwarderMode", StringComparison.OrdinalIgnoreCase);

    // ── Incoterms (log.Incoterms) — no write gate ────────────────────────

    internal static async Task<IReadOnlyList<IncotermsRow>> ListIncotermsAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<IncotermsRow>(new CommandDefinition(
            "SELECT incotermsID AS IncotermsId, incotermsDescription AS IncotermsDescription FROM log.Incoterms", cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IncotermsRow?> GetIncotermsAsync(INexusOperationsDb db, string incotermsId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleOrDefaultAsync<IncotermsRow>(new CommandDefinition(
            "SELECT incotermsID AS IncotermsId, incotermsDescription AS IncotermsDescription FROM log.Incoterms WHERE incotermsID = @incotermsId", new { incotermsId }, cancellationToken: ct));
    }

    internal static async Task CreateIncotermsAsync(INexusOperationsDb db, CreateIncotermsRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "INSERT INTO log.Incoterms (incotermsID, incotermsDescription) VALUES (@IncotermsId, @IncotermsDescription)", body, cancellationToken: ct));
    }

    // ── Rates KN (log.RatesKN) — no write gate ───────────────────────────

    internal static async Task<IReadOnlyList<RatesKnRow>> ListRatesKnAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<RatesKnRow>(new CommandDefinition(
            "SELECT countryCode AS CountryCode, postalCode AS PostalCode, minWeight AS MinWeight, maxWeight AS MaxWeight, agreedRate AS AgreedRate, transitTime AS TransitTime, minimumCharge AS MinimumCharge FROM log.RatesKN", cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<RatesKnRow>> GetRatesKnByCountryAsync(INexusOperationsDb db, string countryCode, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<RatesKnRow>(new CommandDefinition(
            "SELECT countryCode AS CountryCode, postalCode AS PostalCode, minWeight AS MinWeight, maxWeight AS MaxWeight, agreedRate AS AgreedRate, transitTime AS TransitTime, minimumCharge AS MinimumCharge FROM log.RatesKN WHERE countryCode = @countryCode", new { countryCode }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<RatesKnRow>> GetRatesKnByPostalCodeAsync(INexusOperationsDb db, string postalCode, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<RatesKnRow>(new CommandDefinition(
            "SELECT countryCode AS CountryCode, postalCode AS PostalCode, minWeight AS MinWeight, maxWeight AS MaxWeight, agreedRate AS AgreedRate, transitTime AS TransitTime, minimumCharge AS MinimumCharge FROM log.RatesKN WHERE postalCode = @postalCode", new { postalCode }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task CreateRatesKnAsync(INexusOperationsDb db, CreateRatesKnRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO log.RatesKN (countryCode, postalCode, minWeight, maxWeight, agreedRate, transitTime)
            VALUES (@CountryCode, @PostalCode, @MinWeight, @MaxWeight, @AgreedRate, @TransitTime)
            """, body, cancellationToken: ct));
    }

    /// <summary>Rate lookup: country + postcode prefix (first 2 characters, uppercased) + chargeable weight (rounded up). Returns null (not a 404) when no matching band exists — a real, expected outcome the caller must handle, not an error.</summary>
    internal static async Task<RatesKnLookupResult?> LookupRatesKnAsync(INexusOperationsDb db, string country, string postcode, decimal weight, CancellationToken ct)
    {
        var prefix = postcode.Length > 2 ? postcode[..2].ToUpperInvariant() : postcode.ToUpperInvariant();
        var chargeableWeight = Math.Ceiling(Math.Max(0, weight));

        using var connection = await db.CreateConnectionAsync(ct);
        var row = await connection.QuerySingleOrDefaultAsync<(decimal AgreedRate, decimal? MinimumCharge, int? TransitTime)?>(new CommandDefinition("""
            SELECT TOP 1 agreedRate AS AgreedRate, minimumCharge AS MinimumCharge, transitTime AS TransitTime
            FROM log.RatesKN
            WHERE countryCode = @country AND postalCode = @prefix
              AND @weight >= minWeight AND @weight <= maxWeight
            """, new { country = country.ToUpperInvariant(), prefix, weight = chargeableWeight }, cancellationToken: ct));

        if (row is null) return null;

        var rawCost = row.Value.AgreedRate * chargeableWeight;
        var minCharge = row.Value.MinimumCharge ?? 0m;
        var expectedCost = Math.Round(Math.Max(rawCost, minCharge), 2);
        return new RatesKnLookupResult(row.Value.AgreedRate, row.Value.MinimumCharge, row.Value.TransitTime, chargeableWeight, expectedCost);
    }

    // ── Rates TPN (log.RatesTPN) — no write gate ─────────────────────────

    internal static async Task<IReadOnlyList<RatesTpnRow>> ListRatesTpnAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<RatesTpnRow>(new CommandDefinition(
            "SELECT postalZone AS PostalZone, palletCategory AS PalletCategory, serviceLevel AS ServiceLevel, agreedRate AS AgreedRate FROM log.RatesTPN", cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<RatesTpnRow>> GetRatesTpnByZoneAsync(INexusOperationsDb db, string postalZone, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<RatesTpnRow>(new CommandDefinition(
            "SELECT postalZone AS PostalZone, palletCategory AS PalletCategory, serviceLevel AS ServiceLevel, agreedRate AS AgreedRate FROM log.RatesTPN WHERE postalZone = @postalZone", new { postalZone }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<RatesTpnRow>> GetRatesTpnByCategoryAsync(INexusOperationsDb db, string palletCategory, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<RatesTpnRow>(new CommandDefinition(
            "SELECT postalZone AS PostalZone, palletCategory AS PalletCategory, serviceLevel AS ServiceLevel, agreedRate AS AgreedRate FROM log.RatesTPN WHERE palletCategory = @palletCategory", new { palletCategory }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task CreateRatesTpnAsync(INexusOperationsDb db, CreateRatesTpnRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO log.RatesTPN (postalZone, palletCategory, serviceLevel, agreedRate)
            VALUES (@PostalZone, @PalletCategory, @ServiceLevel, @AgreedRate)
            """, body, cancellationToken: ct));
    }

    // ── Assignment TPN (log.AssignmentTPN) — no write gate ───────────────

    internal static async Task<IReadOnlyList<AssignmentTpnRow>> ListAssignmentTpnAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<AssignmentTpnRow>(new CommandDefinition(
            "SELECT postalZone AS PostalZone, postalCode AS PostalCode FROM log.AssignmentTPN", cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<AssignmentTpnRow>> GetAssignmentTpnByZoneAsync(INexusOperationsDb db, string postalZone, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<AssignmentTpnRow>(new CommandDefinition(
            "SELECT postalZone AS PostalZone, postalCode AS PostalCode FROM log.AssignmentTPN WHERE postalZone = @postalZone", new { postalZone }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<AssignmentTpnRow>> GetAssignmentTpnByPostalCodeAsync(INexusOperationsDb db, string postalCode, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<AssignmentTpnRow>(new CommandDefinition(
            "SELECT postalZone AS PostalZone, postalCode AS PostalCode FROM log.AssignmentTPN WHERE postalCode = @postalCode", new { postalCode }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task CreateAssignmentTpnAsync(INexusOperationsDb db, CreateAssignmentTpnRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "INSERT INTO log.AssignmentTPN (postalZone, postalCode) VALUES (@PostalZone, @PostalCode)", body, cancellationToken: ct));
    }

    // ── Delivery Routes (log.DeliveryRoutes) — LOG_ADMIN writes ──────────

    internal static async Task<IReadOnlyList<DeliveryRouteRow>> ListDeliveryRoutesAsync(INexusOperationsDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<DeliveryRouteRow>(new CommandDefinition("""
            SELECT routeID AS RouteId, countryCode AS CountryCode, postcodePrefix AS PostcodePrefix, transitDays AS TransitDays
            FROM log.DeliveryRoutes ORDER BY countryCode ASC, ISNULL(postcodePrefix, 'ZZZZZ') ASC
            """, cancellationToken: ct));
        return rows.AsList();
    }

    /// <summary>Prefers a specific country+prefix match over a country-only fallback (ORDER BY exact-prefix-match-first, TOP 1) — called in-process by Warehouse's Staging Post (needed-by date estimates are out of scope here) and reused by Shipping (8a) once that phase lands.</summary>
    internal static async Task<int?> LookupTransitDaysAsync(INexusOperationsDb db, string country, string? postcode, CancellationToken ct)
    {
        var prefix = string.IsNullOrEmpty(postcode) ? null : postcode[..Math.Min(2, postcode.Length)].ToUpperInvariant();
        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleOrDefaultAsync<int?>(new CommandDefinition("""
            SELECT TOP 1 transitDays
            FROM log.DeliveryRoutes
            WHERE countryCode = @country AND (postcodePrefix = @prefix OR postcodePrefix IS NULL)
            ORDER BY CASE WHEN postcodePrefix = @prefix THEN 0 ELSE 1 END ASC
            """, new { country = country.ToUpperInvariant(), prefix }, cancellationToken: ct));
    }

    internal static async Task<int> CreateDeliveryRouteAsync(INexusOperationsDb db, CreateDeliveryRouteRequest body, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.CountryCode))
            throw new NexusValidationException("countryCode and transitDays are required");

        using var connection = await db.CreateConnectionAsync(ct);
        return await connection.QuerySingleAsync<int>(new CommandDefinition("""
            INSERT INTO log.DeliveryRoutes (countryCode, postcodePrefix, transitDays)
            VALUES (@countryCode, @postcodePrefix, @transitDays);
            SELECT CAST(SCOPE_IDENTITY() AS INT);
            """, new { countryCode = body.CountryCode.ToUpperInvariant(), postcodePrefix = body.PostcodePrefix?.ToUpperInvariant(), body.TransitDays }, cancellationToken: ct));
    }

    internal static async Task UpdateDeliveryRouteAsync(INexusOperationsDb db, int routeId, CreateDeliveryRouteRequest body, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE log.DeliveryRoutes
            SET countryCode = @countryCode, postcodePrefix = @postcodePrefix, transitDays = @transitDays
            WHERE routeID = @routeId
            """, new { routeId, countryCode = body.CountryCode.ToUpperInvariant(), postcodePrefix = body.PostcodePrefix?.ToUpperInvariant(), body.TransitDays }, cancellationToken: ct));
    }

    internal static async Task DeleteDeliveryRouteAsync(INexusOperationsDb db, int routeId, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition("DELETE FROM log.DeliveryRoutes WHERE routeID = @routeId", new { routeId }, cancellationToken: ct));
    }

    private static void ValidateCodeAndDescription(string code, string codeField, string description, string descriptionField)
    {
        if (string.IsNullOrWhiteSpace(code))
            throw new NexusValidationException($"{codeField} is required.");
        if (string.IsNullOrWhiteSpace(description))
            throw new NexusValidationException($"{descriptionField} is required.");
    }
}
