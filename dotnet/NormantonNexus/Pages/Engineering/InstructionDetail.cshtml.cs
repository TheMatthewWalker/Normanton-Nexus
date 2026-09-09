using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using NormantonNexus.Services.Auth;

namespace NormantonNexus.Pages.Engineering;

/// <summary>Packaging Instruction Detail tile — port of engineering.js's renderInstructionDetail(). Write requires Perm:ENG_INSTRUCTION_DETAIL at the API layer.</summary>
[Authorize(Policy = "Dept:" + NexusDepartments.Engineering)]
public class InstructionDetailModel : PageModel
{
    public void OnGet()
    {
    }
}
