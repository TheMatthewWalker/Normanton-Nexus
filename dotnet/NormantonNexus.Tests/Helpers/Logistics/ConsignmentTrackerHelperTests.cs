using NormantonNexus.Helpers.Logistics;
using NormantonNexus.Models.Dto;

namespace NormantonNexus.Tests.Helpers.Logistics;

// Pure-function coverage for the three algorithmic cores of the Vendor
// Consignment Tracker (ComputeReversalCancellations, BuildAllocationProposal,
// ComputeReassignmentPlan) — all real, no-DB logic, and the highest-stakes
// part of this slice given ComputeReversalCancellations' own real,
// documented production incidents (Raaj Ratna reversal chains).
public class ConsignmentTrackerHelperTests
{
    private static ReversalWalkRow Row(long id, string doc, string item, decimal qty, decimal remaining, string? reversalDoc = null, string? reversalItem = null) =>
        new(id, "MAT001", doc, item, qty, remaining, reversalDoc, reversalItem);

    [Fact]
    public void ComputeReversalCancellations_leaves_a_standalone_row_alone()
    {
        var rows = new[] { Row(1, "5000001", "0001", 100, 100) };

        var result = ConsignmentTrackerHelper.ComputeReversalCancellations(rows);

        Assert.Empty(result.Zeroed);
        Assert.Empty(result.NeedsReview);
    }

    [Fact]
    public void ComputeReversalCancellations_zeroes_both_root_and_reversal_for_a_two_link_chain()
    {
        // Chain length 2 (root + 1 reversal) is even -> root ends cancelled;
        // the reversal row is always cancelled regardless of parity.
        var rows = new[]
        {
            Row(1, "5005206623", "0001", 50, 50),
            Row(2, "5005206624", "0001", 50, 50, "5005206623", "0001"),
        };

        var result = ConsignmentTrackerHelper.ComputeReversalCancellations(rows);

        Assert.Equal(2, result.Zeroed.Count);
        Assert.Contains(result.Zeroed, z => z.DeliveryId == 1);
        Assert.Contains(result.Zeroed, z => z.DeliveryId == 2);
        Assert.Empty(result.NeedsReview);
    }

    [Fact]
    public void ComputeReversalCancellations_restores_the_root_for_a_three_link_cancel_of_cancel_chain()
    {
        // Chain length 3 (root + 2 reversals) is odd -> root stays LIVE
        // (not zeroed); both intermediate documents are always cancelled.
        var rows = new[]
        {
            Row(1, "5005174284", "0001", 200, 200),
            Row(2, "5005203102", "0001", 200, 200, "5005174284", "0001"),
            Row(3, "5005203103", "0001", 200, 200, "5005203102", "0001"),
        };

        var result = ConsignmentTrackerHelper.ComputeReversalCancellations(rows);

        Assert.Equal(2, result.Zeroed.Count);
        Assert.DoesNotContain(result.Zeroed, z => z.DeliveryId == 1);
        Assert.Contains(result.Zeroed, z => z.DeliveryId == 2);
        Assert.Contains(result.Zeroed, z => z.DeliveryId == 3);
    }

    [Fact]
    public void ComputeReversalCancellations_flags_for_review_instead_of_zeroing_a_row_already_partly_declared()
    {
        var rows = new[]
        {
            Row(1, "5000001", "0001", 100, 40), // RemainingQty already differs from Quantity — a declaration was made
            Row(2, "5000002", "0001", 100, 100, "5000001", "0001"),
        };

        var result = ConsignmentTrackerHelper.ComputeReversalCancellations(rows);

        Assert.Single(result.Zeroed);
        Assert.Equal(2, result.Zeroed[0].DeliveryId);
        Assert.Single(result.NeedsReview);
        Assert.Equal(1, result.NeedsReview[0].DeliveryId);
        Assert.Contains("already differs", result.NeedsReview[0].Reason);
    }

    [Fact]
    public void ComputeReversalCancellations_flags_a_second_reverser_of_the_same_target_for_review()
    {
        var rows = new[]
        {
            Row(1, "5000001", "0001", 100, 100),
            Row(2, "5000002", "0001", 100, 100, "5000001", "0001"),
            Row(3, "5000003", "0001", 100, 100, "5000001", "0001"), // also claims to reverse doc 1
        };

        var result = ConsignmentTrackerHelper.ComputeReversalCancellations(rows);

        Assert.Contains(result.NeedsReview, r => r.DeliveryId == 3 && r.Reason.Contains("multiple documents"));
    }

    [Fact]
    public void ComputeReversalCancellations_ignores_a_reversal_pointing_outside_the_given_row_set()
    {
        var rows = new[] { Row(1, "5000002", "0001", 100, 100, "5000001", "0001") };

        var result = ConsignmentTrackerHelper.ComputeReversalCancellations(rows);

        // Row 1 is treated as its own root (its reversal target isn't in this set) — nothing to cancel.
        Assert.Empty(result.Zeroed);
        Assert.Empty(result.NeedsReview);
    }

    private static AllocatableDeliveryRow Allocatable(long id, decimal remaining, DateTime? expiry = null, DateTime? documentDate = null) =>
        new(id, "MAT001", remaining, $"INV{id}", expiry, documentDate);

    [Fact]
    public void BuildAllocationProposal_takes_exactly_what_is_needed_from_a_single_row()
    {
        var rows = new[] { Allocatable(1, 100) };

        var result = ConsignmentTrackerHelper.BuildAllocationProposal(rows, 40);

        Assert.Single(result.Lines);
        Assert.Equal(40, result.Lines[0].QtyAllocated);
        Assert.Equal(0, result.UnallocatedQty);
    }

