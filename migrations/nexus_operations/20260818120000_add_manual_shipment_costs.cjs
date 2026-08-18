'use strict';
// Manual (unlinked) freight cost entry — per the user, an odd invoice
// sometimes arrives for a freight cost that isn't tied to any specific
// shipment at all (not an outbound log.ShipmentMain row, not an inbound
// log.PurchaseOrderShipment row). These columns let a log.ShipmentCost row
// exist with BOTH shipmentID and poShipmentID NULL, carrying its own copy
// of the display fields that would otherwise come from the linked shipment
// (haulier, dates, location, tracking) — see routes/shipmentcost.js's
// POST /manual and the extended GET /unprocessed / GET /processed /
// POST /post-migo, which only ever read these columns when shipmentID AND
// poShipmentID are both NULL.
//
// Direction is deliberately NOT stored as its own column here — it's still
// derived from the row's costElement via log.CostElements.direction (the
// same join GET /unprocessed already does for outbound/inbound rows), so
// there's one source of truth for direction<->element instead of two that
// could disagree.
//
// manualIncurredDate stands in for the plannedCollection/deliveredDate a
// real shipment would carry — POST /post-migo blocks posting until a line's
// "delivered" date is set, and manual lines satisfy that gate with this
// column instead (required at entry, not defaulted).

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
    await knex.raw(`
IF COL_LENGTH('log.ShipmentCost', 'manualReference') IS NULL
ALTER TABLE log.ShipmentCost ADD manualReference NVARCHAR(100) NULL`);

    await knex.raw(`
IF COL_LENGTH('log.ShipmentCost', 'manualForwarderID') IS NULL
ALTER TABLE log.ShipmentCost ADD manualForwarderID BIGINT NULL`);

    await knex.raw(`
IF COL_LENGTH('log.ShipmentCost', 'manualCountry') IS NULL
ALTER TABLE log.ShipmentCost ADD manualCountry NVARCHAR(50) NULL`);

    await knex.raw(`
IF COL_LENGTH('log.ShipmentCost', 'manualPostcode') IS NULL
ALTER TABLE log.ShipmentCost ADD manualPostcode NVARCHAR(20) NULL`);

    await knex.raw(`
IF COL_LENGTH('log.ShipmentCost', 'manualTrackingNumber') IS NULL
ALTER TABLE log.ShipmentCost ADD manualTrackingNumber NVARCHAR(50) NULL`);

    await knex.raw(`
IF COL_LENGTH('log.ShipmentCost', 'manualIncurredDate') IS NULL
ALTER TABLE log.ShipmentCost ADD manualIncurredDate DATETIME NULL`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
    await knex.raw(`
IF COL_LENGTH('log.ShipmentCost', 'manualIncurredDate') IS NOT NULL
ALTER TABLE log.ShipmentCost DROP COLUMN manualIncurredDate`);

    await knex.raw(`
IF COL_LENGTH('log.ShipmentCost', 'manualTrackingNumber') IS NOT NULL
ALTER TABLE log.ShipmentCost DROP COLUMN manualTrackingNumber`);

    await knex.raw(`
IF COL_LENGTH('log.ShipmentCost', 'manualPostcode') IS NOT NULL
ALTER TABLE log.ShipmentCost DROP COLUMN manualPostcode`);

    await knex.raw(`
IF COL_LENGTH('log.ShipmentCost', 'manualCountry') IS NOT NULL
ALTER TABLE log.ShipmentCost DROP COLUMN manualCountry`);

    await knex.raw(`
IF COL_LENGTH('log.ShipmentCost', 'manualForwarderID') IS NOT NULL
ALTER TABLE log.ShipmentCost DROP COLUMN manualForwarderID`);

    await knex.raw(`
IF COL_LENGTH('log.ShipmentCost', 'manualReference') IS NOT NULL
ALTER TABLE log.ShipmentCost DROP COLUMN manualReference`);
};
