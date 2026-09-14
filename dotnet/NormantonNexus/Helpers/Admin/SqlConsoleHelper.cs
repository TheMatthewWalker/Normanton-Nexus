using NormantonNexus.Models;
using NormantonNexus.Models.Dto;
using NormantonNexus.Services.Auth;
using NormantonNexus.Services.Sql;

namespace NormantonNexus.Helpers.Admin;

/// <summary>
/// SQL Console — port of routes/sqlqueries.js's POST /sql/query. See
/// SqlConsoleQueryRequest's own header comment (SqlConsoleModels.cs) for why
/// /sql/query-csv is not ported.
///
/// Runs against a plain INexusDb connection, not a dedicated
/// "isolated"/throwaway one the way Node's own getIsolatedNexusConnection()
/// does — Node needed that because a console query may contain a
/// session-scoped statement (e.g. USE &lt;db&gt;) that would otherwise leak
/// into mssql's own connection pool and corrupt unrelated requests reusing
/// the same physical connection. ADO.NET's SqlClient pool already resets
/// session state (sp_reset_connection) whenever a pooled connection is
/// closed and later reused, so a plain CreateConnectionAsync() per request
/// is already safe here without needing Node's own workaround.
/// </summary>
internal static class SqlConsoleHelper
{
    private static readonly string[] ForbiddenKeywords = ["DELETE", "DROP", "UPDATE", "INSERT", "ALTER", "TRUNCATE", "EXEC", "MERGE"];

    internal static async Task<SqlConsoleQueryResult> RunQueryAsync(
        INexusDb db, IAuditLogger audit, string? query, bool isSuperadmin, string? username, string? ipAddress, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(query))
            throw new NexusValidationException("Missing query");

        // Only superadmin may bypass the destructive-keyword block — this same route also
        // serves plain SELECTs for ordinary department data-browser pages in Node, so it
        // can't be locked down to superadmin entirely; only the dangerous-keyword bypass is.
        if (!isSuperadmin)
        {
            var normalized = query.ToUpperInvariant();
            var hit = Array.Find(ForbiddenKeywords, k => normalized.Contains(k, StringComparison.Ordinal));
            if (hit is not null)
            {
                await audit.LogAsync("RAW_SQL_BLOCKED", username, Truncate(query, 500), ipAddress, ct);
                throw new NexusPermissionException($"Forbidden keyword detected: one of {string.Join(", ", ForbiddenKeywords)}");
            }
        }

        await using var connection = await db.CreateConnectionAsync(ct);
        await using var command = connection.CreateCommand();
        command.CommandText = query;
        command.CommandTimeout = 120;

        try
        {
            var recordsets = new List<IReadOnlyList<Dictionary<string, object?>>>();
            int rowsAffected;
            await using (var reader = await command.ExecuteReaderAsync(ct))
            {
                do
                {
                    var rows = new List<Dictionary<string, object?>>();
                    while (await reader.ReadAsync(ct))
                    {
                        var row = new Dictionary<string, object?>(reader.FieldCount);
                        for (var i = 0; i < reader.FieldCount; i++)
                            row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
                        rows.Add(row);
                    }
                    recordsets.Add(rows);
                } while (await reader.NextResultAsync(ct));
                rowsAffected = reader.RecordsAffected;
            }

            await audit.LogAsync("RAW_SQL", username, Truncate(query, 500), ipAddress, ct);
            return new SqlConsoleQueryResult(Math.Max(rowsAffected, 0), recordsets);
        }
        catch (Exception ex)
        {
            await audit.LogAsync("RAW_SQL_ERROR", username, $"{Truncate(query, 400)} — ERR: {Truncate(ex.Message, 80)}", ipAddress, ct);
            throw new NexusSqlExecutionException(ex.Message);
        }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
