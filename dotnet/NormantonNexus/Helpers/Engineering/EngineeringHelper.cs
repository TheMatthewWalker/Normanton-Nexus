using Dapper;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Engineering;

/// <summary>
/// All Engineering (Packaging Data) business logic — the C# port of
/// routes/packaging.js. EngineeringController stays thin: permission check
/// → call one of these → return ApiResponse&lt;T&gt;. Every write here proxies
/// to SapServer's PackagingController (see that repo's Controllers/PackagingController.cs
/// and Models/Bapi/PackagingModels.cs, which this file's DTOs mirror field-for-field)
/// via SapServerClient, and audits the same way routes/packaging.js's audit()
/// helper did.
/// </summary>
internal static class EngineeringHelper
{
    // Per-tile permission codes replacing the Node app's single coarse
    // MASTER_DATA code (which today gates all three tiles' writes at once —
    // see the migration plan's "Authorization model"/per-department migration
    // path). Read/view routes stay department-gated only (Dept:engineering),
    // matching routes/packaging.js's canView = requireDepartment('engineering').
    internal const string FnMassUpdate = "ENG_MASS_UPDATE";
    internal const string FnNewPackaging = "ENG_NEW_PACKAGING";
    internal const string FnInstructionDetail = "ENG_INSTRUCTION_DETAIL";

    internal static async Task<IReadOnlyList<MaterialOption>> SearchMaterialsAsync(
        INexusOperationsDb db, string? search, CancellationToken ct)
    {
        var hasSearch = !string.IsNullOrWhiteSpace(search);
        var sql = $"""
            SELECT TOP 200 Material AS Material, MaterialText AS MaterialText
            FROM log.TurnsValClassSnapshot
            {(hasSearch ? "WHERE Material LIKE @pattern OR MaterialText LIKE @pattern" : "")}
            ORDER BY Material
            """;

        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<MaterialOption>(new CommandDefinition(
            sql, hasSearch ? new { pattern = $"%{search}%" } : null, cancellationToken: ct));
        return rows.ToArray();
    }

    // T? on an unconstrained generic parameter is a no-op for a value type
    // like bool (only reference-type substitutions actually get a nullable
    // annotation) — GetAsync<bool> really returns Task<bool>, not Task<bool?>,
    // so no null-coalescing is needed here the way the string/record overloads below need it.
    internal static Task<bool> MaterialExistsAsync(ISapServerClient sap, string material, int userId, CancellationToken ct) =>
        sap.GetAsync<bool>($"api/packaging/{Uri.EscapeDataString(material)}/exists", userId, ct: ct);

    internal static Task<string?> GetMaterialDescriptionAsync(ISapServerClient sap, string material, int userId, CancellationToken ct) =>
        sap.GetAsync<string>($"api/packaging/{Uri.EscapeDataString(material)}/description", userId, ct: ct);

    internal static Task<PackagingMaraRow?> GetMaterialDetailsAsync(ISapServerClient sap, string material, int userId, CancellationToken ct) =>
        sap.GetAsync<PackagingMaraRow>($"api/packaging/{Uri.EscapeDataString(material)}/mara", userId, ct: ct);

    internal static async Task<IReadOnlyList<PackagingBomRow>> GetMaterialBomAsync(ISapServerClient sap, string material, int userId, CancellationToken ct) =>
        await sap.GetAsync<PackagingBomRow[]>($"api/packaging/{Uri.EscapeDataString(material)}/bom", userId, ct: ct) ?? [];

    internal static async Task<IReadOnlyList<PackagingCustomerRow>> GetMaterialCustomersAsync(ISapServerClient sap, string material, int userId, CancellationToken ct) =>
        await sap.GetAsync<PackagingCustomerRow[]>($"api/packaging/{Uri.EscapeDataString(material)}/customers", userId, ct: ct) ?? [];

