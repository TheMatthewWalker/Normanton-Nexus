using Microsoft.EntityFrameworkCore;

namespace NormantonNexus.Data;

/// <summary>
/// EF Core is used ONLY as migration tooling here — raw-SQL migrationBuilder.Sql()
/// calls, never a fluent model — runtime queries go through Dapper (Services/Sql/).
/// This context intentionally has no DbSet&lt;T&gt; properties; it exists purely so
/// `dotnet ef migrations add`/`dotnet ef database update` have somewhere to run.
/// Mirrors the existing app's knex-migrations-are-really-just-raw-idempotent-T-SQL
/// pattern (28 files, IF COL_LENGTH(...) IS NULL-style guards) — see the migration
/// plan's "Migrations tooling" note.
/// </summary>
public sealed class NexusMigrationContext(DbContextOptions<NexusMigrationContext> options)
    : DbContext(options);
