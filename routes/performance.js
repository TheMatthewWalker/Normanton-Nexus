import express from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { runFullRefresh, runTurnsValClassRefresh } from '../routes/performancesync.js';
import * as sap from './performancesap.js';
import * as db  from './performancesql.js';
import sql from 'mssql';
import ExcelJS from 'exceljs';
import { sqlConfig, auditQuery } from '../config.js';
import { requirePermission, requireSessionOrApiToken } from '../middleware/auth.js';

async function getPool() {
  return await sql.connect(sqlConfig);
}

// ── Weekly expected-stock-level forecast ────────────────────────────────────
// Projects stock forward week by week from a current total, driven by the 13
// monthly PredictedUsage buckets already computed by the seasonal-index model
// (performanceforecast.js), optionally overridden day-by-day by manual
// dbo.DemandAdjustment rows (see makeDailyUsageFn below). This is Phase 1: no
// confirmed-delivery data exists yet (that's a later phase), so the line only
// ever goes down on its own; it does not yet show deliveries putting stock
// back up (that's incomingDeliveries, added separately below).
//
// predictedMonthly[i] is month i's total, where i=0 is the CURRENT calendar
// month and i=12 is 12 months out — see the big comment on PredictedUsage
// in create_performance_turnsvalclass_database.sql and the frontend's
// shfLoadChart() for why array index 0 (DB column PredictedM12) means
// "current month" rather than "12 months ago" the way HistoryM12 does: both
// series reuse the same 13-column physical layout for the shared batch-insert
// helper, but History counts backward from "now" while Forecast/Predicted
// count forward from "now", so the same column names end up meaning opposite
// ends of the two timelines.
//
// Returns weeks running from "today" through the end of month index 12,
// each with the stock level AS OF that week's end date (i.e. after that
// week's share of usage has been deducted).

// Builds a day -> usage function shared by buildWeeklyStockForecast and
// demandOverDays. Both used to spread each month's total across whatever
// date range they cared about using a month-overlap-fraction shortcut
// (qty * overlapDays / daysInMonth) — mathematically identical to a flat
// per-day rate within a month, just computed without actually visiting each
// day. That shortcut broke once a demand adjustment needed to change the
// rate partway through a month (or partway through a week), since the rate
// is no longer uniform across the month — so both functions now walk day by
// day instead. Adjustments are validated not to overlap each other for the
// same material at write time (see findOverlappingDemandAdjustment in
// performancesql.js), so at most one ever applies to a given day; a NULL
// startDate/endDate on an adjustment means unbounded in that direction.
function makeDailyUsageFn(predictedMonthly, from, adjustments = []) {
  const months = predictedMonthly.map((qty, i) => {
    const monthStart = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
    const monthEnd    = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i + 1, 1));
    const daysInMonth  = Math.round((monthEnd - monthStart) / 86400000);
    return { monthStart, monthEnd, dailyRate: daysInMonth > 0 ? (Number(qty) || 0) / daysInMonth : 0 };
  });
  return function dailyUsage(day) {
    const month = months.find(m => day >= m.monthStart && day < m.monthEnd);
    let rate = month ? month.dailyRate : 0;
    for (const adj of adjustments) {
      const afterStart = !adj.startDate || day >= adj.startDate;
      const beforeEnd = !adj.endDate || day <= adj.endDate;
      if (afterStart && beforeEnd) {
        rate *= (Number(adj.usagePercent) || 0) / 100;
        break;
      }
    }
    return rate;
  };
}

function buildWeeklyStockForecast(currentStock, predictedMonthly, today, incomingDeliveries = [], adjustments = []) {
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  // Calendar-month windows for i = 0..12, each [monthStart, monthEnd) — only
  // needed here now for the overall horizon end; per-day rates come from
  // makeDailyUsageFn.
  const monthEnds = predictedMonthly.map((qty, i) =>
    new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i + 1, 1))
  );
  const horizonEnd = monthEnds[monthEnds.length - 1];
  const dailyUsage = makeDailyUsageFn(predictedMonthly, start, adjustments);

  const weeks = [];
  let runningStock = currentStock;
  let weekStart = start;

  while (weekStart < horizonEnd) {
    const weekEnd = new Date(Math.min(weekStart.getTime() + 7 * 86400000, horizonEnd.getTime()));

    // Open orders (accepted-but-not-received) expected to land this week —
    // added before that week's usage is deducted, since goods arrive then
    // get consumed. See dbo.PurchaseOrderSuggestion / listOpenIncomingOrders.
    // Empty array by default, so every existing caller that doesn't pass
    // incomingDeliveries behaves exactly as before.
    const incomingThisWeek = incomingDeliveries
      .filter(d => d.date >= weekStart && d.date < weekEnd)
      .reduce((sum, d) => sum + d.qty, 0);
    runningStock += incomingThisWeek;

    let weeklyUsage = 0;
    for (let day = weekStart; day < weekEnd; day = addDaysUtc(day, 1)) {
      weeklyUsage += dailyUsage(day);
    }

    runningStock -= weeklyUsage;
    weeks.push({
      weekEnding: weekEnd.toISOString().slice(0, 10),
      weeklyUsage: Math.round(weeklyUsage * 100) / 100,
      incomingQty: Math.round(incomingThisWeek * 100) / 100,
      expectedStock: Math.round(runningStock * 100) / 100,
    });

    weekStart = weekEnd;
  }

  return {
    asOfDate: start.toISOString().slice(0, 10),
    currentStock: Math.round(currentStock * 100) / 100,
    weeks,
  };
}

// Sums several materials' own buildWeeklyStockForecast results into one
// combined series, week by week — used by the /turns-valclass/history
// route's "all materials"/MRP-controller-filtered views. Necessary once
// demand adjustments exist: two materials in the same combined view can
// carry different (or no) adjustment, and a single blended predictedMonthly
// array built by summing raw usage up front can't represent that, so each
// material now gets its own buildWeeklyStockForecast call and the results
// are added together here instead. All forecasts share the same `today` and
// the same 13-month horizon length, so their week grids line up exactly —
// safe to sum by index. Equivalent to the old aggregate-then-forecast
// approach whenever nothing has an adjustment, since day-by-day usage is
// linear/additive either way.
function mergeWeeklyForecasts(forecasts) {
  if (!forecasts.length) return { asOfDate: null, currentStock: 0, weeks: [] };
  const weekCount = forecasts[0].weeks.length;
  const weeks = [];
  for (let i = 0; i < weekCount; i++) {
    weeks.push({
      weekEnding: forecasts[0].weeks[i].weekEnding,
      weeklyUsage: Math.round(forecasts.reduce((sum, f) => sum + f.weeks[i].weeklyUsage, 0) * 100) / 100,
      incomingQty: Math.round(forecasts.reduce((sum, f) => sum + f.weeks[i].incomingQty, 0) * 100) / 100,
      expectedStock: Math.round(forecasts.reduce((sum, f) => sum + f.weeks[i].expectedStock, 0) * 100) / 100,
    });
  }
  return {
    asOfDate: forecasts[0].asOfDate,
    currentStock: Math.round(forecasts.reduce((sum, f) => sum + f.currentStock, 0) * 100) / 100,
    weeks,
  };
}

// ── Order suggestions (MRP Phase 2b) — see sql/migrate_order_suggestions.sql for
// the full design writeup. Not just-in-time: materials are flagged off a
// maintained safety-stock FLOOR (VendorMaterial.MinSafetyStockQty, falling
// back to SAP's own MARC-EISBE), not off hitting zero — this business sees
// frequent supplier date slips, so a buffer is kept on purpose.
const ORDER_REVIEW_HORIZON_DAYS = 14;   // how far ahead to surface upcoming shortages, not just overdue ones
const ORDER_COVERAGE_BUFFER_DAYS = 30;  // extra cover beyond lead time, so the next order isn't due immediately

function addDaysUtc(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

// SAP's PLIFZ and this app's manually-maintained lead/transit time fields
// are working days, not calendar days (per SAP convention here) — so every
// date calculation actually driven by a lead or transit time (order-by
// date, delivery date, EXW ready-to-collect date) needs to skip Saturdays
// and Sundays. Calendar-day math is kept everywhere else in this file:
// demand/coverage spreading (demandOverDays, buildWeeklyStockForecast) and
// the order-review horizon aren't lead-time figures — stock keeps depleting
// over a weekend regardless of whether a supplier is open, so those stay on
// addDaysUtc. Fractional lead times (e.g. 2.5 days) are rounded to the
// nearest whole day before stepping, since fractional working days aren't
// meaningfully steppable.
function addWorkingDaysUtc(date, days) {
  const result = new Date(date.getTime());
  const step = days >= 0 ? 1 : -1;
  let remaining = Math.abs(Math.round(days));
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + step);
    const dow = result.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return result;
}

// Demand between `from` and `from + days`, using the same day-by-day
// dailyUsage as buildWeeklyStockForecast (see makeDailyUsageFn) so a demand
// adjustment applies identically here as it does to the graph — used for
// the suggested-qty calculation, which needs a demand total over an
// arbitrary day-count rather than the week-by-week series.
function demandOverDays(predictedMonthly, from, days, adjustments = []) {
  const rangeEnd = addDaysUtc(from, days);
  const dailyUsage = makeDailyUsageFn(predictedMonthly, from, adjustments);
  let total = 0;
  for (let day = from; day < rangeEnd; day = addDaysUtc(day, 1)) {
    total += dailyUsage(day);
  }
  return total;
}

// First date a weekly forecast's expectedStock drops to/below `threshold`
// (the material's safety-stock floor, not necessarily zero), with a
// same-week linear interpolation so the result is a day rather than only
// ever landing on a week-ending date.
function findStockBelowThresholdDate(weeklyForecast, asOfDate, threshold) {
  let prevStock = weeklyForecast.currentStock;
  let weekStart = asOfDate;
  for (const w of weeklyForecast.weeks) {
    const weekEnd = new Date(w.weekEnding + 'T00:00:00Z');
    if (w.expectedStock <= threshold) {
      const drop = prevStock - w.expectedStock;
      const frac = drop > 0 ? Math.max(0, Math.min(1, (prevStock - threshold) / drop)) : 0;
      const weekMs = weekEnd.getTime() - weekStart.getTime();
      return new Date(weekStart.getTime() + frac * weekMs);
    }
    prevStock = w.expectedStock;
    weekStart = weekEnd;
  }
  return null; // never projected to breach the floor within the 13-month horizon
}

// The live "what needs ordering" computation. Nothing here is persisted until
// a suggestion is accepted (db.acceptOrderSuggestion) — this always reflects
// current stock/usage/vendor data, recomputed fresh on every request.
function groupIncomingByMaterial(incoming) {
  const map = new Map();
  incoming.forEach(r => {
    const list = map.get(r.Material) || [];
    list.push(r);
    map.set(r.Material, list);
  });
  return map;
}

// Shapes raw dbo.DemandAdjustment rows into the {startDate, endDate,
// usagePercent} form makeDailyUsageFn expects, normalizing StartDate/
// EndDate to UTC-midnight Date objects (or null, preserved as-is — a NULL
// bound means unbounded, see migrate_demand_adjustments.sql's header).
function groupAdjustmentsByMaterial(adjustments) {
  const map = new Map();
  adjustments.forEach(r => {
    const list = map.get(r.Material) || [];
    list.push({
      startDate: r.StartDate ? new Date(r.StartDate) : null,
      endDate: r.EndDate ? new Date(r.EndDate) : null,
      usagePercent: r.UsagePercent,
    });
    map.set(r.Material, list);
  });
  return map;
}

// One vendor-material row's full suggestion picture — used both for the
// "needs ordering now" list (computeOrderSuggestions, filtered to dueNow)
// and the Build Order modal (computeVendorOrderBuild, unfiltered, so a
// buyer can pull in a material that isn't urgent yet to help clear a
// vendor's combined order MOQ). Returns null only when there's no SAP
// snapshot to compute from at all.
function buildSuggestionForRow(r, incomingByMaterial, today, asOfDate, horizonDate, adjustmentsByMaterial = new Map()) {
  if (r.StockQty == null && r.ConsignmentQty == null) return null;

  const openOrders = incomingByMaterial.get(r.Material) || [];
  const openQty = openOrders.reduce((sum, o) => sum + (Number(o.OrderQty) || 0), 0);
  const materialAdjustments = adjustmentsByMaterial.get(r.Material) || [];

  // Stock physically on hand right now — deliberately NOT including open
  // orders here. Those only help avoid a breach once they actually land;
  // an order due in December doesn't stop an October breach just because
  // it exists. See incomingDeliveries below, which times each order's
  // contribution to its real delivery week instead.
  const onHandStock = (Number(r.StockQty) || 0) + (Number(r.ConsignmentQty) || 0);
  const predictedMonthly = [
    r.PredictedM12, r.PredictedM11, r.PredictedM10, r.PredictedM09, r.PredictedM08, r.PredictedM07,
    r.PredictedM06, r.PredictedM05, r.PredictedM04, r.PredictedM03, r.PredictedM02, r.PredictedM01, r.PredictedM00
  ];

  // Manually-maintained floor takes priority over SAP's EISBE — see
  // MinSafetyStockQty's column comment in migrate_vendor_master_data.sql.
  const safetyStockQty = Number(r.MinSafetyStockQty ?? r.SapSafetyStock ?? 0);

  // Mirrors the /turns-valclass/history route's incomingDeliveries handling
  // (see buildWeeklyStockForecast's incomingThisWeek) — each open order
  // bumps the forecast only in the week it's actually due, not from today.
  // Previously this function instead added the full openQty straight onto
  // currentStock before the forecast ever ran, which meant an order due
  // to land AFTER a breach was silently treated as already available and
  // could mask the breach (and therefore the suggestion) entirely — the
  // bug reported against 30005R/Raaj Ratna: existing orders dated after
  // the 12 Oct breach date were propping up the projection so no shortage
  // was ever detected. Orders with no recorded DeliveryDate fall back to
  // "today", the same assumption this function made everywhere before.
  const incomingDeliveries = openOrders.map(o => ({
    date: o.DeliveryDate ? new Date(o.DeliveryDate) : asOfDate,
    qty: Number(o.OrderQty) || 0,
  }));

  const weeklyForecast = buildWeeklyStockForecast(onHandStock, predictedMonthly, today, incomingDeliveries, materialAdjustments);
  const breachDate = findStockBelowThresholdDate(weeklyForecast, asOfDate, safetyStockQty);

  const leadTimeDays = Number(r.LeadTimeDaysOverride ?? r.SapLeadTimeDays ?? r.DefaultLeadTimeDays ?? 0);
  const orderByDate = breachDate ? addWorkingDaysUtc(breachDate, -leadTimeDays) : null;
  const dueNow = !!(orderByDate && orderByDate <= horizonDate);
  const urgency = !breachDate ? 'NotDue' : (orderByDate < asOfDate ? 'Overdue' : (dueNow ? 'DueSoon' : 'Upcoming'));

  // Suggested qty: cover lead time + a review-cycle buffer, rebuild the
  // safety-stock floor, minus what's already on hand or already incoming.
  // Unlike the breach-date forecast above, sizing a NEW order deliberately
  // nets off the FULL open-order quantity regardless of timing — stock
  // that's already on order still shouldn't be duplicated by a fresh
  // order, it just doesn't get credited as available before its actual
  // delivery date for the purpose of deciding WHETHER a breach happens.
  // Zero (not negative) when nothing's needed — Upcoming/NotDue materials
  // still get a real number here so the Build Order modal has something
  // sensible to prefill if a buyer opts to pull one in early.
  const currentStock = onHandStock + openQty;
  let suggestedQty = 0;
  if (breachDate) {
    const coverageDays = leadTimeDays + ORDER_COVERAGE_BUFFER_DAYS;
    const demandOverCoverage = demandOverDays(predictedMonthly, asOfDate, coverageDays, materialAdjustments);
    const qty = demandOverCoverage + safetyStockQty - currentStock;
    if (qty > 0) {
      // MaterialMoqQty is a LOT SIZE, not just a floor — this vendor only
      // supplies the material in multiples of it (e.g. MOQ 1000kg means
      // 1000/2000/3000..., never 1300), so a raw shortfall gets rounded UP
      // to the next whole multiple rather than just topped up to the MOQ
      // when it's below one lot. Only applied when actually due — don't
      // inflate an "upcoming" material's number just because it has a lot
      // size of its own. MaterialMaxQty (if set) is then enforced as a hard
      // cap via the same helper the accept routes use, so the auto-suggested
      // number is never something the accept flow would have to correct.
      const moq = Number(r.MaterialMoqQty) || 0;
      const max = Number(r.MaterialMaxQty) || 0;
      const rounded = (dueNow && moq > 0) ? Math.ceil(qty / moq) * moq : qty;
      suggestedQty = (dueNow && max > 0) ? enforceMaterialQty(rounded, moq, max) : Math.round(rounded * 1000) / 1000;
    }
  }

  const isExw = (r.Incoterms || '').toUpperCase() === 'EXW';
  const transitTimeDays = isExw ? (Number(r.TransitTimeDays) || 0) : null;

  return {
    vendorMaterialId: r.VendorMaterialId,
    vendorId: r.VendorId,
    vendorName: r.VendorName,
    material: r.Material,
    materialText: r.MaterialText,
    uom: r.Uom,
    mrpController: r.MrpController,
    currentStock: Math.round(currentStock * 1000) / 1000,
    openIncomingQty: Math.round(openQty * 1000) / 1000,
    safetyStockQty,
    breachDate: breachDate ? breachDate.toISOString().slice(0, 10) : null,
    leadTimeDays,
    transitTimeDays,
    orderByDate: orderByDate ? orderByDate.toISOString().slice(0, 10) : null,
    urgency,
    dueNow,
    suggestedQty,
    materialMoqQty: r.MaterialMoqQty,
    materialMaxQty: r.MaterialMaxQty,
    orderMoqQty: r.OrderMoqQty,
    orderMaxQty: r.OrderMaxQty,
    orderMoqUom: r.OrderMoqUom,
    incoterms: r.Incoterms || null,
    isSpotPo: !r.ScheduleAgreement,
    scheduleAgreement: r.ScheduleAgreement || null,
  };
}

