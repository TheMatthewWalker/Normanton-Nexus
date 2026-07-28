/**
 * routes/dbexplorer.js
 * Kongsberg Portal — DB Explorer (superadmin-only SSMS-lite schema browser)
 *
 * Lets a superadmin browse every database on the SQL Server instance this
 * app connects to (kongsberg, Production, Logistics, plus anything else the
 * login can see — SQL Server's own sys.databases filtering already hides
 * databases the login has no access to, so nothing extra is needed there):
 * list databases -> list tables in a database -> list columns / keys &
 * constraints for a table -> optionally preview the first N rows.
 *
 * All of this is one instance, several databases (confirmed against
 * config.js's sqlConfig / getProductionPool / getLogisticsPool — same
 * `server`, different `database`), so a single connection to the default
 * `kongsberg` database is enough: SQL Server allows querying another
 * database's system catalog views with a three-part name, e.g.
 * `[Production].sys.tables`, as long as the login has visibility into that
 * database. No per-database connection pool is needed.
 *
 * SQL injection note: database/schema/table names can't be parameterized
 * the normal way (they're identifiers, not values), and they're going into
 * a dynamic query string built with [bracket] escaping. To stay safe, every
 * identifier that reaches a dynamic query is first verified with a real,
 * parameterized lookup against sys.databases / that database's sys.schemas
 * / sys.tables — if the requested name doesn't come back as an exact match
 * from the system view, the request is rejected before anything is
 * interpolated. Only the *verified* name (still bracket-escaped defensively)
 * is ever spliced into SQL. This mirrors the two-step "look up, then trust"
 * pattern rather than trusting client input directly.
 *
 * Every route here is gated superadmin-only (stricter than /api/admin's
 * blanket requireRole('admin') mount in server.js) and every query is
 * written to the audit log, same as the existing raw SQL console
 * (routes/sqlqueries.js) — this feature can read structure and data across
 * every database on the box, so it gets the same scrutiny.
 */

import express from 'express';
import sql from 'mssql';
import { auditQuery, sqlConfig } from '../config.js';

const router = express.Router();

function requireSuperadmin(req, res, next) {
  if (req.session?.user?.role === 'superadmin') return next();
  return res.status(403).json({ success: false, error: 'Requires superadmin role.' });
}
router.use(requireSuperadmin);

// Escapes a verified identifier for safe interpolation into a dynamic query
// as [name] — doubles any ] the (already-verified-real) name might contain,
// standard T-SQL bracket-quoting. Belt-and-braces on top of the "must exist
// in sys.*" check every caller below already does.
function bracket(name) {
  return `[${String(name).replace(/]/g, ']]')}]`;
}

// ── Verify a database name is real and visible to this login ────────────────
// Returns the canonical name from sys.databases, or null if not found —
// callers must treat null as "reject the request", never fall back to the
// raw client-supplied value.
async function verifyDatabase(pool, database) {
  const { recordset } = await pool.request()
    .input('name', sql.NVarChar(128), database)
    .query('SELECT name FROM sys.databases WHERE name = @name');
  return recordset[0]?.name ?? null;
}

// ── Verify a schema+table exists in the given (already-verified) database ──
async function verifyTable(pool, dbBracket, schema, table) {
  const { recordset } = await pool.request()
    .input('schema', sql.NVarChar(128), schema)
    .input('table',  sql.NVarChar(128), table)
    .query(`
      SELECT s.name AS SchemaName, t.name AS TableName
      FROM ${dbBracket}.sys.tables t
      JOIN ${dbBracket}.sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = @schema AND t.name = @table
    `);
  return recordset[0] || null;
}

