namespace NormantonNexus.Models.Dto;

// Engineering department — Packaging Data (3 tiles: Mass Packaging Update,
// New Customer Packaging Creation, Packaging Instruction Detail). Field
// shapes mirror SapServer's Models/Bapi/PackagingModels.cs exactly (both
// apps use camelCase JSON — ASP.NET Core's controller default, and
// SapServer's explicit CamelCasePropertyNamesContractResolver), since this
// department is a thin proxy in front of SapServer's PackagingController —
// see Helpers/Engineering/EngineeringHelper.cs and routes/packaging.js
// (the Node original this replaces).

/// <summary>One row from the NexusOperations material picker (log.TurnsValClassSnapshot) — backs the Mass Update tile's search.</summary>
public sealed record MaterialOption(string Material, string MaterialText);

public sealed record PackagingMaraRow(decimal WeightKg, string MaterialType, string HandlingType, string WeightUnit);

public sealed record PackagingBomRow(string Component, string Unit, decimal Quantity);

public sealed record PackagingCustomerRow(string Customer, string CustomerGroup, string Name, string CustomerPart, string SalesOrg);

/// <summary>A ZPACK_INSTR row — null from GetInstructionAsync means "none saved yet for this scope", not an error.</summary>
public sealed record PackagingInstrRow(
    string PackMaterial, decimal PalletQty, decimal SmallBoxQty,
    bool PackProd, bool BoxGen, bool BatchSpread, bool PartMix,
    bool ChargeReq, bool TechStatReq, bool PNumReq);

/// <summary>Save (insert/update) request body for the Instruction Detail tile — SqlAction is "I" or "U", set by the caller based on whether GetInstructionAsync found an existing row.</summary>
public sealed record PackagingInstrSaveRequest(
    string Material, string? Customer, string SqlAction, string? PackMaterial,
    decimal PalletQty, decimal SmallBoxQty, bool PackProd, bool BoxGen,
    bool BatchSpread, bool PartMix, bool ChargeReq, bool TechStatReq, bool PNumReq);

public sealed record PackagingInstrDeleteRequest(string Material, string? Customer);

public sealed record MassPackagingUpdateRow(string Material, string PackMaterial);

public sealed record MassPackagingUpdateRequest(List<MassPackagingUpdateRow> Rows);

public sealed record MassPackagingUpdateResult(string Material, bool Success, string Message);

/// <summary>The 10 packaging-type codes New Packaging Creation offers, all checked by default in the UI.</summary>
public static class PackagingCodes
{
    public static readonly string[] All = ["SD", "MD", "LD", "XD", "SB", "MB", "LB", "XB", "C1", "C2"];
}

public sealed record CreatePackagingRequest(string CustomerPart, List<string> Codes);

public sealed record CreatePackagingResult(string Code, string Material, bool AlreadyExisted, bool MaterialCreated, bool BomCreated, string Message);

/// <summary>Sent on to SapServer's create-elevated endpoint once EngineeringHelper has decrypted the caller's own saved SAP credentials.</summary>
public sealed record CreatePackagingElevatedRequest(string SapUsername, string SapPassword, string CustomerPart, List<string> Codes);
