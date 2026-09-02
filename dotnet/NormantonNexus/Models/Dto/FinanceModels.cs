namespace NormantonNexus.Models.Dto;

// Finance department — GL Account Groups (SQL-only CRUD) + the three SAP
// costing proxies backing Material Costing/Actual Costs/Profit Center Data
// (Node: routes/finance.js for GL groups; routes/sap.js's /cost-sheet,
// /costing/period-balance, /costing/profit-center for the SAP proxies —
// consolidated here under one FinanceController/api/finance since they're
// genuinely Finance-only despite living in a shared Node file; see
// dotnet/CLAUDE.md's Phase 5 notes for why the URL prefix differs from
// Node's literal /api/sap/* mount).

public sealed record GlGroupRow(int Id, string Label, List<string> Accounts);

public sealed record GlGroupSaveRequest(string? Label, List<string>? Accounts);

/// <summary>Mirrors SapServer's CostSheetRequest — POST /api/costing/cost-sheet.</summary>
public sealed record CostSheetRequest(string Date, List<string> Materials);

/// <summary>Mirrors SapServer's CostSheetRow field-for-field (note: Kst fields are NOT declaration-ordered by number in SapServer either).</summary>
public sealed record CostSheetRow(
    string Material, string Plant, string CostingDate, string ValidTo, string ProfitCenter, string CompanyCode, string PartnerNumber,
    decimal Kst001, decimal Kst008, decimal Kst017, decimal Kst002, decimal Kst004, decimal Kst019, decimal Kst006, decimal Kst033,
    decimal LotSize, string Unit, string Status, string Work, string SheetValidFrom, string SheetValidTo,
    decimal OverheadPct, decimal IcMarkUp);

/// <summary>Mirrors SapServer's PeriodBalanceRequest — POST /api/costing/period-balance.</summary>
public sealed record PeriodBalanceRequest(string FiscalYear, string PeriodFrom, string PeriodTo, List<string> GlAccounts);

/// <summary>
/// Mirrors SapServer's PeriodBalanceRow. Balance/CumBalance are SAP's own
/// year-to-date figures — the Actual Costs frontend deliberately ignores
/// both and recomputes a period-range net/cumulative total client-side
/// (see wwwroot/js/finance/actual-costs.js), so this DTO carries them
/// through unused rather than omitting fields SapServer actually sends.
/// </summary>
public sealed record PeriodBalanceRow(string GlAccount, string Period, decimal Debit, decimal Credit, decimal Balance, decimal CumBalance);

/// <summary>Mirrors SapServer's ProfitCenterRequest — POST /api/costing/profit-center.</summary>
public sealed record ProfitCenterRequest(string DateFrom, string DateTo, List<string> GlAccounts);

/// <summary>Mirrors SapServer's ProfitCenterRow.</summary>
public sealed record ProfitCenterRow(
    string GlAccount, string ProfitCenter, string FiscalYear, string PostingDate, decimal CompanyCodeValue,
    string? InvoiceNumber, string? InvoiceItem, string? MaterialNumber, string? Customer, string? SalesOrder, string? SalesOrderItem);
