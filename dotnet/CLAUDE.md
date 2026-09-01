# CLAUDE.md (dotnet/)

Guidance for working in this subtree — the ASP.NET Core 10 rewrite of Normanton-Nexus, developed on the `dotnet-rewrite` branch alongside the live Node.js app at the repo root. See the repo root `CLAUDE.md` for the Node app; this file only covers `dotnet/`. The full migration plan (context, phased rollout, authorization redesign) lives in this session's plan file and should be re-derived/re-documented here as each phase lands, mirroring how `/home/user/SapServer/CLAUDE.md` documents that sibling rebuild.

## Status

**Phase 0 (Scaffold) only** — solution/project skeleton + CI, no application functionality yet. Phase 1 (Foundation: auth, sessions, DB, permission groups) has not started.

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
NormantonNexus/            ASP.NET Core 10 web app (Controllers/Helpers/Models/Services/Middleware/Pages — populated from Phase 1 onward)
NormantonNexus.Tests/      xUnit, InternalsVisibleTo from NormantonNexus — mirrors SapServer.Tests's Helpers-first testing approach
```

`NormantonNexus.Tests` reaches `internal` `Helpers/*` types directly via `[InternalsVisibleTo("NormantonNexus.Tests")]` in `NormantonNexus.csproj`, same convention as `SapServer.csproj`.

## CI

`.github/workflows/dotnet-test.yml` (repo root) — separate from the Node app's own `.github/workflows/test.yml`, scoped to `dotnet/**` changes on `dotnet-rewrite` and its PRs. Runs on `ubuntu-latest` (no Windows-only native dependency the way SapServer's SAP NCo requires): `dotnet restore && dotnet build && dotnet test`.
