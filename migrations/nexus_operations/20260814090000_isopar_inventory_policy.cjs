'use strict';
// Isopar (Material 10010) inventory policy — a simple fixed reorder-point/fixed-order-quantity
// scheme, distinct from the coverage-days sizing the rest of MRP uses:
//   - Reorder point: 2000 L (log.VendorMaterial.MinSafetyStockQty — the SAME field every other
//     material's safety floor uses, so buildSuggestionForRow's existing breach-date/urgency
//     logic already produces "order in time to arrive right as stock crosses 2000L" for free).
//   - Order quantity: always exactly 5000 L (log.VendorMaterial.MaterialMoqQty ==
//     MaterialMaxQty == 5000 — the same "exact quantity" pattern already used for Raaj Ratna's
//     combined-order MOQ; enforceMaterialQty snaps to precisely one lot whenever moq === max).
//   - Tank capacity: 7000 L — genuinely new, no existing field represents "maximum sensible
//     stock level" (MaterialMaxQty caps an ORDER, not the resulting STOCK). Added as
//     log.IsoparPlanningRate.MaxStockCapacityQty, alongside the weekday/weekend planning rate,
//     since it's the same kind of Isopar-specific, UI-editable, versioned setting — see
//     routes/performance.js's computeIsoparStockRisk, which warns if a reading or forecast
//     implies exceeding it (or running out) once a pending delivery is factored in.
//
// 2000 (reorder) + 5000 (order) = 7000 (capacity) by design — ordering right at the reorder
// point never overfills the tank, provided the forecast is roughly on track; the risk check
// exists for when it isn't (see routes/performance.js's checkIsoparDeclarationDue's sibling,
// computeIsoparStockRisk, called after every meter reading is saved).

/** @param {import('knex').Knex} knex */
exports.up = async function (knex) {
  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'log.IsoparPlanningRate') AND name = 'MaxStockCapacityQty')
ALTER TABLE log.IsoparPlanningRate ADD MaxStockCapacityQty DECIMAL(15,3) NULL`);

  await knex.raw(`
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_IsoparPlanningRate_MaxStockCapacityQty')
ALTER TABLE log.IsoparPlanningRate ADD CONSTRAINT DF_IsoparPlanningRate_MaxStockCapacityQty DEFAULT (7000.00) FOR MaxStockCapacityQty`);

  // DEFAULT constraints only apply to future inserts — backfill the row(s) seeded by the
  // previous migration (or created before this one ran) so "current rate" always resolves a
  // capacity, not NULL.
  await knex.raw(`UPDATE log.IsoparPlanningRate SET MaxStockCapacityQty = 7000.00 WHERE MaxStockCapacityQty IS NULL`);

  // Isopar's own inventory policy, per Kongsberg's stated requirement: reorder at 2000L, order
  // exactly 5000L each time, tank capacity 7000L. Idempotent — safe to re-run.
  await knex.raw(`
UPDATE log.VendorMaterial
SET MinSafetyStockQty = 2000.000, MaterialMoqQty = 5000.000, MaterialMaxQty = 5000.000, UpdatedAtUtc = GETUTCDATE()
WHERE Material = N'10010'`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function (knex) {
  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_IsoparPlanningRate_MaxStockCapacityQty')
ALTER TABLE log.IsoparPlanningRate DROP CONSTRAINT DF_IsoparPlanningRate_MaxStockCapacityQty`);

  await knex.raw(`
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'log.IsoparPlanningRate') AND name = 'MaxStockCapacityQty')
ALTER TABLE log.IsoparPlanningRate DROP COLUMN MaxStockCapacityQty`);
  // Deliberately not reversing the VendorMaterial data update — rolling back the schema
  // shouldn't silently wipe a live inventory-policy configuration.
};
