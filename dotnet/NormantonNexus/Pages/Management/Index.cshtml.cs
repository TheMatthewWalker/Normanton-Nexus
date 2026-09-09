using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Management;

/// <summary>KPIs, order book, and cross-department insight dashboard — C# port of private/management.html/js/management.js. One dense page, not a tile grid, matching the migration plan's "different frontend pattern... direct port" precedent for Admin/Management. Every underlying route it calls (GET api/performance/value-metrics/otif-metrics/orderbook-summary/orderbook-breakdown, POST api/performance/refresh, consignment-customers CRUD) is Logistics-owned (PerformanceController) with no extra permission gate beyond being logged in — this page's own Dept:management gate is the real access control for reaching it at all. The live-formula orderbook Excel export (GET orderbook-breakdown/export) was intentionally left out of Logistics's own backend scope (see dotnet/CLAUDE.md's Sub-phase 8b notes) and is therefore not offered here either — Upload Updated Notes is still wired since that endpoint is real.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Management)]
public class IndexModel : PageModel
{
    public void OnGet()
    {
    }
}
