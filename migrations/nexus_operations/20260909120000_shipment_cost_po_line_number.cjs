'use strict';
// Confirmed production incident (2026-09-09, costID 66, PO 4500438488): a
// freight cost line's PO was created successfully in SAP but its goods
// receipt failed — and neither routes/shipmentcost.js's POST /post-migo nor
// its dotnet port (ShipmentCostSapPostingHelper.PostMigoAsync) persisted the
// already-created purchaseOrder back onto the cost row when only the GR leg
// failed (both only wrote purchaseOrder on a fully successful line). That
// left the PO sitting open in SAP with no way for Nexus to know it already
// exists — a naive retry would call create-po-and-receipt again and create a
// SECOND purchase order for the same freight cost, orphaning the first
// forever.
//
// This column lets a retry post ONLY the goods receipt against the
// already-created PO (SapServer's plain, non-elevated POST
// /api/purchasing/post-goods-receipt) instead of creating a new one — see
// ShipmentCostSapPostingHelper.PostMigoAsync's now-updated header comment.
// RM07M-EBELP (the PO item) is assigned sequentially per line within one
// create-po-and-receipt call (LineNumber = its 1-based position in that
// call's Items array) — that same number must be replayed on retry, since a
// multi-line shipment group's PO can have several items and there's no way
// to re-derive which item belongs to which still-unposted cost line without
// it. A manual cost line's group is always exactly one line, so this is
// always 1 for that case, but shipment-grouped lines need the real value.

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
    await knex.raw(`
IF COL_LENGTH('log.ShipmentCost', 'poLineNumber') IS NULL
ALTER TABLE log.ShipmentCost ADD poLineNumber INT NULL`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
    await knex.raw(`
IF COL_LENGTH('log.ShipmentCost', 'poLineNumber') IS NOT NULL
ALTER TABLE log.ShipmentCost DROP COLUMN poLineNumber`);
};
