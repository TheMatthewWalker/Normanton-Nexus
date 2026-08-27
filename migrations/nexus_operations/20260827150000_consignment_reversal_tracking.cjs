'use strict';
// Vendor Consignment Tracker — reversal-chain tracking (2026-08-27).
//
// A goods receipt line can be cancelled in SAP (transaction MBST) — the
// cancelling MSEG line carries SMBLN/SMBLP ("material document for
// reversal") pointing back at the document/item it cancels. Nexus's GR sync
// (SapServer's ConsignmentHelpers) previously discarded SMBLN/SMBLP
// entirely, so a cancelled delivery line kept its full original
// RemainingQty forever — only a Nexus-confirmed declaration ever decrements
// it, and nobody declares against stock that was reversed in SAP. Once that
// cancelled line's PostingDate aged past the vendor's ExpiryDays window, it
// falsely tripped the Expiry Warnings "overdue" list for material that was
// never physically outstanding. See routes/consignmentsql.js's
// applyReversalCancellations for the parity-walk that uses this column to
// correct RemainingQty — both going forward (every sync) and retroactively
// (run once against existing data).
//
// These columns store SMBLN/SMBLP verbatim when SAP populates them on a
// synced row (NULL otherwise, same as every other optional GR field on this
// table). NVARCHAR(10)/(4) match MaterialDocument/MaterialDocItem's own
// widths since a reversal's SMBLN/SMBLP is just another document/item pair.

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'log.ConsignmentDelivery') AND name = 'ReversalOfMaterialDocument')
ALTER TABLE log.ConsignmentDelivery ADD ReversalOfMaterialDocument NVARCHAR(10) NULL`);
  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'log.ConsignmentDelivery') AND name = 'ReversalOfMaterialDocItem')
ALTER TABLE log.ConsignmentDelivery ADD ReversalOfMaterialDocItem NVARCHAR(4) NULL`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'log.ConsignmentDelivery') AND name = 'ReversalOfMaterialDocItem')
ALTER TABLE log.ConsignmentDelivery DROP COLUMN ReversalOfMaterialDocItem`);
  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'log.ConsignmentDelivery') AND name = 'ReversalOfMaterialDocument')
ALTER TABLE log.ConsignmentDelivery DROP COLUMN ReversalOfMaterialDocument`);
};