    /// <summary>Null means "no instruction saved yet for this scope" — not an error. Mirrors routes/packaging.js swallowing SapServer's 404 into {success:true, data:null}.</summary>
    internal static async Task<PackagingInstrRow?> GetInstructionAsync(ISapServerClient sap, string material, string? customer, int userId, CancellationToken ct)
    {
        var path = $"api/packaging/{Uri.EscapeDataString(material)}/instruction";
        if (!string.IsNullOrWhiteSpace(customer)) path += $"?customer={Uri.EscapeDataString(customer)}";

        try
        {
            return await sap.GetAsync<PackagingInstrRow>(path, userId, ct: ct);
        }
        catch (SapProxyException ex) when (ex.StatusCode == StatusCodes.Status404NotFound)
        {
            return null;
        }
    }

    internal static async Task<string> SaveInstructionAsync(
        ISapServerClient sap, IAuditLogger audit, PackagingInstrSaveRequest body,
        int userId, string? username, string? ipAddress, CancellationToken ct)
    {
        var message = await sap.PutAsync<string>("api/packaging/instruction", body, userId, ct: ct) ?? "";
        await audit.LogAsync("PACKAGING_INSTRUCTION_SAVED", username, $"{body.Material}/{body.Customer ?? "(plant)"}", ipAddress, ct);
        return message;
    }

    internal static async Task<string> DeleteInstructionAsync(
        ISapServerClient sap, IAuditLogger audit, PackagingInstrDeleteRequest body,
        int userId, string? username, string? ipAddress, CancellationToken ct)
    {
        var message = await sap.DeleteAsync<string>("api/packaging/instruction", body, userId, ct: ct) ?? "";
        await audit.LogAsync("PACKAGING_INSTRUCTION_DELETED", username, $"{body.Material}/{body.Customer ?? "(plant)"}", ipAddress, ct);
        return message;
    }

    internal static async Task<IReadOnlyList<MassPackagingUpdateResult>> MassUpdateAsync(
        ISapServerClient sap, IAuditLogger audit, MassPackagingUpdateRequest body,
        int userId, string? username, string? ipAddress, CancellationToken ct)
    {
        if (body.Rows.Count == 0)
        {
            throw new NexusValidationException("Rows must not be empty.");
        }

        var results = await sap.PostAsync<List<MassPackagingUpdateResult>>("api/packaging/mass-update", body, userId, ct: ct) ?? [];
        var okCount = results.Count(r => r.Success);
        await audit.LogAsync("PACKAGING_MASS_UPDATE", username, $"{okCount}/{results.Count} materials updated", ipAddress, ct);
        return results;
    }

    private sealed record SapCredentialsRow(string? SapUsername, string? SapPasswordEncrypted);

    internal static async Task<IReadOnlyList<CreatePackagingResult>> CreatePackagingAsync(
        ISapServerClient sap, ISapCredentialCipher credentialCipher, INexusDb nexusDb, IAuditLogger audit,
        CreatePackagingRequest body, int userId, string? username, string? ipAddress, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.CustomerPart))
        {
            throw new NexusValidationException("customerPart is required.");
        }

        using var connection = await nexusDb.CreateConnectionAsync(ct);
        var credentials = await connection.QuerySingleOrDefaultAsync<SapCredentialsRow>(new CommandDefinition(
            "SELECT SapUsername, SapPasswordEncrypted FROM dbo.PortalUsers WHERE UserID = @userId",
            new { userId }, cancellationToken: ct));

        if (string.IsNullOrEmpty(credentials?.SapUsername) || string.IsNullOrEmpty(credentials.SapPasswordEncrypted))
        {
            throw new NexusValidationException(
                "You need to save your SAP username and password in My Account before creating packaging materials in SAP.");
        }

        var sapPassword = credentialCipher.Decrypt(credentials.SapPasswordEncrypted);
        var elevatedRequest = new CreatePackagingElevatedRequest(credentials.SapUsername, sapPassword, body.CustomerPart, body.Codes);

        // MM01+CS01 batch-input per code can be slow — 120s, matching sap.js's
        // long-running-write timeout convention (see SapServerOptions.LongRunningTimeoutSeconds).
        var results = await sap.PostAsync<List<CreatePackagingResult>>(
            "api/packaging/create-elevated", elevatedRequest, userId, longRunning: true, ct: ct) ?? [];

        var createdCount = results.Count(r => r.MaterialCreated);
        await audit.LogAsync("PACKAGING_MATERIALS_CREATED", username, $"{createdCount}/{results.Count} materials created for {body.CustomerPart}", ipAddress, ct);
        return results;
    }
}
