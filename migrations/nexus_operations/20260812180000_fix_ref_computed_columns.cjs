'use strict';
// Fixes a real, unrelated bug surfaced while investigating a "BraidRef
// missing on BraidingID 5" report: every process's *Ref column
// (MixRef/ExtRef/ConvRef/BraidRef/CovRef/TWRef/DrumRef/EwaldRef/FWRef —
// HARef was unaffected, see below) is supposed to be a computed, PERSISTED
// column derived from the record's own identity column (e.g. BraidRef =
// 'BR' + BraidingID zero-padded to 8 digits — sql/migrate_production_v6.sql
// lines 78-176 has the original, correct formula for every one of these).
//
// sql/generate_production_schema_script.sql's CREATE-TABLE generator builds
// column definitions from sys.columns/sys.types only and never checks
// sys.computed_columns, so when it extracted the live schema to seed
// migrations/nexus_operations/20260804120000_initial_schema.cjs (the
// migration that created NexusOperations fresh around 2026-08-10), it
// silently dropped every one of these computed formulas and emitted plain
// nullable NVARCHAR(10) columns instead. Nothing in application code has
// ever written to these columns (they were always meant to populate
// themselves) — so every row inserted since NexusOperations went live has
// had a NULL *Ref, and since each column also has a UNIQUE index
// (UQ_Braiding_BraidRef etc.) which SQL Server treats as allowing only ONE
// NULL, only the very first row of each process silently "worked" before
// every subsequent insert would have started throwing a unique-constraint
// violation.
//
// Every statement below is individually guarded in SQL (COL_LENGTH/
// COLUMNPROPERTY/sys.indexes checks — same convention as every other
// migration in this project, e.g. 20260805134845_billet_staging.cjs), so
// the whole migration is idempotent and safe to run against an environment
// that's already correct (e.g. a fresh copy seeded from the original,
// uncorrupted sql/create_production_database.sql) — nothing here branches
// in JS on a query result. Re-adding each column AS (...) PERSISTED
// automatically recomputes and backfills every existing row, including the
// one(s) currently sitting at NULL — no manual UPDATE needed. See
// sql/generate_production_schema_script.sql for the separate fix to the
// generator itself, so a future schema extraction doesn't reintroduce this.

