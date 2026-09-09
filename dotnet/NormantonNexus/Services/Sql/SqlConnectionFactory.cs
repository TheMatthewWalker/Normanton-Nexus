using Microsoft.Data.SqlClient;

namespace NormantonNexus.Services.Sql;

internal abstract class SqlConnectionFactoryBase(string connectionString) : ISqlConnectionFactory
{
    public async Task<SqlConnection> CreateConnectionAsync(CancellationToken ct = default)
    {
        var connection = new SqlConnection(connectionString);
        await connection.OpenAsync(ct);
        return connection;
    }
}

// Three named factories, one per database, all against the same SQL Server
// instance/login by default — mirrors config.js's resolvePoolConfig, which
// lets ONE database move to a different server/login via a per-pool
// override without touching the others. Here that's just three separate
// "ConnectionStrings" entries in configuration; a future per-database
// server split is a config change, not a code change.
internal sealed class NexusDb(IConfiguration configuration)
    : SqlConnectionFactoryBase(configuration.GetConnectionString("Nexus")
        ?? throw new InvalidOperationException("ConnectionStrings:Nexus is not configured.")), INexusDb;

internal sealed class NexusOperationsDb(IConfiguration configuration)
    : SqlConnectionFactoryBase(configuration.GetConnectionString("NexusOperations")
        ?? throw new InvalidOperationException("ConnectionStrings:NexusOperations is not configured.")), INexusOperationsDb;

internal sealed class NexusArchiveDb(IConfiguration configuration)
    : SqlConnectionFactoryBase(configuration.GetConnectionString("NexusArchive")
        ?? throw new InvalidOperationException("ConnectionStrings:NexusArchive is not configured.")), INexusArchiveDb;
