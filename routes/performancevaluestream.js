// ── Profit centre → value stream mapping ─────────────────────────────────────
// Single source of truth for ValueStream assignment. Every dataset (stock,
// agreements, invoicing, otif) carries profitCentre on each record from the
// SAP download, and each record is mapped independently — no cross-dataset
// material lookups. Unmapped centres return null (= excluded from snapshots).

const centreToArea = {
  '2000': 'PTFE',
  '2001': 'PTFE',
  '2002': 'PTFE',
  '2003': 'PTFE',
  '2004': 'PTFE',
  '2005': 'PTFE',
  '2006': 'PTFE',
  '2007': 'PTFE',
  '2008': 'PV',
  '2009': 'PTFE',
  '2010': 'PV',
  '2011': 'PV',
  '2012': 'PTFE',
  '2013': 'PV',
  '2014': 'PV',
  '2015': 'PV',
  '2016': 'PTFE',
  '2017': 'PV',
  '2018': 'PV',
  '2019': 'PV',
  '2021': 'PTFE',
  '2022': 'PTFE',
  '2023': 'PTFE',
  '2024': 'PV',
  '2026': 'PV',
  '2028': 'PV',
  '9912': 'PTFE'
};

// SAP PRCTR arrives either bare ("2008") or zero-padded to 10 ("0000002008").
export function mapProfitCentreToValueStream(profitCentre) {
  if (!profitCentre) return null;

  const centre = String(profitCentre).trim().replace(/^0+/, '');

  return centreToArea[centre] || null; // null = exclude
}

export function enrichWithValueStream(rows) {
  for (const row of rows) {
    row.valueStream = mapProfitCentreToValueStream(row.profitCentre);
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
  //  if (row.currency && row.currency !== homeCurrency) {  //blanked out of localCurrency is calculated in SAP
  //    skipped++;
  //    continue;
  //  }

    const unitPrice = row.orderQty ? row.localAmount / row.orderQty : 0;

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
