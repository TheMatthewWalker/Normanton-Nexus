// Knex migration config for the databases this app depends on: Kongsberg
// (portal/session/audit), Production (prod.* shop-floor tables), Logistics
// (Logistics.dbo.* shipping/warehouse tables), plus production_archive — a
// new database holding the legacy per-process production-tracking tables
// (Mixing/Extrusion/Convo/Ewald/Firewall/Batches/Coils/Waste/etc.) that
// predate Production Nexus and are being retired out of Kongsberg proper.
// See migrations/README.md.
//
// This is the "EF Migrations for Node" system referenced in chat: the
// existing sql/*.sql files (59 of them) capture ad-hoc, manually-applied
// changes with no tracking of what's been run where. Knex migrations under
// migrations/<database>/ replace that going forward with tracked, ordered,
// re-runnable files — a knex_migrations table (created automatically) records
// what's already been applied per database, the same job EF's
// __EFMigrationsHistory table does.
//
// .cjs (not .js) is deliberate: package.json sets "type": "module" for the
// app itself, but the knex CLI's ESM-knexfile support has enough rough edges
// that plain CommonJS here is the safer, better-trodden path. This file is
// tooling, not app code — it doesn't need to match the app's module system.
//
// Each top-level key below is a knex "environment" in the CLI sense, but
// used here to select which DATABASE to target, not dev/staging/prod — run
// e.g. `npx knex migrate:latest --env kongsberg --knexfile knexfile.cjs`.
// See package.json's migrate:* scripts for the short forms.
//
// Connection details come from MIGRATE_DB_* env vars (.env.example), kept
// deliberately separate from the app's own config.json-sourced sqlConfig —
// see that .env.example section for why.

require('dotenv').config();

// Named-instance support (e.g. SQL Server Express's default "SQLEXPRESS"
// instance): when MIGRATE_DB_INSTANCE is set, tedious resolves the actual
// TCP port itself via the SQL Server Browser service (UDP 1434) — an
// explicit `port` is mutually exclusive with `options.instanceName` and
// must be omitted, not just left at its default, or the connection is
// rejected outright.
const instanceName = process.env.MIGRATE_DB_INSTANCE || undefined;

const baseConnection = {
  server: process.env.MIGRATE_DB_SERVER || 'localhost',
  user: process.env.MIGRATE_DB_USER,
  password: process.env.MIGRATE_DB_PASSWORD,
  ...(instanceName ? {} : { port: Number(process.env.MIGRATE_DB_PORT) || 1433 }),
  options: {
    // SQL Server 2005 (the current production instance this app's TLS
    // bridge exists for) has no encryption support worth relying on here;
    // the new/test server this migration system targets may differ, but
    // trustServerCertificate keeps a self-signed/dev cert from failing the
    // connection either way. Tighten this once the new server's real
    // certificate situation is known.
    encrypt: false,
    trustServerCertificate: true,
    ...(instanceName ? { instanceName } : {}),
  },
};

function dbConfig(databaseName, dir, hasSeeds) {
  return {
    client: 'mssql',
    connection: { ...baseConnection, database: databaseName },
    migrations: {
      directory: `./migrations/${dir}`,
      tableName: 'knex_migrations',
    },
    // Seeds are separate from migrations on purpose: migrations are schema
    // changes, tracked and run once each; seeds are re-runnable reference/
    // lookup DATA loaders (see seeds/README.md), run explicitly via
    // `knex seed:run`, never auto-applied by migrate:latest.
    ...(hasSeeds ? { seeds: { directory: `./seeds/${dir}` } } : {}),
  };
}

module.exports = {
  kongsberg: dbConfig('Kongsberg', 'kongsberg', true),
  production: dbConfig('Production', 'production', true),
  logistics: dbConfig('Logistics', 'logistics', true),
  production_archive: dbConfig('production_archive', 'production_archive', false),
};