// The live "what needs ordering" computation. Nothing here is persisted until
// a suggestion is accepted (db.acceptOrderSuggestion) — this always reflects
// current stock/usage/vendor data, recomputed fresh on every request.
async function computeOrderSuggestions() {
  const [rows, incoming, adjustments] = await Promise.all([
    db.listVendorMaterialsForSuggestions(),
    db.listOpenIncomingOrders(),
    db.listDemandAdjustments(),
  ]);
  const incomingByMaterial = groupIncomingByMaterial(incoming);
  const adjustmentsByMaterial = groupAdjustmentsByMaterial(adjustments);

  const today = new Date();
  const asOfDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const horizonDate = addDaysUtc(asOfDate, ORDER_REVIEW_HORIZON_DAYS);

  const suggestions = [];
  for (const r of rows) {
    const built = buildSuggestionForRow(r, incomingByMaterial, today, asOfDate, horizonDate, adjustmentsByMaterial);
    if (built && built.dueNow && built.suggestedQty > 0) suggestions.push(built);
  }

  suggestions.sort((a, b) => a.orderByDate.localeCompare(b.orderByDate));
  return suggestions;
}

// Groups the flat "needs ordering" list by vendor and tallies the running
// total against that vendor's combined order-level MOQ (dbo.Vendor.
// OrderMoqQty) — without this a buyer has to manually add up several
// materials' suggested quantities themselves to know whether a single order
// would even clear the vendor's shipping/order minimum.
function groupSuggestionsByVendor(suggestions) {
  const groups = new Map();
  for (const s of suggestions) {
    if (!groups.has(s.vendorId)) {
      groups.set(s.vendorId, {
        vendorId: s.vendorId,
        vendorName: s.vendorName,
        orderMoqQty: s.orderMoqQty,
        orderMaxQty: s.orderMaxQty,
        orderMoqUom: s.orderMoqUom,
        materials: [],
      });
    }
    groups.get(s.vendorId).materials.push(s);
  }

  const result = Array.from(groups.values()).map(g => {
    const combinedQty = g.materials.reduce((sum, m) => sum + (Number(m.suggestedQty) || 0), 0);
    // Exact-quantity vendor (e.g. Raaj Ratna: exactly 20,000kg, not just at
    // least) — a min that equals the max, not two independent checks.
    const isExactQty = !!(g.orderMoqQty && g.orderMaxQty && Number(g.orderMoqQty) === Number(g.orderMaxQty));
    const moqShortfall = g.orderMoqQty ? Math.max(0, Number(g.orderMoqQty) - combinedQty) : 0;
    const moqOverage = g.orderMaxQty ? Math.max(0, combinedQty - Number(g.orderMaxQty)) : 0;
    const earliestOrderByDate = g.materials.reduce(
      (min, m) => (!min || m.orderByDate < min) ? m.orderByDate : min, null
    );
    return {
      ...g,
      combinedQty: Math.round(combinedQty * 1000) / 1000,
      isExactQty,
      moqMet: moqShortfall <= 0.001 && moqOverage <= 0.001,
      moqShortfall: Math.round(moqShortfall * 1000) / 1000,
      moqOverage: Math.round(moqOverage * 1000) / 1000,
      earliestOrderByDate,
    };
  });

  result.sort((a, b) => (a.earliestOrderByDate || '9999').localeCompare(b.earliestOrderByDate || '9999'));
  return result;
}

// Every material a vendor supplies (not just the ones currently due) so the
// Build Order modal can offer pulling a not-yet-urgent material into the
// order to help clear a combined MOQ, alongside the ones actually needed.
async function computeVendorOrderBuild(vendorId) {
  const [rows, incoming, adjustments] = await Promise.all([
    db.listVendorMaterialsForSuggestions(),
    db.listOpenIncomingOrders(),
    db.listDemandAdjustments(),
  ]);
  const incomingByMaterial = groupIncomingByMaterial(incoming);
  const adjustmentsByMaterial = groupAdjustmentsByMaterial(adjustments);

  const today = new Date();
  const asOfDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const horizonDate = addDaysUtc(asOfDate, ORDER_REVIEW_HORIZON_DAYS);

  const vendorRows = rows.filter(r => r.VendorId === vendorId);
  const materials = [];
  let vendorName = null, orderMoqQty = null, orderMaxQty = null, orderMoqUom = null;

  for (const r of vendorRows) {
    vendorName = r.VendorName;
    orderMoqQty = r.OrderMoqQty;
    orderMaxQty = r.OrderMaxQty;
    orderMoqUom = r.OrderMoqUom;
    const built = buildSuggestionForRow(r, incomingByMaterial, today, asOfDate, horizonDate, adjustmentsByMaterial);
    if (built) materials.push(built);
  }

  materials.sort((a, b) => {
    if (a.dueNow !== b.dueNow) return a.dueNow ? -1 : 1;
    return (a.orderByDate || '9999').localeCompare(b.orderByDate || '9999');
  });

  return { vendorId, vendorName, orderMoqQty, orderMaxQty, orderMoqUom, materials };
}

// A material's own lot size (MaterialMoqQty) and cap (MaterialMaxQty) are
// ENFORCED, not just hinted at in the UI — a quantity that isn't a whole
// number of lots literally can't be supplied, so it's snapped rather than
// left for a human to notice and fix. Used both when auto-computing a
// suggestion (buildSuggestionForRow) and, authoritatively, when a quantity
// is actually accepted (the /accept and /accept-batch routes re-derive moq/
// max fresh from the DB rather than trusting whatever the client sent).
// Snaps to the NEAREST multiple (not always up) since this also runs against
// manually-typed quantities, where a buyer may deliberately want fewer lots
// than the auto-suggestion — rounding up unconditionally would fight them.
function enforceMaterialQty(qty, materialMoqQty, materialMaxQty) {
  let q = Number(qty) || 0;
  const moq = Number(materialMoqQty) || 0;
  if (moq > 0) {
    q = Math.round(q / moq) * moq;
    if (q <= 0) q = moq; // never snap a genuinely-entered qty all the way to zero
  }
  const max = Number(materialMaxQty) || 0;
  if (max > 0 && q > max) {
    // Clamp to the largest whole lot that still fits under the cap, if the
    // lot size divides in; otherwise just clamp straight to the cap.
    q = moq > 0 ? Math.floor(max / moq) * moq : max;
    if (q <= 0) q = max;
  }
  return Math.round(q * 1000) / 1000;
}

// Vendor-level combined min/max/exact can't be auto-corrected the way a
// single material's lot size can — there's no non-arbitrary way to decide
// which material's quantity to bump (or trim) to close a multi-material
// gap. Enforced as a hard block instead: returns an error message when the
// total doesn't satisfy the vendor's requirement, or null when it does.
function validateVendorCombinedQty(totalQty, orderMoqQty, orderMaxQty) {
  const total = Math.round((Number(totalQty) || 0) * 1000) / 1000;
  const min = orderMoqQty != null && orderMoqQty !== '' ? Number(orderMoqQty) : null;
  const max = orderMaxQty != null && orderMaxQty !== '' ? Number(orderMaxQty) : null;

  if (min && max && min === max) {
    if (Math.abs(total - min) > 0.001) {
      return `This vendor requires an exact combined order of ${min.toLocaleString()} — this order totals ${total.toLocaleString()}.`;
    }
    return null;
  }
  if (min && total < min - 0.001) {
    return `This vendor requires a combined order of at least ${min.toLocaleString()} — this order totals ${total.toLocaleString()}.`;
  }
  if (max && total > max + 0.001) {
    return `This vendor's combined order cannot exceed ${max.toLocaleString()} — this order totals ${total.toLocaleString()}.`;
  }
  return null;
}

// Shared date-math for accepting a suggestion, used by both the single-item
// and batch accept routes so the EXW ready-to-collect logic only lives in
// one place.
function buildAcceptPayload({
  vendorMaterialId, vendorId, material, suggestedQty, orderQty, orderDateObj,
  leadTimeDays, transitTimeDays, incoterms, isSpotPo, notes, deliveryDateOverride
}) {
  const leadTime = Number(leadTimeDays) || 0;
  // A user-entered delivery date takes priority over the lead-time-derived
  // one — e.g. the vendor has confirmed a specific date that doesn't match
  // the standard lead time. Falls back to the working-days calc when absent
  // or invalid, so the default behaviour is unchanged.
  const overrideDate = deliveryDateOverride ? new Date(deliveryDateOverride) : null;
  const deliveryDate = (overrideDate && !isNaN(overrideDate.getTime()))
    ? overrideDate
    : addWorkingDaysUtc(orderDateObj, leadTime);

  // EXW: the date actually quoted to the supplier is the ready-to-collect
  // date, not the delivery date — see migrate_vendor_master_data.sql's DATE
  // MATH block. Every other Incoterm leaves these columns NULL/unused.
  const isExw = (incoterms || '').toUpperCase() === 'EXW';
  const transitTime = isExw ? (Number(transitTimeDays) || 0) : null;
  const readyToCollectDate = isExw ? addWorkingDaysUtc(deliveryDate, -(transitTime || 0)) : null;

  return {
    vendorMaterialId, vendorId, material,
    suggestedQty: suggestedQty ?? null,
    orderQty,
    orderDate: orderDateObj,
    leadTimeDaysUsed: leadTime,
    deliveryDate,
    transitTimeDaysUsed: transitTime,
    readyToCollectDate,
    isSpotPo: !!isSpotPo,
    notes: notes || null,
  };
}

// ── Supplier invoice imports (Tracked Orders / Inbound Log) ────────────────
// Mirrors routes/shipmentmain.js's export-folder pattern (assertValidExportRoot
// / mkdirRecursiveSafe / getShipmentFolderInfo) for the equivalent import-side
// folder. Files land at:
//   LOGISTICS_IMPORT_ROOT\{Year}\{MM}. {MonthName}\{ShipmentReference} - {SupplierName}\
// Year/month is the shipment's CreatedAtUtc, not today's date, so a shipment
// created near a month boundary always files under the month it was actually
// created in, even if the invoice itself is uploaded weeks later. Supplier
// name comes from the first order linked to the shipment — a shipment is
// assumed single-vendor in practice (confirmed with the business), even
// though the schema technically allows a shipment to carry orders from more
// than one vendor.
const IMPORT_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function assertValidImportRoot(importRoot) {
  const value = String(importRoot || '').trim();
  const looksValid = /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^?\\]/.test(value);
  if (!looksValid) {
    const err = new Error(
      `Logistics import folder path is misconfigured (LOGISTICS_IMPORT_ROOT resolved to "${value}"). ` +
      `Check the .env value and that no stray Machine-scope environment variable of the same name is ` +
      `shadowing it, then restart the service.`
    );
    err.statusCode = 500;
    throw err;
  }
  return value;
}

function sanitizeImportFolderSegment(value) {
  const clean = String(value || 'Unknown Supplier').replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').trim();
  return clean || 'Unknown Supplier';
}

function sanitizeImportFileSegment(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/[. ]+$/g, '')
    .trim() || 'document';
}

