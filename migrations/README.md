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

Reference/lookup **data** (not schema) is seeded separately — see
`../seeds/README.md`.

## Using this against the live databases (before the new server exists)

`kongsberg_live` / `logistics_live` / `production_live` in `knexfile.cjs`
point at the actual live SQL Server 2005 box, using the exact same
server/login the running app itself already connects with (`config.json`'s
`sqlConfig`) — not a duplicate copy of that password in `.env`. They only
exist if `config.json` is present (git-ignored, same as `.env`), so they
silently don't appear on a checkout that hasn't set that up.

**Do not just run `npm run migrate:kongsberg_live` straight away.** The
existing `20260804120000_initial_schema.cjs` / `20260804160000_initial_schema.cjs`
migrations were extracted *from* the live databases — every table, default,
unique/check constraint, index, and FK they create already exists there
under the same name. Running them for real would fail on the very first
`ALTER TABLE ... ADD CONSTRAINT` (`There is already an object named
'DF_...'`), since only the `CREATE TABLE` statements have an `IF NOT EXISTS`
guard.

Instead, **baseline** each live database first — tell Knex the initial
migration is already applied, without ever executing its DDL, so future new
migrations layer on top cleanly:

```powershell
# 1. Hide the initial migration from Knex by renaming its extension so the
#    loader doesn't pick it up (repeat per db; filename differs for production).
Rename-Item migrations\kongsberg\20260804120000_initial_schema.cjs `
            migrations\kongsberg\20260804120000_initial_schema.cjs.bak

# 2. With no migration files visible, this only creates the (empty)
#    knex_migrations / knex_migrations_lock tracking tables -- no DDL
#    touches any real table.
npm run migrate:kongsberg_live

# 3. Confirm the tracking table's real column names before hand-writing the
#    INSERT (don't assume -- verify). Use the same user/password from
#    config.json's sqlConfig.
sqlcmd -S GATEWAYHO -U <user> -P <password> -d Kongsberg -Q "SELECT * FROM knex_migrations"

# 4. Record the initial migration as already applied (batch 1), matching
#    the exact filename Knex expects -- no DDL runs, this is a plain INSERT.
sqlcmd -S GATEWAYHO -U <user> -P <password> -d Kongsberg -Q "INSERT INTO knex_migrations (name, batch, migration_time) VALUES ('20260804120000_initial_schema.cjs', 1, GETUTCDATE())"

# 5. Put the migration file back.
Rename-Item migrations\kongsberg\20260804120000_initial_schema.cjs.bak `
            migrations\kongsberg\20260804120000_initial_schema.cjs

# 6. Confirm: should show the initial migration as already run, nothing pending.
npm run migrate:status:kongsberg_live
```

Repeat for `logistics_live` (same filename,
`20260804120000_initial_schema.cjs`) and `production_live`
(`20260804160000_initial_schema.cjs`).

After baselining, real schema work against live is:

```bash
npx knex migrate:make <description> --env kongsberg_live --knexfile knexfile.cjs
# edit the new file in migrations/kongsberg/, then:
npm run migrate:kongsberg_live
```

**Never run `npm run seed:*` against a `_live` environment** — the
`*_live` environments have no `seeds` config at all for exactly this reason;
seeding would `DELETE` and reinsert `PortalUsers`/`Vendor`/etc. with a stale
point-in-time snapshot, wiping real changes made since.

### `production_archive_live` is different — no baseline needed

Unlike the three above, `Production_Archive` was created **empty** on the
live server specifically for this migration, so there's nothing existing to
collide with — no renaming dance, no manually-inserted baseline row. Just:

```powershell
npm run migrate:production_archive_live
```

This runs the same 27 `CREATE TABLE` statements (no defaults/uniques/checks/
indexes/FKs — none of these legacy tables ever had any) that already ran
clean against the test server. **Schema only** — no data has been moved from
Kongsberg into these tables yet; that's a deliberately separate, much
higher-stakes step (~558,000 rows across the 27 tables, dominated by `Coils`
at ~190K) that hasn't been decided on yet (copy vs. move, when to delete the
Kongsberg originals if ever).

### The `datetime2` SQL Server 2005 incompatibility applies here too

Same issue as the other three live environments: Knex's default migration-
tracking table hardcodes a `datetime2` column (SQL Server 2008+ only), so
the very first `migrate:production_archive_live` run will fail unless the
tracking tables are pre-created with a compatible type first:

```powershell
sqlcmd -S GATEWAYHO -U <user> -P <password> -d Production_Archive -Q "CREATE TABLE knex_migrations (id INT IDENTITY(1,1) NOT NULL PRIMARY KEY, name NVARCHAR(255), batch INT, migration_time DATETIME); CREATE TABLE knex_migrations_lock ([index] INT IDENTITY(1,1) NOT NULL PRIMARY KEY, is_locked INT);"
```

Knex only auto-creates these if they don't already exist, so once they're
there with `DATETIME` instead of `DATETIME2`, `migrate:production_archive_live`
runs normally.
