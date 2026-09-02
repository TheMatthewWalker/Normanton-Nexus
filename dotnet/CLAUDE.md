# CLAUDE.md (dotnet/)

Guidance for working in this subtree — the ASP.NET Core 10 rewrite of Normanton-Nexus, developed on the `dotnet-rewrite` branch alongside the live Node.js app at the repo root. See the repo root `CLAUDE.md` for the Node app; this file only covers `dotnet/`. The full migration plan (context, phased rollout, authorization redesign) lives in this session's plan file and should be re-derived/re-documented here as each phase lands, mirroring how `/home/user/SapServer/CLAUDE.md` documents that sibling rebuild.

## Status

**Phase 0 (Scaffold) done. Phase 1 (Foundation) done** (`notifications.js`/`deploy-banner.js` deliberately deferred, see below). **Phase 2 (Engineering) done** — the first complete vertical slice (Controller/Helper/Models/Pages/JS/tests/permission migration), the "is the pattern actually settled" checkpoint the plan calls for. Phase 3 (Quality) is next.

**Real, confirmed verification** (not just "it compiles"): started the app for real (`dotnet run`) in Development — which enables ASP.NET Core's strictest DI validation (`ValidateOnBuild`/`ValidateScopes`) — and it booted clean with no DI graph errors across every service registered so far. Then hit it with real HTTP requests: `GET /Login` → 200 with correctly rendered HTML; `GET /Engineering` (unauthenticated) → 302 to `/Login?ReturnUrl=%2FEngineering`; an unmatched route → clean 404. This confirms the whole auth/routing/authorization pipeline wiring is real and working, not just type-checked — the actual login round-trip and any SQL/SapServer-touching path are still unverified (no live SQL Server or SapServer reachable in this sandbox).

## Phase 2: Engineering (reference implementation for every later department phase)

Full vertical slice for Packaging Data (3 tiles), ported from `routes/packaging.js` + `private/engineering.html`/`private/js/engineering.js`:
- `Controllers/EngineeringController.cs` (`[Route("api/packaging")]`, same URL prefix Node used — only page URLs change in this migration, not the JSON API shape) + `Helpers/Engineering/EngineeringHelper.cs` (100% of the logic — thin-controller pattern starts here) + `Models/Dto/EngineeringModels.cs`.
- **`Services/SapServerClient.cs` turned out to be needed here, not in Quality as the plan originally guessed** — 8 of Engineering's 11 routes proxy to SapServer's own `PackagingController`. DTOs in `EngineeringModels.cs` mirror `SapServer/Models/Bapi/PackagingModels.cs` field-for-field (read directly from the SapServer repo in this same session, not guessed) so the wire format matches exactly.
- **A deliberate, documented security tightening over Node's literal current behavior**: Node's write routes (`PUT/DELETE /instruction`, `POST /mass-update`, `POST /create`) check ONLY `requirePermission('MASTER_DATA')`, never additionally `requireDepartment('engineering')` — the two gates are independent in Node and a route picks exactly one. `EngineeringController` requires BOTH (`Dept:engineering` at the class level, `Perm:ENG_*` added per write action) — matches the plan's "Authorization model" intent that permission groups are the tile-access mechanism *within* an already-accessible department, not a substitute for it. Strictly more restrictive than Node, never less.
- `Services/Auth/SapCredentialCipher.cs` — the "New Packaging Creation" tile needs a user's own saved SAP password (`PortalUsers.SapPasswordEncrypted`) to call SapServer's elevated `create-elevated` endpoint. Byte-for-byte AES-256-GCM port of `lib/sapCredentials.js` (12-byte IV, 16-byte tag, `base64(IV‖tag‖ciphertext)`, UTF-8 plaintext) — read from the real Node source, not guessed, since credential crypto is not something to approximate. Round-trip + tamper-detection unit tests confirm the implementation is internally correct; byte-level interop with a real Node-encrypted value is still unverified (no shared key/no live DB in this sandbox).
- `Data/Migrations/20260902054517_SeedEngineeringPermissions.cs` — first real run of the plan's per-department permission migration path: defines `ENG_MASS_UPDATE`/`ENG_NEW_PACKAGING`/`ENG_INSTRUCTION_DETAIL`, creates a default "Engineering Master Data" group bundling all three, and migrates every existing `MASTER_DATA` grant into membership of that group so nobody loses access. Legacy `MASTER_DATA` itself is deliberately left in place (not deleted) — full retirement is a later cleanup once this pattern is confirmed against a real database.
- `Pages/Engineering/{Index,MassUpdate,NewPackaging,InstructionDetail}.cshtml(.cs)` + `wwwroot/js/engineering/{mass-update,new-packaging,instruction-detail}.js` — one real page and one dedicated JS file per tile, replacing `engineering.js`'s single-file `openFunction()`/innerHTML-swap dispatch. Client-side tile logic (search debounce, selection-persists-across-refresh, scope picker, form field set) is a faithful behavioral port, verified against the Node source read in full.
- 14 new Helper-level tests (Moq-mocked `ISapServerClient`/`IAuditLogger`) covering the 404-swallow behavior (`GetInstructionAsync`), the empty-rows validation, and audit-message formatting. `CreatePackagingAsync`'s DB-touching credential lookup isn't unit-tested (needs a real `INexusDb`) — same class of gap as SapServer's own DB-dependent integration tests.

