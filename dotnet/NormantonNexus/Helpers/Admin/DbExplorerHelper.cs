using Dapper;
using Microsoft.Data.SqlClient;
using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Admin;

/// <summary>
/// DB Explorer — Phase 9, superadmin-only SSMS-lite schema browser. Port of
/// routes/dbexplorer.js: list databases -&gt; list tables -&gt; list columns/
/// keys &amp; constraints for a table -&gt; optionally preview the first N rows.
///
/// One connection to the default (Nexus) database is enough — SQL Server
/// allows querying another database's system catalog views with a
/// three-part name (e.g. `[NexusOperations].sys.tables`) as long as the
/// login has visibility into that database, confirmed against config.js's
/// getNexusPool/getNexusOperationsPool/getNexusArchivePool all pointing at
/// the same server, different databases — no per-database connection pool
/// needed here either.
///
/// SQL injection note (matches Node's own header comment exactly): database/
/// schema/table names can't be parameterized the normal way (they're
/// identifiers, not values), and they end up in a dynamic query string built
/// with [bracket] escaping. Every identifier that reaches a dynamic query is
/// first verified with a real, parameterized lookup against sys.databases /
/// that database's sys.schemas/sys.tables — if the requested name doesn't
/// come back as an exact match, the request is rejected before anything is
/// interpolated. Only the verified name (still bracket-escaped defensively)
/// is ever spliced into SQL.
/// </summary>
internal static class DbExplorerHelper
{
    /// <summary>Escapes a verified identifier for safe interpolation into a dynamic query as [name] — doubles any ] the (already-verified-real) name might contain, standard T-SQL bracket-quoting. Belt-and-braces on top of the "must exist in sys.*" check every caller does.</summary>
    internal static string Bracket(string name) => $"[{name.Replace("]", "]]")}]";

    /// <summary>Returns the canonical name from sys.databases, or null if not found — callers must treat null as "reject the request", never fall back to the raw client-supplied value.</summary>
    internal static async Task<string?> VerifyDatabaseAsync(SqlConnection connection, string database, CancellationToken ct) =>
        await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "SELECT name FROM sys.databases WHERE name = @database", new { database }, cancellationToken: ct));

    private sealed record VerifiedTable(string SchemaName, string TableName);

    private static async Task<VerifiedTable?> VerifyTableAsync(SqlConnection connection, string dbBracket, string schema, string table, CancellationToken ct) =>
        await connection.QuerySingleOrDefaultAsync<VerifiedTable?>(new CommandDefinition($"""
            SELECT s.name AS SchemaName, t.name AS TableName
            FROM {dbBracket}.sys.tables t
            JOIN {dbBracket}.sys.schemas s ON s.schema_id = t.schema_id
            WHERE s.name = @schema AND t.name = @table
            """, new { schema, table }, cancellationToken: ct));

    /// <summary>Verifies both the database and the table in one call — every route past /databases needs this same two-step lookup, so it's centralised here rather than duplicated per method.</summary>
    private static async Task<(string DbBracket, string SchemaName, string TableName)> VerifyDatabaseAndTableAsync(
        SqlConnection connection, string database, string schema, string table, CancellationToken ct)
    {
        var dbName = await VerifyDatabaseAsync(connection, database, ct) ?? throw new NexusNotFoundException("Database not found.");
        var dbBracket = Bracket(dbName);
        var tbl = await VerifyTableAsync(connection, dbBracket, schema, table, ct) ?? throw new NexusNotFoundException("Table not found.");
        return (dbBracket, tbl.SchemaName, tbl.TableName);
    }

    internal static async Task<IReadOnlyList<DatabaseInfoRow>> ListDatabasesAsync(INexusDb db, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var rows = await connection.QueryAsync<DatabaseInfoRow>(new CommandDefinition("""
            SELECT name AS Name, database_id AS DatabaseId, create_date AS CreateDate,
                   state_desc AS StateDesc, recovery_model_desc AS RecoveryModelDesc, compatibility_level AS CompatibilityLevel
            FROM sys.databases ORDER BY database_id
            """, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<TableInfoRow>> ListTablesAsync(INexusDb db, string database, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var dbName = await VerifyDatabaseAsync(connection, database, ct) ?? throw new NexusNotFoundException("Database not found.");
        var dbBracket = Bracket(dbName);

        var rows = await connection.QueryAsync<TableInfoRow>(new CommandDefinition($"""
            SELECT s.name AS SchemaName, t.name AS TableName, SUM(p.rows) AS ApproxRowCount
            FROM {dbBracket}.sys.tables t
            JOIN {dbBracket}.sys.schemas s ON s.schema_id = t.schema_id
            LEFT JOIN {dbBracket}.sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
            GROUP BY s.name, t.name
            ORDER BY s.name, t.name
            """, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<IReadOnlyList<ColumnInfoRow>> ListColumnsAsync(INexusDb db, string database, string schema, string table, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var (dbBracket, schemaName, tableName) = await VerifyDatabaseAndTableAsync(connection, database, schema, table, ct);

        var rows = await connection.QueryAsync<ColumnInfoRow>(new CommandDefinition($"""
            SELECT
                c.column_id AS ColumnId, c.name AS ColumnName, ty.name AS DataType, c.max_length AS MaxLength,
                c.precision AS Precision, c.scale AS Scale, c.is_nullable AS IsNullable, c.is_identity AS IsIdentity,
                dc.definition AS DefaultValue,
                CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS IsPrimaryKey
            FROM {dbBracket}.sys.columns c
            JOIN {dbBracket}.sys.types ty ON ty.user_type_id = c.user_type_id
            JOIN {dbBracket}.sys.tables t ON t.object_id = c.object_id
            JOIN {dbBracket}.sys.schemas s ON s.schema_id = t.schema_id
            LEFT JOIN {dbBracket}.sys.default_constraints dc ON dc.object_id = c.default_object_id
            LEFT JOIN (
                SELECT ic.object_id, ic.column_id
                FROM {dbBracket}.sys.index_columns ic
                JOIN {dbBracket}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                WHERE i.is_primary_key = 1
            ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
            WHERE s.name = @schemaName AND t.name = @tableName
            ORDER BY c.column_id
            """, new { schemaName, tableName }, cancellationToken: ct));
        return rows.AsList();
    }

    internal static async Task<TableConstraintsResult> GetConstraintsAsync(INexusDb db, string database, string schema, string table, CancellationToken ct)
    {
        using var connection = await db.CreateConnectionAsync(ct);
        var (dbBracket, schemaName, tableName) = await VerifyDatabaseAndTableAsync(connection, database, schema, table, ct);
        var parameters = new { schemaName, tableName };

        // No STRING_AGG — this app targets SQL Server 2005 (STRING_AGG is 2017+), so
        // column lists use the STUFF(...FOR XML PATH('')) concatenation trick instead,
        // same pattern used everywhere else in this codebase.
        var keys = await connection.QueryAsync<KeyConstraintRow>(new CommandDefinition($"""
            SELECT kc.name AS ConstraintName, kc.type_desc AS ConstraintType,
                STUFF((
                    SELECT ', ' + c2.name
                    FROM {dbBracket}.sys.index_columns ic2
                    JOIN {dbBracket}.sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
                    WHERE ic2.object_id = kc.parent_object_id AND ic2.index_id = kc.unique_index_id
                    ORDER BY ic2.key_ordinal FOR XML PATH('')
                ), 1, 2, '') AS Columns
            FROM {dbBracket}.sys.key_constraints kc
            JOIN {dbBracket}.sys.tables t ON t.object_id = kc.parent_object_id
            JOIN {dbBracket}.sys.schemas s ON s.schema_id = t.schema_id
            WHERE s.name = @schemaName AND t.name = @tableName
            """, parameters, cancellationToken: ct));

        var fkOut = await connection.QueryAsync<ForeignKeyOutRow>(new CommandDefinition($"""
            SELECT fk.name AS ConstraintName, c.name AS ColumnName, rs.name AS ReferencedSchema, rt.name AS ReferencedTable,
                rc.name AS ReferencedColumn, fk.delete_referential_action_desc AS OnDelete, fk.update_referential_action_desc AS OnUpdate
            FROM {dbBracket}.sys.foreign_keys fk
            JOIN {dbBracket}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
            JOIN {dbBracket}.sys.tables t ON t.object_id = fk.parent_object_id
            JOIN {dbBracket}.sys.schemas s ON s.schema_id = t.schema_id
            JOIN {dbBracket}.sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
            JOIN {dbBracket}.sys.tables rt ON rt.object_id = fk.referenced_object_id
            JOIN {dbBracket}.sys.schemas rs ON rs.schema_id = rt.schema_id
            JOIN {dbBracket}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
            WHERE s.name = @schemaName AND t.name = @tableName
            ORDER BY fk.name
            """, parameters, cancellationToken: ct));

        var fkIn = await connection.QueryAsync<ForeignKeyInRow>(new CommandDefinition($"""
            SELECT fk.name AS ConstraintName, s.name AS SourceSchema, t.name AS SourceTable, c.name AS SourceColumn, rc.name AS ColumnName
            FROM {dbBracket}.sys.foreign_keys fk
            JOIN {dbBracket}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
            JOIN {dbBracket}.sys.tables t ON t.object_id = fk.parent_object_id
            JOIN {dbBracket}.sys.schemas s ON s.schema_id = t.schema_id
            JOIN {dbBracket}.sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
            JOIN {dbBracket}.sys.tables rt ON rt.object_id = fk.referenced_object_id
            JOIN {dbBracket}.sys.schemas rs ON rs.schema_id = rt.schema_id
            JOIN {dbBracket}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
            WHERE rs.name = @schemaName AND rt.name = @tableName
            ORDER BY fk.name
            """, new { schemaName, tableName }, cancellationToken: ct));

        var checks = await connection.QueryAsync<CheckConstraintRow>(new CommandDefinition($"""
            SELECT cc.name AS ConstraintName, cc.definition AS Definition, cc.is_disabled AS IsDisabled
            FROM {dbBracket}.sys.check_constraints cc
            JOIN {dbBracket}.sys.tables t ON t.object_id = cc.parent_object_id
            JOIN {dbBracket}.sys.schemas s ON s.schema_id = t.schema_id
            WHERE s.name = @schemaName AND t.name = @tableName
            """, parameters, cancellationToken: ct));

        var indexes = await connection.QueryAsync<IndexInfoRow>(new CommandDefinition($"""
            SELECT i.name AS IndexName, i.type_desc AS IndexType, i.is_unique AS IsUnique, i.is_primary_key AS IsPrimaryKey,
                STUFF((
                    SELECT ', ' + c2.name
                    FROM {dbBracket}.sys.index_columns ic2
                    JOIN {dbBracket}.sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
                    WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id AND ic2.is_included_column = 0
                    ORDER BY ic2.key_ordinal FOR XML PATH('')
                ), 1, 2, '') AS Columns
            FROM {dbBracket}.sys.indexes i
            JOIN {dbBracket}.sys.tables t ON t.object_id = i.object_id
            JOIN {dbBracket}.sys.schemas s ON s.schema_id = t.schema_id
            WHERE s.name = @schemaName AND t.name = @tableName AND i.name IS NOT NULL
            ORDER BY i.name
            """, parameters, cancellationToken: ct));

        return new TableConstraintsResult(keys.AsList(), fkOut.AsList(), fkIn.AsList(), checks.AsList(), indexes.AsList());
    }

    /// <summary>Read-only TOP (N) SELECT * — N is clamped server-side (1-500) regardless of what's requested, and every preview is audited (success and failure alike), unlike the metadata methods above, since this one returns actual row data.</summary>
    internal static async Task<IReadOnlyList<Dictionary<string, object?>>> PreviewRowsAsync(
        INexusDb db, IAuditLogger audit, string database, string schema, string table, int? requestedTop, string? actorUsername, string? ipAddress, CancellationToken ct)
    {
        var top = Math.Min(Math.Max(requestedTop ?? 100, 1), 500);

        using var connection = await db.CreateConnectionAsync(ct);
        // Not-found (bad database/schema/table) is not itself audited, matching Node —
        // the audit calls below only wrap the actual preview query.
        var (dbBracket, schemaName, tableName) = await VerifyDatabaseAndTableAsync(connection, database, schema, table, ct);

        var target = $"{dbBracket}.{Bracket(schemaName)}.{Bracket(tableName)}";
        try
        {
            var rows = await connection.QueryAsync(new CommandDefinition($"SELECT TOP ({top}) * FROM {target}", cancellationToken: ct));
            var result = rows.Select(row => ((IDictionary<string, object>)row).ToDictionary(kv => kv.Key, kv => (object?)kv.Value)).ToList();

            await audit.LogAsync("DBEXPLORER_PREVIEW", actorUsername, $"TOP {top} FROM {database}.{schemaName}.{tableName}", ipAddress, ct);
            return result;
        }
        catch (Exception ex)
        {
            var detail = ex.Message.Length > 200 ? ex.Message[..200] : ex.Message;
            await audit.LogAsync("DBEXPLORER_PREVIEW_ERROR", actorUsername, $"{database}.{schema}.{table} — ERR: {detail}", ipAddress, ct);
            throw;
        }
    }
}
