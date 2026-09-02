# CLAUDE.md (dotnet/)

Guidance for working in this subtree — the ASP.NET Core 10 rewrite of Normanton-Nexus, developed on the `dotnet-rewrite` branch alongside the live Node.js app at the repo root. See the repo root `CLAUDE.md` for the Node app; this file only covers `dotnet/`. The full migration plan (context, phased rollout, authorization redesign) lives in this session's plan file and should be re-derived/re-documented here as each phase lands, mirroring how `/home/user/SapServer/CLAUDE.md` documents that sibling rebuild.

## Status

**Phase 0 (Scaffold) done. Phase 1 (Foundation) done. Phase 2 (Engineering) done. Phase 3 (Quality) done.** Phase 4 (Sales) is next.

**Real, confirmed verification** (not just "it compiles"): `dotnet run` in Development — which enables ASP.NET Core's strictest DI validation (`ValidateOnBuild`/`ValidateScopes`) — boots clean with no DI graph errors across every service registered so far, including Quality's SSE-streaming bulk endpoint and its dynamic per-direction `IAuthorizationService` check. Real HTTP requests confirmed: `GET /Login` → 200 with correctly rendered HTML; unauthenticated department Razor Pages → 302 to `/Login?ReturnUrl=...`; unauthenticated `[ApiController]` JSON endpoints → 401 (not a redirect — matters, since `session-guard.js` keys off exactly that distinction); unmatched route → clean 404; `GET /health` → 200. This confirms the whole auth/routing/authorization pipeline wiring is real and working, not just type-checked.

**Not yet verified anywhere in this migration** (no live SQL Server or SapServer reachable in this sandbox): an actual login round-trip, session persistence across a simulated restart, either idle-timeout variant firing end-to-end, any real SapServerClient call, any real Dapper query. Same caveat class as SapServer's own repeated "confirmed for real in production" callouts — none of this has had that pass yet. Manual click-through of every department is likewise still pending for the same reason.

## Phase 1: Foundation

