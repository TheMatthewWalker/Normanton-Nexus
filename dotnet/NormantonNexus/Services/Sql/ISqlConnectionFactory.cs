using Microsoft.Data.SqlClient;

namespace NormantonNexus.Services.Sql;

/// <summary>
/// Opens a ready-to-use connection to one specific database. Callers use
/// Dapper extension methods against the returned connection — this project
/// has no runtime ORM, matching the existing Node app's 100%-raw-parameterized-SQL
/// style (see dotnet/CLAUDE.md).
/// </summary>
public interface ISqlConnectionFactory
{
    Task<SqlConnection> CreateConnectionAsync(CancellationToken ct = default);
}

/// <summary>Nexus — the primary portal database (users, sessions, permissions, most department data).</summary>
public interface INexusDb : ISqlConnectionFactory;

/// <summary>NexusOperations — production/logistics operational data.</summary>
public interface INexusOperationsDb : ISqlConnectionFactory;

/// <summary>
/// NexusArchive — schema-only today, no data yet (see the migration plan's
/// Architecture section). Wired up for completeness; don't build real
/// features against it until it actually holds data.
/// </summary>
public interface INexusArchiveDb : ISqlConnectionFactory;
