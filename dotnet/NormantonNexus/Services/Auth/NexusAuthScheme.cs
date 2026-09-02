namespace NormantonNexus.Services.Auth;

/// <summary>Cookie authentication scheme name — shared between Program.cs (registration) and AuthService (ticket construction).</summary>
public static class NexusAuthScheme
{
    public const string Name = "NormantonNexus.Auth";
}