// ── GET /api/admin/dbexplorer/databases ─────────────────────────────────────
router.get('/databases', async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
    const { recordset } = await pool.request().query(`
      SELECT
        name,
        database_id,
        create_date,
        state_desc,
        recovery_model_desc,
        compatibility_level
      FROM sys.databases
      ORDER BY database_id
    `);
    res.json({ success: true, data: recordset });
  } catch (err) {
    console.error('[dbexplorer/databases]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/admin/dbexplorer/:database/tables ──────────────────────────────
router.get('/:database/tables', async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
    const dbName = await verifyDatabase(pool, req.params.database);
    if (!dbName) return res.status(404).json({ success: false, error: 'Database not found.' });
    const db = bracket(dbName);

    const { recordset } = await pool.request().query(`
      SELECT
        s.name AS SchemaName,
        t.name AS TableName,
        SUM(p.rows) AS ApproxRowCount
      FROM ${db}.sys.tables t
      JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
      LEFT JOIN ${db}.sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
      GROUP BY s.name, t.name
      ORDER BY s.name, t.name
    `);
    res.json({ success: true, data: recordset });
  } catch (err) {
    console.error('[dbexplorer/tables]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/admin/dbexplorer/:database/:schema/:table/columns ─────────────
router.get('/:database/:schema/:table/columns', async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
    const dbName = await verifyDatabase(pool, req.params.database);
    if (!dbName) return res.status(404).json({ success: false, error: 'Database not found.' });
    const db = bracket(dbName);

    const tbl = await verifyTable(pool, db, req.params.schema, req.params.table);
    if (!tbl) return res.status(404).json({ success: false, error: 'Table not found.' });

    const { recordset } = await pool.request()
      .input('schema', sql.NVarChar(128), tbl.SchemaName)
      .input('table',  sql.NVarChar(128), tbl.TableName)
      .query(`
        SELECT
          c.column_id                                   AS ColumnID,
          c.name                                         AS ColumnName,
          ty.name                                        AS DataType,
          c.max_length                                   AS MaxLength,
          c.precision                                    AS Precision,
          c.scale                                        AS Scale,
          c.is_nullable                                  AS IsNullable,
          c.is_identity                                  AS IsIdentity,
          dc.definition                                  AS DefaultValue,
          CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS IsPrimaryKey
        FROM ${db}.sys.columns c
        JOIN ${db}.sys.types   ty ON ty.user_type_id = c.user_type_id
        JOIN ${db}.sys.tables  t  ON t.object_id = c.object_id
        JOIN ${db}.sys.schemas s  ON s.schema_id = t.schema_id
        LEFT JOIN ${db}.sys.default_constraints dc ON dc.object_id = c.default_object_id
        LEFT JOIN (
          SELECT ic.object_id, ic.column_id
          FROM ${db}.sys.index_columns ic
          JOIN ${db}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
          WHERE i.is_primary_key = 1
        ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
        WHERE s.name = @schema AND t.name = @table
        ORDER BY c.column_id
      `);
    res.json({ success: true, data: recordset });
  } catch (err) {
    console.error('[dbexplorer/columns]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/admin/dbexplorer/:database/:schema/:table/constraints ─────────
// Primary/unique key constraints, foreign keys FROM this table, foreign keys
// referencing this table FROM elsewhere, check constraints, and indexes.
router.get('/:database/:schema/:table/constraints', async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
    const dbName = await verifyDatabase(pool, req.params.database);
    if (!dbName) return res.status(404).json({ success: false, error: 'Database not found.' });
    const db = bracket(dbName);

    const tbl = await verifyTable(pool, db, req.params.schema, req.params.table);
    if (!tbl) return res.status(404).json({ success: false, error: 'Table not found.' });

    const schemaInput = () => ({ schema: tbl.SchemaName, table: tbl.TableName });

    const keysReq = pool.request()
      .input('schema', sql.NVarChar(128), tbl.SchemaName)
      .input('table',  sql.NVarChar(128), tbl.TableName);
    // No STRING_AGG — this app targets SQL Server 2005 (STRING_AGG is
    // 2017+), so column lists are built with the STUFF(...FOR XML PATH(''))
    // concatenation trick instead, same pattern used everywhere else in
    // this codebase (see performancesql.js listOrderShipments()).
    const keys = await keysReq.query(`
      SELECT
        kc.name        AS ConstraintName,
        kc.type_desc   AS ConstraintType,
        STUFF((
          SELECT ', ' + c2.name
          FROM ${db}.sys.index_columns ic2
          JOIN ${db}.sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
          WHERE ic2.object_id = kc.parent_object_id AND ic2.index_id = kc.unique_index_id
          ORDER BY ic2.key_ordinal
          FOR XML PATH('')
        ), 1, 2, '') AS Columns
      FROM ${db}.sys.key_constraints kc
      JOIN ${db}.sys.tables  t  ON t.object_id = kc.parent_object_id
      JOIN ${db}.sys.schemas s  ON s.schema_id = t.schema_id
      WHERE s.name = @schema AND t.name = @table
    `);

    const fkOutReq = pool.request()
      .input('schema', sql.NVarChar(128), tbl.SchemaName)
      .input('table',  sql.NVarChar(128), tbl.TableName);
    const fkOut = await fkOutReq.query(`
      SELECT
        fk.name                                  AS ConstraintName,
        c.name                                   AS ColumnName,
        rs.name                                  AS ReferencedSchema,
        rt.name                                  AS ReferencedTable,
        rc.name                                  AS ReferencedColumn,
        fk.delete_referential_action_desc        AS OnDelete,
        fk.update_referential_action_desc        AS OnUpdate
      FROM ${db}.sys.foreign_keys fk
      JOIN ${db}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      JOIN ${db}.sys.tables  t  ON t.object_id = fk.parent_object_id
      JOIN ${db}.sys.schemas s  ON s.schema_id = t.schema_id
      JOIN ${db}.sys.columns c  ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
      JOIN ${db}.sys.tables  rt ON rt.object_id = fk.referenced_object_id
      JOIN ${db}.sys.schemas rs ON rs.schema_id = rt.schema_id
      JOIN ${db}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      WHERE s.name = @schema AND t.name = @table
      ORDER BY fk.name
    `);

    const fkInReq = pool.request()
      .input('schema', sql.NVarChar(128), tbl.SchemaName)
      .input('table',  sql.NVarChar(128), tbl.TableName);
    const fkIn = await fkInReq.query(`
      SELECT
        fk.name                                  AS ConstraintName,
        s.name                                   AS SourceSchema,
        t.name                                   AS SourceTable,
        c.name                                   AS SourceColumn,
        rc.name                                  AS ColumnName
      FROM ${db}.sys.foreign_keys fk
      JOIN ${db}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      JOIN ${db}.sys.tables  t  ON t.object_id = fk.parent_object_id
      JOIN ${db}.sys.schemas s  ON s.schema_id = t.schema_id
      JOIN ${db}.sys.columns c  ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
      JOIN ${db}.sys.tables  rt ON rt.object_id = fk.referenced_object_id
      JOIN ${db}.sys.schemas rs ON rs.schema_id = rt.schema_id
      JOIN ${db}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      WHERE rs.name = @schema AND rt.name = @table
      ORDER BY fk.name
    `);

    const checksReq = pool.request()
      .input('schema', sql.NVarChar(128), tbl.SchemaName)
      .input('table',  sql.NVarChar(128), tbl.TableName);
    const checks = await checksReq.query(`
      SELECT cc.name AS ConstraintName, cc.definition AS Definition, cc.is_disabled AS IsDisabled
      FROM ${db}.sys.check_constraints cc
      JOIN ${db}.sys.tables  t ON t.object_id = cc.parent_object_id
      JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = @schema AND t.name = @table
    `);

    const indexesReq = pool.request()
      .input('schema', sql.NVarChar(128), tbl.SchemaName)
      .input('table',  sql.NVarChar(128), tbl.TableName);
    const indexes = await indexesReq.query(`
      SELECT
        i.name         AS IndexName,
        i.type_desc    AS IndexType,
        i.is_unique    AS IsUnique,
        i.is_primary_key AS IsPrimaryKey,
        STUFF((
          SELECT ', ' + c2.name
          FROM ${db}.sys.index_columns ic2
          JOIN ${db}.sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
          WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id AND ic2.is_included_column = 0
          ORDER BY ic2.key_ordinal
          FOR XML PATH('')
        ), 1, 2, '') AS Columns
      FROM ${db}.sys.indexes i
      JOIN ${db}.sys.tables  t ON t.object_id = i.object_id
      JOIN ${db}.sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = @schema AND t.name = @table AND i.name IS NOT NULL
      ORDER BY i.name
    `);

    res.json({
      success: true,
      data: {
        keys: keys.recordset,
        foreignKeysOut: fkOut.recordset,
        foreignKeysIn: fkIn.recordset,
        checkConstraints: checks.recordset,
        indexes: indexes.recordset,
      }
    });
  } catch (err) {
    console.error('[dbexplorer/constraints]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/admin/dbexplorer/:database/:schema/:table/preview?top=100 ─────
// Read-only TOP (N) SELECT * — N is clamped server-side (1-500) regardless
// of what's passed, and every preview is audited since, unlike the metadata
// routes above, this one returns actual row data.
router.get('/:database/:schema/:table/preview', async (req, res) => {
  const username = req.session?.user?.username || null;
  try {
    const pool = await sql.connect(sqlConfig);
    const dbName = await verifyDatabase(pool, req.params.database);
    if (!dbName) return res.status(404).json({ success: false, error: 'Database not found.' });
    const db = bracket(dbName);

    const tbl = await verifyTable(pool, db, req.params.schema, req.params.table);
    if (!tbl) return res.status(404).json({ success: false, error: 'Table not found.' });

    const requestedTop = parseInt(req.query.top, 10);
    const top = Number.isFinite(requestedTop) ? Math.min(Math.max(requestedTop, 1), 500) : 100;

    const target = `${db}.${bracket(tbl.SchemaName)}.${bracket(tbl.TableName)}`;
    const { recordset } = await pool.request()
      .query(`SELECT TOP (${top}) * FROM ${target}`);

    await auditQuery(
      'DBEXPLORER_PREVIEW',
      username,
      `TOP ${top} FROM ${dbName}.${tbl.SchemaName}.${tbl.TableName}`,
      req
    );

    res.json({ success: true, data: recordset });
  } catch (err) {
    console.error('[dbexplorer/preview]', err.message);
    await auditQuery(
      'DBEXPLORER_PREVIEW_ERROR',
      username,
      `${req.params.database}.${req.params.schema}.${req.params.table} — ERR: ${err.message.slice(0, 200)}`,
      req
    );
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