// Node's native fs.mkdir(path, { recursive: true }) has a known bug on
// Windows — see routes/shipmentmain.js's mkdirRecursiveSafe for the full
// writeup (surfaces as an opaque "ENOENT ... mkdir '\\?'" unrelated to
// whether the configured path is actually valid). Build each directory
// level ourselves instead of relying on the native recursive walk.
async function mkdirImportRecursiveSafe(targetPath) {
  const toCreate = [];
  let current = targetPath;
  while (true) {
    try {
      await fsp.access(current, fs.constants.F_OK);
      break; // this level (and everything above it) already exists
    } catch {
      toCreate.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) break; // reached the drive/UNC root
      current = parent;
    }
  }
  for (const dir of toCreate) {
    try {
      await fsp.mkdir(dir);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

function getShipmentImportFolderInfo(shipment, supplierName) {
  const importRoot = assertValidImportRoot(process.env.LOGISTICS_IMPORT_ROOT);
  const created = shipment.CreatedAtUtc ? new Date(shipment.CreatedAtUtc) : new Date();
  const year = String(created.getFullYear());
  const monthFolder = `${String(created.getMonth() + 1).padStart(2, '0')}. ${IMPORT_MONTH_NAMES[created.getMonth()]}`;
  const orderFolder = sanitizeImportFolderSegment(`${shipment.ShipmentReference || `Shipment ${shipment.ShipmentId}`} - ${supplierName || 'Unknown Supplier'}`);
  const monthPath = path.join(importRoot, year, monthFolder);
  return { monthPath, shipmentPath: path.join(monthPath, orderFolder) };
}

async function ensureShipmentImportFolder(shipment, supplierName) {
  const folder = getShipmentImportFolderInfo(shipment, supplierName);
  await mkdirImportRecursiveSafe(folder.monthPath);
  await mkdirImportRecursiveSafe(folder.shipmentPath);
  return folder;
}

// A shipment record (from db.getOrderShipmentWithOrders) plus the single
// supplier name derived from its first linked order — shared by all three
// document routes below so the folder-path derivation only lives in one
// place.
async function loadShipmentForImportDocs(shipmentId) {
  const record = await db.getOrderShipmentWithOrders(shipmentId);
  if (!record) { const err = new Error('Shipment not found.'); err.statusCode = 404; throw err; }
  const supplierName = record.orders?.[0]?.VendorName || '';
  return { record, supplierName };
}

const router = express.Router();

// ── Manual trigger for SAP refresh ─────────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const results = await runFullRefresh(req);
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/refresh-log', async (req, res) => {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    SELECT TOP 20 * FROM dbo.RefreshLog ORDER BY RunId DESC
  `);
  res.json({ success: true, data: recordset });
});

router.get('/refresh-status', async (req, res) => {
  try {
    const datasets = ['Stock', 'Agreements', 'Invoicing', 'Otif'];
    const pool = await getPool();
    const { recordset } = await pool.request().query(`
      SELECT TOP 80 DatasetName, Status, CompletedAtUtc, ErrorMessage, RunId
      FROM dbo.RefreshLog
      WHERE DatasetName IN ('Stock', 'Agreements', 'Invoicing', 'Otif')
      ORDER BY RunId DESC
    `);

    const latest = {};

    for (const row of recordset) {
      if (!latest[row.DatasetName]) latest[row.DatasetName] = row;
    }

    const data = datasets.map(name => ({
      name,
      status: latest[name]?.Status || 'Missing',
      completedAtUtc: latest[name]?.CompletedAtUtc || null,
      errorMessage: latest[name]?.ErrorMessage || null
    }));

    const failures = data.filter(row => row.status !== 'Success');
    const completedTimes = data
      .filter(row => row.status === 'Success' && row.completedAtUtc)
      .map(row => new Date(row.completedAtUtc).getTime())
      .filter(time => !Number.isNaN(time));

    res.json({
      success: true,
      data: {
        lastRefreshUtc: failures.length || completedTimes.length !== datasets.length
          ? null
          : new Date(Math.max(...completedTimes)).toISOString(),
        failures,
        datasets: data
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Daily performance — the trend data ────────────────────────────────────
// This is the table the eventual graphs/metrics views should query. Never query the
// *Snapshot tables for trends — they only ever hold the latest pull.

router.get('/value-metrics', async (req, res) => {
  const pool = await getPool();

  const { recordset } = await pool.request().query(`
    SELECT MetricDate, ValueStream,
           InvoicedValue, StockValue, PickedValue
    FROM dbo.DailyPerformance
    ORDER BY MetricDate
  `);

  const result = {};

  for (const row of recordset) {
    const date = row.MetricDate.toISOString().substring(0, 10);
    const vs = row.ValueStream;

    if (!result[date]) result[date] = { date };

    if (!result[date][vs]) {
      result[date][vs] = {
        invoiced: 0,
        stock: 0,
        picked: 0
      };
    }

    result[date][vs].invoiced += row.InvoicedValue || 0;
    result[date][vs].stock += row.StockValue || 0;
    result[date][vs].picked += row.PickedValue || 0;
  }

  res.json({
    success: true,
    data: Object.values(result)
  });
});



router.get('/otif-metrics', async (req, res) => {
  const pool = await getPool();
  const unknownCentres = new Set();

  const { recordset } = await pool.request().query(`
    SELECT MetricDate, ValueStream,
           OtifOnTimeCount, OtifTotalCount
    FROM dbo.DailyPerformance
    ORDER BY MetricDate
  `);

  const result = {};

  for (const row of recordset) {
    const date = row.MetricDate.toISOString().substring(0, 10);
    const vs = row.ValueStream;

    if (!result[date]) result[date] = { date };

    if (!result[date][vs]) {
      result[date][vs] = {
        onTime: 0,
        total: 0,
        otif: 0
      };
    }

    result[date][vs].onTime += row.OtifOnTimeCount || 0;
    result[date][vs].total += row.OtifTotalCount || 0;

    const total = result[date][vs].total;

    result[date][vs].otif =
      total > 0
        ? result[date][vs].onTime / total
        : 0;
  }

  res.json({
    success: true,
    data: Object.values(result)
  });
});

// ── Order book summary ─────────────────────────────────────────────
router.get('/orderbook-summary', async (req, res, next) => {
  try {
    const rows = await db.getOrderBookSummary();

    res.json({
      success: true,
      data: rows.map(r => ({
        year: Number(r.Year),
        month: Number(r.Month),
        valueStream: r.ValueStream,

        orders: Number(r.OrdersValue || 0),
        stock: Number(r.StockValue || 0),
        picked: Number(r.PickedValue || 0)
      }))
    });

  } catch (err) {
    next(err);
  }
});

// ── Order book full breakdown (Customer > Order > Material) ─────────────────
router.get('/orderbook-breakdown', async (req, res, next) => {
  try {
    const rows = await db.getOrderBookBreakdown();

    res.json({
      success: true,
      data: rows.map(r => ({
        valueStream: r.ValueStream,
        customer: r.Customer,
        customerName: r.CustomerName || r.Customer,
        referenceDocument: r.ReferenceDocument,
        material: r.Material,
        materialText: r.MaterialText,
        requestDate: r.RequestDate ? new Date(r.RequestDate).toISOString().slice(0, 10) : null,

        orderQty: Number(r.OrderQty || 0),
        orderValue: Number(r.OrderValue || 0),
        stockQty: Number(r.StockQty || 0),
        stockValue: Number(r.StockValue || 0),
        pickedQty: Number(r.PickedQty || 0),
        pickedValue: Number(r.PickedValue || 0)
      }))
    });

  } catch (err) {
    next(err);
  }
});

// "On or before the current month" — same comparison the Month End
// Breakdown modal applies client-side (management.js isOnOrBeforeCurrentMonth),
// mirrored here so ?mode=monthEnd on the export applies the identical filter.
// Uses UTC accessors since RequestDate comes back from mssql as a UTC
// midnight Date (the SQL side truncates it via CONVERT(...,112), and this
// file's tedious config defaults to useUTC=true — see performancesql.js).
function isOnOrBeforeCurrentMonth(date) {
  if (!date) return false;

  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return false;

  const today = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const cy = today.getUTCFullYear();
  const cm = today.getUTCMonth() + 1;

  return y < cy || (y === cy && m <= cm);
}

// Feeds the Next Month tab — orders due in the calendar month immediately
// after the current one, i.e. the pool a planner might pull forward to help
// meet this month's target if Month End Breakdown shows a shortfall.
function isInNextCalendarMonth(date) {
  if (!date) return false;

  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return false;

  const today = new Date();
  const next = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));

  return d.getUTCFullYear() === next.getUTCFullYear() && d.getUTCMonth() === next.getUTCMonth();
}

// 1-based column index -> Excel letter ('A', 'B', ..., 'Z', 'AA', ...).
// Used to build cell references for the Stock/Picked Value formulas below —
// computed from ws.getColumn(key).number rather than hardcoded, so the
// formulas stay correct if the column order in ws.columns ever changes.
function excelColumnLetter(n) {
  let letter = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

// ── Order book full breakdown — Excel export (Dashboard + Data) ─────────────
// ?mode=monthEnd applies the same on-or-before-current-month filter as the
// Breakdown for Month End modal; otherwise exports the full unfiltered
// dataset (same query as the JSON route above).
//
// Two sheets:
//   Dashboard — summary cards (Invoiced to date, Invoiced+Picked, Invoiced+
//   Potential Stock, and a Risk card). Every total except "Invoiced to date"
//   is a live SUMIFS/COUNTIFS formula against the Data sheet, scoped to
//   ValueStream = PTFE, so it recalculates as planners edit Stock Qty /
//   Picked Qty / Risk there. "Invoiced to date" comes from real SAP billing
//   documents (dbo.InvoiceSnapshot via dbo.DailyPerformance) — there's
//   nothing on the Data sheet to compute it from, so it's written as a plain
//   value, accurate as of the moment this file was generated.
//   Data — the row-level export (as before), plus two new blank columns:
//   Risk and Reason. Flagging a row "x" in Risk excludes its Stock Value
//   from the Invoiced + Potential Stock card and rolls it into the Risk
//   card instead ("we may or may not get it").
router.get('/orderbook-breakdown/export', async (req, res) => {
  try {
    const mode = req.query.mode === 'monthEnd' ? 'monthEnd' : 'full';

    let [allRows, invoicedToDate, lineNotesMap] = await Promise.all([
      db.getOrderBookBreakdown(),
      db.getPtfeInvoicedMonthToDate(),
      db.listOrderBookLineNotes()
    ]);

    let rows = allRows;
    if (mode === 'monthEnd') {
      rows = rows.filter(r => isOnOrBeforeCurrentMonth(r.RequestDate));
      // Month End Breakdown is PTFE-only — the Full Breakdown export (mode
      // !== 'monthEnd') is left showing every value stream, unchanged.
      rows = rows.filter(r => r.ValueStream === 'PTFE');
    }

    // Next Month tab — PTFE orders due the calendar month after this one,
    // so a planner can spot candidates to bring forward. Only built for the
    // Month End export; drawn from allRows (unfiltered by date) rather than
    // rows, since rows has already been narrowed to "this month or earlier".
    const nextMonthRows = mode === 'monthEnd'
      ? allRows.filter(r => r.ValueStream === 'PTFE' && isInNextCalendarMonth(r.RequestDate))
      : [];

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Kongsberg Portal';
    wb.created = new Date();
    // Forces Excel to fully recalculate every formula the moment this file is
    // opened, regardless of the user's Automatic/Manual calculation setting —
    // without this, a workbook opened in an Excel session left in Manual mode
    // (an application-level setting that can carry over from a previous file)
    // would keep showing the cached 0 values this file was generated with
    // until the user presses F9, which looks exactly like "the formula is
    // stuck" even though it isn't.
    wb.calcProperties = { fullCalcOnLoad: true };

    // Dashboard added first so it lands as the left-most/active tab.
    const dashboardWs = wb.addWorksheet('Dashboard');
    const dataWs = wb.addWorksheet('Data');

    // ── Data sheet ────────────────────────────────────────────────────────
    dataWs.columns = [
      { header: 'Value Stream',  key: 'valueStream',       width: 14 },
      { header: 'Customer',      key: 'customer',          width: 14 },
      { header: 'Customer Name', key: 'customerName',      width: 30 },
      { header: 'Order',         key: 'referenceDocument', width: 14 },
      { header: 'Date',          key: 'requestDate',       width: 14 },
      { header: 'Material',      key: 'material',          width: 16 },
      { header: 'Order Qty',     key: 'orderQty',          width: 14 },
      { header: 'Order Value',   key: 'orderValue',        width: 14 },
      { header: 'Stock Qty',     key: 'stockQty',          width: 14 },
      { header: 'Stock Value',   key: 'stockValue',        width: 14 },
      { header: 'Picked Qty',    key: 'pickedQty',         width: 14 },
      { header: 'Picked Value',  key: 'pickedValue',       width: 14 },
      { header: 'Risk',          key: 'risk',              width: 8 },
      { header: 'Won\'t Get',    key: 'wontGet',           width: 10 },
      { header: 'Reason',        key: 'reason',            width: 34 },
      { header: 'Last Day',                key: 'lastDay',               width: 10 },
      { header: 'Last Day Time',           key: 'lastDayTime',           width: 14 },
      { header: 'Planned Production Qty',  key: 'plannedProductionQty',  width: 16 },
      { header: 'Planned Production Value',key: 'plannedProductionValue',width: 18 },
      { header: 'At Risk Seq',             key: 'atRiskSeq',             width: 10 }
    ];

    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
    const headerFont = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    const border      = { style: 'thin', color: { argb: 'FFBFCAD4' } };
    const cellBorder  = { top: border, bottom: border, left: border, right: border };
    const oddFill     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    const evenFill    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEF4' } };
    // Pale yellow — flags Risk/Reason as the two columns planners type into.
    const inputFill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9DB' } };

    const headerRow = dataWs.getRow(1);
    headerRow.height = 22;
    headerRow.eachCell(cell => {
      cell.fill      = headerFill;
      cell.font      = headerFont;
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
      cell.border    = cellBorder;
    });

    // Stock Value / Picked Value are written as live formulas, not static
    // numbers — this file goes to planners who manually overwrite Stock Qty /
    // Picked Qty with expected month-end figures that haven't landed in SAP
    // yet, and the Value cells need to recalculate automatically as they type.
    // Formula mirrors the SQL-side valuation exactly (see getOrderBookBreakdown
    // in performancesql.js): qty * (OrderValue / OrderQty), guarded against
    // OrderQty = 0.
    const orderQtyCol    = excelColumnLetter(dataWs.getColumn('orderQty').number);
    const orderValueCol  = excelColumnLetter(dataWs.getColumn('orderValue').number);
    const stockQtyCol    = excelColumnLetter(dataWs.getColumn('stockQty').number);
    const stockValueCol  = excelColumnLetter(dataWs.getColumn('stockValue').number);
    const pickedQtyCol   = excelColumnLetter(dataWs.getColumn('pickedQty').number);
    const pickedValueCol = excelColumnLetter(dataWs.getColumn('pickedValue').number);
    const valueStreamCol = excelColumnLetter(dataWs.getColumn('valueStream').number);
    const riskCol        = excelColumnLetter(dataWs.getColumn('risk').number);
    const wontGetCol     = excelColumnLetter(dataWs.getColumn('wontGet').number);
    const lastDayCol              = excelColumnLetter(dataWs.getColumn('lastDay').number);
    const lastDayTimeCol          = excelColumnLetter(dataWs.getColumn('lastDayTime').number);
    const plannedProductionQtyCol = excelColumnLetter(dataWs.getColumn('plannedProductionQty').number);
    const plannedProductionValueCol = excelColumnLetter(dataWs.getColumn('plannedProductionValue').number);
    const materialCol            = excelColumnLetter(dataWs.getColumn('material').number);
    const referenceDocumentCol   = excelColumnLetter(dataWs.getColumn('referenceDocument').number);
    const atRiskSeqCol           = excelColumnLetter(dataWs.getColumn('atRiskSeq').number);
    // Hidden running-count helper: numbers PTFE rows flagged Risk = "x" in the
    // order they appear (1, 2, 3…), so the Dashboard's At-Risk Lines list can
    // pull them out with plain INDEX/MATCH — no TEXTJOIN, no dynamic arrays,
    // no CSE. Works identically on every Excel version, unlike the old
    // array-formula approach.
    dataWs.getColumn('atRiskSeq').hidden = true;

    rows.forEach((r, i) => {
      const excelRow = i + 2; // header occupies row 1

      // Prefill from whatever a previous planner already flagged and
      // uploaded for this exact order/material — see
      // dbo.OrderBookLineNotes / listOrderBookLineNotes — so downloading
      // fresh never starts from a blank sheet and duplicates work already
      // done.
      const notes = lineNotesMap.get(`${r.ReferenceDocument}||${r.Material}`) || {};

      const row = dataWs.addRow({
        valueStream: r.ValueStream,
        customer: r.Customer,
        customerName: r.CustomerName || r.Customer,
        referenceDocument: r.ReferenceDocument,
        requestDate: r.RequestDate ? new Date(r.RequestDate).toISOString().slice(0, 10) : '',
        material: r.Material,
        orderQty: Number(r.OrderQty || 0),
        orderValue: Number(r.OrderValue || 0),
        stockQty: Number(r.StockQty || 0),
        pickedQty: Number(r.PickedQty || 0),
        risk: notes.risk || '',
        wontGet: notes.wontGet || '',
        reason: notes.reason || '',
        lastDay: notes.lastDay || '',
        lastDayTime: notes.lastDayTime || '',
        // Defaults to Order Qty — planners can overtype per line, but this
        // way the Value-by-Hour "Planned" bucket and the Invoiced + Planned
        // card start from what was actually ordered rather than what's
        // physically in stock right now.
        plannedProductionQty: Number(r.OrderQty || 0)
        // stockValue / pickedValue / plannedProductionValue / atRiskSeq set as
        // formulas below.
      });

      row.getCell('stockValue').value = {
        formula: `IF(${orderQtyCol}${excelRow}>0,${stockQtyCol}${excelRow}*(${orderValueCol}${excelRow}/${orderQtyCol}${excelRow}),0)`,
        result: Number(r.StockValue || 0)
      };
      row.getCell('pickedValue').value = {
        formula: `IF(${orderQtyCol}${excelRow}>0,${pickedQtyCol}${excelRow}*(${orderValueCol}${excelRow}/${orderQtyCol}${excelRow}),0)`,
        result: Number(r.PickedValue || 0)
      };
      // Planned Production Value — same valuation formula as Stock/Picked Value,
      // but driven off Planned Production Qty (defaults to Stock Qty above, so
      // this starts out equal to Stock Value until a planner overtypes it).
      row.getCell('plannedProductionValue').value = {
        formula: `IF(${orderQtyCol}${excelRow}>0,${plannedProductionQtyCol}${excelRow}*(${orderValueCol}${excelRow}/${orderQtyCol}${excelRow}),0)`,
        result: Number(r.StockValue || 0)
      };
      // Running count of PTFE rows flagged Risk = "x", in row order — the
      // Dashboard's At-Risk Lines list uses this with INDEX/MATCH to pull out
      // the 1st, 2nd, 3rd… flagged line. Blank ("") when this row isn't a
      // flagged PTFE row, so MATCH skips straight past it.
      row.getCell('atRiskSeq').value = {
        formula: `IF(AND(${valueStreamCol}${excelRow}="PTFE",${riskCol}${excelRow}="x"),COUNTIFS($${riskCol}$2:$${riskCol}${excelRow},"x",$${valueStreamCol}$2:$${valueStreamCol}${excelRow},"PTFE"),"")`,
        result: ''
      };

      // Risk is a manual flag ("x" = we may not actually get this stock) —
      // a dropdown keeps entries consistent, though SUMIFS/COUNTIFS on the
      // Dashboard match "x" case-insensitively regardless.
      row.getCell('risk').dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"x"']
      };
      row.getCell('risk').alignment   = { horizontal: 'center' };

      // Won't Get is a separate, stronger flag than Risk — "x" here means
      // confirmed, not maybe. Kept as its own column (rather than a second
      // value in the Risk dropdown) so the two can never be confused when
      // filtering, and so a row can't accidentally be both at once without
      // it being obvious on the sheet.
      row.getCell('wontGet').dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"x"']
      };
      row.getCell('wontGet').alignment = { horizontal: 'center' };

      row.getCell('reason').alignment = { horizontal: 'left', vertical: 'top', wrapText: true };

      // Last Day — same "x" flag pattern as Risk: marks a line as due on the
      // last day of the month, with a free-text time next to it (kept as plain
      // text rather than an Excel time value so planners can write "TBC",
      // "AM", etc. as well as a clock time).
      row.getCell('lastDay').dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"x"']
      };
      row.getCell('lastDay').alignment     = { horizontal: 'center' };
      row.getCell('lastDayTime').alignment = { horizontal: 'center' };

      const fill = i % 2 === 0 ? oddFill : evenFill;
      row.eachCell(cell => {
        cell.fill   = fill;
        cell.font   = { name: 'Arial', size: 10, color: { argb: 'FF000000' } };
        cell.border = cellBorder;
      });

      // Override the alternating fill on every manual-entry column so they
      // stand out from the SAP-sourced / formula columns.
      row.getCell('risk').fill                  = inputFill;
      row.getCell('wontGet').fill                = inputFill;
      row.getCell('reason').fill                 = inputFill;
      row.getCell('lastDay').fill                = inputFill;
      row.getCell('lastDayTime').fill            = inputFill;
      row.getCell('plannedProductionQty').fill   = inputFill;
    });

    ['orderQty', 'stockQty', 'pickedQty', 'plannedProductionQty'].forEach(key => {
      dataWs.getColumn(key).numFmt = '#,##0';
    });
    ['orderValue', 'stockValue', 'pickedValue'].forEach(key => {
      dataWs.getColumn(key).numFmt = '#,##0.00';
    });

    dataWs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: dataWs.columns.length } };
    dataWs.views = [{ state: 'frozen', ySplit: 1 }];

    // ── Next Month sheet (Month End export only) ────────────────────────────
    // PTFE orders due the calendar month after this one — a candidate pool
    // to pull forward if the Data tab shows this month falling short. Bring
    // Forward is the same "x" flag pattern as Risk/Last Day, and round-trips
    // through the same notes upload as the Data tab (see
    // dbo.OrderBookLineNotes.BringForward) — it's purely a planning flag,
    // nothing in this app acts on it automatically.
    if (mode === 'monthEnd') {
      const nextMonthWs = wb.addWorksheet('Next Month');
      nextMonthWs.columns = [
        { header: 'Customer',      key: 'customer',          width: 14 },
        { header: 'Customer Name', key: 'customerName',      width: 30 },
        { header: 'Order',         key: 'referenceDocument', width: 14 },
        { header: 'Date',          key: 'requestDate',       width: 14 },
        { header: 'Material',      key: 'material',          width: 16 },
        { header: 'Order Qty',     key: 'orderQty',          width: 14 },
        { header: 'Order Value',   key: 'orderValue',        width: 14 },
        { header: 'Bring Forward', key: 'bringForward',      width: 14 },
      ];

      const nmHeaderRow = nextMonthWs.getRow(1);
      nmHeaderRow.height = 22;
      nmHeaderRow.eachCell(cell => {
        cell.fill      = headerFill;
        cell.font      = headerFont;
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
        cell.border    = cellBorder;
      });

      nextMonthRows.forEach((r, i) => {
        const notes = lineNotesMap.get(`${r.ReferenceDocument}||${r.Material}`) || {};

        const row = nextMonthWs.addRow({
          customer: r.Customer,
          customerName: r.CustomerName || r.Customer,
          referenceDocument: r.ReferenceDocument,
          requestDate: r.RequestDate ? new Date(r.RequestDate).toISOString().slice(0, 10) : '',
          material: r.Material,
          orderQty: Number(r.OrderQty || 0),
          orderValue: Number(r.OrderValue || 0),
          bringForward: notes.bringForward || '',
        });

        row.getCell('bringForward').dataValidation = { type: 'list', allowBlank: true, formulae: ['"x"'] };
        row.getCell('bringForward').alignment = { horizontal: 'center' };

        const fill = i % 2 === 0 ? oddFill : evenFill;
        row.eachCell(cell => {
          cell.fill   = fill;
          cell.font   = { name: 'Arial', size: 10, color: { argb: 'FF000000' } };
          cell.border = cellBorder;
        });
        row.getCell('bringForward').fill = inputFill;
      });

      nextMonthWs.getColumn('orderQty').numFmt   = '#,##0';
      nextMonthWs.getColumn('orderValue').numFmt = '#,##0.00';
      nextMonthWs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: nextMonthWs.columns.length } };
      nextMonthWs.views = [{ state: 'frozen', ySplit: 1 }];
    }

    // ── Dashboard sheet ──────────────────────────────────────────────────
    const dataStockRange  = `'Data'!$${stockValueCol}:$${stockValueCol}`;
    const dataPickedRange = `'Data'!$${pickedValueCol}:$${pickedValueCol}`;
    const dataStreamRange = `'Data'!$${valueStreamCol}:$${valueStreamCol}`;
    const dataRiskRange   = `'Data'!$${riskCol}:$${riskCol}`;
    const dataWontGetRange = `'Data'!$${wontGetCol}:$${wontGetCol}`;
    const dataLastDayRange              = `'Data'!$${lastDayCol}:$${lastDayCol}`;
    const dataPlannedQtyRange           = `'Data'!$${plannedProductionQtyCol}:$${plannedProductionQtyCol}`;
    const dataPlannedValueRange         = `'Data'!$${plannedProductionValueCol}:$${plannedProductionValueCol}`;

    // Bounded (not full-column) ranges for the two array-style formulas below
    // (At-Risk Lines list, Value-by-Hour table) — SUMPRODUCT/TEXTJOIN over a
    // full column is needlessly slow, so these are capped generously past the
    // current row count to leave room for rows added later.
    const maxDataRow = Math.max(2000, rows.length + 500);
    const b = (col) => `'Data'!$${col}$2:$${col}$${maxDataRow}`;
    const dataStreamRangeB      = b(valueStreamCol);
    const dataRiskRangeB        = b(riskCol);
    const dataLastDayRangeB     = b(lastDayCol);
    const dataLastDayTimeRangeB = b(lastDayTimeCol);
    const dataStockRangeB       = b(stockValueCol);
    const dataPlannedValueRangeB      = b(plannedProductionValueCol);
    const dataReferenceDocumentRangeB = b(referenceDocumentCol);

    // Cached display values (Excel recalculates the live formulas on open) —
    // computed the same way the formulas will: no rows are flagged Risk yet
    // at export time, so the "potential stock" total starts out equal to the
    // full stock total and the Risk card starts at zero.
    const ptfeRows = rows.filter(r => r.ValueStream === 'PTFE');
    const pickedTotalPtfe    = ptfeRows.reduce((sum, r) => sum + Number(r.PickedValue || 0), 0);
    const stockTotalPtfe     = ptfeRows.reduce((sum, r) => sum + Number(r.StockValue  || 0), 0);
    const invoicedPlusPicked = invoicedToDate + pickedTotalPtfe;
    const invoicedPlusStock  = invoicedPlusPicked + stockTotalPtfe;

    dashboardWs.columns = [
      { key: 'a', width: 16 }, { key: 'b', width: 16 }, { key: 'c', width: 16 },
      { key: 'd', width: 16 }, { key: 'e', width: 16 }, { key: 'f', width: 16 }
    ];

    const titleFill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
    const titleFont      = { name: 'Arial', bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    const subFont        = { name: 'Arial', italic: true, size: 10, color: { argb: 'FF666666' } };
    const cardLabelFill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
    const cardLabelFont  = { name: 'Arial', bold: true, size: 10, color: { argb: 'FF1F3864' } };
    const cardValueFont  = { name: 'Arial', bold: true, size: 20, color: { argb: 'FF1F3864' } };
    const cardDescFont   = { name: 'Arial', italic: true, size: 9, color: { argb: 'FF666666' } };
    const riskLabelFill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8CBAD' } };
    const riskLabelFont  = { name: 'Arial', bold: true, size: 10, color: { argb: 'FF9C0006' } };
    const riskValueFont  = { name: 'Arial', bold: true, size: 20, color: { argb: 'FFC00000' } };
    const centerMiddle   = { horizontal: 'center', vertical: 'middle', wrapText: true };

    function setMergedCell(range, value, font, fill, alignment) {
      dashboardWs.mergeCells(range);
      const cell = dashboardWs.getCell(range.split(':')[0]);
      cell.value = value;
      if (font) cell.font = font;
      if (fill) cell.fill = fill;
      cell.alignment = alignment || centerMiddle;
      return cell;
    }

    const monthLabel = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const modeLabel = mode === 'monthEnd' ? 'Month End Breakdown' : 'Full Breakdown';
    // Date + time, not just date — this is the one clock-in-time reference point
    // for every "as of the moment this file was generated" note on the sheet
    // (Invoiced to date, Risk/Last Day/Planned Production starting at their
    // export-time values), so it needs to be precise enough to tell two
    // exports from the same day apart.
    const generatedAt = new Date().toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    dashboardWs.getRow(1).height = 28;
    setMergedCell('A1:F1', 'PTFE Order Book Dashboard', titleFont, titleFill);
    dashboardWs.getRow(2).height = 18;
    setMergedCell('A2:F2', `${modeLabel} — generated ${generatedAt}`, subFont, null);

    // Card 1 — Invoiced to date
    setMergedCell('A4:F4', `INVOICED TO DATE (PTFE — ${monthLabel})`, cardLabelFont, cardLabelFill);
    dashboardWs.getRow(5).height = 30;
    const invoicedCell = setMergedCell('A5:F5', invoicedToDate, cardValueFont, null);
    invoicedCell.numFmt = '#,##0.00';
    setMergedCell('A6:F6', 'From SAP billing documents, as of the moment this file was generated — not a live formula.', cardDescFont, null);

    // Card 2 — Invoiced + Picked
    setMergedCell('A8:F8', 'INVOICED + PICKED (PTFE)', cardLabelFont, cardLabelFill);
    dashboardWs.getRow(9).height = 30;
    const pickedCardCell = setMergedCell(
      'A9:F9',
      { formula: `$A$5+SUMIFS(${dataPickedRange},${dataStreamRange},"PTFE")`, result: invoicedPlusPicked },
      cardValueFont, null
    );
    pickedCardCell.numFmt = '#,##0.00';
    setMergedCell('A10:F10', 'Invoiced plus stock already picked — effectively secured.', cardDescFont, null);

    // Card 3 — Invoiced + Potential Stock. Stock Qty/Value already includes
    // picked stock (picked is a subset of stock, not additional to it), so
    // this does NOT also add Picked Value on top — that would double-count
    // whatever's already been picked.
    setMergedCell('A12:F12', 'INVOICED + POTENTIAL STOCK (PTFE)', cardLabelFont, cardLabelFill);
    dashboardWs.getRow(13).height = 30;
    const stockCardCell = setMergedCell(
      'A13:F13',
      {
        formula: `$A$5+SUMIFS(${dataStockRange},${dataStreamRange},"PTFE",${dataRiskRange},"<>x",${dataWontGetRange},"<>x")`,
        result: invoicedToDate + stockTotalPtfe
      },
      cardValueFont, null
    );
    stockCardCell.numFmt = '#,##0.00';
    setMergedCell('A14:F14', 'Full month-end prediction: invoiced + stock not flagged at risk or Won\'t Get on the Data tab. Stock Value already includes anything picked, so Picked Value isn\'t added again here.', cardDescFont, null);

    // Card 4 — Invoiced + Planned. Excludes rows flagged Last Day = "x" —
    // those are tracked separately in the Final Day Total card and the
    // Value-by-Hour table below, so they're deliberately left out here to
    // avoid double-counting them in both places.
    setMergedCell('A16:F16', 'INVOICED + PLANNED (PTFE)', cardLabelFont, cardLabelFill);
    dashboardWs.getRow(17).height = 30;
    const plannedCardCell = setMergedCell(
      'A17:F17',
      {
        formula: `$A$5+SUMIFS(${dataPlannedValueRange},${dataStreamRange},"PTFE",${dataLastDayRange},"<>x",${dataWontGetRange},"<>x")`,
        result: invoicedToDate + ptfeRows.filter(r => String(r.lastDay || '').toLowerCase() !== 'x').reduce((sum, r) => sum + Number(r.StockValue || 0), 0)
      },
      cardValueFont, null
    );
    plannedCardCell.numFmt = '#,##0.00';
    setMergedCell('A18:F18', 'Invoiced plus Planned Production Value for everything NOT flagged Last Day or Won\'t Get (Last Day items are in Final Day Total below instead; Won\'t Get items are confirmed misses).', cardDescFont, null);

    // Card 4b — Final Day Total. Invoiced + Planned above, plus whatever's
    // flagged Last Day on top — the true month-end grand total once the
    // final day's production lands.
    setMergedCell('A20:F20', 'FINAL DAY TOTAL (PTFE)', cardLabelFont, cardLabelFill);
    dashboardWs.getRow(21).height = 30;
    const finalDayTotalCell = setMergedCell(
      'A21:F21',
      {
        formula: `$A$17+SUMIFS(${dataPlannedValueRange},${dataStreamRange},"PTFE",${dataLastDayRange},"x",${dataWontGetRange},"<>x")`,
        result: 0
      },
      cardValueFont, null
    );
    finalDayTotalCell.numFmt = '#,##0.00';
    setMergedCell('A22:F22', 'Invoiced + Planned (above) plus the Planned Production Value of everything flagged Last Day but NOT Won\'t Get — see the hour-by-hour breakdown below for when it lands.', cardDescFont, null);

    // Card 5 — Risk
    setMergedCell('A24:C24', 'VALUE AT RISK (PTFE)', riskLabelFont, riskLabelFill);
    setMergedCell('D24:F24', 'ITEMS FLAGGED (PTFE)', riskLabelFont, riskLabelFill);
    dashboardWs.getRow(25).height = 30;
    const riskValueCell = setMergedCell(
      'A25:C25',
      { formula: `SUMIFS(${dataStockRange},${dataStreamRange},"PTFE",${dataRiskRange},"x")`, result: 0 },
      riskValueFont, null
    );
    riskValueCell.numFmt = '#,##0.00';
    setMergedCell(
      'D25:F25',
      { formula: `COUNTIFS(${dataStreamRange},"PTFE",${dataRiskRange},"x")`, result: 0 },
      riskValueFont, null
    );
    setMergedCell('A26:F26', 'Flagged rows are excluded from Invoiced + Potential Stock above — we may or may not receive this stock. See the Risk / Reason columns on the Data tab for detail.', cardDescFont, null);

    // Card 5b — Won't Get. Deliberately separate from Risk above: this is a
    // confirmed miss, not a maybe, so it's tracked on its own so the two
    // never get conflated when someone's reading the dashboard quickly.
    setMergedCell('A28:C28', 'CONFIRMED NOT GETTING (PTFE)', riskLabelFont, riskLabelFill);
    setMergedCell('D28:F28', 'ITEMS FLAGGED (PTFE)', riskLabelFont, riskLabelFill);
    dashboardWs.getRow(29).height = 30;
    const wontGetValueCell = setMergedCell(
      'A29:C29',
      { formula: `SUMIFS(${dataStockRange},${dataStreamRange},"PTFE",${dataWontGetRange},"x")`, result: 0 },
      riskValueFont, null
    );
    wontGetValueCell.numFmt = '#,##0.00';
    setMergedCell(
      'D29:F29',
      { formula: `COUNTIFS(${dataStreamRange},"PTFE",${dataWontGetRange},"x")`, result: 0 },
      riskValueFont, null
    );
    setMergedCell('A30:F30', 'Flagged rows are excluded from Invoiced + Potential Stock, Invoiced + Planned and Final Day Total above — this stock is confirmed not coming this month. Filter the Won\'t Get column on the Data tab for detail.', cardDescFont, null);

    // Card 6 — At-risk lines detail. Excel has no true "hover tooltip" that
    // can show live, formula-driven content (native cell comments only hold
    // static text), so this pairs a hyperlink to the filtered Data tab (works
    // on every Excel version) with a short static list of the flagged lines
    // themselves — built with plain INDEX/MATCH against the hidden "At Risk
    // Seq" helper column on the Data tab, not TEXTJOIN/dynamic arrays, so it
    // evaluates correctly on any Excel version (2007 and up), not just
    // 365/2021+.
    setMergedCell('A32:F32', 'AT-RISK LINES (PTFE)', cardLabelFont, cardLabelFill);
    setMergedCell(
      'A33:F33',
      { text: 'Open the Data tab and use the Risk column filter arrow to show every flagged row', hyperlink: "#'Data'!A1" },
      { name: 'Arial', size: 10, color: { argb: 'FF1F3864' }, underline: true },
      null,
      { horizontal: 'left', vertical: 'middle' }
    );

    const atRiskListStartRow = 34;
    const atRiskListCount = 10;
    for (let idx = 0; idx < atRiskListCount; idx++) {
      const r = atRiskListStartRow + idx;
      const n = idx + 1;
      dashboardWs.getRow(r).height = 15;
      dashboardWs.mergeCells(`A${r}:F${r}`);
      const cell = dashboardWs.getCell(`A${r}`);
      cell.value = {
        formula: `IFERROR(INDEX(Data!$${materialCol}:$${materialCol},MATCH(${n},Data!$${atRiskSeqCol}:$${atRiskSeqCol},0))&" | Order "&INDEX(Data!$${referenceDocumentCol}:$${referenceDocumentCol},MATCH(${n},Data!$${atRiskSeqCol}:$${atRiskSeqCol},0))&" | £"&TEXT(INDEX(Data!$${stockValueCol}:$${stockValueCol},MATCH(${n},Data!$${atRiskSeqCol}:$${atRiskSeqCol},0)),"#,##0.00"),"")`,
        result: ''
      };
      cell.font = { name: 'Arial', size: 9, color: { argb: 'FF444444' } };
      cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    }
    setMergedCell(
      `A${atRiskListStartRow + atRiskListCount}:F${atRiskListStartRow + atRiskListCount}`,
      `Shows the first ${atRiskListCount} flagged lines, in the order they appear on the Data tab — works on every Excel version. More than ${atRiskListCount}? Use the link above for the full list. Blank rows above just mean fewer than ${atRiskListCount} are flagged.`,
      cardDescFont, null
    );

    // Card 7 — Due on last day of the month
    setMergedCell('A46:C46', 'VALUE DUE (PTFE) — LAST DAY', cardLabelFont, cardLabelFill);
    setMergedCell('D46:F46', 'ITEMS DUE (PTFE) — LAST DAY', cardLabelFont, cardLabelFill);
    dashboardWs.getRow(47).height = 30;
    const lastDayValueCell = setMergedCell(
      'A47:C47',
      { formula: `SUMIFS(${dataPlannedValueRange},${dataStreamRange},"PTFE",${dataLastDayRange},"x")`, result: 0 },
      cardValueFont, null
    );
    lastDayValueCell.numFmt = '#,##0.00';
    setMergedCell(
      'D47:F47',
      { formula: `COUNTIFS(${dataStreamRange},"PTFE",${dataLastDayRange},"x")`, result: 0 },
      cardValueFont, null
    );
    setMergedCell('A48:F48', 'What product, value and time is coming through on the last day of the month. Flag a row "x" in Last Day on the Data tab and fill in Last Day Time — filter the Data tab by Last Day to see the individual products and times.', cardDescFont, null);

    // Card 8 — Value-by-hour for Last Day items. Sourced from Planned
    // Production Value (column R) — that's the "expected production" figure,
    // not Stock Value, since Last Day items are typically not made yet.
    // ExcelJS can't create native embedded chart objects (no chart API), so
    // this pairs a live SUMPRODUCT column with Excel's built-in Data Bar
    // conditional formatting for an automatic in-cell visual. For a full axis
    // chart, select A51:C75 in Excel and Insert > Chart — a one-off manual
    // step since this file regenerates fresh on every export. Rows with Last
    // Day = "x" but no parseable Last Day Time default into the Hour 0 bucket
    // rather than being dropped.
    setMergedCell('A50:F50', 'LAST DAY — EXPECTED VALUE BY HOUR (PTFE)', cardLabelFont, cardLabelFill);

    const hourHeaderRow = 51;
    dashboardWs.getCell(`A${hourHeaderRow}`).value = 'Hour';
    dashboardWs.getCell(`B${hourHeaderRow}`).value = 'Expected Value (Planned Production)';
    dashboardWs.getCell(`C${hourHeaderRow}`).value = 'Cumulative Invoiced Total';
    [`A${hourHeaderRow}`, `B${hourHeaderRow}`, `C${hourHeaderRow}`].forEach(ref => {
      const cell = dashboardWs.getCell(ref);
      cell.font = cardLabelFont;
      cell.fill = cardLabelFill;
      cell.alignment = { horizontal: 'center', wrapText: true };
    });
    dashboardWs.mergeCells(`C${hourHeaderRow}:F${hourHeaderRow}`);

    const firstHourRow = hourHeaderRow + 1; // 52
    const lastHourRow = firstHourRow + 23;  // 75

    for (let hour = 0; hour <= 23; hour++) {
      const r = firstHourRow + hour;
      dashboardWs.getCell(`A${r}`).value = hour;
      dashboardWs.getCell(`A${r}`).alignment = { horizontal: 'center' };

      // Hour extraction is done with TEXT/LEFT/FIND rather than HOUR() —
      // HOUR() only works reliably on a genuine Excel time value, but Last
      // Day Time is free text (so planners can write "TBC" etc.), and text
      // typed or pasted in isn't always auto-converted to a real time by
      // Excel. TEXT(cell,"hh:mm") normalises a real time value to a 2-digit
      // "hh:mm" string but passes plain text straight through unchanged, so
      // this reads the hour correctly whether the cell holds a true Excel
      // time (e.g. from typing "15:00" and Excel auto-converting it) or
      // plain text (e.g. "9:00", "15:00", pasted rather than typed).
      // Defaults an unparseable/blank Last Day Time to hour 0 (per request).
      const hourExpr = `LEFT(TEXT(${dataLastDayTimeRangeB},"hh:mm"),FIND(":",TEXT(${dataLastDayTimeRangeB},"hh:mm"))-1)`;
      const valueCell = dashboardWs.getCell(`B${r}`);
      valueCell.value = {
        formula: `SUMPRODUCT((${dataStreamRangeB}="PTFE")*(${dataLastDayRangeB}="x")*(IFERROR(VALUE(${hourExpr}),0)=A${r})*${dataPlannedValueRangeB})`,
        result: 0
      };
      valueCell.numFmt = '#,##0.00';

      dashboardWs.mergeCells(`C${r}:F${r}`);
      const cumulativeCell = dashboardWs.getCell(`C${r}`);
      cumulativeCell.value = {
        formula: `$A$17+SUM($B$${firstHourRow}:B${r})`,
        result: 0
      };
      cumulativeCell.numFmt = '#,##0.00';
      cumulativeCell.font = { name: 'Arial', bold: true, size: 10, color: { argb: 'FF1F3864' } };
    }

    dashboardWs.addConditionalFormatting({
      ref: `B${firstHourRow}:B${lastHourRow}`,
      rules: [{
        type: 'dataBar',
        cfvo: [{ type: 'min' }, { type: 'max' }],
        color: { argb: 'FF638EC6' },
        priority: 1
      }]
    });

    const hourTableCaptionRow = lastHourRow + 1; // 76
    setMergedCell(
      `A${hourTableCaptionRow}:F${hourTableCaptionRow}`,
      'Data bars approximate a value-by-hour chart — this export can\'t embed a native Excel chart object. For a full axis chart, select A51:C75 and Insert > Chart. Blank/unrecognised Last Day Time defaults to the Hour 0 row.',
      cardDescFont, null
    );

    dashboardWs.views = [{ showGridLines: false }];
    wb.views = [{ activeTab: 0 }];

    const filenamePrefix = mode === 'monthEnd' ? 'orderbook_month_end' : 'orderbook_breakdown';
    const filename = `${filenamePrefix}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await wb.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('[orderbook-breakdown/export]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: { message: err.message } });
    }
  }
});

