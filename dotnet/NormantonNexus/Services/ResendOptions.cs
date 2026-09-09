namespace NormantonNexus.Services;

/// <summary>C# equivalent of config.js's resendAPI (.env's RESEND_API_KEY) — used only by the forgot/reset-password flow (routes/auth.js's POST /forgot-password).</summary>
public sealed class ResendOptions
{
    public const string SectionName = "Resend";

    public string ApiKey { get; set; } = "";
    public string FromAddress { get; set; } = "Normanton Nexus <onboarding@resend.dev>";
}
