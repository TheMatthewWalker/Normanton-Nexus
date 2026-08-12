// tableCopy.js
//
// Shared single-table bulk-copy engine used by both copy-data-to-new-server.js
// (Nexus & NexusOperations, GATEWAYHO -> eudc-sql-app) and
// archive-legacy-tables.js (legacy Kongsberg tables, GATEWAYHO's `kongsberg`
// database -> eudc-sql-app's NexusArchive). Both are cross-server copies from
// a source table into an already-schema-migrated target table of the same
// name/columns, so the mechanics (and the two bugs below, found the hard way
// running the first of these two scripts) are identical either way.
//
// Two node-mssql pitfalls this works around:
//   1. Building a bulk `sql.Table` by hand (`columns.add(name, type, {..,
//      precision, scale})`) silently drops precision/scale -- `columns.add`'s
//      3rd-arg `options` only copies nullable/primary/identity/readOnly/
//      length onto the column, so tedious's bulk validator falls back to
//      precision 18/scale 0 and rejects any DECIMAL/NUMERIC value that
//      doesn't fit ("Invalid data for type 'numeric'"). `Table.fromRecordset`
//      instead passes {type, length, scale, precision} as the column object
//      itself, which is the path that actually preserves them -- see
//      node_modules/mssql/lib/table.js.
//   2. A failed bulk load can leave its physical connection unusable for
//      later calls (surfaces as "Transaction has been aborted" on every
//      subsequent table sharing that pooled connection) -- so the bulk step
//      always gets its own short-lived connection, opened and closed per
//      table, rather than reusing one shared pool across many tables.

import sql from 'mssql';

