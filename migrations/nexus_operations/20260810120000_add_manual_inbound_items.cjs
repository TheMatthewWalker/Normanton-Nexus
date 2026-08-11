'use strict';
// Manual Inbound Shipment cargo lines — lets an operator record what
// materials/quantities are actually on a manual inbound shipment (one not
// derived from any PurchaseOrderSuggestion/tracked order, e.g. a customer
// return) so there's still something to check against on arrival. Mirrors
// Logistics.dbo.ManualCargoItem's role for Manual Outbound Shipment
// (sql/migrate_manual_outbound_shipment.sql) — same "flag on the header,
// separate child rows" shape, but with SAP-material fields (Material/
// Quantity/UnitOfMeasure) instead of ManualCargoItem's generic physical
// dimensions, since inbound items are being reconciled against a known
// material rather than packed/booked by weight and volume.
//
// Unlike ManualCargoItem (Logistics.dbo, no FK — see that file's header),
// this table lives in the same database as PurchaseOrderShipment, so it
// follows the FK convention already used for
// PurchaseOrderSuggestion.ShipmentId (FK_POS_Shipment,
// sql/migrate_order_shipments.sql) rather than app-managed-only.

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
  await knex.raw(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.objects
      WHERE object_id = OBJECT_ID(N'log.ManualInboundItem') AND type = 'U'
    )
    BEGIN
      CREATE TABLE log.ManualInboundItem (
        ItemId        INT           NOT NULL IDENTITY(1,1),
        ShipmentId    INT           NOT NULL,

        Material      NVARCHAR(18)  NULL,   -- SAP material number when known; free-text Description covers items with none
        Description   NVARCHAR(200) NULL,
        Quantity      DECIMAL(15,3) NOT NULL,
        UnitOfMeasure NVARCHAR(10)  NULL,   -- free text (e.g. 'M', 'KG', 'PC') — no SAP UOM validation for a non-SAP-tracked line

        Removed       BIT           NOT NULL DEFAULT 0,   -- soft delete, matches ManualCargoItem.Removed
        CreatedAtUtc  DATETIME      NOT NULL DEFAULT GETUTCDATE(),
        CreatedBy     NVARCHAR(100) NULL,

        CONSTRAINT PK_ManualInboundItem PRIMARY KEY (ItemId),
        CONSTRAINT FK_ManualInboundItem_Shipment FOREIGN KEY (ShipmentId) REFERENCES log.PurchaseOrderShipment (ShipmentId)
      );

      CREATE INDEX IX_ManualInboundItem_Shipment ON log.ManualInboundItem (ShipmentId);
    END
  `);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
  await knex.raw(`
    IF EXISTS (
      SELECT 1 FROM sys.objects
      WHERE object_id = OBJECT_ID(N'log.ManualInboundItem') AND type = 'U'
    )
      DROP TABLE log.ManualInboundItem
  `);
};