- Three Dapper connection factories (`Services/Sql/`) — `INexusDb`/`INexusOperationsDb`/`INexusArchiveDb`, each just a captured connection string, safe as singletons.
- EF Core migrations (`Data/Migrations/`, tooling-only — see `Data/NexusMigrationContext.cs`): `EnsureCoreSchema` idempotently creates `PortalUsers`/`PortalUserDepartments`/`PortalPermissions`/`PortalUserPermissions`/`PortalSessions`/`PortalAuditLog` if missing (guarded, safe to run against a DB the Node app's knex migrations already touched); `AddPermissionGroups` adds the new `PortalPermissionGroups`/`PortalPermissionGroupPermissions`/`PortalUserPermissionGroups` tables (see the plan's "Authorization model"). Verified with `dotnet ef migrations script` — real `dotnet ef database update` against a real SQL Server is still unverified.
- Cookie authentication with a SQL-backed `ITicketStore` (`Services/Auth/PortalSessionStore.cs`) — the direct analog of `lib/sqlSessionStore.js`, reusing the same `PortalSessions` table shape (not the same row *format* — this app's `SessionData` holds a serialized `AuthenticationTicket`, not Node's JSON session blob; users re-log-in once at cutover regardless, per the plan). Cookie `SecurePolicy` is `Always` only in Production — `SameAsRequest` everywhere else, so a plain `dotnet run` + `http://localhost` smoke test actually gets the cookie back (fixed after the `Always`-everywhere default silently broke local-HTTP session persistence).
- Per-user variable idle timeout (`Services/Auth/IdleTimeoutPolicy.cs` + `IdleTimeoutValidation.cs`) — 30 min default / 5 min `ShortIdleTimeout`, matching `config.js`'s `idleTimeoutMsFor` exactly, applied every request via `CookieAuthenticationEvents.OnValidatePrincipal` (the C# equivalent of `server.js`'s per-request `cookie.maxAge` reset under `rolling:true`).
- Login flow (`Pages/Login.cshtml(.cs)` + `Services/Auth/AuthService.cs`) — faithful port of `routes/auth.js`'s `POST /login`: hardcoded-hash dummy bcrypt compare for unknown usernames, lockout at 10 failed attempts (permanent, admin-unlock only — matches `useradmin.js`, no time-based auto-unlock), IP-partitioned rate limiting (10/15 min, matching `express-rate-limit`), a fresh session key on every successful login (session-fixation defense — no explicit `regenerate()` call needed, since `PortalSessionStore.StoreAsync` always mints a new key).
- `MustChangePassword` enforcement (`Services/Auth/MustChangePasswordPageFilter.cs` + `Pages/ChangePassword.cshtml(.cs)`) — global `IAsyncPageFilter` (registered via `AddMvcOptions` so it only ever runs for Razor Page requests, never `[ApiController]`/static assets) redirecting to a real dedicated page instead of Node's `landing.js` blocking modal. Re-signs-in with the claim dropped on success so the live session updates immediately, not just the DB row.
- Role (`operator`<`admin`<`superadmin`, superadmin bypasses) + department + the new per-tile-permission authorization gates, all independent (never ANDed on one route, matching `middleware/auth.js`) — `Services/Auth/AuthorizationRequirements.cs` + `NexusPolicyProvider.cs` lets a controller write `[Authorize(Policy = "Perm:WAREHOUSE_STOCK_ADJUST")]` / `"Dept:warehouse"` / `"Role:admin"` without pre-registering every policy name at startup.
- `Services/Auth/PermissionResolver.cs` — effective permission set = direct `PortalUserPermissions` grants UNION every group's permissions via `PortalUserPermissionGroups`/`PortalPermissionGroupPermissions`, computed once at login and baked into the ticket as claims (cheap since the ticket lives server-side in SQL, not the browser cookie — no cookie-size ceiling on permission count as tile-level codes accumulate).
- `Pages/Admin/PermissionGroups*` — minimal (not the full Phase 9 UI) group create/list/manage screen, `Role:admin` gated.
- `Models/ApiResponse.cs` + `NexusExceptions.cs` + `Middleware/ApiExceptionMiddleware.cs` — the `{success,data,error}` envelope every department `[ApiController]` returns, mapped from a small exception hierarchy (C# analog of SapServer's `ApiResponse<T>`/`SapExceptionMapper`). Scoped to `/api/*` only — Razor Page requests still go through the normal HTML error page.
- `Services/SapServerClient.cs` — typed `HttpClient` wrapper matching `sap.js`'s `makeSapToken`/axios pattern (shared-secret JWT: `{userId}`, issuer `normanton-nexus`, audience `sap-server`, 60s expiry). Originally planned for the Quality phase, built here once Engineering turned out to need it first. TLS pinning (`sap.js`'s `certs/sap-server-cert.pem`) is NOT ported — uses the system trust store; revisit once both apps are deployed against real certs.
- `Pages/Shared/_Layout.cshtml` + `wwwroot/css/site.css` — header/page-title-bar structure matches the Node app's real markup (confirmed by diffing three department HTML files — it's copy-pasted per department in Node, not templated). Styling is a clean, functional approximation, **not** pixel-accurate (`logistics.css`/`nexus-common.css` never fully captured) — department SVG badge icons also simplified to text-only. Revisit for visual parity once worth polishing.
- `Pages/Index.cshtml(.cs)` — the Hub landing page (port of `private/landing.html`), listing tiles for every department the current user belongs to (superadmin sees all 8).
- `wwwroot/js/shared/session-guard.js` — line-for-line port of `private/js/session-guard.js` (global `fetch` monkey-patch: 401 or a non-JSON body redirects to `/Login?error=session_expired`, deduped via `sessionStorage`). Must stay the first, non-deferred `<script>` in `<head>` — see `_Layout.cshtml`.
- `GET /health` — unauthenticated liveness check for IIS Application Initialization warm-up + external monitoring, matching SapServer's own `HealthController`.

**Deliberately deferred, not forgotten**: `notifications.js` and `deploy-banner.js` both need real backing features (a `Notifications`/`NotificationDeliveries` schema + `/api/notifications/*`; a `ScheduledDeployments` table + `/api/deploy/next`) that were never fully schema-confirmed during research — only inferred from `SELECT` queries, not `CREATE TABLE` statements. Come back to these once a department phase actually needs one, or as a dedicated small foundation follow-up, with the same schema-confirmation rigor `EnsureCoreSchema` got.

## Phase 2: Engineering (reference implementation for every later department phase)