// ── Upload Month End Breakdown comments back ────────────────────────────────
// Body is the raw edited .xlsx — same "plain fetch(..., { body: file })",
// not-multipart pattern as the supplier invoice upload further down this
// file (see /order-suggestions/shipments/:shipmentId/documents/upload).
// Reads the Data and Next Month sheets back out with ExcelJS and upserts
// whatever a planner typed into Risk/Won't Get/Reason/Last Day/Last Day
// Time/Bring Forward into dbo.OrderBookLineNotes, so the next person to
// download the sheet sees it prefilled instead of starting blank.
//
// Column positions are read from the header row rather than assumed fixed
// — ExcelJS doesn't preserve the `key` metadata used when the file was
// first written (that's an ExcelJS-only construct, not part of the xlsx
// format itself), so a freshly-loaded workbook has no column keys at all.
// Matching by header text also means the upload still works if a planner
// reorders or hides columns before sending it back.
//
// requireSessionOrApiToken accepts either the normal portal session
// (web page's "Upload updated file" button) or a bearer token from
// POST /api/auth/orderbook-token (the Excel macro) — either way the
// route reads req.uploadUser for who to credit the update to.
function buildHeaderMap(headerRow) {
  const map = {};
  headerRow.eachCell((cell, colNumber) => {
    const text = String(cell.value || '').trim();
    if (text) map[text] = colNumber;
  });
  return map;
}

