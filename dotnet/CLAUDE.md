# CLAUDE.md (dotnet/)

Guidance for working in this subtree — the ASP.NET Core 10 rewrite of Normanton-Nexus, developed on the `dotnet-rewrite` branch alongside the live Node.js app at the repo root. See the repo root `CLAUDE.md` for the Node app; this file only covers `dotnet/`. The full migration plan (context, phased rollout, authorization redesign) lives in this session's plan file and should be re-derived/re-documented here as each phase lands, mirroring how `/home/user/SapServer/CLAUDE.md` documents that sibling rebuild.

## Status

**Phase 0 (Scaffold) done. Phase 1 (Foundation) in progress** — auth/session/permission-group core is built; layout, shared JS ports, and the minimal admin group-management screen are not yet.

Done so far:
- Three Dapper connection factories (`Services/Sql/`) — `INexusDb`/`INexusOperationsDb`/`INexusArchiveDb`, each just a captured connection string, safe as singletons.
- EF Core migrations (`Data/Migrations/`, tooling-only — see `Data/NexusMigrationContext.cs`): `EnsureCoreSchema` idempotently creates `PortalUsers`/`PortalUserDepartments`/`PortalPermissions`/`PortalUserPermissions`/`PortalSessions`/`PortalAuditLog` if missing (guarded, safe to run against a DB the Node app's knex migrations already touched); `AddPermissionGroups` adds the new `PortalPermissionGroups`/`PortalPermissionGroupPermissions`/`PortalUserPermissionGroups` tables (see the plan's "Authorization model"). Verified with `dotnet ef migrations script` (no live SQL Server available in this sandbox — real `dotnet ef database update` against a real SQL Server is still unverified, same caveat class as SapServer's own NCo-dependent pieces).
- Cookie authentication with a SQL-backed `ITicketStore` (`Services/Auth/PortalSessionStore.cs`) — the direct analog of `lib/sqlSessionStore.js`, reusing the same `PortalSessions` table shape (not the same row *format* — this app's `SessionData` holds a serialized `AuthenticationTicket`, not Node's JSON session blob; users re-log-in once at cutover regardless, per the plan).
- Per-user variable idle timeout (`Services/Auth/IdleTimeoutPolicy.cs` + `IdleTimeoutValidation.cs`) — 30 min default / 5 min `ShortIdleTimeout`, matching `config.js`'s `idleTimeoutMsFor` exactly, applied every request via `CookieAuthenticationEvents.OnValidatePrincipal` (the C# equivalent of `server.js`'s per-request `cookie.maxAge` reset under `rolling:true`).
- Login flow (`Pages/Login.cshtml(.cs)` + `Services/Auth/AuthService.cs`) — faithful port of `routes/auth.js`'s `POST /login`: hardcoded-hash dummy bcrypt compare for unknown usernames, lockout at 10 failed attempts (permanent, admin-unlock only — matches `useradmin.js`, no time-based auto-unlock), IP-partitioned rate limiting (10/15 min, matching `express-rate-limit`), a fresh session key on every successful login (session-fixation defense — see that file's own comments for why no explicit `regenerate()` call is needed here).
- Role (`operator`<`admin`<`superadmin`, superadmin bypasses) + department + the new per-tile-permission authorization gates, all independent (never ANDed on one route, matching `middleware/auth.js`) — `Services/Auth/AuthorizationRequirements.cs` + `NexusPolicyProvider.cs` lets a controller write `[Authorize(Policy = "Perm:WAREHOUSE_STOCK_ADJUST")]` / `"Dept:warehouse"` / `"Role:admin"` without pre-registering every policy name at startup.
- `Services/Auth/PermissionResolver.cs` — effective permission set = direct `PortalUserPermissions` grants UNION every group's permissions via `PortalUserPermissionGroups`/`PortalPermissionGroupPermissions`, computed once at login and baked into the ticket as claims (cheap since the ticket lives server-side in SQL, not the browser cookie — no cookie-size ceiling on permission count as tile-level codes accumulate).
- 27 xUnit tests covering the role hierarchy, idle-timeout policy, dynamic policy provider, and all three authorization handlers (including superadmin bypass) — `NormantonNexus.Tests/Services/Auth/`.

Not yet done (rest of Phase 1): `_Layout.cshtml` + shared nav partial, ported shared JS (`session-guard.js`/`notifications.js`/`deploy-banner.js`), the minimal permission-group admin screen, `MustChangePassword` page-level enforcement (the claim is carried on the ticket but nothing gates on it yet — no private pages exist to gate). Verification not yet done: session persistence across a simulated restart, both idle-timeout variants firing correctly end-to-end, a real login round-trip against a real SQL Server (none reachable in this sandbox).

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
  Services/Auth/            Cookie auth, SQL-backed session store, idle timeout, role/department/permission authorization
  Pages/                    Razor Pages (Login.cshtml so far; one per tile from Phase 2 onward)
  Controllers/Helpers/Models/Middleware/   Not populated yet — start with the first department phase (Phase 2, Engineering)
NormantonNexus.Tests/      xUnit, InternalsVisibleTo from NormantonNexus — mirrors SapServer.Tests's Helpers-first testing approach
```

`NormantonNexus.Tests` reaches `internal` `Helpers/*` types directly via `[InternalsVisibleTo("NormantonNexus.Tests")]` in `NormantonNexus.csproj`, same convention as `SapServer.csproj`.

## CI

`.github/workflows/dotnet-test.yml` (repo root) — separate from the Node app's own `.github/workflows/test.yml`, scoped to `dotnet/**` changes on `dotnet-rewrite` and its PRs. Runs on `ubuntu-latest` (no Windows-only native dependency the way SapServer's SAP NCo requires): `dotnet restore && dotnet build && dotnet test`.
