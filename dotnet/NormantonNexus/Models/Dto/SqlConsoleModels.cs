namespace NormantonNexus.Models.Dto;

/// <summary>
/// SQL Console — Phase 9-adjacent Admin gap found by a later tile-parity
/// audit against the Node tile inventory (admin.html's SQL Console section,
/// backed by routes/sqlqueries.js's POST /sql/query). Distinct from DB
/// Explorer (schema/data browsing only, read-only) — this runs arbitrary
/// SQL, gated to admins with a destructive-keyword block that only
/// superadmin may bypass, matching Node exactly. routes/sqlqueries.js's
/// second route, POST /sql/query-csv, is NOT ported — its only real
/// frontend caller (private/js/production.js's legacy dbo-table CSV export)
/// belongs to routes/production.js's legacy NexusArchive-backed reads,
/// already confirmed out of scope for this migration (see dotnet/CLAUDE.md's
/// Phase 6 top-level scope note) — porting query-csv here would be building
/// a route with no real consumer in this app.
/// </summary>
public sealed record SqlConsoleQueryRequest(string? Query);

/// <summary>
/// One entry per statement's result set, in order (a query batch with
/// several semicolon-separated SELECTs produces one entry per SELECT) —
/// matches Node's own recordsets shape. RowsAffected is a single total
/// across the whole batch (SqlDataReader.RecordsAffected has no
/// per-statement breakdown the way mssql's own rowsAffected array does;
/// the console UI only ever sums it for display anyway).
/// </summary>
public sealed record SqlConsoleQueryResult(int RowsAffected, IReadOnlyList<IReadOnlyList<Dictionary<string, object?>>> Recordsets);
