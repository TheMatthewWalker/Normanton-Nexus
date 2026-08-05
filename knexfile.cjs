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

// ---------------------------------------------------------------------------
// *_live environments — point at the actual live SQL Server 2005 box, using
// the SAME server/login the running app itself already uses (config.json's
// sqlConfig), not a duplicate copy of that password in .env. There's no
// reason for the live credential to exist in two places.
//
// These are for baselining Knex against the already-existing live databases
// (see migrations/README.md's "Using this against live" section) and then
// running genuinely NEW migrations against them going forward — NOT for
// re-running the existing 2026-08-04 initial-schema migrations, which would
// fail immediately (every constraint/index they create already exists live
// under the same name).
//
// Deliberately no `seeds` config here at all: seeding live would DELETE and
// reinsert PortalUsers/Vendor/etc. with a stale point-in-time snapshot,
// wiping real changes made since. `knex seed:run --env kongsberg_live`
// falls back to Knex's default top-level ./seeds/ directory, which has
// nothing directly in it to run — a deliberate safety net, not just an
// omission.
let liveConfig = null;
try {
  const fs = require('fs');
  liveConfig = JSON.parse(fs.readFileSync('./config.json', 'utf8')).sqlConfig;
} catch {
  // config.json is git-ignored and won't exist on every checkout (e.g. a
  // fresh clone that's only set up .env for the test server) — the *_live
  // environments just won't be defined below in that case, rather than
  // breaking every other environment in this file.
}

function liveDbConfig(databaseName, dir) {
  return {
    client: 'mssql',
    connection: {
      user: liveConfig.user,
      password: liveConfig.password,
      server: liveConfig.server,
      database: databaseName,
      options: { encrypt: false, trustServerCertificate: true },
    },
    migrations: {
      directory: `./migrations/${dir}`,
      tableName: 'knex_migrations',
    },
  };
}

module.exports = {
  kongsberg: dbConfig('Kongsberg', 'kongsberg', true),
  production: dbConfig('Production', 'production', true),
  logistics: dbConfig('Logistics', 'logistics', true),
  production_archive: dbConfig('production_archive', 'production_archive', false),
  ...(liveConfig
    ? {
        kongsberg_live: liveDbConfig('Kongsberg', 'kongsberg'),
        production_live: liveDbConfig('Production', 'production'),
        logistics_live: liveDbConfig('Logistics', 'logistics'),
      }
    : {}),
};
