'use strict';
// log.VendorMaterial.ScheduleAgreement (the SAP scheduling agreement number, where this
// vendor+material is bought against one instead of a spot PO — see the ScheduleAgreement
// comment on the CREATE TABLE in sql/migrate_vendor_master_data.sql) was informational only:
// nothing downstream actually used it to skip PO creation. This adds the missing item number
// (SAP EBELP-equivalent line item on the agreement, e.g. "00010") so a Tracked Orders line can
// be assigned straight to the agreement (routes/performance.js's
// POST /order-suggestions/assign-schedule-agreement, mirroring what Create PO in SAP stamps
// onto PoNumber/PoItemNumber, just without ever calling SAP — see that route's own comment)
// and, downstream of that, so postGoodsReceiptToSap has a PoNumber+PoItemNumber pair to post
// against at Mark Received time, the same as it already does for a real PO. Same NVARCHAR(5)
// shape as PurchaseOrderSuggestion.PoItemNumber (SAP item numbers are 5-digit, zero-padded).

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'log.VendorMaterial') AND name = 'ScheduleAgreementItem')
ALTER TABLE log.VendorMaterial ADD ScheduleAgreementItem NVARCHAR(5) NULL`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'log.VendorMaterial') AND name = 'ScheduleAgreementItem')
ALTER TABLE log.VendorMaterial DROP COLUMN ScheduleAgreementItem`);
};
