using System.Data;
using Dapper;

namespace NormantonNexus.Helpers.Logistics;

/// <summary>
/// Generic TRUNCATE+batch-insert and batched-upsert engines shared by every
/// Performance snapshot/history table — Logistics Sub-phase 8b.6. C# port of
/// routes/performancesql.js's replaceTable()/upsertBatch() column-metadata-
/// driven helpers: same parameterised UNION-ALL-SELECT staging idiom (SQL
/// Server 2005 has no MERGE and no BCP bulk() available here), same
/// batch-size-under-2100-parameters math, same "no explicit transaction"
/// choice (a batch failure mid-insert leaves a partial table until the next
/// refresh runs — acceptable given these refresh 1-3x/day and errors surface
/// immediately). A declarative column list keeps each table's Helper method
/// to its column mapping alone, rather than hand-writing a bespoke
/// TRUNCATE/INSERT for tables with 80+ columns (log.TurnsValClassSnapshot).
/// </summary>
internal static class SnapshotTableWriter
{
    internal sealed record Column<T>(string Name, Func<T, object?> Value, int? MaxLen = null);

    /// <summary>TRUNCATE TABLE then batched positional INSERT — for "latest pull replaces everything" snapshot tables (StockSnapshot, AgreementSnapshot, InvoiceSnapshot, OtifSnapshot, TurnsValClassSnapshot, ValuationClassCatalog).</summary>
    internal static async Task ReplaceAsync<T>(IDbConnection connection, string tableName, IReadOnlyList<Column<T>> columns, IReadOnlyList<T> rows, CancellationToken ct)
    {
        await connection.ExecuteAsync(new CommandDefinition($"TRUNCATE TABLE {tableName}", cancellationToken: ct));
        if (rows.Count == 0) return;

        var batchSize = Math.Max(1, 2000 / columns.Count);
        var colList = string.Join(", ", columns.Select(c => $"[{c.Name}]"));

        for (var i = 0; i < rows.Count; i += batchSize)
        {
            var batch = rows.Skip(i).Take(batchSize).ToList();
            var parameters = new DynamicParameters();
            var selectClauses = new List<string>();

            for (var rowIdx = 0; rowIdx < batch.Count; rowIdx++)
            {
                var parts = new List<string>();
                for (var colIdx = 0; colIdx < columns.Count; colIdx++)
                {
                    var col = columns[colIdx];
                    var paramName = $"p{rowIdx}_{colIdx}";
                    parameters.Add(paramName, Truncate(col.Value(batch[rowIdx]), col.MaxLen));
                    parts.Add($"@{paramName}");
                }
                selectClauses.Add($"SELECT {string.Join(", ", parts)}");
            }

            await connection.ExecuteAsync(new CommandDefinition(
                $"INSERT INTO {tableName} ({colList})\n{string.Join("\nUNION ALL\n", selectClauses)}",
                parameters, cancellationToken: ct));
        }
    }

    /// <summary>
    /// Batched upsert against keyColumns via a staged UPDATE then anti-join INSERT — for
    /// append-only history tables that must NOT be truncated (StockValuationHistory,
    /// ForecastAccuracyLog, MaterialConsumptionHistory, MaterialReceiptHistory). Every
    /// upserted table carries a LastUpdatedUtc column, stamped on the UPDATE branch only
    /// (an INSERT relies on the column's own DEFAULT (GETUTCDATE()) constraint).
    /// insertOnly skips the UPDATE branch entirely — an existing row for a given key is left
    /// untouched forever, only a not-yet-seen key gets written (used to freeze the current
    /// month's recorded forecast at whatever it was on the first sync run after the month
    /// started, instead of letting it drift all month via repeated UPDATEs).
    /// </summary>
    internal static async Task UpsertAsync<T>(IDbConnection connection, string tableName, IReadOnlyList<Column<T>> keyColumns, IReadOnlyList<Column<T>> columns, IReadOnlyList<T> rows, CancellationToken ct, bool insertOnly = false)
    {
        if (rows.Count == 0) return;

        var allColumns = keyColumns.Concat(columns).ToList();
        var batchSize = Math.Max(1, 2000 / allColumns.Count);
        var keyJoin = string.Join(" AND ", keyColumns.Select(c => $"t.[{c.Name}] = s.[{c.Name}]"));
        var insertCols = string.Join(", ", allColumns.Select(c => $"[{c.Name}]"));
        var insertVals = string.Join(", ", allColumns.Select(c => $"s.[{c.Name}]"));
        var updateSet = string.Join(", ", columns.Select(c => $"t.[{c.Name}] = s.[{c.Name}]"));

        string BuildStaging(DynamicParameters parameters, IReadOnlyList<T> batch, string paramPrefix)
        {
            var selectClauses = new List<string>();
            for (var rowIdx = 0; rowIdx < batch.Count; rowIdx++)
            {
                var parts = new List<string>();
                for (var colIdx = 0; colIdx < allColumns.Count; colIdx++)
                {
                    var col = allColumns[colIdx];
                    var paramName = $"{paramPrefix}{rowIdx}_{colIdx}";
                    parameters.Add(paramName, Truncate(col.Value(batch[rowIdx]), col.MaxLen));
                    parts.Add($"@{paramName} AS [{col.Name}]");
                }
                selectClauses.Add($"SELECT {string.Join(", ", parts)}");
            }
            return string.Join("\nUNION ALL\n", selectClauses);
        }

        for (var i = 0; i < rows.Count; i += batchSize)
        {
            var batch = rows.Skip(i).Take(batchSize).ToList();

            if (!insertOnly)
            {
                var updateParams = new DynamicParameters();
                var updateStaging = BuildStaging(updateParams, batch, "u");
                await connection.ExecuteAsync(new CommandDefinition($"""
                    WITH staging AS ({updateStaging})
                    UPDATE t SET {updateSet}, LastUpdatedUtc = GETUTCDATE()
                    FROM {tableName} t
                    INNER JOIN staging s ON {keyJoin};
                    """, updateParams, cancellationToken: ct));
            }

            var insertParams = new DynamicParameters();
            var insertStaging = BuildStaging(insertParams, batch, "i");
            await connection.ExecuteAsync(new CommandDefinition($"""
                WITH staging AS ({insertStaging})
                INSERT INTO {tableName} ({insertCols})
                SELECT {insertVals}
                FROM staging s
                LEFT JOIN {tableName} t ON {keyJoin}
                WHERE t.[{keyColumns[0].Name}] IS NULL;
                """, insertParams, cancellationToken: ct));
        }
    }

    /// <summary>Same client-side truncation guard as replaceTable()/upsertBatch() in Node — a fixed-length column that receives a longer string doesn't fail with a clean SQL error, it throws a much more confusing TDS-layer error instead.</summary>
    private static object? Truncate(object? value, int? maxLen) =>
        value is string s && maxLen is int len && s.Length > len ? s[..len] : value;
}
