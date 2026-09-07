using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Logistics;

/// <summary>Consolidated Logistics reference-data admin — destinations, forwarders, forwarder mode mapping, cost centres, GL accounts (cost elements), material request units, pallet/packaging data. Every write action's own [Authorize] on the underlying controller (LOG_ADMIN, or none for a handful Node itself never gated — see LogisticsReferenceHelper's header comment) is the real per-action gate; this page-level policy is LOG_MRP so any Logistics planner can at least view it.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Logistics)]
[Authorize(Policy = "Perm:LOG_MRP,LOG_ADMIN")]
public class ReferenceDataModel : PageModel
{
    public void OnGet()
    {
    }
}
