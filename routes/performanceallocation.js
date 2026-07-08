const PACKAGING_CUSTOMER_PATTERN = /^IB_(\w+?)_/;

export function packagingCustomer(packagingMaterial) {
  const match = PACKAGING_CUSTOMER_PATTERN.exec(packagingMaterial || '');
  return match ? match[1] : null;
}

export function stagingBin(referenceDocument) {
  return String(referenceDocument ?? '').padStart(10, '0');
}

function defaultStockKey(stockRow) {
  return `${stockRow.material}|${packagingCustomer(stockRow.packagingMaterial)}`;
}

function defaultAgreementKey(agreementRow) {
  return `${agreementRow.material}|${agreementRow.customer}`;
}

export function allocateStock(
  agreementRows,
  stockRows,
  {
    stockKey = defaultStockKey,
    agreementKey = defaultAgreementKey
  } = {}
) {
  const availablePool = new Map();
  
  for (const s of stockRows) {
    const key = stockKey(s);
    availablePool.set(key, (availablePool.get(key) || 0) + (s.availableQty || 0));
  }

  const stagedPool = new Map();

  for (const s of stockRows) {
    const key = `${s.material}|${s.storageBin}`;
    stagedPool.set(key, (stagedPool.get(key) || 0) + (s.totalQty || 0));
  }

  const sorted = [...agreementRows].sort(
    (a, b) => new Date(a.requestDate) - new Date(b.requestDate)
  );

  for (const row of sorted) {
    const key = agreementKey(row);

    const remainingAvailable = Math.max(availablePool.get(key) || 0, 0);
    row.dockStockAllocated = Math.min(row.orderQty, remainingAvailable);
    availablePool.set(key, remainingAvailable - row.dockStockAllocated);

    const stagedKey = `${row.material}|${stagingBin(row.referenceDocument)}`;
    const remainingStaged = Math.max(stagedPool.get(stagedKey) || 0, 0);
    row.pickedStockAllocated = Math.min(row.orderQty, remainingStaged);
    stagedPool.set(stagedKey, remainingStaged - row.pickedStockAllocated);
  }

  return sorted;
}