# Knex migrations

One subfolder per database (`kongsberg/`, `production/`, `logistics/`,
`production_archive/`), each tracked independently via its own
`knex_migrations` table — see `knexfile.cjs` for connection config and the
`--env` convention.

Run with:

```bash
npm run migrate:kongsberg
npm run migrate:production
npm run migrate:logistics
npm run migrate:production_archive
```

(or `npx knex migrate:latest --env <name> --knexfile knexfile.cjs` directly,
and `migrate:rollback` / `migrate:status` work the same way).

## Status

- **Kongsberg** / **Logistics**: each has one `20260804120000_initial_schema.cjs`,
  generated from a live extraction (`sql/generate_schema_script.sql`, run via
  the admin.html SQL Console on 2026-08-04) — every base table, DEFAULT/
  UNIQUE/CHECK constraint, non-PK index, and foreign key, reproduced via
  `knex.raw()` calls in dependency order (tables → defaults → uniques →
  checks → indexes → FKs). Schema only, no data — reference/lookup data
  seeding is a separate, later migration once that's been decided per table.
  Deliberately excluded from both:
  - `sp_alterdiagram`/`sp_creatediagram`/etc. (Kongsberg's 7 stored procs) —
    SSMS's own "Database Diagrams" plumbing, auto-created boilerplate, not
    application logic. Not reproduced anywhere.
  - Neither database had any views or triggers to reproduce.
  - Kongsberg's ~27 legacy per-process production-tracking tables (see
    `production_archive` below) — split out, not part of this migration.
  - A `Logistics.dbo.PortalPermissions` table was flagged for exclusion as a
    stale pre-cross-database-query-convention leftover, but the live
    extraction found no such table in Logistics — nothing to exclude there.
- **`production_archive`** (new database): the ~27 tables split out of
  Kongsberg — `Mixing`/`Extrusion`/`Convo`/`Ewald`/`Firewall` and their
  `*Waste`/`*Messages`/`*Trace`/etc. siblings, plus `Batches`, `Coils`,
  `Waste`, `Trace`, `archive`, `test`, `Emails` — legacy per-process
  production tracking that predates Production Nexus, kept for historical
  reference only. The 6 `Portal*` tables (`PortalUsers`, `PortalSessions`,
  `PortalPermissions`, `PortalUserDepartments`, `PortalUserPermissions`,
  `PortalAuditLog`) stay in Kongsberg proper — those are live auth/session
  infrastructure, not legacy production data, despite sharing a similar
  row-count range in the raw extraction. None of the archived tables have
  foreign keys to or from anything outside the archive set, so the split is
  clean — no cross-database references to work around.
- **Production**: has one `20260804160000_initial_schema.cjs`, generated the
  same way as Kongsberg/Logistics but from a dedicated
  `sql/generate_production_schema_script.sql` (single-database version of
  the same extraction, since Production wasn't covered by the original
  script) — 26 `prod.*` tables (the current Production Nexus schema:
  `Braiding`/`Convoluting`/`Coverline`/`Drumming`/`Ewald`/`Extrusion`/
  `Firewall`/`HoseAssembly`/`Mixing`/`TapeWrap` plus the 5 shared tables
  each process writes to — `BatchOperators`, `ScrapEntries`, `SAPPostings`,
  `EventLog`, `ProductionTrace` — see `sql/cleanup/README.md`). Not the same
  tables as `production_archive` — those are the legacy pre-Production-Nexus
  tables that lived in Kongsberg, unrelated to this schema.
  `prod.vw_ActiveBatches` (a view) and the `trg_EwaldBoxes_SyncTotals`
  trigger on `prod.EwaldBoxes` both came back from the live extraction with
  empty `OBJECT_DEFINITION()` text — `WITH ENCRYPTION` on the source server
  blocks reading a definition back out that way. Both are still included in
  the migration, reconstructed instead from the last known unencrypted
  source: `sql/create_production_database.sql` (original `CREATE TRIGGER` —
  never altered again anywhere in `sql/*.sql`) and `sql/migrate_production_v6.sql`
  (a later `ALTER VIEW` that supersedes the view's original definition in
  `create_production_database.sql` — column shape cross-checked against
  `sql/production_schema.csv`'s live column dump, exact match, 11 columns).
  Neither tracked source ever included `WITH ENCRYPTION`, so that must have
  been added later directly via SSMS, outside any committed script — there's
  a small chance of an undocumented logic change alongside that step that
  this reconstruction can't capture. Recreated unencrypted on the new server
  on purpose. No stored procedures existed to extract.

Once all four have an initial migration, every *new* schema change goes
through `npx knex migrate:make <description> --env <db> --knexfile knexfile.cjs`
instead of a new hand-written `sql/migrate_*.sql` file — this is what
replaces that ad-hoc convention going forward.