Not yet done for Engineering: manual click-through against real data (no SQL Server/SapServer reachable here), and the frontend's exact CSS (functional but not pixel-matched — see Phase 1 notes).

Done so far:
- Three Dapper connection factories (`Services/Sql/`) — `INexusDb`/`INexusOperationsDb`/`INexusArchiveDb`, each just a captured connection string, safe as singletons.
- EF Core migrations (`Data/Migrations/`, tooling-only — see `Data/NexusMigrationContext.cs`): `EnsureCoreSchema` idempotently creates `PortalUsers`/`PortalUserDepartments`/`PortalPermissions`/`PortalUserPermissions`/`PortalSessions`/`PortalAuditLog` if missing (guarded, safe to run against a DB the Node app's knex migrations already touched); `AddPermissionGroups` adds the new `PortalPermissionGroups`/`PortalPermissionGroupPermissions`/`PortalUserPermissionGroups` tables (see the plan's "Authorization model"). Verified with `dotnet ef migrations script` (no live SQL Server available in this sandbox — real `dotnet ef database update` against a real SQL Server is still unverified, same caveat class as SapServer's own NCo-dependent pieces).
- Cookie authentication with a SQL-backed `ITicketStore` (`Services/Auth/PortalSessionStore.cs`) — the direct analog of `lib/sqlSessionStore.js`, reusing the same `PortalSessions` table shape (not the same row *format* — this app's `SessionData` holds a serialized `AuthenticationTicket`, not Node's JSON session blob; users re-log-in once at cutover regardless, per the plan).
- Per-user variable idle timeout (`Services/Auth/IdleTimeoutPolicy.cs` + `IdleTimeoutValidation.cs`) — 30 min default / 5 min `ShortIdleTimeout`, matching `config.js`'s `idleTimeoutMsFor` exactly, applied every request via `CookieAuthenticationEvents.OnValidatePrincipal` (the C# equivalent of `server.js`'s per-request `cookie.maxAge` reset under `rolling:true`).
- Login flow (`Pages/Login.cshtml(.cs)` + `Services/Auth/AuthService.cs`) — faithful port of `routes/auth.js`'s `POST /login`: hardcoded-hash dummy bcrypt compare for unknown usernames, lockout at 10 failed attempts (permanent, admin-unlock only — matches `useradmin.js`, no time-based auto-unlock), IP-partitioned rate limiting (10/15 min, matching `express-rate-limit`), a fresh session key on every successful login (session-fixation defense — see that file's own comments for why no explicit `regenerate()` call is needed here).
- Role (`operator`<`admin`<`superadmin`, superadmin bypasses) + department + the new per-tile-permission authorization gates, all independent (never ANDed on one route, matching `middleware/auth.js`) — `Services/Auth/AuthorizationRequirements.cs` + `NexusPolicyProvider.cs` lets a controller write `[Authorize(Policy = "Perm:WAREHOUSE_STOCK_ADJUST")]` / `"Dept:warehouse"` / `"Role:admin"` without pre-registering every policy name at startup.
- `Services/Auth/PermissionResolver.cs` — effective permission set = direct `PortalUserPermissions` grants UNION every group's permissions via `PortalUserPermissionGroups`/`PortalPermissionGroupPermissions`, computed once at login and baked into the ticket as claims (cheap since the ticket lives server-side in SQL, not the browser cookie — no cookie-size ceiling on permission count as tile-level codes accumulate).
- `Pages/Admin/PermissionGroups*` — minimal (not the full Phase 9 UI) group create/list/manage screen, `Role:admin` gated.
- `Models/ApiResponse.cs` + `NexusExceptions.cs` + `Middleware/ApiExceptionMiddleware.cs` — the `{success,data,error}` envelope every department `[ApiController]` returns, mapped from a small exception hierarchy (C# analog of SapServer's `ApiResponse<T>`/`SapExceptionMapper`). Wired into the pipeline scoped to `/api/*` only — Razor Page requests still go through the normal HTML error page.
- `Services/SapServerClient.cs` — typed `HttpClient` wrapper matching `sap.js`'s `makeSapToken`/axios pattern (same shared-secret JWT shape: `{userId}`, issuer `normanton-nexus`, audience `sap-server`, 60s expiry). **Originally planned for the Quality phase** (see the migration plan) but built here in Phase 1/2 instead — real research into the Engineering department (next section) showed it's actually the first real consumer, not Quality. TLS pinning (`sap.js`'s `certs/sap-server-cert.pem`) is NOT ported yet — uses the system trust store; revisit once both apps are deployed against real certs.
- `Pages/Shared/_Layout.cshtml` + `wwwroot/css/site.css` — header/page-title-bar structure matches the Node app's real markup (confirmed via diffing `engineering.html`/`sales.html`/`quality.html` — it's copy-pasted per department in Node, not templated, so there was nothing to reverse-engineer beyond the shape). Visual styling is a clean, functional approximation, **not** a pixel-accurate port of `logistics.css`/`nexus-common.css` (never fully captured) — revisit for visual parity once worth polishing. Department SVG badge icons are also not ported (simplified to text-only for now).
- `Pages/Index.cshtml(.cs)` — the Hub landing page (port of `private/landing.html`), listing tiles for every department the current user belongs to (superadmin sees all 8).
- `wwwroot/js/shared/session-guard.js` — line-for-line port of `private/js/session-guard.js` (global `fetch` monkey-patch: 401 or a non-JSON body redirects to `/Login?error=session_expired`, deduped via `sessionStorage`). Must stay the first, non-deferred `<script>` in `<head>` — see `_Layout.cshtml`.
- 27 xUnit tests covering the role hierarchy, idle-timeout policy, dynamic policy provider, and all three authorization handlers (including superadmin bypass) — `NormantonNexus.Tests/Services/Auth/`.

**Deliberately deferred, not forgotten**: `notifications.js` and `deploy-banner.js` (the other two shared JS files the plan calls out) both need real backing features — a `Notifications`/`NotificationDeliveries` schema + `/api/notifications/*` endpoints, and a `ScheduledDeployments` table + `/api/deploy/next` — that were never fully schema-confirmed during research (only inferred from the Node app's `SELECT` queries, not its `CREATE TABLE` statements). Porting the JS without a real, schema-confirmed backend risked shipping something that silently does nothing or — worse — a guessed schema that's wrong. Come back to these once a department phase actually needs one of them, or as a dedicated small foundation follow-up, with the same schema-confirmation rigor `EnsureCoreSchema` got.

**Also not yet done**: `MustChangePassword` page-level enforcement (the claim is carried on the ticket but nothing gates on it yet — no private pages existed to gate until Engineering). Verification not yet done at all: session persistence across a simulated restart, both idle-timeout variants firing correctly end-to-end, a real login round-trip against a real SQL Server, a real `SapServerClient` call against a real SapServer — none reachable in this sandbox (no live SQL Server, no live SapServer instance). Same caveat class as SapServer's own repeated "confirmed for real in production" callouts — none of this has had that pass yet.

## Build & Test

```bash
cd dotnet
dotnet build
dotnet test
```

Target framework: `net10.0`, `Microsoft.NET.Sdk.Web` (unlike SapServer's net48 + plain `Microsoft.NET.Sdk`, this SDK produces a correct IIS-ready `dotnet publish` layout automatically — `web.config` with the ASP.NET Core Module v2 `<aspNetCore>` handler, appsettings copied to the publish root — confirmed via a real local `dotnet publish -c Release -o <dir>`, no relocation MSBuild target needed the way SapServer needed one).

## Hosting

**IIS via ASP.NET Core Module v2, in-process hosting model** (the ASP.NET Core Web App template's default `hostingModel="inprocess"` in the generated `web.config` — the app runs directly inside the IIS worker process, not as a separate Kestrel process behind a reverse proxy). No `UseWindowsService()` — this is a deliberate departure from how the Node app is hosted today (a genuine Windows Service via `node-windows`/WinSW), per explicit user preference, and also means this app ends up hosted the same way as the sibling `SapServer` repo (both IIS sites), even though the two stay separate deployed apps.

IIS hosting carries real gotchas already confirmed painfully for real on SapServer this same session (see `/home/user/SapServer/CLAUDE.md`'s "Critical Platform Constraints") that this app's own `install.ps1`/`Program.cs`/app-pool config will need to account for once they're written:
- App pool default `OnDemand` start mode delays all startup code (DI, any background scheduler) until the first real request — needs `startMode=AlwaysRunning` + `preloadEnabled=true` + IIS Application Initialization.
- `ApplicationPoolIdentity` needs explicit `icacls` grants (read+execute on site root, Modify on any writable path) and `processModel.loadUserProfile=$false`.
- App-pool recycling can kill an in-flight Quartz.NET job — a risk the old Windows-Service hosting didn't have. Needs either `idleTimeout=00:00:00` + recycling disabled, or every scheduled job made safely resumable across a restart. Not yet decided — tracked for the Foundation phase.

## Project layout

```
NormantonNexus.slnx
NormantonNexus/
  Data/                     EF Core migration tooling only (Data/Migrations/) — see Data/NexusMigrationContext.cs
  Services/Sql/             Dapper connection factories (INexusDb/INexusOperationsDb/INexusArchiveDb)
  Services/Auth/            Cookie auth, SQL-backed session store, idle timeout, role/department/permission authorization, SAP-credential cipher
  Services/                 SapServerClient.cs (root of Services/ — cross-department, not tied to one Helpers/ folder)
  Services/Admin/           Minimal permission-group management (Phase 9 gets the full CRUD UI)
  Controllers/              Thin [ApiController] JSON layer, one per department — EngineeringController.cs so far
  Helpers/<Department>/     100% of each department's logic — Helpers/Engineering/ so far
  Models/Dto/               Wire DTOs, one file per department — EngineeringModels.cs so far
  Models/                   ApiResponse<T>/NexusExceptions.cs (root — shared by every department)
  Middleware/                ApiExceptionMiddleware.cs
  Pages/                    Razor Pages — Login.cshtml, Index.cshtml (Hub), Admin/, Engineering/ (one page per tile) so far
  wwwroot/js/<department>/  One dedicated JS file per tile page (wwwroot/js/engineering/ so far) + wwwroot/js/shared/ (session-guard.js)
NormantonNexus.Tests/      xUnit, InternalsVisibleTo from NormantonNexus — mirrors SapServer.Tests's Helpers-first testing approach
```

`NormantonNexus.Tests` reaches `internal` `Helpers/*` types directly via `[InternalsVisibleTo("NormantonNexus.Tests")]` in `NormantonNexus.csproj`, same convention as `SapServer.csproj`.

## CI

`.github/workflows/dotnet-test.yml` (repo root) — separate from the Node app's own `.github/workflows/test.yml`, scoped to `dotnet/**` changes on `dotnet-rewrite` and its PRs. Runs on `ubuntu-latest` (no Windows-only native dependency the way SapServer's SAP NCo requires): `dotnet restore && dotnet build && dotnet test`.
