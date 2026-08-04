# Knex seeds — reference/lookup data

Separate from `migrations/` on purpose: migrations are schema changes,
tracked in `knex_migrations` and run exactly once each. Seeds are data
loaders — not tracked, safe to re-run, and never applied automatically by
`migrate:latest`. Run them explicitly, after the matching migration:

```bash
npm run migrate:kongsberg  && npm run seed:kongsberg
npm run migrate:logistics  && npm run seed:logistics
npm run migrate:production && npm run seed:production
```

(or `npx knex seed:run --env <db> --knexfile knexfile.cjs` directly).

## What's seeded, and why

This is **not** a full data migration — only reference/lookup tables, small
master data, and login accounts. Everything else (transactional and
historical data — snapshots, waste/scrap logs, audit logs, `Coils`,
`StockValuationHistory`, etc.) is deliberately excluded; a real production
cutover needs a proper data migration plan, not this.

- **Kongsberg** (15 tables, 748 rows): `FinanceGlGroups`,
  `FinanceGlGroupAccounts`, `ForwarderModeMapping`, `MaterialGroupMapping`,
  `ValuationClassCatalog`, `ScrapReasons`, `PortalPermissions` (config/lookup
  tables); `Vendor`, `VendorMaterial`, `ConsignmentCustomer`,
  `ConsignmentVendorConfig`, `CustomerStandardInstructions` (small
  vendor/customer master data); `PortalUsers`, `PortalUserDepartments`,
  `PortalUserPermissions` (the actual login accounts — password hashes carry
  over as bcrypt, not plaintext; SAP credentials carry over AES-encrypted,
  same as they're stored live).
  **`seeds/kongsberg/001_reference_data.cjs` is deliberately not committed**
  (see `.gitignore`) — it contains real bcrypt password hashes,
  AES-encrypted SAP credentials, and staff PII for every `PortalUsers` row.
  It exists locally (already run against the new server as of 2026-08-04)
  but needs a deliberate decision — private repo confirmed safe, split the
  sensitive tables into their own file, etc. — before it goes into source
  control.
- **Logistics** (11 tables, 2067 rows): `CostTypes`, `CostElements`,
  `CostCenters`, `Incoterms`, `PackagingData`, `PalletData`,
  `DeliveryRoutes`, `Destinations`, `Forwarders`, `RatesKN`, `RatesTPN`.
  (`Incoterms` and `RatesTPN` were empty in the source — nothing to seed for
  those two, the seed file just deletes-and-reinserts zero rows.)
- **Production** (5 tables, 218 rows): `StatusCodes`, `WorkCentres`,
  `Machines`, `Shifts`, `ScrapReasons`.

## How the seed files were generated

`sql/generate_seed_data_script.sql` (run via the admin.html SQL Console, same
workflow as the schema extraction scripts) pulled every row from the 31
tables above, with `DATETIME` columns pre-`CONVERT`ed to a fixed string
format so they survive the CSV round-trip cleanly. The CSV exports were then
turned into these seed files with type-aware value formatting per column
(strings `N'...'`-escaped, `BIT` normalized to `1`/`0`, `DATETIME` as a plain
quoted literal, everything else raw) — column types came from the DDL
already captured for the schema migrations, not re-derived by guesswork.

Each seed file `DELETE`s all 31 tables in reverse FK-dependency order, then
`INSERT`s the real rows back in forward order (batched at 500 rows per
statement — SQL Server's practical limit is 1000 per `VALUES` list),
wrapping `SET IDENTITY_INSERT ... ON/OFF` around the 12 tables with an
identity primary key so cross-references (e.g. `VendorMaterial.VendorId` →
`Vendor.VendorId`) still point at the right row after reload. This makes
re-running a seed safe — it always leaves the table in the same state
regardless of how many times it's run.
