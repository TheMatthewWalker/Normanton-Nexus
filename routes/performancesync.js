import * as sap from './performancesap.js';
import * as db from '../routes/performancesql.js';

import { allocateStock } from './performanceallocation.js';
import {
  buildValueStreamLookup,
  enrichWithValueStream,
  computeTodayStockAndPickedTotals
} from './performancevaluestream.js';

async function syncStockAndAgreements(stockRows, agreementRows, valueStreamByMaterial) {
  const stockRunId = await db.startRefresh('Stock');
  const agreementsRunId = await db.startRefresh('Agreements');

  try {
    const allocated = allocateStock(agreementRows, stockRows);

    enrichWithValueStream(stockRows, valueStreamByMaterial);

    await db.replaceStockSnapshot(stockRows);
    await db.completeRefresh(stockRunId, stockRows.length);

    await db.replaceAgreementSnapshot(allocated);
    await db.completeRefresh(agreementsRunId, allocated.length);

    const todayTotals = computeTodayStockAndPickedTotals(allocated);
    await db.upsertTodayStockAndPicked(todayTotals);

    return [
      { name: 'Stock', status: 'success', rowCount: stockRows.length },
      { name: 'Agreements', status: 'success', rowCount: allocated.length }
    ];
  } catch (err) {
    await db.failRefresh(stockRunId, err.message);
    await db.failRefresh(agreementsRunId, err.message);

    return [
      { name: 'Stock', status: 'failed', error: err.message },
      { name: 'Agreements', status: 'failed', error: err.message }
    ];
  }
}

async function syncInvoicing(rows, valueStreamByMaterial) {
  const runId = await db.startRefresh('Invoicing');

  try {
    enrichWithValueStream(rows, valueStreamByMaterial);
    await db.replaceInvoiceSnapshot(rows);
    await db.recomputeDailyInvoiced();
    await db.completeRefresh(runId, rows.length);

    return { name: 'Invoicing', status: 'success', rowCount: rows.length };
  } catch (err) {
    await db.failRefresh(runId, err.message);
    return { name: 'Invoicing', status: 'failed', error: err.message };
  }
}

async function syncOtif(rows, valueStreamByMaterial) {
  const runId = await db.startRefresh('Otif');

  try {
    enrichWithValueStream(rows, valueStreamByMaterial);
    await db.replaceOtifSnapshot(rows);
    await db.recomputeDailyOtif();
    await db.completeRefresh(runId, rows.length);

    return { name: 'Otif', status: 'success', rowCount: rows.length };
  } catch (err) {
    await db.failRefresh(runId, err.message);
    return { name: 'Otif', status: 'failed', error: err.message };
  }
}

export async function runFullRefresh(req) {
  
const now = new Date();

const fromDate30 = new Date();
fromDate30.setDate(now.getDate() - 30);

const fromDate365 = new Date();
fromDate365.setDate(now.getDate() - 365);

  const [stockResult, agreementsResult, invoicingResult, otifResult] =
    await Promise.allSettled([
      sap.getStock(req),
      sap.getAgreements(req),
      sap.getInvoicing(req, fromDate30, now),
      sap.getOtif(req, fromDate365, now)
    ]);

  const results = [];

  const agreementRows =
    agreementsResult.status === 'fulfilled' ? agreementsResult.value : [];

  const valueStreamByMaterial = buildValueStreamLookup(agreementRows);

  if (stockResult.status === 'fulfilled' && agreementsResult.status === 'fulfilled') {
    results.push(
      ...(await syncStockAndAgreements(
        stockResult.value,
        agreementsResult.value,
        valueStreamByMaterial
      ))
    );
  } else {
    if (stockResult.status === 'rejected') {
      results.push({
        name: 'Stock',
        status: 'failed',
        error: stockResult.reason.message
      });
    }

    if (agreementsResult.status === 'rejected') {
      results.push({
        name: 'Agreements',
        status: 'failed',
        error: agreementsResult.reason.message
      });
    }
  }

  if (invoicingResult.status === 'fulfilled') {
    results.push(await syncInvoicing(invoicingResult.value, valueStreamByMaterial));
  } else {
    results.push({
      name: 'Invoicing',
      status: 'failed',
      error: invoicingResult.reason.message
    });
  }

  if (otifResult.status === 'fulfilled') {
    results.push(await syncOtif(otifResult.value, valueStreamByMaterial));
  } else {
    results.push({
      name: 'Otif',
      status: 'failed',
      error: otifResult.reason.message
    });
  }

  return results;
}
