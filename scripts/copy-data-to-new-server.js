/**
 * copy-data-to-new-server.js
 *
 * One-time (but safely re-runnable) data copy: Nexus & NexusOperations,
 * GATEWAYHO (the live SQL Server 2005 box, via config.js's own pools) ->
 * eudc-sql-app (the new datacenter server, via the MIGRATE_DB_* env vars --
 * see scripts/lib/migrateTargetConnection.js). Schema on the target must
 * already exist (npm run migrate:nexus / migrate:nexus_operations).
 *
 * COPY ONLY -- GATEWAYHO is left completely untouched. The running "Normanton
 * Nexus" service keeps serving off GATEWAYHO throughout; cutting the app over
 * to eudc-sql-app (config.json's sqlConfig/sqlPools) is a deliberate later
 * step, not done here.
 *
 * This is a point-in-time snapshot of live, actively-written tables -- run it
 * during a quiet period or a brief maintenance window so the copy is
 * internally consistent. The script itself has no way to pause writers.
 *
 * SAFE TO RE-RUN -- see scripts/lib/tableCopy.js's copyTable for the
 * skip/flag rules that make this idempotent.
 *
 * Run manually:
 *   node scripts/copy-data-to-new-server.js
 */

// Must come before importing config.js -- see scripts/seed-vendor-materials.js
// for why a standalone script needs this even though server.js gets it for
// free via the Windows service wrapper.
import 'dotenv/config';
import { getNexusPool, getNexusOperationsPool } from '../config.js';
import { getMigrateTargetPool } from './lib/migrateTargetConnection.js';
import { copyTable, setAllConstraints, printSummary } from './lib/tableCopy.js';

// PortalSessions is ephemeral -- copying stale session rows across doesn't
// help anyone, the new server would need matching in-memory Express session
// state anyway, and every user gets a fresh login on cutover regardless.
// knex_migrations/knex_migrations_lock are Knex's own per-server bookkeeping
// tables; eudc-sql-app already has its own correct ones from Step 1.
const EXCLUDED_TABLES = {
  Nexus: new Set(['PortalSessions', 'knex_migrations', 'knex_migrations_lock']),
  NexusOperations: new Set(['knex_migrations', 'knex_migrations_lock']),
};

async function listTables(pool, excluded) {
  const { recordset } = await pool.request().query(`
    SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS [name]
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_SCHEMA, TABLE_NAME
  `);
  return recordset.filter((t) => !excluded.has(t.name));
}

async function copyDatabase(label, getSourcePool, targetDatabaseName, excluded) {
  console.log(`\n=== ${label} ===`);
  const sourcePool = await getSourcePool();
  const targetPool = await getMigrateTargetPool(targetDatabaseName);
  const tables = await listTables(sourcePool, excluded);
  console.log(`  ${tables.length} table(s) to check.`);

  await setAllConstraints(targetPool, tables, false);

  const results = [];
  for (const { schema, name } of tables) {
    try {
      results.push(
        await copyTable(sourcePool, targetPool, () => getMigrateTargetPool(targetDatabaseName), schema, name)
      );
    } catch (err) {
      console.error(`  [${schema}].[${name}]: FAILED -- ${err.message}`);
      results.push({ schema, name, sourceCount: null, targetCount: null, status: 'error', error: err.message });
    }
  }

  const constraintFailures = await setAllConstraints(targetPool, tables, true);

  await targetPool.close();
  return { results, constraintFailures };
}

async function main() {
  const nexus = await copyDatabase('Nexus', getNexusPool, 'Nexus', EXCLUDED_TABLES.Nexus);
  const nexusOperations = await copyDatabase(
    'NexusOperations',
    getNexusOperationsPool,
    'NexusOperations',
    EXCLUDED_TABLES.NexusOperations
  );

  const problemCount =
    printSummary('Nexus', nexus.results, nexus.constraintFailures) +
    printSummary('NexusOperations', nexusOperations.results, nexusOperations.constraintFailures);

  if (problemCount) {
    console.log(`\n${problemCount} item(s) need attention -- see CHECK THIS above.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll tables copied and verified. GATEWAYHO was not modified.');
  }
}

main().catch((err) => {
  console.error('Copy failed:', err);
  process.exitCode = 1;
});
