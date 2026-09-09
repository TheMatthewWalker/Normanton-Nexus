namespace NormantonNexus.Models.Dto;

// C# port of routes/profile.js — self-service "My Account" (change password
// + SAP credentials). Never the password itself round-tripped back out —
// SapCredentialStatus deliberately excludes it, matching
// lib/sapCredentials.js's getSapCredentialStatus.

public sealed record SapCredentialStatus(string? SapUsername, bool HasCredentials, DateTime? UpdatedAt);

public sealed record SetSapCredentialsRequest(string? SapUsername, string? SapPassword);

public sealed record ChangePasswordApiRequest(string? CurrentPassword, string? NewPassword);
