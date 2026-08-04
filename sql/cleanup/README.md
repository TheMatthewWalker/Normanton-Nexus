# Production test-data cleanup scripts

One `preview_<process>.sql` / `execute_<process>.sql` pair per Production
Nexus process, for clearing pre-go-live test records the same way it was
done for Mixing (`prod.Mixing`, cleared up to `MixingID` 32 — see git
history / chat for that one-off run; it isn't reproduced here since it's
already done).

All scripts are **SQL Server 2005 compatible** (this database sits on the
same physical instance as the legacy `kongsberg` DB, which is why the whole
TLS-bridge side of this app exists). Concretely that means:
- no `DECLARE @x TYPE = value` inline initialization (2008+) — always a
  separate `DECLARE` then `SET`
- no `CONCAT()` (2012+) — string-build with `+` and `CAST(... AS NVARCHAR(10))`
- no `IIF`, `TRY_CONVERT`, table-valued parameters, etc.

## How to use, per table

1. Open `preview_<process>.sql`. Edit `@Cutoff` near the top to the first
   **real** (non-test) ID for that table's primary key — i.e. the same way
   `32` was chosen for Mixing: everything below that ID is test data.
   Every script refuses to run (`RAISERROR` + `RETURN`) while `@Cutoff` is
   still `NULL`, so you can't accidentally fire it with an unset cutoff.
2. Run the preview. It's read-only — counts only, no locks held beyond the
   query itself. Sanity-check the numbers, and look at the "unreversed
   successful SAP postings" query at the bottom — if real SAP material
   documents were posted during testing and never reversed there, deleting
   the local row here won't undo the SAP side.
3. Open `execute_<process>.sql`, set the same `@Cutoff` value, leave
   `@Commit = 0`, and run it. It performs the real deletes inside a
   transaction, prints exactly how many rows it removed from each table,
   then **rolls back** — nothing is persisted. Confirm the printed counts
   match the preview.
4. Only once that looks right, flip `@Commit` to `1` in the same script and
   run again to actually commit.

## What each script touches

Every process writes to five shared tables keyed by `ProcessCode` +
`ProcessRecordID` (or `Child`/`ParentProcessCode`/`RecordID` for
`prod.ProductionTrace`): `BatchOperators`, `ScrapEntries`, `SAPPostings`,
`EventLog`, `ProductionTrace`. None of these have real FK constraints back
to the process tables, but they're cleaned anyway so no orphaned test rows
are left behind. Every script also deletes from the process's own main
table last (or, for tables with a real FK-enforced child, deletes the
child first).

Process-code map (from `routes/productionnexus.js`'s `PROCESS` config —
note `Extrusion` is `EX`, **not** `EXT`; a `EXT`→`EX` code rename happened
in `migrate_production_v6.sql` and the old CHECK-constraint value is gone):

| Code | Table | PK | Notes |
|---|---|---|---|
| MX | `prod.Mixing` | `MixingID` | Already cleaned (cutoff 32). Child: `prod.MixingTubs` (real FK). |
| EX | `prod.Extrusion` | `ExtrusionID` | No child tables. |
| CO | `prod.Convoluting` | `ConvolutingID` | No child tables. |
| BR | `prod.Braiding` | `BraidingID` | No child tables. |
| CL | `prod.Coverline` | `CoverlineID` | No child tables. |
| TW | `prod.TapeWrap` | `TapeWrapID` | No child tables. |
| DR | `prod.Drumming` | `DrummingID` | Child: `prod.DrummingCoils` (real FK, `FK_DrummingCoils_DR`) — deleted first. |
| EW | `prod.Ewald` | `EwaldID` | Child: `prod.EwaldBoxes` (real FK). **Also**: `prod.Firewall.EwaldID` is a real FK into Ewald (`FK_Firewall_Ewald`) — any Firewall row inspecting a test Ewald batch is captured and removed (along with its own `FW`-coded generic-table rows) before the Ewald delete, regardless of that Firewall row's own `FirewallID`. |
| FW | `prod.Firewall` | `FirewallID` | Standalone script here cleans by Firewall's own ID range, for when Firewall test data needs clearing independently of Ewald (e.g. Firewall wasn't part of the same go-live wave). If you're clearing Ewald test data, use `execute_ewald.sql` — it already handles the Firewall dependency for you. |
| HA | `prod.HoseAssembly` | `HoseAssemblyID` | No child tables. `prod.HoseAssemblyQARouting` is a `Material`-keyed config table (which materials require QA), not per-batch data — deliberately **not** touched by any of these scripts. |

Not covered (not process/batch tables): `prod.Shifts`, `prod.WorkCentres`,
`prod.Machines`, `prod.ScrapReasons`, `prod.StatusCodes`,
`prod.HoseAssemblyQARouting`, `prod.vw_ActiveBatches` (a view).
