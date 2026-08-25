'use strict';
// Lets two (or more) open picksheets share one pallet pool — stock picked
// for one picksheet often doesn't fill a whole pallet, so batches for a
// different picksheet can be picked onto the same physical pallet. See
// routes/deliverymain.js's GET /:deliveryId/pallets and
// runZdelflagMaintenance for how this widens *visibility* only — log.
// DeliveryLink ownership (which delivery's pallet builder actually created
// a given pallet) is left completely unchanged by this table; a shared
// pallet's weight/count still rolls up to exactly one delivery, and each
// delivery's own ZDELFLAG run still only ever carries its own batches
// (log.PalletPackages.sapDelivery already scopes that independently of
// which delivery owns the pallet).
//
// Populated symmetrically — linking A<->B inserts BOTH (A, B) and (B, A) —
// so every query stays a plain one-directional WHERE deliveryID = @id, no
// OR-condition/UNION needed anywhere that reads it.

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.DeliveryPicksheetLink') AND type = 'U')
CREATE TABLE log.DeliveryPicksheetLink (
    deliveryID       BIGINT   NOT NULL
,   linkedDeliveryID BIGINT   NOT NULL
,   linkedAtUtc      DATETIME NOT NULL
,   linkedByUserID   INT      NULL
,   CONSTRAINT PK_DeliveryPicksheetLink PRIMARY KEY (deliveryID, linkedDeliveryID)
)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_DeliveryPicksheetLink_LinkedAt')
ALTER TABLE log.DeliveryPicksheetLink ADD CONSTRAINT DF_DeliveryPicksheetLink_LinkedAt DEFAULT (getutcdate()) FOR linkedAtUtc`);

    // deliveryID/linkedDeliveryID are the same domain (unlike DeliveryLink's
    // deliveryID/palletID, which can't self-reference) so a self-link is a
    // real defect class worth blocking at the DB level, not just in route
    // logic.
    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_DeliveryPicksheetLink_NotSelf')
ALTER TABLE log.DeliveryPicksheetLink ADD CONSTRAINT CK_DeliveryPicksheetLink_NotSelf
  CHECK (deliveryID <> linkedDeliveryID)`);

    // Every read is "WHERE deliveryID = @id" (the PK's leading column
    // already covers that); this is for the reverse direction — finding/
    // removing the mirror row by linkedDeliveryID when unlinking.
    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DeliveryPicksheetLink_Linked' AND object_id = OBJECT_ID('log.DeliveryPicksheetLink'))
CREATE NONCLUSTERED INDEX IX_DeliveryPicksheetLink_Linked ON log.DeliveryPicksheetLink (linkedDeliveryID)`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DeliveryPicksheetLink_Linked' AND object_id = OBJECT_ID('log.DeliveryPicksheetLink'))
DROP INDEX IX_DeliveryPicksheetLink_Linked ON log.DeliveryPicksheetLink`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.DeliveryPicksheetLink') AND type = 'U')
DROP TABLE log.DeliveryPicksheetLink`);
};
