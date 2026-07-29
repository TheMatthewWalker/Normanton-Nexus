-- Add outbound customs duties cost element (603100).
-- Run after migrate_shipment_costing.sql / migrate_customs_element.sql /
-- migrate_fix_customs_element_direction.sql.
--
-- Distinct from 603120 "Customs Clearance" (the forwarder's handling fee,
-- charged on effectively every KN shipment via the /estimate endpoint) —
-- 603100 is for actual duty charged by customs on a shipment, which only
-- comes up occasionally and isn't something the app can calculate itself,
-- hence it's just another selectable GL element on the outbound Associated
-- Costs "+ Add Cost" form rather than anything wired into the cost
-- estimator.
--
-- direction is set to 'outbound' immediately (unlike 603120's original
-- insert in migrate_customs_element.sql, which left it NULL and broke the
-- Associated Costs join until migrate_fix_customs_element_direction.sql
-- corrected it — see task #443).
IF NOT EXISTS (SELECT 1 FROM Logistics.dbo.CostElements WHERE elementCode = '603100')
INSERT INTO Logistics.dbo.CostElements (elementCode, direction, tier, elementDescription)
VALUES ('603100', 'outbound', NULL, 'Customs Duties');
