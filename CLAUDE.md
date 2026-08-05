# CLAUDE.md — Normanton Nexus

## Project Overview

**Normanton Nexus** (npm package name `sql2005-bridge` — the project's original purpose before it grew into a full portal) is Kongsberg Automotive's internal web portal for the Normanton site. It started as a TLS bridge exposing a modern REST API in front of a legacy SQL Server 2005 database (Windows 11 dropped TLS 1.0/1.1 support, which SQL Server 2005 requires) and has since grown into the enterprise portal for production, logistics, warehouse, finance, sales, quality, engineering and management, plus a SAP integration via the separate `SapServer` service.

- **Runtime**: Node.js (ES Modules — `"type": "module"` in package.json)
- **Framework**: Express 5.x
- **Ports**: 443 (HTTPS, serves the app) + 80 (plain HTTP → 301 redirect to HTTPS). Requires `certs/key.pem` and `certs/cert.pem`.
- **Production deployment**: runs as a Windows Service named **"Normanton Nexus"** (via `node-windows`), not a foreground process.
- **Databases** (same SQL Server instance, `config.sqlConfig`): `kongsberg` (portal/auth/most business tables, default pool), `Production`, `Logistics` — see `getProductionPool()` / `getLogisticsPool()` in `config.js`.

---

## Running & Deploying

```bash
node server.js                    # dev/foreground run — binds 443 + 80 directly
```

Production runs as a Windows Service instead:

```bash
node install.cjs                  # registers + starts the "Normanton Nexus" service, configures SCM auto-recovery
node restart.cjs                  # manual stop→start, with identity-verified liveness checking (see below)
node uninstall.cjs                # unregisters the service
```

**Restart verification matters here.** `node-windows` stops a service via an emulated SIGINT, which is not always reliably delivered on Windows — a naive stop→start can leave the *old* process still bound to port 443 while a new one flashes up and dies. `restart.cjs` and `deploy-runner.cjs` both use `restart-lib.cjs`'s identity-aware checks (`GET /api/health` returns `{ pid, bootId, startedAt }` — `bootId` is a fresh UUID per process start) to confirm a restart actually replaced the running process, with a force-kill fallback if the graceful path doesn't work.

**Scheduled deploys**: superadmins can schedule a deploy (git pull + service restart) for a future date/time via `/api/deploy` (`routes/deploy.js`), for maintenance windows without anyone logging into the server. A `node-cron` job in `server.js` polls `kongsberg.dbo.ScheduledDeployments` every minute and hands due rows off to `deploy-runner.cjs`, launched via a **one-shot Task Scheduler task** (`schtasks /create` + `/run`), NOT a direct `child_process.spawn`. This matters: a plain `spawn(..., { detached: true })` was used here previously, but `detached` alone does not exempt a child from the "Normanton Nexus" service's WinSW-managed Job Object (kill-on-close) — when `deploy-runner.cjs` force-kills the OLD server.js process partway through its own restart, Windows can tear down that *whole* Job Object, including `deploy-runner.cjs` itself, before it ever reaches `svc.start()` again, leaving the service down with nothing left to notice or recover. A Task Scheduler task is launched by the Task Scheduler service instead — a separate process lineage — so it survives that (same reason SapServer itself runs via Task Scheduler rather than a Windows Service). `deploy-runner.cjs` writes its own log directly to `deploy-runner.log` (no inherited stdio to redirect from a Task Scheduler launch) and deletes its own one-shot task on every exit path. A second `node-cron` safety net every 5 minutes fails any deployment stuck at `'running'` for over 20 minutes, so a crash mid-restart can't pin the countdown banner forever. Once Normanton-Nexus itself is confirmed restarted and stable, `deploy-runner.cjs` also pulls + republishes + restarts the sibling **SapServer** repo (`SapServer/scripts/deploy.ps1`, since SapServer runs via a Task Scheduler task rather than a Windows Service — see that repo's `CLAUDE.md`), reusing the same `GitRef` — assumes SapServer is checked out on the same machine; skipped (not failed) if it isn't. `ScheduledAt` is a naive local-time SQL `DATETIME` compared directly against `GETDATE()` — it's written/read via hand-built date literals, never round-tripped through a JS `Date`, to avoid node-mssql's UTC conversion silently shifting the fire time.

`config.json` (git-ignored; copy from `config.example.json`) holds `sqlConfig`, `sessionSecret`, `printers`, and legacy `sapConfig`. A separate `.env` (copy from `.env.example`) holds secrets that must fail loudly if missing: `SAP_SERVER_SECRET`, `RESEND_API_KEY`, plus feature-scoped ones — `SAP_CRED_ENCRYPTION_KEY`, `KN_*` (Kuehne+Nagel), `CLEARPORT_API_*`, `LOGISTICS_IMPORT_ROOT` / `LOGISTICS_PO_ROOT` (UNC share paths).

## Testing

```bash
npm test    # node --experimental-vm-modules node_modules/jest/bin/jest.js
```

Jest, run under Node's native ESM support (`transform: {}` in `package.json`'s `jest` config — no Babel). `test/jest.globalSetup.js` auto-creates a throwaway `config.json` on first run if none exists (config.js/server.js read it synchronously at import time with no override hook — see that file's comment); `test/jest.setupEnv.js` sets dummy values for the env vars config.js requires (`SAP_SERVER_SECRET`, `RESEND_API_KEY`, `SAP_CRED_ENCRYPTION_KEY`). Neither ever touches a real developer config.

- `test/unit/` — pure logic (`middleware/auth.js`, `config.js`, `lib/sqlSessionStore.js`, `lib/notify.js`, `lib/sapCredentials.js` (AES-256-GCM round-trip + tamper detection — see `sapCredentials.badKey.test.js` for the encryption-key error paths, split into its own file since `config.js` caches the key at first import), `performancesql.js`'s demand-adjustment overlap rule, `productionschedulesql.js`'s working-day/OTIF-diff math, `consignmentsql.js` (transaction commit/rollback, FEFO/FIFO allocation), `performanceallocation.js`/`performanceforecast.js`/`performancevaluestream.js`/`performanceorderlink.js`/`performancesap.js` — small pure/near-pure modules tested directly rather than through a route) with `mssql` mocked via `test/helpers/mockPool.js`
- `test/routes/` — route handlers via `supertest` + `test/helpers/testApp.js` (stub session, no real express-session). `mssql` mocked via `test/helpers/mockPool.js` (a `Proxy`-based fallback fills in any SQL type tag not explicitly listed; `NVarChar`/`VarChar`/`Decimal`/`Int`/`Bit`/`BigInt`/`DateTime` are listed with stable values because at least one route compares a type tag by reference — add a new one here, not just wherever it's first needed, if you hit `sql.X is not a function` or a reference-equality mismatch). `mockPool.js` also provides `sql.Transaction` support (`transaction`/`Transaction` returned from `createMockSql()`, reset via `resetMockSql()`) for routes that batch writes atomically (`consignmentsql.js`, `shipmentmain.js`). Or the module's own DB-layer sibling mocked wholesale instead when a route delegates to one — see `test/routes/consignment.test.js`/`performance.test.js` (`*sql.js` DB-layer siblings), `test/routes/sap.test.js`/`freightbooking.test.js` (`axios`-proxied SAP/KN calls), and `freightbooking.test.js` again for wrapping real `fs`/`fs/promises` (mocking them outright breaks `config.js`'s own synchronous file read, which nearly every module pulls in transitively). `mockPool.js`'s shared `pool` object also backs `config.js`'s `getProductionPool()`/`getLogisticsPool()` (a different entry point — `sql.ConnectionPool(...).connect()` — than the more common `sql.connect(sqlConfig)`), so both land on the same mocked query queue.
- `test/integration/*.integration.test.js` — run against a **real** staging SQL Server (env-gated on `TEST_SQL_SERVER`/`TEST_SQL_DATABASE`/`TEST_SQL_USER`/`TEST_SQL_PASSWORD`; skip, not fail, when unset) — this is the only layer that can catch behavior differences from the SQL Server version migration (collation, rounding, whether the legacy `nvarchar`-as-date columns survived unchanged). See `test/helpers/stagingDb.js`.

**Coverage is now comprehensive** — essentially every route file has a dedicated `test/routes/*.test.js` (or is covered as part of a larger file's suite), and every non-trivial DB-layer/pure-logic module has a `test/unit/*.test.js`. Full suite: `npm test` (~840 tests, a handful skipped without staging-DB env vars). Rather than enumerate every file here (each test file's own header comment explains its scope and any deliberately-uncovered branches), the notable **remaining gaps**, all deliberately scoped down for cost/value reasons and documented in the relevant test file's header comment:
- `shipmentmain.js` — the actual SMTP send (a hand-rolled protocol implementation directly over `net`/`tls` sockets, no library — meaningful testing would need a full multi-line SMTP conversation simulator) and the ClearPort export/PDF-download success path (external API + multi-query transactional sync) are not covered; the validation/skip-condition logic around both is.
- `productionnexus.js` — `POST /drumming/stock` / `POST /drumming/customer` (the Make-to-Stock/Make-to-Order `submitDrumming()` path, a different and larger SAP call than the wizard's direct backflush covered in `productionnexus.drumming.test.js`) and the scrap-entry/parent-batch-trace-link branches within `/drumming/entry` itself.
- `performance.js` — `ComputeTurnsRows`-equivalent orchestration and the MRP order-suggestion **acceptance**/PO-creation flow beyond `GET /order-suggestions` itself (covered in `performance.orderSuggestions.test.js`, including a fully hand-verified forecast/breach-date/suggested-qty calculation).
- `labels.js` — the network-print/PDF-generation happy path itself (would need pdfkit/bwip-js/node:net all mocked at once for the formatting code, not the routing, it would actually be testing).

**Real bugs found while writing these tests** (flagged via a documenting test + comment, not silently fixed — a product/design call, not a testing one):
- `reports.js`: `Ewald`/`Mixing`/`Extrusion` report types have no `type` field set, and the response-shaping `switch` has no default case matching `undefined` — a request for any of those three hangs with no response ever sent.
- ~~`routes/sqlqueries.js` line 50: `POST /query-csv` referenced a bare `config` identifier that was never imported~~ — **fixed**: `config.js` now exports `apiKey` as a named export (alongside `sqlConfig`/`auditQuery`/etc.), and `sqlqueries.js` imports and uses it.
- `SapServer/Helpers/SapPad.cs`: XML doc claims mixed/alpha strings get space-padded; the implementation's non-digit branch just returns the value unchanged (SapServer's own `CLAUDE.md`/tests document this).
- `SapServer/Helpers/RfcRowHelpers.cs`'s `GetDecimal` (and the equivalent private `Dec()` duplicated in a few SapServer helpers): unconditionally strips every `.` before converting `,` to `.`, assuming SAP always sends European-grouped decimals (`"1.234,56"`). A plain invariant-culture value with no thousands separator (`"1234.56"`) has its decimal point stripped as a false grouping separator and parses as `123456` — silently 100x too large.

---

## Architecture

### Entry point (`server.js`)

- Express app with global rate limiting (500 req/min/IP), JSON/urlencoded body parsing, `trust proxy` enabled.
- **Sessions are SQL Server-backed** (`lib/sqlSessionStore.js`'s `SqlSessionStore`, persisted to `kongsberg.dbo.PortalSessions`) rather than express-session's default in-memory store — a service restart/deploy no longer silently logs everyone out. Requires `sql/migrate_portal_sessions.sql` to have been run.
- Cookie `maxAge` is a **per-user idle timeout**: 30 min default, 5 min for users flagged `ShortIdleTimeout` on `PortalUsers` (toggled in User Administration). `config.idleTimeoutMsFor()` computes it; a per-request middleware re-applies it every request so `rolling: true` refreshes to the *correct* duration.
- ~60 route modules are mounted under `/api/*`, almost all behind `requireLogin` (see `middleware/auth.js` below); a few (`/api/admin`, `/api/admin/dbexplorer`, `/api/deploy`) layer on role checks at mount time.
- Static/protected pages: `public/` is served unauthenticated (login page, 403 page); `private/*.html` (+ its `js/`, `css/`, `images/`) is served through explicit `GET /private/:page` handlers that check `requireLogin`, then a page→department mapping (`config.DEPT_PAGE_MAP`), or a hardcoded role for `admin.html` (admin). The raw-SQL console lives inside `admin.html`'s SQL Console section (`private/js/admin.js`'s `runSql()`/`setupSqlConsole()`), not a standalone page.
- **Scheduled jobs (`node-cron`)**, all defined in `server.js`, deliberately staggered to avoid clashing:
  | Schedule | Job | Purpose |
  |---|---|---|
  | `0,30 * * * *` | `runFullRefresh()` (`routes/performancesync.js`) | Performance data refresh, every 30 min |
  | `45 5 * * *` | `runTurnsValClassRefresh()` | Heavier MM Turns/Valuation Class pull, daily |
  | `55 * * * *` | `runSapSync()` (`routes/deliverymain.js`) | Warehouse SAP sync (open picksheets → DeliveryMain) |
  | `20 * * * *` | `sessionStore.cleanupExpired()` | Housekeeping — deletes expired `PortalSessions` rows |
  | `10 6 * * *` | `runProductionScheduleOtifDiff()` | Diffs `AgreementSnapshot` vs `OrderFulfillmentTracking` for OTIF tracking |
  | `20 6 * * *` | `runConsignmentSync()` | Vendor consignment GR + stock snapshot sync |
  | `* * * * *` | scheduled-deploy checker | Described above |
- Graceful shutdown handles `SIGINT`/`SIGTERM` explicitly (Windows Service stop emulates SIGINT unreliably) with an 8s force-exit fallback.

### Route modules (`routes/`)

Roughly organized by business domain — logistics/shipping (`shipmentmain`, `shipmentcost`, `deliverymain`, `deliverylink`, `deliveryroutes`, `palletmain`, `palletpackages`, `rateskn`, `ratestpn`, `forwarders`, `forwarderapproval`, `forwardermodemapping`, `freightbooking`, `clearportexport`, `destinations`, `incoterms`, `inboundcosts`, `assignmenttpn`), production (`production`, `productionnexus`, `mixing`, `productionschedule` + its `*sql.js` counterparts, `labels`), consignment/customs (`consignment`, `consignmentsql`), department pages (`quality`, `finance`, `sales`, `packaging`), plus cross-cutting concerns (`reports`, `exportxlsx`, `notifications`, `performance`/`performancesql`/`performancesync`/`performanceforecast`/etc., `staging`/`stagingsql`, `sqlqueries`, `sap`, `gemini`, `profile`, `relatedrecords`, `filterrecords`).

Several of the largest files (`productionnexus.js`, `shipmentmain.js`, `performance.js`, `performancesql.js`) are large, actively-evolving modules covering many related endpoints for one feature area rather than a single small route — check the file's own header comments before assuming a small, isolated change is safe.

Admin/superadmin-only: `useradmin.js` (user approval, role/department/permission assignment), `dbexplorer.js` (SSMS-lite schema/data browser, superadmin only), `deploy.js` (scheduled deploys, superadmin-managed).

### Auth & permission modules (`middleware/auth.js`)

Three-tier role hierarchy — **not** the four-tier viewer/editor/admin/superadmin scheme from earlier in the project's history; that was collapsed by `sql/migrate_permissions.sql`:

| Role | Level | Notes |
|---|---|---|
| operator | 1 | Basic site access (former viewer/editor/supervisor/management roles were all collapsed into this) |
| admin | 2 | Approve users, assign departments & permissions; cannot promote to admin/superadmin |
| superadmin | 3 | Everything — raw SQL, edit usernames, promote/demote admins, bypasses all department checks |

Fine-grained access beyond role is now **department + permission code** based, not baked into the role itself:

- `requireLogin` — any authenticated user (401 JSON for API routes, redirect to `/` for pages)
- `requireRole(minRole)` — role-level gate; superadmin always passes
- `requireDepartment(dept)` / `requireAnyDepartment([...])` — user must hold that department (or any of the given departments) on `PortalUserDepartments`; superadmin bypasses
- `requirePermission(code)` / `requireAnyPermission([...])` — user must hold a specific permission code from `dbo.PortalPermissions`/`dbo.PortalUserPermissions` (e.g. `PROD_SUPERVISOR`, `LOG_PLANNING`) — for actions narrower than a whole department (approvals, supervisor-only edits); superadmin bypasses. New permission codes are added via their own `sql/migrate_*_permission.sql` file — check those for the current full list rather than assuming this doc has it.
- `requireSessionOrApiToken` — accepts either the normal session cookie **or** a short-lived JWT bearer token (signed with `sapServerSecret`, issuer `kongsberg-portal`), for the one route (`routes/performance.js`'s Month End Breakdown upload) that's called from an Excel macro with no cookie jar. The macro authenticates once via `POST /api/auth/orderbook-token`.

### Database conventions

- All routes use parameterized queries via `mssql` (`pool.request().input(...).query(...)`) — never string-interpolate user input.
- **Date handling**: legacy tables store dates as `nvarchar` in `"dd.mm.yy hh:mm:ss"` format; use `CONVERT(datetime, col, 4)` for comparisons. Newer tables (sessions, permissions, scheduled deployments, etc.) use real `DATETIME` columns.
- `config.stampDbChange(username, tableName)` — fire-and-forget helper that backfills the portal username onto the row a SQL trigger just wrote to `dbo.DataChangeLog` (the trigger only knows the SQL login, `SYSTEM_USER`, not the portal user). Call immediately after any INSERT/UPDATE/DELETE you want attributed.
- `config.auditQuery(eventType, username, detail, req)` — fire-and-forget insert into `kongsberg.dbo.PortalAuditLog`.
- `lib/notify.js`'s `notify(pool, { title, body, severity, category, actionLabel, actionURL, target })` creates an in-app notification fanned out to matching users. `target.type` is one of `user` / `department` / `permission` / `role` / `all`.

---

## SAP Integration

Two related but distinct SAP paths:

1. **`routes/sap.js`** and the legacy `sapConfig` — direct integration used by older routes.
2. **`SapServer`** (sibling repo/service, see its own `CLAUDE.md`) — an ASP.NET Core RFC bridge. Normanton Nexus issues it a short-lived JWT (shared HMAC secret, `SAP_SERVER_SECRET`/`sapServerSecret`) so the frontend can call SAP RFC functions authenticated through the same accounts this app already manages. SapServer checks `dbo.SapDepartmentPermissions` for department-level RFC authorization.
3. **Elevated per-user SAP credentials** (`lib/sapCredentials.js`) — some operations (PO creation + goods receipt) must run under the *real* user's own SAP authorization rather than the shared service account. Each user's own SAP username/password is encrypted at rest (AES-256-GCM, `SAP_CRED_ENCRYPTION_KEY`) in `PortalUsers.SapUsername`/`SapPasswordEncrypted` and decrypted here — SapServer can't reach this SQL Server 2005-hosted table itself over TLS, so decryption has to happen on this side and be handed across.

---

## Other External Integrations

| Integration | Where | Purpose |
|---|---|---|
| Kuehne+Nagel (KN) Freight Booking API | `routes/freightbooking.js` | OAuth client-credentials (`KN_SECRET_64`) booking + shipment document management |
| ClearPort | `routes/clearportexport.js` | Customs declaration export (bearer token, `CLEARPORT_API_TOKEN`) |
| Resend | `RESEND_API_KEY` | Transactional email |
| Gemini | `routes/gemini.js` | Rate-limited (20 req/15min) AI query endpoint, audited like other sensitive actions |
| Label printers | `routes/labels.js`, `config.printersConfig` | Network printers (host/port/paperSize) for production/mixing label printing |
| PDF generation | `lib/poPdf.js`, `lib/consignmentDeclarationPdf.js` | Purchase order PDFs (written to `LOGISTICS_PO_ROOT`), consignment declaration PDFs |

---

## Key Patterns

- **ES Modules throughout** — `import`/`export`, not `require` (except the `.cjs` deployment/service scripts, which run outside the app process: `install.cjs`, `uninstall.cjs`, `restart.cjs`, `restart-lib.cjs`, `deploy-runner.cjs`)
- **All routes** export a default `Router` instance
- **Error handling**: try/catch in every route handler, `res.status(500).json({ error: err.message })`; no stack traces exposed in HTTP responses
- **Rate limiting**: global 500 req/min/IP, plus tighter per-route limits on sensitive/expensive endpoints (login, Gemini)
- **Bcrypt cost factor**: 12
- **Audit logging and DB-change stamping are always fire-and-forget** — failures must never crash or block the request they're attached to

---

## Further reading

- `README.md` — original problem statement/background for the TLS-bridge origins of this project
- `APP_GUIDE.md` — user-facing guide to departments, roles, and modules (production, logistics, warehouse, etc.) — the source of truth for *what the app does*, as opposed to this file's *how it's built*
