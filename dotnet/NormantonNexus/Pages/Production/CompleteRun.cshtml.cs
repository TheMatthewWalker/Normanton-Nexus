using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Production;

/// <summary>
/// The draft-&gt;complete two-step wizard for the metre processes (EX/CO/BR/CL/TW)
/// — the piece MetreEntry.cshtml's own scope note flagged as not yet built.
/// Start a new draft (BOM-snapshot/MX-tub-link traceability captured up
/// front) or pick an existing open draft from the queue, then complete it
/// with the actual length/shift/scrap — MetreProcessHelper.CompleteAsync
/// hard-blocks on an unresolved traceability mismatch unless an approved
/// concession covers it, same as the backend already documented.
/// </summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Production)]
public class CompleteRunModel : PageModel
{
    private static readonly Dictionary<string, string> Labels = new(StringComparer.OrdinalIgnoreCase)
    {
        ["EX"] = "Extrusion",
        ["CO"] = "Convoluting",
        ["BR"] = "Braiding",
        ["CL"] = "Coverline",
        ["TW"] = "Tape Wrap",
    };

    public string Code { get; private set; } = "";
    public string ProcessLabel { get; private set; } = "";

    public IActionResult OnGet(string code)
    {
        if (!Labels.TryGetValue(code, out var label))
        {
            return NotFound();
        }
        Code = code.ToUpperInvariant();
        ProcessLabel = label;
        return Page();
    }
}
