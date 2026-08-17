// ── Weight unit conversion ──────────────────────────────────────────────────
//
// Some vendors (e.g. DeWAL) require purchase orders to be placed in a unit
// other than the material's SAP base unit of measure (almost always KG in
// this system — see log.TurnsValClassSnapshot.Uom). The vendor's required
// order unit is recorded on log.Vendor.OrderMoqUom (Vendor Master Data page).
//
// Everywhere else in Normanton-Nexus (stock, forecast, MRP suggestion math)
// deliberately stays in the material's SAP base unit — only the two places
// that actually cross the boundary with the physical/SAP world need to
// convert: building the SAP PO (BAPI_PO_CREATE1's PO_UNIT/QUANTITY), the PO
// PDF sent to the supplier, and the goods-receipt quantity confirmed off the
// supplier's own delivery paperwork (routes/performance.js).
//
// KG_PER_UNIT expresses each supported unit as "how many KG is 1 of this
// unit" — kept deliberately small (only units actually in use) rather than a
// general-purpose conversion library; convertQty throws on anything not
// listed here instead of silently treating an unknown unit as a no-op.
const KG_PER_UNIT = {
  KG: 1,
  LB: 0.45359237,
};

export function convertQty(qty, fromUnit, toUnit) {
  const from = (fromUnit || 'KG').toUpperCase();
  const to = (toUnit || 'KG').toUpperCase();
  if (from === to) return qty;

  const fromFactor = KG_PER_UNIT[from];
  const toFactor = KG_PER_UNIT[to];
  if (!fromFactor || !toFactor) {
    throw new Error(`Unsupported unit conversion: ${fromUnit} -> ${toUnit}`);
  }
  return qty * fromFactor / toFactor;
}
