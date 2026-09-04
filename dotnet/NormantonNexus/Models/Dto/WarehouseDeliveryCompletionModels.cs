namespace NormantonNexus.Models.Dto;

// Delivery completion pipeline — port of routes/deliverymain.js's
// PATCH /:deliveryId/complete, POST /:deliveryId/sync-delivery-quantities,
// completeOneDelivery, runZdelflagMaintenance, and runGoodsIssueApproval.
// Sub-phase 7c.

public sealed record ZdelflagRunResult(string Status, List<SapReturnMessage> Messages);

public sealed record GoodsIssueRunResult(string Status, List<SapReturnMessage> Messages);

public sealed record CompleteDeliveryResult(
    int? PalletCount, decimal? GrossWeight, decimal? NetWeight,
    string? SapWarning, string? ZdelflagWarning, string? GoodsIssueWarning, string? Note, bool WasHeldForPackaging);

public sealed record DeliveryQuantityMatchItem(
    string ItemNumber, string Material, decimal RequiredQty, decimal PickedQty, decimal DiffQty, decimal PctDiff, string Status);

public sealed record DeliveryQuantityMatchResult(List<DeliveryQuantityMatchItem> Items, bool AllExact, bool AnyExceedsTolerance);

public sealed record DeliveryQuantityOutstanding(string DeliveryId, List<DeliveryQuantityMatchItem> Items);

/// <summary>
/// The single result type PATCH /:deliveryId/complete's Helper method
/// returns for every outcome — mirrors the "Helper returns a result,
/// controller maps it to the right HTTP status" pattern PalletUpdateResult/
/// DrummingSubmitResult already established. Status is one of "BLOCKED"
/// (409 — mismatchType/Error/Outstanding populated, Primary/LinkedResults
/// null) or "COMPLETE" (200 — Primary/LinkedResults populated, everything
/// else null).
/// </summary>
public sealed record CompleteDeliveryGroupResult(
    string Status, string? MismatchType, string? Error, List<DeliveryQuantityOutstanding>? Outstanding,
    CompleteDeliveryResult? Primary, Dictionary<string, CompleteDeliveryResult>? LinkedResults);

/// <summary>Same "Helper returns a result" pattern for sync-delivery-quantities — Success:false covers both 409 outcomes (an item now exceeds tolerance, or nothing needs correcting) and the 422 (SAP rejected the change); Error/FailedDeliveryId are only populated for the 422 case, matching Node's own per-delivery-in-group error message.</summary>
public sealed record SyncDeliveryQuantitiesResult(bool Success, int StatusCode, string? Error);
