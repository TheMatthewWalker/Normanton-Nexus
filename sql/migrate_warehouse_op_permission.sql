/* ============================================================
   WAREHOUSE_OP permission — run against the kongsberg database.
   Compatibility: SQL Server 2005+ (no GO, no MERGE — matches every
   other migration in this project).

   Gates the whole Picking Operations section on the Warehouse page:
   Open Picksheets, Picksheets on Hold, Closed Picksheets, and the two new
   operator-friendly tiles — Inbound Deliveries and Outbound Deliveries.

   Inbound Deliveries / Outbound Deliveries are simplified, warehouse-side
   views of two Logistics tiles:
     - Inbound Log (Logistics > Transport Management, LOG_MRP) — Warehouse's
       version only lets an operator confirm the quantity that showed up and
       Mark Arrived (posts the goods receipt to SAP). See routes/
       performance.js's GET /order-suggestions/shipments[/:id] and POST
       .../receive, all now requireAnyPermission(['LOG_MRP','WAREHOUSE_OP']).
     - Awaiting Collection (Logistics > Transport Management, LOG_PLANNING) —
       Warehouse's version only lets an operator Mark Collected. See routes/
       shipmentmain.js's POST /mark-collected-bulk, now
       requireAnyPermission(['LOG_PLANNING','WAREHOUSE_OP']).
   Neither tile lets a warehouse operator edit shipment details, cancel,
   undo a receive, or unbook a collection — those stay planner-only.

   Deliberately NOT auto-granted to existing Warehouse-department users —
   matches how every other permission in this table has been rolled out
   (ISOPAR_DECL, FIN_STOCK_APPROVE, etc.): added with zero grants, then
   assigned per-user via User Administration. Because this migration also
   newly gates Open Picksheets/Picksheets on Hold/Closed Picksheets (routes/
   deliverymain.js's /open-picksheets, /packaging-holding[/all],
   /:id/picksheet-materials, /:id/stage-batch, /:id/complete — previously
   reachable by any logged-in Warehouse user), grant WAREHOUSE_OP to the
   current warehouse team BEFORE or immediately after deploying this, or
   Picking Operations will go dark for them until it's done.
   ============================================================ */

IF NOT EXISTS (SELECT 1 FROM dbo.PortalPermissions WHERE PermissionCode = N'WAREHOUSE_OP')
  INSERT INTO dbo.PortalPermissions (PermissionCode, PermissionName, Description, Category) VALUES
    (N'WAREHOUSE_OP', N'Warehouse Operator',
     N'Picking Operations: Open Picksheets, Picksheets on Hold, Closed Picksheets, Inbound Deliveries (mark arrived/GR) and Outbound Deliveries (mark collected)', N'Warehouse');

PRINT 'WAREHOUSE_OP permission verified/added';

/* ── Verify ───────────────────────────────────────────────────────────────── */
SELECT PermissionCode FROM dbo.PortalPermissions WHERE PermissionCode = N'WAREHOUSE_OP';
