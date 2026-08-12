// migrateTargetConnection.js
//
// Connects to "whichever SQL Server the migration tooling is currently
// pointed at" -- the exact same MIGRATE_DB_* env vars knexfile.cjs's
// migrate:* scripts use (see .env.example's own description of that
// section). Mirrors knexfile.cjs's baseConnection builder so there's a
// single definition of "where's the new server" shared by knex and any
// standalone Node script (copy-data-to-new-server.js, archive-legacy-tables.js)
// that needs to talk to the same target outside of Knex.
//
// Deliberately NOT reading config.json's sqlConfig here -- that's the app's
// own live-server connection (see config.js), a different physical server
// during the migration window.

import 'dotenv/config';
import sql from 'mssql';

const instanceName = process.env.MIGRATE_DB_INSTANCE || undefined;

function baseConnection() {
  return {
    server: process.env.MIGRATE_DB_SERVER || 'localhost',
    user: process.env.MIGRATE_DB_USER,
    password: process.env.MIGRATE_DB_PASSWORD,
    ...(instanceName ? {} : { port: Number(process.env.MIGRATE_DB_PORT) || 1433 }),
    options: {
      encrypt: false,
      trustServerCertificate: true,
      ...(instanceName ? { instanceName } : {}),
    },
  };
}

// Opens a fresh, uncached pool -- these scripts are one-shot CLI runs, not a
// long-lived server process, so there's no shared-pool lifecycle to manage
// (contrast with config.js's makePoolGetter caching for the running app).
export async function getMigrateTargetPool(databaseName) {
  const pool = new sql.ConnectionPool({ ...baseConnection(), database: databaseName });
  await pool.connect();
  return pool;
}