function readCellText(row, colNumber) {
  if (!colNumber) return '';
  const v = row.getCell(colNumber).value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ('result' in v) return String(v.result ?? '').trim();
    if ('text' in v) return String(v.text ?? '').trim();
    return '';
  }
  return String(v).trim();
}

router.post('/orderbook-breakdown/upload-notes',
  requireSessionOrApiToken,
  express.raw({
    type: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream'
    ],
    limit: '20mb'
  }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ success: false, error: { message: 'No file content received.' } });
      }

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.body);

      const dataWs = wb.getWorksheet('Data');
      if (!dataWs) {
        return res.status(400).json({ success: false, error: { message: 'This file has no "Data" sheet — is it a Month End Breakdown export?' } });
      }

      const dataHeaderMap = buildHeaderMap(dataWs.getRow(1));
      const notesByKey = new Map();

      dataWs.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return; // header

        const referenceDocument = readCellText(row, dataHeaderMap['Order']);
        const material          = readCellText(row, dataHeaderMap['Material']);
        if (!referenceDocument || !material) return;

        notesByKey.set(`${referenceDocument}||${material}`, {
          referenceDocument,
          material,
          risk:         readCellText(row, dataHeaderMap['Risk']),
          reason:       readCellText(row, dataHeaderMap['Reason']),
          wontGet:      readCellText(row, dataHeaderMap["Won't Get"]),
          lastDay:      readCellText(row, dataHeaderMap['Last Day']),
          lastDayTime:  readCellText(row, dataHeaderMap['Last Day Time']),
          bringForward: '',
        });
      });

      // Next Month tab is optional — a Full Breakdown export (or a Month
      // End export where nobody touched that tab) won't necessarily carry
      // one, and that's fine; Bring Forward just stays unset for every row.
      const nextMonthWs = wb.getWorksheet('Next Month');
      if (nextMonthWs) {
        const nmHeaderMap = buildHeaderMap(nextMonthWs.getRow(1));

        nextMonthWs.eachRow({ includeEmpty: false }, (row, rowNumber) => {
          if (rowNumber === 1) return;

          const referenceDocument = readCellText(row, nmHeaderMap['Order']);
          const material          = readCellText(row, nmHeaderMap['Material']);
          if (!referenceDocument || !material) return;

          const key = `${referenceDocument}||${material}`;
          const existing = notesByKey.get(key) || {
            referenceDocument, material, risk: '', reason: '', wontGet: '', lastDay: '', lastDayTime: ''
          };
          existing.bringForward = readCellText(row, nmHeaderMap['Bring Forward']);
          notesByKey.set(key, existing);
        });
      }

      const noteRows = Array.from(notesByKey.values());
      await db.upsertOrderBookLineNotes(noteRows, req.uploadUser?.username);

      await auditQuery(
        'ORDERBOOK_NOTES_UPLOAD',
        req.uploadUser?.username,
        `Uploaded Month End Breakdown comments for ${noteRows.length} line(s)`,
        req
      );

      res.json({ success: true, data: { rowsUpdated: noteRows.length } });

    } catch (err) {
      console.error('[orderbook-breakdown/upload-notes]', err.message);
      res.status(500).json({ success: false, error: { message: err.message } });
    }
  }
);


