export function buildValueStreamLookup(agreementRows) {
  const map = new Map();

  for (const row of agreementRows) {
    if (!map.has(row.material)) {
      map.set(row.material, row.valueStream || null);
    }
  }

  return map;
}

export function enrichWithValueStream(rows, valueStreamByMaterial) {
  for (const row of rows) {
    row.valueStream = valueStreamByMaterial.get(row.material) ?? null;
  }
  return rows;
}

export function computeTodayStockAndPickedTotals(
  allocatedAgreementRows,
  { homeCurrency = process.env.HOME_CURRENCY || 'GBP' } = {}
) {
  const totals = new Map(); // valueStream -> { stockValue, pickedValue }
  let skipped = 0;

  function add(valueStream, field, amount) {
    if (!amount) return;

    const vs = valueStream || 'UNKNOWN';

    if (!totals.has(vs)) {
      totals.set(vs, { stockValue: 0, pickedValue: 0 });
    }

    totals.get(vs)[field] += amount;
  }

  for (const row of allocatedAgreementRows) {
    if (row.currency && row.currency !== homeCurrency) {
      skipped++;
      continue;
    }

    const unitPrice = row.orderQty ? row.amount / row.orderQty : 0;

    add(row.valueStream, 'stockValue', (row.dockStockAllocated || 0) * unitPrice);
    add(row.valueStream, 'pickedValue', (row.pickedStockAllocated || 0) * unitPrice);
  }

  if (skipped > 0) {
    console.warn(
      `[valueStream] skipped ${skipped} agreement row(s) not in ${homeCurrency} — ` +
      `stock/picked value excludes these until a real currency conversion is wired in`
    );
  }

  return totals;
}
