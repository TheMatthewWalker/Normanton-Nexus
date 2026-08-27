'use strict';
// Goods Issue posting (BAPI_DELIVERYPROCESSING_EXEC) — fired automatically
// by routes/deliverymain.js's runGoodsIssueApproval right after a
// delivery's ZDELFLAG/ZDELPACK maintenance run (log.DeliveryZdelflagRun)
// records 'Success'. No manual approval step. See that function and
// WarehouseController.PostGoodsIssue (SapServer) for the full flow.
//
// log.DeliveryGoodsIssueRun tracks, per SAP delivery (VBELN), the outcome
// of each GI posting attempt. Supports:
//   - a warning log listing deliveries whose GI posting failed
//   - a "reprocess" action, but ONLY while status is Failed (or no run
//     exists yet) — once Success, a VBELN cannot be run again without a
//     future reversal feature (not implemented yet), same precedent as
//     log.DeliveryZdelflagRun's reprocess guard
//   - a "resolve" action (LOG_SUPER-gated) for when GI was posted directly
//     in SAP outside the automatic flow — inserts a terminal 'Resolved' run
//     with no SAP call, clearing the delivery off the warnings list
// Status: 'Success' | 'Failed' | 'Resolved'. No 'Warning' bucket — SAP's
// RETURN table here is a standard BAPIRET2 (real per-message severity), so
// there's no synthetic third status needed the way ZDELFLAG's flat
// ET_MESSAGE table required.
//
// This was originally sql/migrate_goods_issue.sql (written against the
// pre-restructure "Logistics" database) — that file is historical now (see
// migrations/README.md's 2026-08-10 restructure note) and was never
// actually applied to the real server, since it targeted a database name
// ("Logistics") that no longer exists post-restructure. This migration
// replaces it, targeting nexus_operations (schema log) directly. Mirrors
// 20260825134852_delivery_picksheet_link.cjs's shape (raw SQL, idempotent
// IF NOT EXISTS guards, no knex schema builder — same convention every
// other table in this migrations folder uses).

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.DeliveryGoodsIssueRun') AND type = 'U')
CREATE TABLE log.DeliveryGoodsIssueRun (
    runID        INT           NOT NULL IDENTITY(1,1)
,   deliveryID   NVARCHAR(10)  NOT NULL   -- VBELN, unpadded
,   status       NVARCHAR(10)  NOT NULL   -- Success | Failed | Resolved
,   messages     NVARCHAR(MAX) NULL       -- JSON array of {type, message}
,   ranAtUtc     DATETIME      NOT NULL
,   ranByUserID  INT           NULL       -- null for automatic runs; set for a manual 'resolve'
,   CONSTRAINT PK_DeliveryGoodsIssueRun PRIMARY KEY (runID)
)`);

    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_DeliveryGoodsIssueRun_RanAt')
ALTER TABLE log.DeliveryGoodsIssueRun ADD CONSTRAINT DF_DeliveryGoodsIssueRun_RanAt DEFAULT (getutcdate()) FOR ranAtUtc`);

    // Every read is "WHERE deliveryID = @id ORDER BY ranAtUtc DESC" (latest
    // run per delivery) — same shape/rationale as
    // IX_DeliveryZdelflagRun_Delivery.
    await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DeliveryGoodsIssueRun_Delivery' AND object_id = OBJECT_ID('log.DeliveryGoodsIssueRun'))
CREATE NONCLUSTERED INDEX IX_DeliveryGoodsIssueRun_Delivery ON log.DeliveryGoodsIssueRun (deliveryID, ranAtUtc DESC)`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DeliveryGoodsIssueRun_Delivery' AND object_id = OBJECT_ID('log.DeliveryGoodsIssueRun'))
DROP INDEX IX_DeliveryGoodsIssueRun_Delivery ON log.DeliveryGoodsIssueRun`);

    await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'log.DeliveryGoodsIssueRun') AND type = 'U')
DROP TABLE log.DeliveryGoodsIssueRun`);
};