    [Fact]
    public void BuildAllocationProposal_greedily_consumes_across_multiple_rows_in_order()
    {
        var rows = new[] { Allocatable(1, 30), Allocatable(2, 30), Allocatable(3, 30) };

        var result = ConsignmentTrackerHelper.BuildAllocationProposal(rows, 50);

        Assert.Equal(2, result.Lines.Count);
        Assert.Equal(30, result.Lines[0].QtyAllocated);
        Assert.Equal(20, result.Lines[1].QtyAllocated);
        Assert.Equal(0, result.UnallocatedQty);
    }

    [Fact]
    public void BuildAllocationProposal_reports_a_shortfall_when_open_stock_is_insufficient()
    {
        var rows = new[] { Allocatable(1, 10) };

        var result = ConsignmentTrackerHelper.BuildAllocationProposal(rows, 25);

        Assert.Single(result.Lines);
        Assert.Equal(10, result.Lines[0].QtyAllocated);
        Assert.Equal(15, result.UnallocatedQty);
    }

    [Fact]
    public void BuildAllocationProposal_skips_rows_with_no_remaining_stock()
    {
        var rows = new[] { Allocatable(1, 0), Allocatable(2, 20) };

        var result = ConsignmentTrackerHelper.BuildAllocationProposal(rows, 20);

        Assert.Single(result.Lines);
        Assert.Equal(2, result.Lines[0].DeliveryId);
    }

    [Fact]
    public void BuildAllocationProposal_rounds_allocated_quantity_to_three_decimal_places()
    {
        var rows = new[] { Allocatable(1, 10.12345m) };

        var result = ConsignmentTrackerHelper.BuildAllocationProposal(rows, 5.6789m);

        Assert.Equal(5.679m, result.Lines[0].QtyAllocated);
    }

    private static OpenDeliveryForReassignment OpenDelivery(long id, decimal remaining, DateTime? expiry = null, DateTime? documentDate = null) =>
        new(id, "MAT001", remaining, expiry, documentDate);

    [Fact]
    public void ComputeReassignmentPlan_reassigns_a_single_cancelled_line_to_one_open_delivery()
    {
        var cancelled = new[] { new CancelledDeclarationLine(1, 10, 999, "MAT001", 25) };
        var open = new[] { OpenDelivery(2, 100) };

        var plan = ConsignmentTrackerHelper.ComputeReassignmentPlan(cancelled, open);

        Assert.Single(plan);
        Assert.Single(plan[0].Splits);
        Assert.Equal(2, plan[0].Splits[0].DeliveryId);
        Assert.Equal(25, plan[0].Splits[0].Qty);
        Assert.Equal(0, plan[0].Shortfall);
    }

    [Fact]
    public void ComputeReassignmentPlan_shares_one_mutable_pool_across_cancelled_lines_for_the_same_material()
    {
        var cancelled = new[]
        {
            new CancelledDeclarationLine(1, 10, 901, "MAT001", 30),
            new CancelledDeclarationLine(2, 10, 902, "MAT001", 30),
        };
        var open = new[] { OpenDelivery(50, 40) }; // only enough for the first line, plus a bit

        var plan = ConsignmentTrackerHelper.ComputeReassignmentPlan(cancelled, open);

        Assert.Equal(2, plan.Count);
        Assert.Equal(30, plan[0].Splits.Sum(s => s.Qty));
        Assert.Equal(0, plan[0].Shortfall);
        // Second line only gets what's left (40 - 30 = 10) — a real shortfall.
        Assert.Equal(10, plan[1].Splits.Sum(s => s.Qty));
        Assert.Equal(20, plan[1].Shortfall);
    }

    [Fact]
    public void ComputeReassignmentPlan_orders_open_deliveries_FEFO_then_by_document_date()
    {
        var cancelled = new[] { new CancelledDeclarationLine(1, 10, 999, "MAT001", 10) };
        var open = new[]
        {
            OpenDelivery(1, 100, expiry: new DateTime(2026, 6, 1), documentDate: new DateTime(2026, 1, 1)),
            OpenDelivery(2, 100, expiry: new DateTime(2026, 3, 1), documentDate: new DateTime(2026, 2, 1)), // earliest expiry — should be picked first
        };

        var plan = ConsignmentTrackerHelper.ComputeReassignmentPlan(cancelled, open);

        Assert.Equal(2, plan[0].Splits[0].DeliveryId);
    }

    [Fact]
    public void ComputeReassignmentPlan_processes_cancelled_lines_in_declaration_then_declaration_line_order()
    {
        var cancelled = new[]
        {
            new CancelledDeclarationLine(DeclarationLineId: 5, DeclarationId: 2, CancelledDeliveryId: 901, Material: "MAT001", QtyAllocated: 10),
            new CancelledDeclarationLine(DeclarationLineId: 3, DeclarationId: 1, CancelledDeliveryId: 902, Material: "MAT001", QtyAllocated: 10),
        };
        var open = new[] { OpenDelivery(50, 15) };

        var plan = ConsignmentTrackerHelper.ComputeReassignmentPlan(cancelled, open);

        // DeclarationId 1 (line 3) must be processed before DeclarationId 2 (line 5), regardless of input order.
        Assert.Equal(1, plan[0].DeclarationId);
        Assert.Equal(2, plan[1].DeclarationId);
    }
}