Full vertical slice for Packaging Data (3 tiles), ported from `routes/packaging.js` + `private/engineering.html`/`private/js/engineering.js`:
- `Controllers/EngineeringController.cs` (`[Route("api/packaging")]`, same URL prefix Node used — only page URLs change in this migration, not the JSON API shape) + `Helpers/Engineering/EngineeringHelper.cs` (100% of the logic — thin-controller pattern starts here) + `Models/Dto/EngineeringModels.cs`.
- 8 of 11 routes proxy to SapServer's own `PackagingController`; DTOs mirror `SapServer/Models/Bapi/PackagingModels.cs` field-for-field (read directly from that repo, not guessed).
- **A deliberate, documented security tightening over Node's literal current behavior**: Node's write routes check ONLY `requirePermission('MASTER_DATA')`, never additionally `requireDepartment('engineering')` — the two gates are independent in Node and a route picks exactly one. `EngineeringController` requires BOTH (`Dept:engineering` at the class level, `Perm:ENG_*` per write action) — matches the plan's intent that permission groups are the tile-access mechanism *within* an already-accessible department, not a substitute for it. Strictly more restrictive than Node, never less — this same pattern repeats in every later department.
- `Services/Auth/SapCredentialCipher.cs` — the "New Packaging Creation" tile needs a user's own saved SAP password (`PortalUsers.SapPasswordEncrypted`) to call SapServer's elevated `create-elevated` endpoint. Byte-for-byte AES-256-GCM port of `lib/sapCredentials.js` (12-byte IV, 16-byte tag, `base64(IV‖tag‖ciphertext)`, UTF-8 plaintext), read from the real Node source. Round-trip + tamper-detection tests confirm internal correctness; byte-level interop with a real Node-encrypted value is unverified (no shared key/live DB here).
- `Data/Migrations/20260902054517_SeedEngineeringPermissions.cs` — first real run of the per-department permission-migration path: defines `ENG_MASS_UPDATE`/`ENG_NEW_PACKAGING`/`ENG_INSTRUCTION_DETAIL`, creates a default "Engineering Master Data" group bundling all three, migrates every existing `MASTER_DATA` grant into it. Legacy `MASTER_DATA` is left in place (not deleted) — full retirement is a later cleanup once confirmed against a real database.
- `Pages/Engineering/{Index,MassUpdate,NewPackaging,InstructionDetail}.cshtml(.cs)` + `wwwroot/js/engineering/{mass-update,new-packaging,instruction-detail}.js` — one real page and one dedicated JS file per tile, replacing `engineering.js`'s single-file dispatch-map/innerHTML-swap.
- 14 Helper tests + 4 controller tests.

## Phase 3: Quality

Stock Information (Display/Block/Unblock Stock) + Traceability Concessions, ported from `routes/quality.js` + `private/quality.js`/`.html`, and the review slice of `routes/productionnexus.js`'s concession endpoints.

