/**
 * archive-legacy-tables.js
 *
 * Copies the legacy Kongsberg-era per-process production-tracking tables
 * (Mixing, Extrusion, Convo, Ewald, Firewall, Batches, Coils, Waste, Trace,
 * archive, test, Emails, ScrapReasons, and their *Messages/*Trace/*Waste
 * siblings) into NexusArchive on eudc-sql-app. This is the
 * deliberately-deferred data migration flagged (but never executed) in
 * migrations/README.md and config.js's getNexusArchivePool comment when
 * NexusArchive's schema-only migration first landed.
 *
 * SOURCE: GATEWAYHO's `kongsberg` database (the original, still-live
 * database -- NOT the new `Nexus`). This matters: when Nexus's own schema
 * was extracted (migrations/nexus/20260804120000_initial_schema.cjs), these
 * ~27 legacy tables were deliberately excluded ("split out, not part of this
 * migration" -- see migrations/README.md), so Nexus never had them and
 * config.json's `sqlConfig.database: "kongsberg"` (unused by the app's own
 * pools, which hardcode Nexus/NexusOperations/NexusArchive -- see
 * config.js's resolvePoolConfig) is actually the live pointer to where this
 * data still is. Confirmed live: GATEWAYHO has a separate `kongsberg`
 * database alongside `Nexus`/`NexusOperations`/`NexusArchive`, and
 * `kongsberg.dbo.Coils` alone has ~192K rows, matching the ~190K estimate in
 * migrations/README.md.
 *
 * TARGET: NexusArchive on eudc-sql-app (via MIGRATE_DB_* -- see
 * scripts/lib/migrateTargetConnection.js), whose schema must already exist
 * (npm run migrate:nexus_archive).
 *
 * The table list is read from NexusArchive's own schema rather than
 * hardcoded, so it can't drift from that migration.
 *
 * COPY ONLY, per explicit decision when this was scoped (see
 * migrations/README.md) -- rows stay in `kongsberg` too. Nothing here
 * deletes or truncates the source.
 *
 * SAFE TO RE-RUN -- see scripts/lib/tableCopy.js's copyTable for the
 * skip/flag rules that make this idempotent.
 *
 * Run manually:
 *   node scripts/archive-legacy-tables.js
 */

import 'dotenv/config';
import fs from 'fs';
import sql from 'mssql';
import { getMigrateTargetPool } from './lib/migrateTargetConnection.js';
import { copyTable, setAllConstraints, printSummary } from './lib/tableCopy.js';

// Not exposed by config.js -- the app's own pools (getNexusPool etc.) always
// hardcode their database name (Nexus/NexusOperations/NexusArchive), and
// `kongsberg` isn't one of those three. Reuses config.json's server/user/
// password (same connection the running app already uses), same convention
// as config.js's own resolvePoolConfig.
async function getKongsbergSourcePool() {
  const raw = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const cfg = raw.sqlConfig;
  const pool = new sql.ConnectionPool({
    user: cfg.user,
    password: cfg.password,
    server: cfg.server,
    database: 'kongsberg',
    options: { encrypt: false, trustServerCertificate: true },
  });
  await pool.connect();
  return pool;
}

const EXCLUDED_TABLES = new Set(['knex_migrations', 'knex_migrations_lock']);

async function listArchiveTables(targetPool) {
  const { recordset } = await targetPool.request().query(`
    SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS [name]
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_SCHEMA, TABLE_NAME
  `);
  return recordset.filter((t) => !EXCLUDED_TABLES.has(t.name));
}

async function main() {
  const sourcePool = await getKongsbergSourcePool();
  const targetPool = await getMigrateTargetPool('NexusArchive');
  const tables = await listArchiveTables(targetPool);
  console.log(`${tables.length} legacy table(s) to check.\n`);

  await setAllConstraints(targetPool, tables, false);

  const results = [];
  for (const { schema, name } of tables) {
    try {
      results.push(await copyTable(sourcePool, targetPool, () => getMigrateTargetPool('NexusArchive'), schema, name));
    } catch (err) {
      console.error(`  [${schema}].[${name}]: FAILED -- ${err.message}`);
      results.push({ schema, name, sourceCount: null, targetCount: null, status: 'error', error: err.message });
    }
  }

  const constraintFailures = await setAllConstraints(targetPool, tables, true);

  await sourcePool.close();
  await targetPool.close();

  const problemCount = printSummary('NexusArchive', results, constraintFailures);
  if (problemCount) {
    console.log(`\n${problemCount} item(s) need attention -- see CHECK THIS above.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll legacy tables archived and verified. kongsberg was not modified (copy only).');
  }
}

main().catch((err) => {
  console.error('Archive failed:', err);
  process.exitCode = 1;
});