export function assertSafeIdentifier(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Refusing to use unexpected identifier: ${name}`);
  }
  return name;
}

export function qualify(schema, name) {
  return `[${assertSafeIdentifier(schema)}].[${assertSafeIdentifier(name)}]`;
}

export async function rowCount(pool, schema, name) {
  const { recordset } = await pool.request().query(`SELECT COUNT(*) AS cnt FROM ${qualify(schema, name)}`);
  return recordset[0].cnt;
}

async function getComputedColumnNames(pool, schema, name) {
  const { recordset } = await pool
    .request()
    .input('schema', sql.NVarChar, schema)
    .input('name', sql.NVarChar, name).query(`
      SELECT c.name
      FROM sys.computed_columns c
      JOIN sys.tables t ON c.object_id = t.object_id
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name = @schema AND t.name = @name
    `);
  return new Set(recordset.map((r) => r.name));
}

// Disables FK/CHECK constraint enforcement on every given table (or
// re-enables, with re-validation). Failures are collected rather than thrown
// so one table's constraint problem doesn't stop the rest from being
// processed. Call with enabled=false before copying a batch of tables and
// enabled=true once every table in that batch has been loaded -- avoids
// having to hand-compute FK dependency order between them.
export async function setAllConstraints(pool, tables, enabled) {
  const failures = [];
  for (const { schema, name } of tables) {
    const sqlText = enabled
      ? `ALTER TABLE ${qualify(schema, name)} WITH CHECK CHECK CONSTRAINT ALL`
      : `ALTER TABLE ${qualify(schema, name)} NOCHECK CONSTRAINT ALL`;
    try {
      await pool.request().query(sqlText);
    } catch (err) {
      failures.push({ schema, name, error: err.message });
    }
  }
  return failures;
}

/**
 * Copies one table's rows from sourcePool to targetPool (same schema/name on
 * both, target already schema-migrated). Skips if row counts already match
 * (resumable); flags but doesn't touch a table whose target has
 * some-but-not-matching rows.
 *
 * getFreshTargetPool: () => Promise<pool> -- opens a brand-new connection to
 * the target database, used only for the bulk-load transaction itself (see
 * module comment, pitfall 2).
 */
export async function copyTable(sourcePool, targetPool, getFreshTargetPool, schema, name) {
  const qualified = qualify(schema, name);
  const [sourceCount, targetCount] = await Promise.all([
    rowCount(sourcePool, schema, name),
    rowCount(targetPool, schema, name),
  ]);

  if (sourceCount === 0) {
    console.log(`  ${qualified}: source empty, nothing to copy.`);
    return { schema, name, sourceCount, targetCount: 0, status: 'empty' };
  }
  if (targetCount === sourceCount) {
    console.log(`  ${qualified}: already copied (${targetCount} rows), skipping.`);
    return { schema, name, sourceCount, targetCount, status: 'skipped' };
  }
  if (targetCount > 0 && targetCount !== sourceCount) {
    console.warn(
      `  ${qualified}: target has ${targetCount} rows but source has ${sourceCount} -- ambiguous partial copy, leaving alone (clear the target table by hand and re-run to redo it).`
    );
    return { schema, name, sourceCount, targetCount, status: 'mismatch-skipped' };
  }

  // Computed columns can't be given an explicit value on INSERT -- strip
  // them from the recordset's own column list before handing it to
  // Table.fromRecordset, which otherwise builds the bulk column list
  // straight from whatever SELECT * returned.
  const computedColumns = await getComputedColumnNames(targetPool, schema, name);
  const sourceResult = await sourcePool.request().query(`SELECT * FROM ${qualified}`);
  const recordset = sourceResult.recordset;
  if (computedColumns.size) {
    const filtered = {};
    for (const [key, col] of Object.entries(recordset.columns)) {
      if (!computedColumns.has(col.name)) filtered[key] = col;
    }
    // mssql defines `columns` on the recordset via Object.defineProperty
    // with no `writable: true`, so a plain `recordset.columns = filtered`
    // throws ("Cannot assign to read only property") -- it's still
    // `configurable`, so redefining it this way is the correct fix.
    Object.defineProperty(recordset, 'columns', { enumerable: false, configurable: true, value: filtered });
  }
  const hasIdentity = Object.values(recordset.columns).some((c) => c.identity);

  const bulkTable = sql.Table.fromRecordset(recordset, `${schema}.${name}`);
  bulkTable.create = false;

  const txPool = await getFreshTargetPool();
  try {
    const transaction = new sql.Transaction(txPool);
    await transaction.begin();
    try {
      const request = new sql.Request(transaction);
      if (hasIdentity) await request.query(`SET IDENTITY_INSERT ${qualified} ON`);
      await request.bulk(bulkTable);
      if (hasIdentity) await request.query(`SET IDENTITY_INSERT ${qualified} OFF`);
      await transaction.commit();
    } catch (err) {
      try {
        await transaction.rollback();
      } catch {
        // Best-effort -- the connection is being discarded either way.
      }
      throw err;
    }
  } finally {
    await txPool.close();
  }

  const finalCount = await rowCount(targetPool, schema, name);
  console.log(`  ${qualified}: copied ${finalCount}/${sourceCount} rows.`);
  return {
    schema,
    name,
    sourceCount,
    targetCount: finalCount,
    status: finalCount === sourceCount ? 'copied' : 'row-count-mismatch',
  };
}

export function printSummary(label, results, extraFailures = []) {
  console.log(`\n--- ${label} summary ---`);
  for (const r of results) {
    const flag = ['row-count-mismatch', 'mismatch-skipped', 'error'].includes(r.status) ? '  <-- CHECK THIS' : '';
    console.log(`${r.schema}.${r.name}: source=${r.sourceCount} target=${r.targetCount} [${r.status}]${flag}`);
  }
  if (extraFailures.length) {
    console.log(
      `\n${extraFailures.length} table(s) failed constraint re-validation (likely a real data problem, not a copy bug):`
    );
    for (const f of extraFailures) console.log(`  ${f.schema}.${f.name}: ${f.error}`);
  }
  return (
    results.filter((r) => ['row-count-mismatch', 'mismatch-skipped', 'error'].includes(r.status)).length +
    extraFailures.length
  );
}
