/* ============================================================
   Inbound Log costing + Manual Inbound Shipment + Forwarders admin.
   Compatibility: SQL Server 2005+ (matches migrate_order_shipments.sql /
   migrate_shipment_costing.sql — no GO, no CONCAT(), no DATETIME2).

   Two sections below run against different databases — see the comment on
   each ALTER for which one.

   Feature summary (requested by user):
   1. Associated Costs on an Inbound Log shipment (kongsberg.dbo.
      PurchaseOrderShipment) post to SAP via the same MIGO-cost mechanism
      already used for outbound freight (Logistics.dbo.ShipmentCost ->
      SapServer's BAPI_ACC_DOCUMENT_POST /api/costing/freight-posting).
      Inbound GL = 602200 standard / 602100 premium (already seeded in
      CostElements by migrate_shipment_costing.sql), cost centre = 2012
      (new row below), vendor = the shipment's haulier, looked up via
      Logistics.dbo.Forwarders.forwarderID — confirmed by the user that
      forwarderID IS the SAP vendor code already, so no new mapping column
      is needed.
   2. Manual Inbound Shipment — a PurchaseOrderShipment row not linked to
      any PurchaseOrderSuggestion (e.g. a customer return), with its own
      origin (Destinations lookup), price, cost centre (dropdown of every
      Logistics.dbo.CostCenters row, per user's answer) and GL tier.
   3. Forwarders admin (add/edit/approve) — Logistics.dbo.Forwarders
      already exists (created ad hoc, no CREATE TABLE script on file); no
      schema change needed, just new PUT support in routes/forwarders.js.
   ============================================================ */

-- ── Runs against the Logistics database ────────────────────────────────────

-- New inbound cost centre (Logistics.dbo.CostCenters already holds
-- '0000002004' PTFE / '0000002011' PV etc. in the same zero-padded SAP
-- format — see migrate_shipment_costing.sql).
INSERT INTO Logistics.dbo.CostCenters (centerCode, centerDescription)
VALUES ('0000002012', 'Inbound Logistics');

-- Logistics.dbo.ShipmentCost.shipmentID is scoped to Logistics.dbo.
-- ShipmentMain (outbound only, different DB/identity space than kongsberg's
-- PurchaseOrderShipment). Rather than overload shipmentID and risk an ID
-- collision across two unrelated identity sequences, inbound cost lines get
-- their own nullable column. Every existing outbound query in
-- routes/shipmentcost.js INNER JOINs ShipmentMain on shipmentID, which
-- naturally excludes rows where shipmentID IS NULL — so inbound rows
-- (shipmentID NULL, poShipmentID set) are invisible to that code with zero
-- changes required there.
ALTER TABLE Logistics.dbo.ShipmentCost ADD poShipmentID INT NULL;

CREATE INDEX IX_ShipmentCost_poShipmentID ON Logistics.dbo.ShipmentCost(poShipmentID);

-- Recorded per cost line (not inherited live from the shipment) so it's
-- fixed at the point the cost was raised. For inbound lines this is
-- defaulted from PurchaseOrderShipment.ModeOfTransport at insert time (see
-- insertInboundCostLine in routes/inboundcosts.js) but can differ from the
-- shipment's current value if that's changed since. Per the user: this will
-- drive the material group of the PO the freight cost eventually needs
-- (Road/Sea/Air use different material groups) — that PO-creation step
-- itself is NOT built yet (BAPI_ACC_DOCUMENT_POST, the only working SAP
-- posting call currently wired up, posts a straight FI/AP document, not a
-- PO/goods-receipt pair), so this column is captured now ready for that
-- follow-up work.
ALTER TABLE Logistics.dbo.ShipmentCost ADD modeOfTransport NVARCHAR(20) NULL;

-- ── Runs against the kongsberg database ─────────────────────────────────────

-- Haulier moves from free text to a Logistics.dbo.Forwarders-backed
-- dropdown (unique forwarder names) per the user's request. ForwarderID is
-- the source of truth going forward; the existing Haulier text column is
-- kept and auto-populated with the forwarder's name (a display snapshot),
-- so existing reads of PurchaseOrderShipment.Haulier keep working
-- unchanged, and the "Supplier Transport" self-delivery case used by
-- Auto-Shipment (no real forwarder involved) still works as free text.
ALTER TABLE dbo.PurchaseOrderShipment ADD ForwarderID BIGINT NULL;

-- Manual Inbound Shipment support — a shipment not derived from any
-- PurchaseOrderSuggestion selection (e.g. a customer return). IsManual
-- distinguishes these in the Inbound Log list/detail views (they have no
-- linked order lines by definition, so OrderCount alone isn't a reliable
-- flag). Origin is captured via the Destinations lookup, as requested;
-- OriginName is a display snapshot so the Inbound Log list doesn't need a
-- live cross-database join to Logistics.dbo.Destinations on every read.
ALTER TABLE dbo.PurchaseOrderShipment ADD IsManual BIT NOT NULL DEFAULT 0;
ALTER TABLE dbo.PurchaseOrderShipment ADD OriginDestinationID BIGINT NULL;
ALTER TABLE dbo.PurchaseOrderShipment ADD OriginName NVARCHAR(200) NULL;