const REF_COLUMNS = [
  { table: 'Mixing',       idCol: 'MixingID',       col: 'MixRef',   prefix: 'MX', indexes: [
      { name: 'IX_Mixing_CreatedAt', def: "CREATE NONCLUSTERED INDEX IX_Mixing_CreatedAt ON prod.Mixing (CreatedAt) INCLUDE (Material, Status, MixRef)" },
      { name: 'IX_Mixing_Status',    def: "CREATE NONCLUSTERED INDEX IX_Mixing_Status ON prod.Mixing (Status) INCLUDE (Material, CreatedAt, MixRef)" },
      { name: 'UQ_Mixing_MixRef',    def: "CREATE UNIQUE NONCLUSTERED INDEX UQ_Mixing_MixRef ON prod.Mixing (MixRef)" },
  ] },
  { table: 'Extrusion',    idCol: 'ExtrusionID',    col: 'ExtRef',   prefix: 'EX', indexes: [
      { name: 'IX_Extrusion_CreatedAt', def: "CREATE NONCLUSTERED INDEX IX_Extrusion_CreatedAt ON prod.Extrusion (CreatedAt) INCLUDE (Material, Status, ExtRef)" },
      { name: 'IX_Extrusion_Status',    def: "CREATE NONCLUSTERED INDEX IX_Extrusion_Status ON prod.Extrusion (Status) INCLUDE (Material, CreatedAt, ExtRef)" },
      { name: 'UQ_Extrusion_ExtRef',    def: "CREATE UNIQUE NONCLUSTERED INDEX UQ_Extrusion_ExtRef ON prod.Extrusion (ExtRef)" },
  ] },
  { table: 'Convoluting',  idCol: 'ConvolutingID',  col: 'ConvRef',  prefix: 'CO', indexes: [
      { name: 'IX_Convo_CreatedAt', def: "CREATE NONCLUSTERED INDEX IX_Convo_CreatedAt ON prod.Convoluting (CreatedAt) INCLUDE (Material, Status, ConvRef)" },
      { name: 'IX_Convo_Status',    def: "CREATE NONCLUSTERED INDEX IX_Convo_Status ON prod.Convoluting (Status) INCLUDE (Material, CreatedAt, ConvRef)" },
      { name: 'UQ_Convo_ConvRef',   def: "CREATE UNIQUE NONCLUSTERED INDEX UQ_Convo_ConvRef ON prod.Convoluting (ConvRef)" },
  ] },
  { table: 'Braiding',     idCol: 'BraidingID',     col: 'BraidRef', prefix: 'BR', indexes: [
      { name: 'IX_Braiding_CreatedAt', def: "CREATE NONCLUSTERED INDEX IX_Braiding_CreatedAt ON prod.Braiding (CreatedAt) INCLUDE (Material, Status, BraidRef)" },
      { name: 'IX_Braiding_Status',    def: "CREATE NONCLUSTERED INDEX IX_Braiding_Status ON prod.Braiding (Status) INCLUDE (Material, CreatedAt, BraidRef)" },
      { name: 'UQ_Braiding_BraidRef',  def: "CREATE UNIQUE NONCLUSTERED INDEX UQ_Braiding_BraidRef ON prod.Braiding (BraidRef)" },
  ] },
  { table: 'Coverline',    idCol: 'CoverlineID',    col: 'CovRef',   prefix: 'CL', indexes: [
      { name: 'IX_Coverline_CreatedAt', def: "CREATE NONCLUSTERED INDEX IX_Coverline_CreatedAt ON prod.Coverline (CreatedAt) INCLUDE (Material, Status, CovRef)" },
      { name: 'IX_Coverline_Status',    def: "CREATE NONCLUSTERED INDEX IX_Coverline_Status ON prod.Coverline (Status) INCLUDE (Material, CreatedAt, CovRef)" },
      { name: 'UQ_Coverline_CovRef',    def: "CREATE UNIQUE NONCLUSTERED INDEX UQ_Coverline_CovRef ON prod.Coverline (CovRef)" },
  ] },
  { table: 'TapeWrap',     idCol: 'TapeWrapID',     col: 'TWRef',    prefix: 'TW', indexes: [
      { name: 'IX_TapeWrap_CreatedAt', def: "CREATE NONCLUSTERED INDEX IX_TapeWrap_CreatedAt ON prod.TapeWrap (CreatedAt) INCLUDE (Material, Status, TWRef)" },
      { name: 'IX_TapeWrap_Status',    def: "CREATE NONCLUSTERED INDEX IX_TapeWrap_Status ON prod.TapeWrap (Status) INCLUDE (Material, CreatedAt, TWRef)" },
      { name: 'UQ_TapeWrap_TWRef',     def: "CREATE UNIQUE NONCLUSTERED INDEX UQ_TapeWrap_TWRef ON prod.TapeWrap (TWRef)" },
  ] },
  { table: 'Drumming',     idCol: 'DrummingID',     col: 'DrumRef',  prefix: 'DR', indexes: [
      { name: 'IX_Drumming_CreatedAt',  def: "CREATE NONCLUSTERED INDEX IX_Drumming_CreatedAt ON prod.Drumming (CreatedAt) INCLUDE (Material, Status, DrumRef)" },
      { name: 'IX_Drumming_SalesOrder', def: "CREATE NONCLUSTERED INDEX IX_Drumming_SalesOrder ON prod.Drumming (SalesOrderSAP) INCLUDE (Material, Status, DrumRef)" },
      { name: 'IX_Drumming_Status',     def: "CREATE NONCLUSTERED INDEX IX_Drumming_Status ON prod.Drumming (Status) INCLUDE (Material, CreatedAt, DrumRef)" },
      { name: 'UQ_Drumming_DrumRef',    def: "CREATE UNIQUE NONCLUSTERED INDEX UQ_Drumming_DrumRef ON prod.Drumming (DrumRef)" },
  ] },
  { table: 'Ewald',        idCol: 'EwaldID',        col: 'EwaldRef', prefix: 'EW', indexes: [
      { name: 'IX_Ewald_CreatedAt', def: "CREATE NONCLUSTERED INDEX IX_Ewald_CreatedAt ON prod.Ewald (CreatedAt) INCLUDE (Material, Status, EwaldRef)" },
      { name: 'IX_Ewald_Status',    def: "CREATE NONCLUSTERED INDEX IX_Ewald_Status ON prod.Ewald (Status) INCLUDE (Material, CreatedAt, EwaldRef)" },
      { name: 'UQ_Ewald_EwaldRef',  def: "CREATE UNIQUE NONCLUSTERED INDEX UQ_Ewald_EwaldRef ON prod.Ewald (EwaldRef)" },
  ] },
  { table: 'Firewall',     idCol: 'FirewallID',     col: 'FWRef',    prefix: 'FW', indexes: [
      { name: 'UQ_Firewall_FWRef', def: "CREATE UNIQUE NONCLUSTERED INDEX UQ_Firewall_FWRef ON prod.Firewall (FWRef)" },
  ] },
  // HoseAssembly's HARef was confirmed still correctly computed on the live
  // server (only BraidRef was reported/checked) — included here anyway,
  // guarded by the same IsComputed check, so this migration is a complete,
  // safe fix regardless of which columns actually drifted.
  { table: 'HoseAssembly', idCol: 'HoseAssemblyID', col: 'HARef',    prefix: 'HA', indexes: [
      { name: 'IX_HA_CreatedAt', def: "CREATE NONCLUSTERED INDEX IX_HA_CreatedAt ON prod.HoseAssembly (CreatedAt) INCLUDE (Material, Status, HARef)" },
      { name: 'IX_HA_Status',    def: "CREATE NONCLUSTERED INDEX IX_HA_Status ON prod.HoseAssembly (Status) INCLUDE (Material, CreatedAt, HARef)" },
      { name: 'UQ_HA_HARef',     def: "CREATE UNIQUE NONCLUSTERED INDEX UQ_HA_HARef ON prod.HoseAssembly (HARef)" },
  ] },
];

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
  for (const { table, idCol, col, prefix, indexes } of REF_COLUMNS) {
    const full = `prod.${table}`;

    // Every statement below is self-guarding (COL_LENGTH/COLUMNPROPERTY/
    // sys.indexes checks) — dropping an index that's already gone, or
    // re-adding a column that's already computed, is a no-op rather than
    // an error. Nothing branches in JS on a query result, deliberately —
    // see the file header for why.
    for (const idx of indexes) {
      await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${idx.name}' AND object_id = OBJECT_ID('${full}'))
DROP INDEX ${idx.name} ON ${full}`);
    }

    await knex.raw(`
IF COL_LENGTH('${full}', '${col}') IS NOT NULL AND COLUMNPROPERTY(OBJECT_ID(N'${full}'), N'${col}', 'IsComputed') = 0
ALTER TABLE ${full} DROP COLUMN ${col}`);

    await knex.raw(`
IF COL_LENGTH('${full}', '${col}') IS NULL
ALTER TABLE ${full} ADD ${col} AS (CAST(N'${prefix}' + RIGHT('00000000' + CAST(${idCol} AS VARCHAR(8)), 8) AS NVARCHAR(10))) PERSISTED`);

    for (const idx of indexes) {
      await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${idx.name}' AND object_id = OBJECT_ID('${full}'))
${idx.def}`);
    }
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function () {
  // Deliberately a no-op — "reversing" this migration would mean
  // re-breaking every *Ref column back into a non-computed, never-populated
  // NULL column, which is never something you'd actually want. This is a
  // one-way data-integrity fix, not a reversible schema change.
};