// ══════════════════════════════════════════════════════════════════════════
// ── MM Turns / Valuation Class ───────────────────────────────────────────
// Reads come from dbo.TurnsValClassSnapshot / dbo.ValuationClassCatalog —
// the cached daily 05:45 pull, same as every other Performance* read here.
// The change-valuation-class action is the one exception: it's a live SAP
// write, so it goes straight to SapServer and is never served from cache.
// ══════════════════════════════════════════════════════════════════════════

// ── Manual trigger for the daily SAP pull ───────────────────────────────────
router.post('/turns-valclass/refresh', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const results = await runTurnsValClassRefresh(req);
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Full data table, with filtering ─────────────────────────────────────────
// Query params (all optional): plant, valuationClass, mrpController,
// materialType, profitCentre, search (matches Material or MaterialText).
router.get('/turns-valclass', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { plant, valuationClass, mrpController, materialType, profitCentre, search } = req.query;
    const pool = await getPool();
    const request = pool.request();

    const where = [];
    if (plant)          { where.push('Plant = @plant');                    request.input('plant', sql.VarChar(4), plant); }
    if (valuationClass) { where.push('ValuationClass = @valuationClass');   request.input('valuationClass', sql.VarChar(4), valuationClass); }
    if (mrpController)  { where.push('MrpController = @mrpController');    request.input('mrpController', sql.VarChar(3), mrpController); }
    if (materialType)   { where.push('MaterialType = @materialType');      request.input('materialType', sql.VarChar(4), materialType); }
    if (profitCentre)   { where.push('ProfitCentre = @profitCentre');      request.input('profitCentre', sql.VarChar(10), profitCentre); }
    if (search)          {
      where.push('(Material LIKE @search OR MaterialText LIKE @search)');
      request.input('search', sql.VarChar(42), `%${search}%`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Aliased to camelCase — mssql returns rows keyed by the raw column name when
    // there's no AS, and every bit of frontend code here expects camelCase (matching
    // the /aggregates, /value-by-price and /history routes, which already alias).
    const { recordset } = await request.query(`
      SELECT
        Material AS material, Plant AS plant, MaterialText AS materialText, CreatedDate AS createdDate,
        MaterialType AS materialType, Uom AS uom, ProfitCentre AS profitCentre,
        DeletionFlag AS deletionFlag, AbcIndicator AS abcIndicator, PurchasingGroup AS purchasingGroup,
        MrpController AS mrpController, ValuationClass AS valuationClass,
        LotSizeProcedure AS lotSizeProcedure, PlanningTimeFence AS planningTimeFence,
        GrProcessingTime AS grProcessingTime, TotalReplenishmentTime AS totalReplenishmentTime,
        SafetyStock AS safetyStock, MinLotSize AS minLotSize, MaxLotSize AS maxLotSize,
        FixedLotSize AS fixedLotSize, RoundingValue AS roundingValue,
        SpecialProcurementType AS specialProcurementType, PlannedDeliveryTime AS plannedDeliveryTime,
        StockQty AS stockQty, StockValue AS stockValue, UnitPrice AS unitPrice, BookValue AS bookValue,
        LastReceiptDate AS lastReceiptDate, LastGoodsIssueDate AS lastGoodsIssueDate,
        LastConsumptionDate AS lastConsumptionDate, LastGoodsMovementDate AS lastGoodsMovementDate,
        StockTurns AS stockTurns, DaysInStock AS daysInStock, DailyRequirementValue AS dailyRequirementValue,
        TurnoverCategory AS turnoverCategory, Warning AS warning,
        SnapshotAtUtc AS snapshotAtUtc
      FROM dbo.TurnsValClassSnapshot
      ${whereSql}
      ORDER BY Material
    `);

    res.json({ success: true, data: recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Aggregate / KPI tile ─────────────────────────────────────────────────────
router.get('/turns-valclass/aggregates', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const pool = await getPool();

    const totals = await pool.request().query(`
      SELECT
        COUNT(*)                                              AS materialCount,
        SUM(StockValue)                                       AS totalStockValue,
        SUM(BookValue)                                        AS totalBookValue,
        SUM(CASE WHEN Warning IS NOT NULL AND Warning <> '' THEN 1 ELSE 0 END) AS warningCount,
        AVG(CASE WHEN StockTurns  IS NOT NULL THEN StockTurns  END)            AS avgStockTurns,
        AVG(CASE WHEN DaysInStock IS NOT NULL THEN DaysInStock END)            AS avgDaysInStock
      FROM dbo.TurnsValClassSnapshot
    `);

    const byTurnoverCategory = await pool.request().query(`
      SELECT TurnoverCategory AS category, COUNT(*) AS materialCount, SUM(StockValue) AS stockValue
      FROM dbo.TurnsValClassSnapshot
      GROUP BY TurnoverCategory
      ORDER BY stockValue DESC
    `);

    const byValuationClass = await pool.request().query(`
      SELECT ValuationClass AS valuationClass, COUNT(*) AS materialCount, SUM(StockValue) AS stockValue, SUM(BookValue) AS bookValue
      FROM dbo.TurnsValClassSnapshot
      GROUP BY ValuationClass
      ORDER BY stockValue DESC
    `);

    const byMaterialType = await pool.request().query(`
      SELECT MaterialType AS materialType, COUNT(*) AS materialCount, SUM(StockValue) AS stockValue
      FROM dbo.TurnsValClassSnapshot
      GROUP BY MaterialType
      ORDER BY stockValue DESC
    `);

    res.json({
      success: true,
      data: {
        totals: totals.recordset[0],
        byTurnoverCategory: byTurnoverCategory.recordset,
        byValuationClass: byValuationClass.recordset,
        byMaterialType: byMaterialType.recordset
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Stock value breakdown by unit price band ────────────────────────────────
router.get('/turns-valclass/value-by-price', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const pool = await getPool();
    const { recordset } = await pool.request().query(`
      SELECT
        CASE
          WHEN UnitPrice IS NULL      THEN '(no price)'
          WHEN UnitPrice < 1          THEN '£0 - £1'
          WHEN UnitPrice < 5          THEN '£1 - £5'
          WHEN UnitPrice < 20         THEN '£5 - £20'
          WHEN UnitPrice < 100        THEN '£20 - £100'
          WHEN UnitPrice < 500        THEN '£100 - £500'
          ELSE '£500+'
        END AS priceBand,
        CASE
          WHEN UnitPrice IS NULL      THEN 99
          WHEN UnitPrice < 1          THEN 0
          WHEN UnitPrice < 5          THEN 1
          WHEN UnitPrice < 20         THEN 2
          WHEN UnitPrice < 100        THEN 3
          WHEN UnitPrice < 500        THEN 4
          ELSE 5
        END AS sortOrder,
        COUNT(*)          AS materialCount,
        SUM(StockQty)     AS totalStockQty,
        SUM(StockValue)   AS totalStockValue
      FROM dbo.TurnsValClassSnapshot
      GROUP BY
        CASE
          WHEN UnitPrice IS NULL THEN '(no price)'
          WHEN UnitPrice < 1     THEN '£0 - £1'
          WHEN UnitPrice < 5     THEN '£1 - £5'
          WHEN UnitPrice < 20    THEN '£5 - £20'
          WHEN UnitPrice < 100   THEN '£20 - £100'
          WHEN UnitPrice < 500   THEN '£100 - £500'
          ELSE '£500+'
        END,
        CASE
          WHEN UnitPrice IS NULL THEN 99
          WHEN UnitPrice < 1     THEN 0
          WHEN UnitPrice < 5     THEN 1
          WHEN UnitPrice < 20    THEN 2
          WHEN UnitPrice < 100   THEN 3
          WHEN UnitPrice < 500   THEN 4
          ELSE 5
        END
      ORDER BY sortOrder
    `);

    res.json({ success: true, data: recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── History / forecast for given (or all) materials ─────────────────────────
// ?materials=MAT1,MAT2  — omit for all materials in the snapshot.
router.get('/turns-valclass/history', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const pool = await getPool();
    const request = pool.request();
    const where = [];
    let materials = [];

    if (req.query.materials) {
      materials = String(req.query.materials).split(',').map(m => m.trim()).filter(Boolean);
      if (materials.length) {
        const inClause = materials.map((m, i) => {
          request.input(`m${i}`, sql.VarChar(18), m);
          return `@m${i}`;
        }).join(',');
        where.push(`Material IN (${inClause})`);
      }
    }

    // MRP Controller filter — lets the stock history/forecast view (and its
    // weekly stock-forecast line below) be scoped to one controller's book of
    // materials, same as the plain turns-valclass list route already supports,
    // so someone planning shipments isn't wading through every material in the
    // plant to find the ones they're responsible for.
    const mrpController = req.query.mrpController ? String(req.query.mrpController).trim() : '';
    if (mrpController) {
      where.push('MrpController = @mrpController');
      request.input('mrpController', sql.VarChar(3), mrpController);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { recordset } = await request.query(`
      SELECT
        Material, MaterialText, Plant, Uom, StockQty, ConsignmentQty,
        HistoryM12, HistoryM11, HistoryM10, HistoryM09, HistoryM08, HistoryM07,
        HistoryM06, HistoryM05, HistoryM04, HistoryM03, HistoryM02, HistoryM01, HistoryM00,
        ForecastM12, ForecastM11, ForecastM10, ForecastM09, ForecastM08, ForecastM07,
        ForecastM06, ForecastM05, ForecastM04, ForecastM03, ForecastM02, ForecastM01, ForecastM00,
        PredictedM12, PredictedM11, PredictedM10, PredictedM09, PredictedM08, PredictedM07,
        PredictedM06, PredictedM05, PredictedM04, PredictedM03, PredictedM02, PredictedM01, PredictedM00
      FROM dbo.TurnsValClassSnapshot
      ${whereSql}
      ORDER BY Material
    `);

    const data = recordset.map(r => ({
      material: r.Material,
      materialText: r.MaterialText,
      plant: r.Plant,
      uom: r.Uom,
      stockQty: r.StockQty,
      // Not surfaced as its own column anywhere valuation-facing — MBEW (and therefore
      // StockQty) never sees consignment stock by design, since it has no value yet.
      // Kept alongside stockQty here purely so the aggregate below can build an MRP
      // "current stock" figure that includes it without this route needing a second
      // query. See the currentStock comment further down for why they're summed there
      // and nowhere else.
      consignmentQty: r.ConsignmentQty,
      consumptionHistory: [
        r.HistoryM12, r.HistoryM11, r.HistoryM10, r.HistoryM09, r.HistoryM08, r.HistoryM07,
        r.HistoryM06, r.HistoryM05, r.HistoryM04, r.HistoryM03, r.HistoryM02, r.HistoryM01, r.HistoryM00
      ],
      demandForecast: [
        r.ForecastM12, r.ForecastM11, r.ForecastM10, r.ForecastM09, r.ForecastM08, r.ForecastM07,
        r.ForecastM06, r.ForecastM05, r.ForecastM04, r.ForecastM03, r.ForecastM02, r.ForecastM01, r.ForecastM00
      ],
      predictedUsage: [
        r.PredictedM12, r.PredictedM11, r.PredictedM10, r.PredictedM09, r.PredictedM08, r.PredictedM07,
        r.PredictedM06, r.PredictedM05, r.PredictedM04, r.PredictedM03, r.PredictedM02, r.PredictedM01, r.PredictedM00
      ]
    }));

    // ── Weekly expected-stock-level forecast ──────────────────────────────────
    // Built per material and summed (see mergeWeeklyForecasts) rather than
    // aggregating stock/predicted usage across materials up front and running
    // the forecast once — necessary now that a demand adjustment can apply to
    // one material in a combined/MRP-controller view and not another. See
    // mergeWeeklyForecasts' comment for why this is equivalent to the old
    // approach whenever nothing has an adjustment.
    //
    // Each material's own onHandStock intentionally includes consignmentQty
    // here — this is the ONLY place StockQty and ConsignmentQty are added
    // together anywhere in the app. For MRP/shipment planning, what's
    // physically available to consume is what matters, regardless of who
    // currently owns it on paper. Every other reader of StockQty (the plain
    // turns-valclass list, aggregates, value-by-price, the Stock Turns tile)
    // stays on StockQty alone — those are valuation views, and consignment
    // stock has no value yet from our accounting perspective, so it must
    // never appear in anything valuation-facing.
    const materialsInScope = data.map(r => r.material);
    const scopeFilter = materialsInScope.length ? materialsInScope : null;

    // Bump the forecast with expected deliveries from accepted-but-not-yet-
    // received order suggestions (MRP Phase 2b), and apply any manual demand
    // adjustments (machine down, planned extra production, or a standing
    // correction — see sql/migrate_demand_adjustments.sql) — both scoped to
    // whatever material set this request already resolved to, same filter
    // as everything else on this route.
    const [openIncomingOrders, demandAdjustments] = await Promise.all([
      db.listOpenIncomingOrders(scopeFilter),
      db.listDemandAdjustments(scopeFilter),
    ]);
    const incomingByMaterial = groupIncomingByMaterial(openIncomingOrders);
    const adjustmentsByMaterial = groupAdjustmentsByMaterial(demandAdjustments);

    const perMaterialForecasts = data.map(r => {
      const onHandStock = (Number(r.stockQty) || 0) + (Number(r.consignmentQty) || 0);
      const incomingDeliveries = (incomingByMaterial.get(r.material) || [])
        .filter(o => o.DeliveryDate)
        .map(o => ({ date: new Date(o.DeliveryDate), qty: Number(o.OrderQty) || 0 }));
      const materialAdjustments = adjustmentsByMaterial.get(r.material) || [];
      return buildWeeklyStockForecast(onHandStock, r.predictedUsage, new Date(), incomingDeliveries, materialAdjustments);
    });
    const stockForecast = mergeWeeklyForecasts(perMaterialForecasts);

    // ── Recorded accuracy overlay (dbo.ForecastAccuracyLog) ─────────────────────
    // What SAP demand and our prediction WERE for each of the last 12 months, frozen
    // as of right before each month started, alongside what actually happened — see
    // the table comment in create_performance_turnsvalclass_database.sql for the full
    // design. Aggregated server-side (SUM by TargetMonth) rather than returned per
    // material: with the material filter applied it's a no-op (one row per group
    // anyway), and with no filter (the "all materials" view) it collapses what could
    // be hundreds of thousands of rows down to ~13, matching how the frontend already
    // sums consumptionHistory/demandForecast across materials for that same view.
    const thisMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const fromMonth = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - 12, 1));

    const accuracyRequest = pool.request();
    accuracyRequest.input('fromMonth', sql.DateTime, fromMonth);
    accuracyRequest.input('toMonth', sql.DateTime, thisMonth);
    let accuracyWhereSql = 'WHERE TargetMonth >= @fromMonth AND TargetMonth <= @toMonth';

    if (materials.length) {
      const inClause = materials.map((m, i) => {
        accuracyRequest.input(`am${i}`, sql.VarChar(18), m);
        return `@am${i}`;
      }).join(',');
      accuracyWhereSql += ` AND Material IN (${inClause})`;
    }

    const { recordset: accuracyRows } = await accuracyRequest.query(`
      SELECT TargetMonth, SUM(SapDemandQty) AS SapDemandQty, SUM(PredictedQty) AS PredictedQty, SUM(ActualQty) AS ActualQty
      FROM dbo.ForecastAccuracyLog
      ${accuracyWhereSql}
      GROUP BY TargetMonth
      ORDER BY TargetMonth
    `);

    // Same 13-slot alignment as consumptionHistory: index 12 = current month, index 0 = 12 months ago.
    const recordedSapDemand = new Array(13).fill(null);
    const recordedPredicted = new Array(13).fill(null);
    const recordedActual    = new Array(13).fill(null);

    accuracyRows.forEach(r => {
      const targetMonth = new Date(r.TargetMonth);
      const monthsBack = (thisMonth.getUTCFullYear() - targetMonth.getUTCFullYear()) * 12
                        + (thisMonth.getUTCMonth() - targetMonth.getUTCMonth());
      if (monthsBack < 0 || monthsBack > 12) return;

      const idx = 12 - monthsBack;
      recordedSapDemand[idx] = r.SapDemandQty;
      recordedPredicted[idx] = r.PredictedQty;
      recordedActual[idx]    = r.ActualQty;
    });

    res.json({
      success: true,
      data,
      accuracy: { recordedSapDemand, recordedPredicted, recordedActual },
      stockForecast
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Distinct MRP controllers — for filter dropdowns on the Material Planning
// tiles (stock table, stock history/forecast, and eventually the MRP tile
// itself). Small, cheap query; not worth its own snapshot table.             ──
router.get('/turns-valclass/mrp-controllers', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const pool = await getPool();
    const { recordset } = await pool.request().query(`
      SELECT MrpController AS controller, COUNT(*) AS materialCount
      FROM dbo.TurnsValClassSnapshot
      WHERE MrpController IS NOT NULL AND MrpController <> ''
      GROUP BY MrpController
      ORDER BY MrpController
    `);
    res.json({ success: true, data: recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Vendor master data (MRP Phase 2) — manually-maintained, see
// sql/migrate_vendor_master_data.sql and performancesql.js's Vendor/
// VendorMaterial functions for why this isn't sourced from SAP.
// ══════════════════════════════════════════════════════════════════════════

router.get('/vendors', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const data = await db.listVendors();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/vendors', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { vendorName } = req.body;
    if (!vendorName || !String(vendorName).trim()) {
      return res.status(400).json({ success: false, error: { message: 'vendorName is required.' } });
    }
    const vendorId = await db.createVendor(req.body);
    res.json({ success: true, data: { vendorId } });
  } catch (err) {
    // UQ_Vendor_Name violation reads as a generic SQL error otherwise —
    // surface it plainly since this is the one thing a user is likely to hit.
    const message = /UQ_Vendor_Name/i.test(err.message)
      ? `A vendor named "${req.body.vendorName}" already exists.`
      : err.message;
    res.status(500).json({ success: false, error: { message } });
  }
});

router.put('/vendors/:vendorId', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { vendorName } = req.body;
    if (!vendorName || !String(vendorName).trim()) {
      return res.status(400).json({ success: false, error: { message: 'vendorName is required.' } });
    }
    await db.updateVendor(req.params.vendorId, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.delete('/vendors/:vendorId', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    await db.deleteVendor(req.params.vendorId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/vendors/:vendorId/materials', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const data = await db.listVendorMaterials(req.params.vendorId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/vendors/:vendorId/materials', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { material } = req.body;
    if (!material || !String(material).trim()) {
      return res.status(400).json({ success: false, error: { message: 'material is required.' } });
    }
    const vendorMaterialId = await db.addVendorMaterial(req.params.vendorId, req.body);
    res.json({ success: true, data: { vendorMaterialId } });
  } catch (err) {
    const message = /UQ_VendorMaterial/i.test(err.message)
      ? `${req.body.material} is already assigned to this vendor.`
      : err.message;
    res.status(500).json({ success: false, error: { message } });
  }
});

router.put('/vendors/:vendorId/materials/:vendorMaterialId', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    await db.updateVendorMaterial(req.params.vendorMaterialId, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.delete('/vendors/:vendorId/materials/:vendorMaterialId', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    await db.deleteVendorMaterial(req.params.vendorMaterialId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Demand adjustments — manually-maintained overrides to a material's
// predicted usage (machine down, planned extra production, or a standing
// correction to a forecast that's running too high/low). See
// sql/migrate_demand_adjustments.sql and performancesql.js's
// findOverlappingDemandAdjustment for the overlap-rejection rule that keeps
// createDemandAdjustment/updateDemandAdjustment's 400s meaningful.
// ══════════════════════════════════════════════════════════════════════════

router.get('/demand-adjustments', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const data = await db.listDemandAdjustmentsForAdmin();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/demand-adjustments', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { material, usagePercent } = req.body;
    if (!material || !String(material).trim()) {
      return res.status(400).json({ success: false, error: { message: 'material is required.' } });
    }
    if (usagePercent == null || Number(usagePercent) < 0) {
      return res.status(400).json({ success: false, error: { message: 'usagePercent is required and cannot be negative.' } });
    }
    const createdBy = req.session?.user?.username || 'unknown';
    const adjustmentId = await db.createDemandAdjustment({ ...req.body, createdBy });
    res.json({ success: true, data: { adjustmentId } });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: { message: err.message } });
  }
});

router.put('/demand-adjustments/:adjustmentId', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { material, usagePercent } = req.body;
    if (!material || !String(material).trim()) {
      return res.status(400).json({ success: false, error: { message: 'material is required.' } });
    }
    if (usagePercent == null || Number(usagePercent) < 0) {
      return res.status(400).json({ success: false, error: { message: 'usagePercent is required and cannot be negative.' } });
    }
    await db.updateDemandAdjustment(req.params.adjustmentId, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: { message: err.message } });
  }
});

router.delete('/demand-adjustments/:adjustmentId', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    await db.deleteDemandAdjustment(req.params.adjustmentId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Valuation class catalog (cached) — for the change-valuation-class dropdown ──
router.get('/turns-valclass/valuation-classes', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const pool = await getPool();
    const request = pool.request();
    let whereSql = '';

    if (req.query.materialType) {
      whereSql = 'WHERE MaterialType = @materialType';
      request.input('materialType', sql.VarChar(4), req.query.materialType);
    }

    const { recordset } = await request.query(`
      SELECT ValuationClass AS valuationClass, MaterialType AS materialType,
             AccountRef AS accountRef, Description AS description
      FROM dbo.ValuationClassCatalog
      ${whereSql}
      ORDER BY ValuationClass
    `);

    res.json({ success: true, data: recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Change valuation class — LIVE SAP write, never served from cache ────────
// Body: { order, plant?, changes: [{ material, newValuationClass }, ...] }
router.post('/turns-valclass/change-valuation-class', requirePermission('LOG_MRP'), async (req, res) => {
  const { order, plant, changes } = req.body;

  if (!order || !Array.isArray(changes) || !changes.length) {
    return res.status(400).json({ success: false, error: 'order and at least one change are required.' });
  }

  const username = req.session?.user?.username || 'unknown';
  const userId   = req.session?.user?.userID || null;

  try {
    const result = await sap.postChangeValuationClass(req, { order, plant, changes });

    await db.logValuationClassChangeBatch({
      orderNumber: order,
      plant,
      userId,
      userName: username,
      success: result.success,
      totalValueChange: result.totalValueChange,
      errorMessage: result.errorMessage,
      results: result.results
    });

    await auditQuery('VALCLASS_CHANGE', username,
      `Order ${order}: ${changes.length} material(s), success=${result.success}`, req);

    res.json({ success: true, data: result });
  } catch (err) {
    // err.data is the structured ChangeValuationClassResponse SapServer returned
    // on a 422 pre-check failure — log it too, it's still a real attempt.
    if (err.data) {
      try {
        await db.logValuationClassChangeBatch({
          orderNumber: order,
          plant,
          userId,
          userName: username,
          success: false,
          totalValueChange: err.data.totalValueChange || 0,
          errorMessage: err.data.errorMessage || err.message,
          results: err.data.results || []
        });
      } catch (logErr) {
        console.error('Failed to log rejected valuation class change batch:', logErr.message);
      }

      return res.status(422).json({ success: false, error: { message: err.message }, data: err.data });
    }

    res.status(500).json({ success: false, error: { message: err.message } });
  }
});


// ── Order suggestions (MRP Phase 2b) ────────────────────────────────────────
router.get('/order-suggestions', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const suggestions = await computeOrderSuggestions();
    const data = groupSuggestionsByVendor(suggestions);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/order-suggestions/vendor/:vendorId/build', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const data = await computeVendorOrderBuild(Number(req.params.vendorId));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.post('/order-suggestions/accept', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const {
      vendorMaterialId, vendorId, material, suggestedQty, orderQty,
      orderDate, leadTimeDays, transitTimeDays, incoterms, isSpotPo, notes,
      deliveryDate: deliveryDateOverride
    } = req.body;

    if (!vendorMaterialId || !vendorId || !material || !orderQty) {
      return res.status(400).json({
        success: false,
        error: { message: 'vendorMaterialId, vendorId, material and orderQty are required.' }
      });
    }

    // Enforced fresh from the DB, not trusted from the client — see
    // enforceMaterialQty's comment above.
    const [materialConstraints, vendorConstraints] = await Promise.all([
      db.getVendorMaterialConstraints(vendorMaterialId),
      db.getVendorOrderConstraints(vendorId),
    ]);
    const enforcedQty = enforceMaterialQty(
      orderQty,
      materialConstraints?.MaterialMoqQty,
      materialConstraints?.MaterialMaxQty
    );

    // A single-material accept can only ever satisfy a vendor's combined
    // requirement if this one material's qty alone clears it — there's
    // nothing else in the "order" to add up. If it doesn't, block and point
    // at Build Order rather than silently accepting a short/over order.
    if (vendorConstraints && (vendorConstraints.OrderMoqQty || vendorConstraints.OrderMaxQty)) {
      const vendorError = validateVendorCombinedQty(
        enforcedQty, vendorConstraints.OrderMoqQty, vendorConstraints.OrderMaxQty
      );
      if (vendorError) {
        return res.status(400).json({
          success: false,
          error: { message: `${vendorError} Use Build Order to combine materials from this vendor into one order.` }
        });
      }
    }

    const orderDateObj = orderDate ? new Date(orderDate) : new Date();
    const payload = buildAcceptPayload({
      vendorMaterialId, vendorId, material, suggestedQty, orderQty: enforcedQty, orderDateObj,
      leadTimeDays, transitTimeDays, incoterms, isSpotPo, notes, deliveryDateOverride
    });
    const suggestionId = await db.acceptOrderSuggestion(payload);

    res.json({ success: true, data: { suggestionId, orderQty: enforcedQty } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Combines several materials from one vendor into a single accepted order —
// the Build Order modal's submit path, for clearing a vendor's combined
// order-level MOQ (dbo.Vendor.OrderMoqQty/OrderMaxQty) rather than accepting
// materials one at a time and hoping they happen to add up. Every item gets
// its own PurchaseOrderSuggestion row (lead time/dates/spot-PO can differ
// per material even within one vendor) but shares the same OrderDate. Items
// missing required fields are skipped rather than failing the whole batch,
// since a partially-filled row in the modal shouldn't block the rest — but
// the vendor-level combined check runs BEFORE anything is persisted, so a
// batch that doesn't satisfy it is rejected outright, not partially saved.
router.post('/order-suggestions/accept-batch', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { vendorId, orderDate, items } = req.body;
    if (!vendorId || !Array.isArray(items) || !items.length) {
      return res.status(400).json({
        success: false,
        error: { message: 'vendorId and a non-empty items array are required.' }
      });
    }

    const validItems = items.filter(item => item && item.vendorMaterialId && item.material && item.orderQty);
    if (!validItems.length) {
      return res.status(400).json({
        success: false,
        error: { message: 'No valid items to accept — each item needs vendorMaterialId, material and orderQty > 0.' }
      });
    }

    // Enforce each item's own lot size/max first (fresh from the DB), then
    // validate the enforced total against the vendor's combined requirement
    // — all before anything is written, so this is all-or-nothing.
    const constraintsByVmId = new Map();
    await Promise.all(validItems.map(async item => {
      constraintsByVmId.set(item.vendorMaterialId, await db.getVendorMaterialConstraints(item.vendorMaterialId));
    }));

    const enforcedItems = validItems.map(item => {
      const c = constraintsByVmId.get(item.vendorMaterialId);
      return { ...item, orderQty: enforceMaterialQty(item.orderQty, c?.MaterialMoqQty, c?.MaterialMaxQty) };
    });

    const vendorConstraints = await db.getVendorOrderConstraints(vendorId);
    const total = enforcedItems.reduce((sum, item) => sum + (Number(item.orderQty) || 0), 0);
    if (vendorConstraints && (vendorConstraints.OrderMoqQty || vendorConstraints.OrderMaxQty)) {
      const vendorError = validateVendorCombinedQty(total, vendorConstraints.OrderMoqQty, vendorConstraints.OrderMaxQty);
      if (vendorError) {
        return res.status(400).json({ success: false, error: { message: vendorError } });
      }
    }

    const orderDateObj = orderDate ? new Date(orderDate) : new Date();
    const suggestionIds = [];

    for (const item of enforcedItems) {
      const {
        vendorMaterialId, material, suggestedQty, orderQty,
        leadTimeDays, transitTimeDays, incoterms, isSpotPo, notes
      } = item;
      const payload = buildAcceptPayload({
        vendorMaterialId, vendorId, material, suggestedQty, orderQty, orderDateObj,
        leadTimeDays, transitTimeDays, incoterms, isSpotPo, notes
      });
      suggestionIds.push(await db.acceptOrderSuggestion(payload));
    }

    res.json({ success: true, data: { suggestionIds, totalQty: Math.round(total * 1000) / 1000 } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Records an order that already exists outside the suggestion engine — the
// user already has stock on order placed before this feature existed, or
// simply prefers to order ahead of what the engine flagged. Vendor + material
// must already be configured (VendorMaterial is a required FK on
// PurchaseOrderSuggestion), but the order itself isn't checked against
// MOQ/max lot-size rules the way an accepted suggestion is — this is
// documenting something that already happened in the real world, not
// proposing a new order, so a real order that predates or falls outside
// today's MOQ/max settings must still be recorded as-is.
//
// Shared by both the single-row route and the bulk CSV upload below —
// `allRows` is passed in rather than re-fetched here so a bulk upload of
// many rows only hits listVendorMaterialsForSuggestions() once.
async function insertManualOrderRow({ vendorMaterialId, orderQty, orderDate, deliveryDate, poNumber, notes, status, supplierReference }, allRows) {
  const qty = Number(orderQty);
  if (!qty || qty <= 0) {
    const err = new Error('orderQty must be greater than 0.'); err.statusCode = 400; throw err;
  }

  const r = allRows.find(row => Number(row.VendorMaterialId) === Number(vendorMaterialId));
  if (!r) {
    const err = new Error('Vendor material not found.'); err.statusCode = 404; throw err;
  }

  const orderDateObj = orderDate ? new Date(orderDate) : new Date();
  const leadTimeDays = Number(r.LeadTimeDaysOverride ?? r.SapLeadTimeDays ?? r.DefaultLeadTimeDays ?? 0);
  const transitTimeDays = Number(r.TransitTimeDays) || 0;
  const isSpotPo = !r.ScheduleAgreement;

  let payload;
  if (deliveryDate) {
    // The operator already knows the real delivery date (the order's
    // already been placed) — use it as given rather than recomputing from
    // the vendor's lead time, which may not match what was actually
    // agreed for this specific order.
    const deliveryDateObj = new Date(deliveryDate);
    const isExw = (r.Incoterms || '').toUpperCase() === 'EXW';
    payload = {
      vendorMaterialId: r.VendorMaterialId,
      vendorId: r.VendorId,
      material: r.Material,
      suggestedQty: null,
      orderQty: qty,
      orderDate: orderDateObj,
      leadTimeDaysUsed: leadTimeDays,
      deliveryDate: deliveryDateObj,
      transitTimeDaysUsed: isExw ? transitTimeDays : null,
      readyToCollectDate: isExw ? addWorkingDaysUtc(deliveryDateObj, -transitTimeDays) : null,
      isSpotPo,
      notes: notes || null,
    };
  } else {
    payload = buildAcceptPayload({
      vendorMaterialId: r.VendorMaterialId, vendorId: r.VendorId, material: r.Material,
      suggestedQty: null, orderQty: qty, orderDateObj,
      leadTimeDays, transitTimeDays, incoterms: r.Incoterms, isSpotPo, notes,
    });
  }

  const suggestionId = await db.acceptOrderSuggestion(payload);

  // acceptOrderSuggestion always inserts as 'Accepted' — flip it on if the
  // caller says this is further along (already raised in SAP / already
  // booked in / already arrived), and persist PO number / supplier
  // reference in the same call.
  const finalStatus = ['Ordered', 'Booked', 'Received'].includes(status) ? status : 'Accepted';
  if (finalStatus !== 'Accepted' || poNumber || supplierReference) {
    await db.updateOrderSuggestionStatus(suggestionId, {
      status: finalStatus, poNumber: poNumber || null, notes: notes || null, supplierReference: supplierReference || null,
    });
  }

  return suggestionId;
}

router.post('/order-suggestions/manual', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { vendorMaterialId } = req.body;
    if (!vendorMaterialId) {
      return res.status(400).json({ success: false, error: { message: 'vendorMaterialId is required.' } });
    }
    const allRows = await db.listVendorMaterialsForSuggestions();
    const suggestionId = await insertManualOrderRow(req.body, allRows);
    res.json({ success: true, data: { suggestionId } });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: { message: err.message } });
  }
});

// Bulk CSV upload — same fields as the single-row route above, but rows
// reference a vendor by NAME and a material by CODE (not vendorMaterialId,
// which an operator filling in a spreadsheet has no way to know), and the
// whole batch is resolved against one fetch of listVendorMaterialsForSuggestions()
// rather than one query per row. Every row is attempted independently — a
// typo in row 12 shouldn't block rows 1-11 from saving — so the response
// reports success/failure per row rather than all-or-nothing.
router.post('/order-suggestions/manual/bulk', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ success: false, error: { message: 'rows must be a non-empty array.' } });
    }

    const allRows = await db.listVendorMaterialsForSuggestions();
    const findVendorMaterial = (vendorName, material) => {
      const vn  = String(vendorName || '').trim().toLowerCase();
      const mat = String(material || '').trim().toLowerCase();
      if (!vn || !mat) return null;
      return allRows.find(row =>
        String(row.VendorName || '').trim().toLowerCase() === vn &&
        String(row.Material || '').trim().toLowerCase() === mat
      );
    };

    const results = [];
    for (let i = 0; i < rows.length; i++) {
      const csvRow = rows[i] || {};
      const rowNum = i + 2; // +1 for 1-indexing, +1 for the header row
      try {
        const match = findVendorMaterial(csvRow.vendor, csvRow.material);
        if (!match) {
          throw new Error(`No vendor material configured for "${csvRow.vendor || '?'}" / "${csvRow.material || '?'}" — add it in Vendor Master Data first.`);
        }
        const suggestionId = await insertManualOrderRow({
          vendorMaterialId: match.VendorMaterialId,
          orderQty: csvRow.orderQty,
          orderDate: csvRow.orderDate,
          deliveryDate: csvRow.deliveryDate,
          poNumber: csvRow.poNumber,
          supplierReference: csvRow.supplierReference,
          notes: csvRow.notes,
          status: csvRow.status,
        }, allRows);
        results.push({ row: rowNum, success: true, suggestionId });
      } catch (err) {
        results.push({ row: rowNum, success: false, error: err.message });
      }
    }

    const succeeded = results.filter(r => r.success).length;
    res.json({
      success: true,
      data: { total: rows.length, succeeded, failed: rows.length - succeeded, results },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/order-suggestions/tracked', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const data = await db.listOrderSuggestionsTracked();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.put('/order-suggestions/:suggestionId', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { status, orderQty } = req.body;
    if (!status || !['Accepted', 'Ordered', 'Booked', 'Received', 'Cancelled'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: { message: 'status must be one of Accepted, Ordered, Booked, Received, Cancelled.' }
      });
    }
    // Optional — only present when the Tracked Orders qty field was edited.
    // No MOQ/max re-check here, same reasoning as manual order entry: this
    // corrects an order that already happened (deliveries can land a few kg
    // either side of what was placed) rather than proposing a new one.
    if (orderQty != null && (!Number(orderQty) || Number(orderQty) <= 0)) {
      return res.status(400).json({ success: false, error: { message: 'orderQty must be greater than 0.' } });
    }
    await db.updateOrderSuggestionStatus(req.params.suggestionId, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Hard delete — see db.deleteOrderSuggestion's comment for how this differs
// from setting Status='Cancelled'. No restriction on which status/shipment
// state a row is in: the user asked for this specifically to fix mistakes
// (duplicate manual entries, wrong material picked), which can happen at
// any stage.
router.delete('/order-suggestions/:suggestionId', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    await db.deleteOrderSuggestion(req.params.suggestionId);
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: { message: err.message } });
  }
});

// ── Inbound shipment tracking + supplier reference (haulier / mode of
// transport / tracking numbers for orders that travel via a haulier;
// SupplierReference above for vendors who deliver themselves) — see
// sql/migrate_order_shipments.sql for the full reasoning.
router.get('/order-suggestions/shipments', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const data = await db.listOrderShipments();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Create-shipment-from-selected-lines, mirroring Open Deliveries: body is
// { dispatchDate, expectedEta, haulier, modeOfTransport, trackingNumber,
// billOfLading, containerNumber, notes, suggestionIds }. Creation and
// line-assignment happen together in db.createOrderShipment — the
// reference is generated server-side, not supplied by the caller.
router.post('/order-suggestions/shipments', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const data = await db.createOrderShipment(req.body);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Inbound Log's shipment detail view — header fields plus every linked
// order line.
router.get('/order-suggestions/shipments/:shipmentId', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const data = await db.getOrderShipmentWithOrders(req.params.shipmentId);
    if (!data) return res.status(404).json({ success: false, error: { message: 'Shipment not found.' } });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.put('/order-suggestions/shipments/:shipmentId', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    await db.updateOrderShipment(req.params.shipmentId, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Inbound Log's "Mark Received" action — stamps the shipment received and
// bulk-flips every linked order to 'Booked' (see markShipmentReceived's
// comment for why that's a distinct status, and the SAP-booking placeholder
// it calls per order). Body: { receivedAt? } — defaults to now.
router.post('/order-suggestions/shipments/:shipmentId/receive', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const receivedBy = req.session?.user?.username || 'unknown';
    const data = await db.markShipmentReceived(req.params.shipmentId, {
      receivedBy,
      receivedAt: req.body?.receivedAt || null,
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: { message: err.message } });
  }
});

// Links (or unlinks, with shipmentId: null) a tracked order to a shipment —
// for adding a stray order to an already-created shipment after the fact.
// Kept separate from the general PUT /order-suggestions/:suggestionId
// above since assigning a shipment is its own workflow.
router.patch('/order-suggestions/:suggestionId/shipment', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { shipmentId } = req.body;
    await db.assignOrderShipment(req.params.suggestionId, shipmentId ?? null);
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: { message: err.message } });
  }
});

// Inbound Log's "Cancel Shipment" action — unlinks every order on the
// shipment (their own Status is untouched, they're just free to be put on
// a new shipment) and marks the shipment itself cancelled. Blocked once the
// shipment has been received — see cancelOrderShipment's comment.
router.post('/order-suggestions/shipments/:shipmentId/cancel', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const cancelledBy = req.session?.user?.username || 'unknown';
    const data = await db.cancelOrderShipment(req.params.shipmentId, cancelledBy);
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: { message: err.message } });
  }
});


// ── Supplier invoice uploads ────────────────────────────────────────────
// Registered BEFORE the generic /documents/:fileName route below — same
// route-ordering caution as routes/shipmentmain.js's equivalent pair: if
// the fileName route came first, a request for /documents/folder would be
// caught by it with fileName="folder" instead.
router.get('/order-suggestions/shipments/:shipmentId/documents/folder', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const shipmentId = Number(req.params.shipmentId);
    const { record, supplierName } = await loadShipmentForImportDocs(shipmentId);
    const folder = getShipmentImportFolderInfo(record, supplierName);

    let entries = [];
    try {
      entries = await fsp.readdir(folder.shipmentPath, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stat = await fsp.stat(path.join(folder.shipmentPath, entry.name));
      files.push({
        fileName: entry.name,
        sizeBytes: stat.size,
        modifiedAtUtc: stat.mtime.toISOString(),
        downloadUrl: `/api/performance/order-suggestions/shipments/${shipmentId}/documents/${encodeURIComponent(entry.name)}`,
      });
    }
    files.sort((a, b) => a.fileName.localeCompare(b.fileName));

    res.json({ success: true, data: { supplierName, files } });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: { message: err.message } });
  }
});

router.get('/order-suggestions/shipments/:shipmentId/documents/:fileName', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const shipmentId = Number(req.params.shipmentId);
    const { record, supplierName } = await loadShipmentForImportDocs(shipmentId);
    const folder = getShipmentImportFolderInfo(record, supplierName);
    const fileName = path.basename(req.params.fileName || '');
    const target = path.join(folder.shipmentPath, fileName);
    await fsp.access(target, fs.constants.F_OK);
    return res.sendFile(target);
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: { message: err.message } });
  }
});

// Body is the raw file bytes (Content-Type: application/pdf / image/jpeg /
// image/png), not multipart — same pattern as routes/shipmentmain.js's
// operator invoice upload, simplest thing that works from a plain
// fetch(..., { body: file }) without adding a dependency for a single-file
// upload. Auto-creates the destination folder (year/month/shipment) if it
// doesn't exist yet.
router.post('/order-suggestions/shipments/:shipmentId/documents/upload',
  requirePermission('LOG_MRP'),
  express.raw({ type: ['application/pdf', 'image/jpeg', 'image/png'], limit: '20mb' }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ success: false, error: { message: 'No file content received. Content-Type must be application/pdf, image/jpeg or image/png.' } });
      }
      if (req.body.length > 20 * 1024 * 1024) {
        return res.status(413).json({ success: false, error: { message: 'File is too large (20MB limit).' } });
      }

      const shipmentId = Number(req.params.shipmentId);
      const { record, supplierName } = await loadShipmentForImportDocs(shipmentId);
      const folder = await ensureShipmentImportFolder(record, supplierName);

      const contentType = String(req.get('Content-Type') || '').toLowerCase();
      const ext = contentType.includes('pdf') ? '.pdf' : contentType.includes('png') ? '.png' : '.jpg';
      const originalName = String(req.get('X-File-Name') || req.query.fileName || 'invoice').replace(/\.(pdf|jpe?g|png)$/i, '');
      const fileName = `${sanitizeImportFileSegment(originalName)}-${Date.now()}${ext}`;
      const filePath = path.join(folder.shipmentPath, fileName);
      await fsp.writeFile(filePath, req.body);

      res.status(201).json({
        success: true,
        data: {
          fileName,
          sizeBytes: req.body.length,
          downloadUrl: `/api/performance/order-suggestions/shipments/${shipmentId}/documents/${encodeURIComponent(fileName)}`,
        },
      });
    } catch (err) {
      res.status(err.statusCode || 500).json({ success: false, error: { message: err.message } });
    }
  }
);


export default router;