- **A confirmed, deliberate behavioral fork found during research, not a guess**: `quality.js` signs every SapServer JWT with a *fixed* `{userId: 0}` service identity (its own local `makeSapToken()`, no argument) — distinct from `packaging.js`, which passes the real calling user. Preserved exactly (`QualityHelper.SapServiceUserId`), not "corrected," since SapServer-side `SapDepartmentPermissions` provisioning for these RFCs may already be keyed to that fixed identity. Locked in by a dedicated test.
- **Display Stock deliberately does NOT call SapServer's own `QualityController.GetBlockedStock`** (blocked-only, `BESTQ EQ 'S'`) — the real Node frontend never calls it either; it builds its own unfiltered `ZRFC_READ_TABLES` call for *all* LQUA stock in warehouse 312 and colors blocked rows client-side, gated only by department (no permission code). `QualityHelper.DisplayStockAsync` replicates that exact live behavior via SapServer's generic `api/rfc/execute` — confirmed `GetBlockedStock` is dead code from the real UI's perspective, not something this skips by accident.
- Block/Unblock proxy straight through to SapServer's `QualityController` (`api/quality/block`/`unblock`) — all WM-transfer-order-leg/bin-existence-check complexity stays on the SapServer side; DTOs mirror `SapServer/Models/Bapi/QualityModels.cs` field-for-field.
- **Bulk block/unblock is a real Server-Sent-Events stream** (`QualityController.Bulk`, `text/event-stream`, written directly to `Response.Body`) — the required permission depends on `body.Direction`, known only after model binding, so it's checked via injected `IAuthorizationService` rather than a static `[Authorize(Policy=...)]`. Frontend reads the stream manually via `response.body.getReader()`.
- Split legacy `QUAL_BLOCKING` (covered block AND unblock, including both bulk directions, with one code) into `QUAL_BLOCK_STOCK`/`QUAL_UNBLOCK_STOCK`. `QUAL_CONCESSION` maps to `QUAL_TRACEABILITY_CONCESSION` for the review action only.
- **Traceability Concessions reuses Production-domain data** (`prod.TraceabilityConcessions`, cross-database-joined to `Nexus.dbo.PortalUsers`). Ported the core read/approve/reject surface; deliberately did **not** port two Node side effects — a production-batch event-log write (`writeEvent`) and an in-app notification (`notify()`) — both depend on systems not built yet. The Production-side "raise a concession" action isn't ported at all yet.
- Simplified Node's right-click context-menu to a plain inline per-row action link (same API call, more discoverable, no client-side permission-based hide/show — the API's 403 is the real gate either way).
- 12 Helper tests (SSE row-result mapping, SAP-formatted quantity parsing — including the not-obviously-correct "any all-period no-comma string is thousands-grouped" behavior Node's own bulk loop has, ported faithfully rather than silently "fixed" — the fixed service-user-id, audit-message formatting, WM-vs-non-WM field gating).

## Build & Test

```bash
cd dotnet
dotnet build
dotnet test
```

Target framework: `net10.0`, `Microsoft.NET.Sdk.Web` (unlike SapServer's net48 + plain `Microsoft.NET.Sdk`, this SDK produces a correct IIS-ready `dotnet publish` layout automatically — `web.config` with the ASP.NET Core Module v2 `<aspNetCore>` handler, appsettings copied to the publish root — confirmed via a real local `dotnet publish -c Release -o <dir>`, no relocation MSBuild target needed the way SapServer needed one).

Local smoke-testing: `dotnet run --urls http://127.0.0.1:<port>` then `curl`/browser against it works out of the box (no HTTPS dev-cert setup needed) — see the cookie `SecurePolicy` note under Phase 1.

## Hosting

**IIS via ASP.NET Core Module v2, in-process hosting model** (the ASP.NET Core Web App template's default `hostingModel="inprocess"` in the generated `web.config` — the app runs directly inside the IIS worker process, not as a separate Kestrel process behind a reverse proxy). No `UseWindowsService()` — a deliberate departure from how the Node app is hosted today (a genuine Windows Service via `node-windows`/WinSW), per explicit user preference, and also means this app ends up hosted the same way as the sibling `SapServer` repo (both IIS sites), even though the two stay separate deployed apps.

IIS hosting carries real gotchas already confirmed painfully for real on SapServer this same session (see `/home/user/SapServer/CLAUDE.md`'s "Critical Platform Constraints") that this app's own `install.ps1`/app-pool config will need to account for once they're written:
- App pool default `OnDemand` start mode delays all startup code (DI, any background scheduler) until the first real request — needs `startMode=AlwaysRunning` + `preloadEnabled=true` + IIS Application Initialization (the `/health` endpoint above is what it would warm).
- `ApplicationPoolIdentity` needs explicit `icacls` grants (read+execute on site root, Modify on any writable path) and `processModel.loadUserProfile=$false`.
- App-pool recycling can kill an in-flight Quartz.NET job — a risk the old Windows-Service hosting didn't have. Needs either `idleTimeout=00:00:00` + recycling disabled, or every scheduled job made safely resumable across a restart. Not yet decided — no Quartz.NET jobs exist yet (Phase 10).

## Project layout

```
NormantonNexus.slnx
NormantonNexus/
  Data/                     EF Core migration tooling only (Data/Migrations/) — see Data/NexusMigrationContext.cs
  Services/Sql/             Dapper connection factories (INexusDb/INexusOperationsDb/INexusArchiveDb)
  Services/Auth/            Cookie auth, SQL-backed session store, idle timeout, role/department/permission authorization, SAP-credential cipher
  Services/                 SapServerClient.cs (root of Services/ — cross-department, not tied to one Helpers/ folder)
  Services/Admin/           Minimal permission-group management (Phase 9 gets the full CRUD UI)
  Controllers/              Thin [ApiController] JSON layer, one per department — Engineering, Quality so far
  Helpers/<Department>/     100% of each department's logic — Engineering/, Quality/ so far
  Models/Dto/               Wire DTOs, one file per department — Engineering, Quality so far
  Models/                   ApiResponse<T>/NexusExceptions.cs (root — shared by every department)
  Middleware/               ApiExceptionMiddleware.cs
  Pages/                    Razor Pages — Login, Index (Hub), ChangePassword, Admin/, Engineering/, Quality/ (one page per tile) so far
  wwwroot/js/<department>/  One dedicated JS file per tile page (engineering/, quality/ so far) + wwwroot/js/shared/ (session-guard.js)
NormantonNexus.Tests/      xUnit, InternalsVisibleTo from NormantonNexus — mirrors SapServer.Tests's Helpers-first testing approach
```

`NormantonNexus.Tests` reaches `internal` `Helpers/*` types directly via `[InternalsVisibleTo("NormantonNexus.Tests")]` in `NormantonNexus.csproj`, same convention as `SapServer.csproj`. `NormantonNexus.Tests/Controllers/ControllerTestHelpers.cs` mirrors SapServer.Tests's `ControllerTestHelpers.SetUser` for direct-instantiation + Moq controller tests.

## CI

`.github/workflows/dotnet-test.yml` (repo root) — separate from the Node app's own `.github/workflows/test.yml`, scoped to `dotnet/**` changes on `dotnet-rewrite` and its PRs. Runs on `ubuntu-latest` (no Windows-only native dependency the way SapServer's SAP NCo requires): `dotnet restore && dotnet build && dotnet test`.
