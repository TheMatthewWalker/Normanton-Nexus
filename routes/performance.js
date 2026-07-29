import express from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import https from 'https';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { runFullRefresh, runTurnsValClassRefresh } from '../routes/performancesync.js';
import * as sap from './performancesap.js';
import * as db  from './performancesql.js';
import sql from 'mssql';
import ExcelJS from 'exceljs';
import { sqlConfig, auditQuery, sapConfig, sapServerSecret } from '../config.js';
import { requirePermission, requireAnyPermission, requireSessionOrApiToken } from '../middleware/auth.js';
import { insertInboundCostLine } from './inboundcosts.js';
import { getDecryptedSapCredentials } from '../lib/sapCredentials.js';

// Same TLS-pinned Node->SapServer setup used by routes/shipmentcost.js's
// post-migo (create-po-and-receipt) — reused here for the MRP "Create PO in
// SAP" flow, which needs the identical per-user-elevated call shape.
const sapCertPath = new URL('../certs/sap-server-cert.pem', import.meta.url);
const sapAgent = fs.existsSync(sapCertPath)
  ? new https.Agent({ ca: fs.readFileSync(sapCertPath), rejectUnauthorized: true })
  : null;

function makeSapToken(userId) {
  return jwt.sign({ userId: userId ?? 0 }, sapServerSecret,
    { issuer: 'sql2005-bridge', audience: 'sap-server', expiresIn: '60s' });
}

// SapServer's ApiResponse.Fail() puts the generic error under
// body.error.message and the real SAP RETURN-table diagnostic (e.g. "Vendor
// 12345 does not exist") under body.data.messages — see
// PurchasingController.CreatePurchaseOrderElevated / CreatePoElevatedResponse.
// Mirrors shipmentcost.js's extractSapErrorMessage: the generic wrapper
// alone never explains WHY SAP rejected the PO.
function extractPoErrorMessage(body, fallback) {
  const base = body?.error?.message || body?.error || fallback;
  const messages = body?.data?.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    const detail = messages.filter(m => m?.message).map(m => (m.type ? `[${m.type}] ${m.message}` : m.message)).join('; ');
    if (detail) return `${base} ${detail}`;
  }
  return base;
}

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
//   Potential Stock, and a risk section). Every total except "Invoiced to
//   date" is a live SUMIFS/COUNTIFS formula against the Data sheet, scoped
//   to ValueStream = PTFE, so it recalculates as planners edit Stock Qty /
//   Won't Get / Expected to Invoice Qty there. "Invoiced to date" comes from
//   real SAP billing documents (dbo.InvoiceSnapshot via dbo.DailyPerformance)
//   — there's nothing on the Data sheet to compute it from, so it's written
//   as a plain value, accurate as of the moment this file was generated.
//   Data — the row-level export (as before), plus Won't Get and Reason.
//   Risk Value is no longer a manual flag: it's calculated automatically as
//   MAX(Order Qty - Expected to Invoice Qty, 0), priced — see Risk Qty/Risk
//   Value further down. Flagging a row "x" in Won't Get excludes its Stock
//   Value from the Invoiced + Potential Stock card and rolls it into the
//   Confirmed Not Getting card instead ("this definitely isn't coming").
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
      // +/-10% meters leeway SAP will accept as fulfilling an order without
      // complaint — live formulas off Order Qty, see the leeway note further
      // down near where these are populated.
      { header: 'Min Ship Qty (-10%)', key: 'minShipQty',  width: 16 },
      { header: 'Max Ship Qty (+10%)', key: 'maxShipQty',  width: 16 },
      { header: 'Stock Qty',     key: 'stockQty',          width: 14 },
      { header: 'Stock Value',   key: 'stockValue',        width: 14 },
      { header: 'Picked Qty',    key: 'pickedQty',         width: 14 },
      { header: 'Picked Value',  key: 'pickedValue',       width: 14 },
      { header: 'Won\'t Get',    key: 'wontGet',           width: 10 },
      { header: 'Reason',        key: 'reason',            width: 34 },
      { header: 'Last Day',                key: 'lastDay',               width: 10 },
      { header: 'Last Day Time',           key: 'lastDayTime',           width: 14 },
      { header: 'Expected to Invoice Qty',  key: 'plannedProductionQty',  width: 18 },
      { header: 'Expected to Invoice Value',key: 'plannedProductionValue',width: 20 },
      // Calculated, not manual — no more Risk "x" flag column. This is the
      // shortfall between what was ordered and what we now expect to invoice
      // (Expected to Invoice Qty above), and its £ value. See the formulas
      // further down for exactly how these are derived; this is "the risk"
      // per the Month End dashboard card built from Risk Value below.
      { header: 'Risk Qty',                key: 'riskQty',               width: 14 },
      { header: 'Risk Value',              key: 'riskValue',             width: 14 },
      { header: 'At Risk Seq',             key: 'atRiskSeq',             width: 10 },
      // Hidden helper, same pattern as At Risk Seq — numbers PTFE rows
      // flagged Won't Get="x" in row order so the Dashboard's Confirmed Not
      // Getting list can pull them out with INDEX/MATCH, mirroring the
      // At-Risk Lines list alongside it.
      { header: 'Not Getting Seq',         key: 'notGettingSeq',         width: 10 }
    ];

    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
    const headerFont = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    const border      = { style: 'thin', color: { argb: 'FFBFCAD4' } };
    const cellBorder  = { top: border, bottom: border, left: border, right: border };
    const oddFill     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    const evenFill    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEF4' } };
    // Pale yellow — flags the manual-entry columns planners type into.
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
    const minShipQtyCol  = excelColumnLetter(dataWs.getColumn('minShipQty').number);
    const maxShipQtyCol  = excelColumnLetter(dataWs.getColumn('maxShipQty').number);
    const stockQtyCol    = excelColumnLetter(dataWs.getColumn('stockQty').number);
    const stockValueCol  = excelColumnLetter(dataWs.getColumn('stockValue').number);
    const pickedQtyCol   = excelColumnLetter(dataWs.getColumn('pickedQty').number);
    const pickedValueCol = excelColumnLetter(dataWs.getColumn('pickedValue').number);
    const valueStreamCol = excelColumnLetter(dataWs.getColumn('valueStream').number);
    const wontGetCol     = excelColumnLetter(dataWs.getColumn('wontGet').number);
    const lastDayCol              = excelColumnLetter(dataWs.getColumn('lastDay').number);
    const lastDayTimeCol          = excelColumnLetter(dataWs.getColumn('lastDayTime').number);
    const plannedProductionQtyCol = excelColumnLetter(dataWs.getColumn('plannedProductionQty').number);
    const plannedProductionValueCol = excelColumnLetter(dataWs.getColumn('plannedProductionValue').number);
    const riskQtyCol             = excelColumnLetter(dataWs.getColumn('riskQty').number);
    const riskValueCol           = excelColumnLetter(dataWs.getColumn('riskValue').number);
    const materialCol            = excelColumnLetter(dataWs.getColumn('material').number);
    const referenceDocumentCol   = excelColumnLetter(dataWs.getColumn('referenceDocument').number);
    const atRiskSeqCol           = excelColumnLetter(dataWs.getColumn('atRiskSeq').number);
    const notGettingSeqCol       = excelColumnLetter(dataWs.getColumn('notGettingSeq').number);
    // Hidden running-count helper: numbers PTFE rows with a Risk Value > 0 in
    // the order they appear (1, 2, 3…), so the Dashboard's At-Risk Lines list
    // can pull them out with plain INDEX/MATCH — no TEXTJOIN, no dynamic
    // arrays, no CSE. Works identically on every Excel version, unlike the
    // old array-formula approach.
    dataWs.getColumn('atRiskSeq').hidden = true;
    // Same helper pattern, keyed on Won't Get="x" instead of Risk Value>0 —
    // feeds the Dashboard's Confirmed Not Getting list.
    dataWs.getColumn('notGettingSeq').hidden = true;

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
        wontGet: notes.wontGet || '',
        reason: notes.reason || '',
        lastDay: notes.lastDay || '',
        lastDayTime: notes.lastDayTime || '',
        // Prefills from whatever was last uploaded for this line (see
        // dbo.OrderBookLineNotes.PlannedProductionQty) so a planner's
        // override survives a re-download instead of reverting to the
        // default every time; falls back to Order Qty when nothing's been
        // uploaded yet — this way the Value-by-Hour "Expected" bucket and
        // the Invoiced + Expected to Invoice card start from what was
        // actually ordered rather than what's physically in stock right now.
        plannedProductionQty: notes.plannedProductionQty != null
          ? Number(notes.plannedProductionQty)
          : Number(r.OrderQty || 0)
        // stockValue / pickedValue / plannedProductionValue / minShipQty /
        // maxShipQty / riskQty / riskValue / atRiskSeq set as formulas below.
      });

      row.getCell('stockValue').value = {
        formula: `IF(${orderQtyCol}${excelRow}>0,${stockQtyCol}${excelRow}*(${orderValueCol}${excelRow}/${orderQtyCol}${excelRow}),0)`,
        result: Number(r.StockValue || 0)
      };
      row.getCell('pickedValue').value = {
        formula: `IF(${orderQtyCol}${excelRow}>0,${pickedQtyCol}${excelRow}*(${orderValueCol}${excelRow}/${orderQtyCol}${excelRow}),0)`,
        result: Number(r.PickedValue || 0)
      };
      // Expected to Invoice Value — same valuation formula as Stock/Picked
      // Value, but driven off Expected to Invoice Qty (defaults to Order Qty
      // above, so this starts out equal to full Order Value until a planner
      // overtypes the Qty to reflect a known shortfall).
      row.getCell('plannedProductionValue').value = {
        formula: `IF(${orderQtyCol}${excelRow}>0,${plannedProductionQtyCol}${excelRow}*(${orderValueCol}${excelRow}/${orderQtyCol}${excelRow}),0)`,
        result: Number(r.StockValue || 0)
      };
      // Min/Max Ship Qty — the +/-10% metres leeway that applies to every
      // order (SAP will accept a shipment anywhere in this range without it
      // being treated as under/over-delivery), so a planner can see at a
      // glance what could actually go out against this line.
      row.getCell('minShipQty').value = {
        formula: `${orderQtyCol}${excelRow}*0.9`,
        result: Number(r.OrderQty || 0) * 0.9
      };
      row.getCell('maxShipQty').value = {
        formula: `${orderQtyCol}${excelRow}*1.1`,
        result: Number(r.OrderQty || 0) * 1.1
      };
      // Risk Qty / Risk Value — calculated, not manual: the shortfall
      // between Order Qty and what we now expect to invoice (Expected to
      // Invoice Qty), and that shortfall's £ value. Floored at zero so a
      // line that's expected to over-deliver doesn't show a negative risk.
      // By construction this is exactly Order Value minus Expected to
      // Invoice Value, so it's already excluded from the Invoiced + Expected
      // to Invoice dashboard card below — that card sums Expected to Invoice
      // Value, which never includes the shortfall captured here.
      row.getCell('riskQty').value = {
        formula: `MAX(${orderQtyCol}${excelRow}-${plannedProductionQtyCol}${excelRow},0)`,
        // Expected to Invoice Qty always starts equal to Order Qty at export
        // time (see the default above), so the shortfall is 0 until a
        // planner overtypes it — same "starts at zero" convention as the
        // other Risk-driven cached results in this file.
        result: 0
      };
      row.getCell('riskValue').value = {
        formula: `IF(${orderQtyCol}${excelRow}>0,${riskQtyCol}${excelRow}*(${orderValueCol}${excelRow}/${orderQtyCol}${excelRow}),0)`,
        result: 0
      };
      // Running count of PTFE rows with a Risk Value > 0, in row order — the
      // Dashboard's At-Risk Lines list uses this with INDEX/MATCH to pull out
      // the 1st, 2nd, 3rd… flagged line. Blank ("") when this row isn't a
      // flagged PTFE row, so MATCH skips straight past it. Risk Value is
      // fully automatic now (no manual Risk "x" column any more), so this
      // just keys off whatever the calculated shortfall already is.
      row.getCell('atRiskSeq').value = {
        formula: `IF(AND(${valueStreamCol}${excelRow}="PTFE",${riskValueCol}${excelRow}>0),COUNTIFS($${riskValueCol}$2:$${riskValueCol}${excelRow},">0",$${valueStreamCol}$2:$${valueStreamCol}${excelRow},"PTFE"),"")`,
        result: ''
      };
      // Same running-count pattern as At Risk Seq, keyed on Won't Get="x"
      // instead of Risk Value>0 — feeds the Dashboard's Confirmed Not
      // Getting list, mirroring the At-Risk Lines list alongside it.
      row.getCell('notGettingSeq').value = {
        formula: `IF(AND(${valueStreamCol}${excelRow}="PTFE",${wontGetCol}${excelRow}="x"),COUNTIFS($${wontGetCol}$2:$${wontGetCol}${excelRow},"x",$${valueStreamCol}$2:$${valueStreamCol}${excelRow},"PTFE"),"")`,
        result: ''
      };

      // Won't Get — "x" here means confirmed, not maybe. Distinct from Risk
      // Value (which is a calculated, partial shortfall): a row can have a
      // Risk Value shortfall and still be expected in some quantity, whereas
      // Won't Get means none of it is coming.
      row.getCell('wontGet').dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"x"']
      };
      row.getCell('wontGet').alignment = { horizontal: 'center' };

      row.getCell('reason').alignment = { horizontal: 'left', vertical: 'top', wrapText: true };

      // Last Day — same "x" flag pattern as Won't Get: marks a line as due on
      // the last day of the month, with a free-text time next to it (kept as
      // plain text rather than an Excel time value so planners can write
      // "TBC", "AM", etc. as well as a clock time).
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
      row.getCell('wontGet').fill                = inputFill;
      row.getCell('reason').fill                 = inputFill;
      row.getCell('lastDay').fill                = inputFill;
      row.getCell('lastDayTime').fill            = inputFill;
      row.getCell('plannedProductionQty').fill   = inputFill;
    });

    ['orderQty', 'stockQty', 'pickedQty', 'plannedProductionQty', 'minShipQty', 'maxShipQty', 'riskQty'].forEach(key => {
      dataWs.getColumn(key).numFmt = '#,##0';
    });
    ['orderValue', 'stockValue', 'pickedValue', 'plannedProductionValue', 'riskValue'].forEach(key => {
      dataWs.getColumn(key).numFmt = '#,##0.00';
    });

    dataWs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: dataWs.columns.length } };
    dataWs.views = [{ state: 'frozen', ySplit: 1 }];

    // ── Next Month sheet (Month End export only) ────────────────────────────
    // PTFE orders due the calendar month after this one — a candidate pool
    // to pull forward if the Data tab shows this month falling short.
    // "Bring Forward" is a manual "x" flag a planner types in to confirm an
    // order actually will be pulled forward (same dropdown pattern as Won't
    // Get / Last Day on the Data tab). Bring Forward Value is a live formula
    // that reads that flag: Stock Value when flagged "x", 0 otherwise — so
    // the figure only reflects what's actually been confirmed, not just
    // whatever happens to be sat in stock. getOrderBookBreakdown() carries
    // StockQty/StockValue for every row regardless of month, so this needs
    // no extra query. The flag round-trips via dbo.OrderBookLineNotes.
    // BringForward (see listOrderBookLineNotes/upsertOrderBookLineNotes in
    // performancesql.js and the upload-notes route further down) so it
    // survives a re-download instead of resetting every export.
    let nextMonthWs = null;
    if (mode === 'monthEnd') {
      nextMonthWs = wb.addWorksheet('Next Month');
      nextMonthWs.columns = [
        { header: 'Customer',      key: 'customer',          width: 14 },
        { header: 'Customer Name', key: 'customerName',      width: 30 },
        { header: 'Order',         key: 'referenceDocument', width: 14 },
        { header: 'Date',          key: 'requestDate',       width: 14 },
        { header: 'Material',      key: 'material',          width: 16 },
        { header: 'Order Qty',     key: 'orderQty',          width: 14 },
        { header: 'Order Value',   key: 'orderValue',        width: 14 },
        { header: 'Stock Qty',     key: 'stockQty',          width: 14 },
        { header: 'Stock Value',   key: 'stockValue',        width: 14 },
        { header: 'Bring Forward', key: 'bringForwardConfirm', width: 12 },
        { header: 'Bring Forward Value', key: 'bringForward', width: 18 },
      ];

      const nmHeaderRow = nextMonthWs.getRow(1);
      nmHeaderRow.height = 22;
      nmHeaderRow.eachCell(cell => {
        cell.fill      = headerFill;
        cell.font      = headerFont;
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
        cell.border    = cellBorder;
      });

      const nmOrderQtyCol   = excelColumnLetter(nextMonthWs.getColumn('orderQty').number);
      const nmOrderValueCol = excelColumnLetter(nextMonthWs.getColumn('orderValue').number);
      const nmStockQtyCol   = excelColumnLetter(nextMonthWs.getColumn('stockQty').number);
      const nmStockValueCol = excelColumnLetter(nextMonthWs.getColumn('stockValue').number);
      const nmBringForwardConfirmCol = excelColumnLetter(nextMonthWs.getColumn('bringForwardConfirm').number);

      nextMonthRows.forEach((r, i) => {
        const excelRow = i + 2;

        // Prefill the confirm flag from whatever a previous planner already
        // uploaded for this exact order/material — see
        // dbo.OrderBookLineNotes.BringForward / listOrderBookLineNotes — so
        // downloading fresh never resets a decision already made.
        const nmNotes = lineNotesMap.get(`${r.ReferenceDocument}||${r.Material}`) || {};
        const bringForwardFlag = nmNotes.bringForward === 'x' ? 'x' : '';

        const row = nextMonthWs.addRow({
          customer: r.Customer,
          customerName: r.CustomerName || r.Customer,
          referenceDocument: r.ReferenceDocument,
          requestDate: r.RequestDate ? new Date(r.RequestDate).toISOString().slice(0, 10) : '',
          material: r.Material,
          orderQty: Number(r.OrderQty || 0),
          orderValue: Number(r.OrderValue || 0),
          stockQty: Number(r.StockQty || 0),
          bringForwardConfirm: bringForwardFlag,
          // stockValue / bringForward set as formulas below.
        });

        row.getCell('stockValue').value = {
          formula: `IF(${nmOrderQtyCol}${excelRow}>0,${nmStockQtyCol}${excelRow}*(${nmOrderValueCol}${excelRow}/${nmOrderQtyCol}${excelRow}),0)`,
          result: Number(r.StockValue || 0)
        };
        // Bring Forward — "x" here means a planner has confirmed this order
        // will actually be brought forward, same dropdown pattern as Won't
        // Get / Last Day on the Data tab.
        row.getCell('bringForwardConfirm').dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: ['"x"']
        };
        row.getCell('bringForwardConfirm').alignment = { horizontal: 'center' };
        // Bring Forward Value — 0 unless the Bring Forward flag is "x", in
        // which case it's Stock Value: what's already in stock for this
        // next-month order is what actually gets pulled forward once
        // confirmed, not just whatever's available.
        row.getCell('bringForward').value = {
          formula: `IF(${nmBringForwardConfirmCol}${excelRow}="x",${nmStockValueCol}${excelRow},0)`,
          result: bringForwardFlag === 'x' ? Number(r.StockValue || 0) : 0
        };

        const fill = i % 2 === 0 ? oddFill : evenFill;
        row.eachCell(cell => {
          cell.fill   = fill;
          cell.font   = { name: 'Arial', size: 10, color: { argb: 'FF000000' } };
          cell.border = cellBorder;
        });
        // Override the alternating fill so the manual-entry flag stands out
        // from the SAP-sourced / formula columns, same as Won't Get / Last
        // Day on the Data tab.
        row.getCell('bringForwardConfirm').fill = inputFill;
      });

      nextMonthWs.getColumn('orderQty').numFmt   = '#,##0';
      nextMonthWs.getColumn('stockQty').numFmt   = '#,##0';
      ['orderValue', 'stockValue', 'bringForward'].forEach(key => {
        nextMonthWs.getColumn(key).numFmt = '#,##0.00';
      });
      nextMonthWs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: nextMonthWs.columns.length } };
      nextMonthWs.views = [{ state: 'frozen', ySplit: 1 }];
    }

    // ── Dashboard sheet ──────────────────────────────────────────────────
    const dataStockRange  = `'Data'!$${stockValueCol}:$${stockValueCol}`;
    const dataPickedRange = `'Data'!$${pickedValueCol}:$${pickedValueCol}`;
    const dataStreamRange = `'Data'!$${valueStreamCol}:$${valueStreamCol}`;
    const dataWontGetRange = `'Data'!$${wontGetCol}:$${wontGetCol}`;
    const dataLastDayRange              = `'Data'!$${lastDayCol}:$${lastDayCol}`;
    const dataPlannedQtyRange           = `'Data'!$${plannedProductionQtyCol}:$${plannedProductionQtyCol}`;
    const dataPlannedValueRange         = `'Data'!$${plannedProductionValueCol}:$${plannedProductionValueCol}`;
    const dataRiskQtyRange               = `'Data'!$${riskQtyCol}:$${riskQtyCol}`;
    const dataRiskValueRange             = `'Data'!$${riskValueCol}:$${riskValueCol}`;

    // Bounded (not full-column) ranges, capped generously past the current
    // row count to leave room for rows added later. Some of these (the "B"
    // suffix ranges below) were originally shared with the now-removed
    // Value-by-Hour table and are unused elsewhere; left in place as they're
    // harmless and may be useful again if a hour-level view is rebuilt.
    const maxDataRow = Math.max(2000, rows.length + 500);
    const b = (col) => `'Data'!$${col}$2:$${col}$${maxDataRow}`;
    const dataStreamRangeB      = b(valueStreamCol);
    const dataLastDayRangeB     = b(lastDayCol);
    const dataLastDayTimeRangeB = b(lastDayTimeCol);
    const dataStockRangeB       = b(stockValueCol);
    const dataPlannedValueRangeB      = b(plannedProductionValueCol);
    const dataReferenceDocumentRangeB = b(referenceDocumentCol);

    // Cached display values (Excel recalculates the live formulas on open) —
    // computed the same way the formulas will: Expected to Invoice Qty
    // defaults to Order Qty at export time, so Risk Value is 0 for every
    // row, so the "potential stock" total starts out equal to the full
    // stock total and the risk cards start at zero.
    const ptfeRows = rows.filter(r => r.ValueStream === 'PTFE');
    const pickedTotalPtfe    = ptfeRows.reduce((sum, r) => sum + Number(r.PickedValue || 0), 0);
    const stockTotalPtfe     = ptfeRows.reduce((sum, r) => sum + Number(r.StockValue  || 0), 0);
    const invoicedPlusPicked = invoicedToDate + pickedTotalPtfe;
    const invoicedPlusStock  = invoicedPlusPicked + stockTotalPtfe;

    // 16 columns (A:P) — 12 for the main value-card grid plus 4 (M:P) for a
    // dedicated risk section to the right of it. Width dropped from 24 to 15
    // per request to shrink the cards down (Excel showed 24 as ~23.29 once
    // opened — the exact number doesn't map 1:1 to the ExcelJS setting due
    // to font-width rounding, but this is a straightforward reduction).
    dashboardWs.columns = Array.from({ length: 16 }, (_, i) => ({ key: String.fromCharCode(97 + i), width: 15 }));

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
    const descAlign      = { horizontal: 'left', vertical: 'top', wrapText: true };

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
    // (Invoiced to date, Risk/Last Day/Expected to Invoice starting at their
    // export-time values), so it needs to be precise enough to tell two
    // exports from the same day apart.
    const generatedAt = new Date().toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    dashboardWs.getRow(1).height = 30;
    setMergedCell('A1:P1', 'PTFE Order Book Dashboard', titleFont, titleFill);
    // Row 2 (the mode/generated-at subtitle line) removed per request — the
    // card grid now starts right after the title, one row higher than
    // before. generatedAt is still computed above in case it's needed again
    // elsewhere on the sheet.

    // ── Card grid — 2 rows x 3 value cards (A:L) plus a risk section to the
    // right (M:P) ────────────────────────────────────────────────────────
    // Column groups: A:D, E:H, I:L for the main value cards, M:P for the two
    // risk-styled cards (Confirmed Not Getting, Value at Risk — Shortfall),
    // kept visually and structurally separate from the "good news" totals.
    // Row groups: label / value / description / spacer, 4 rows per card row.
    // The value-cell address for card 1 (and every other card) is read back
    // dynamically from placeCard()'s return value rather than hardcoded
    // anywhere, so shifting the grid up when row 2 was removed didn't
    // require touching any formula. Description rows default to 60px tall
    // (vs. the old ~15px default) so wrapped 3-4 line text isn't clipped —
    // Excel doesn't auto-size row height for wrapped merged cells, so this
    // has to be set explicitly. Per request, the two card rows' description
    // rows are then overridden to 40px and 50px respectively — see below.
    const colGroups = [['A', 'D'], ['E', 'H'], ['I', 'L'], ['M', 'P']];
    const gridRowStarts = [3, 7];

    function placeCard(rowIdx, colIdx, { label, value, numFmt, desc, risk }) {
      const [c1, c2] = colGroups[colIdx];
      const labelRow = gridRowStarts[rowIdx];
      const valueRow = labelRow + 1;
      const descRow  = labelRow + 2;
      dashboardWs.getRow(labelRow).height = 22;
      dashboardWs.getRow(valueRow).height = 34;
      dashboardWs.getRow(descRow).height  = 60;

      setMergedCell(`${c1}${labelRow}:${c2}${labelRow}`, label, risk ? riskLabelFont : cardLabelFont, risk ? riskLabelFill : cardLabelFill);
      const valueCell = setMergedCell(`${c1}${valueRow}:${c2}${valueRow}`, value, risk ? riskValueFont : cardValueFont, null);
      if (numFmt) valueCell.numFmt = numFmt;
      setMergedCell(`${c1}${descRow}:${c2}${descRow}`, desc, cardDescFont, null, descAlign);

      return `${c1}${valueRow}`; // this card's value-cell address, for cross-referencing
    }

    // Needed by the Bring Forward card (row 2) below — computed here, ahead
    // of the card grid, since it now sits earlier in the grid than the
    // Next Month tab itself is built further up the file.
    let nextMonthBringForwardRange = null;
    if (nextMonthWs) {
      const nextMonthBringForwardCol = excelColumnLetter(nextMonthWs.getColumn('bringForward').number);
      nextMonthBringForwardRange = `'Next Month'!$${nextMonthBringForwardCol}:$${nextMonthBringForwardCol}`;
    }

    // Row 1 of the grid — running totals building up from Invoiced to date.
    const invoicedCellAddr = placeCard(0, 0, {
      label: `INVOICED TO DATE (PTFE — ${monthLabel})`,
      value: invoicedToDate,
      numFmt: '#,##0.00',
      desc: 'From SAP billing documents, as of the moment this file was generated — not a live formula.'
    });

    placeCard(0, 1, {
      label: 'INVOICED + PICKED (PTFE)',
      value: { formula: `$${invoicedCellAddr}+SUMIFS(${dataPickedRange},${dataStreamRange},"PTFE")`, result: invoicedPlusPicked },
      numFmt: '#,##0.00',
      desc: 'Invoiced plus stock already picked — effectively secured.'
    });

    // Stock Qty/Value already includes picked stock (picked is a subset of
    // stock, not additional to it), so this does NOT also add Picked Value
    // on top — that would double-count whatever's already been picked.
    placeCard(0, 2, {
      label: 'INVOICED + POTENTIAL STOCK (PTFE)',
      value: {
        formula: `$${invoicedCellAddr}+SUMIFS(${dataStockRange},${dataStreamRange},"PTFE",${dataRiskValueRange},"<=0",${dataWontGetRange},"<>x")`,
        result: invoicedToDate + stockTotalPtfe
      },
      numFmt: '#,##0.00',
      desc: 'Full month-end prediction: invoiced + stock for lines with no Risk Value shortfall and not flagged Won\'t Get on the Data tab. Stock Value already includes anything picked, so Picked Value isn\'t added again here.'
    });

    // Confirmed Not Getting — top of the risk section (M:P), aligned with
    // row 1 of the main grid. Deliberately kept apart from the value cards:
    // this is a confirmed miss, not a maybe, so it's tracked on its own so
    // it never gets conflated with the shortfall card below it. Pulls from
    // Expected to Invoice Value (column U) rather than Stock Value — this
    // needs to show what we're actually failing to deliver against the
    // order, not just whatever happens to be sat in stock for that line.
    placeCard(0, 3, {
      label: 'CONFIRMED NOT GETTING (PTFE)',
      value: { formula: `SUMIFS(${dataPlannedValueRange},${dataStreamRange},"PTFE",${dataWontGetRange},"x")`, result: 0 },
      numFmt: '#,##0.00',
      desc: {
        formula: `COUNTIFS(${dataStreamRange},"PTFE",${dataWontGetRange},"x")&" line(s) confirmed not getting. Excluded from Invoiced + Potential Stock, Invoiced + Expected to Invoice and Final Day Total. Filter the Won't Get column on the Data tab for detail."`,
        result: '0 line(s) confirmed not getting.'
      },
      risk: true
    });

    // Row 2 of the main grid — Expected to Invoice, Final Day Total and
    // Value Due (Last Day) — swapped in from its old row-3 slot so the risk
    // shortfall card below can move out to the risk section on the right.
    // Excludes rows flagged Last Day = "x" (tracked separately in Final Day
    // Total) and rows with a Risk Value shortfall (belt-and-braces alongside
    // Expected to Invoice Qty/Value themselves, which should already be
    // reduced to reflect a known shortfall — Risk Value is now fully
    // automatic, so this is just checking the same shortfall two ways).
    const plannedCellAddr = placeCard(1, 0, {
      label: 'INVOICED + EXPECTED TO INVOICE (PTFE)',
      value: {
        formula: `$${invoicedCellAddr}+SUMIFS(${dataPlannedValueRange},${dataStreamRange},"PTFE",${dataLastDayRange},"<>x",${dataWontGetRange},"<>x")`,
        result: invoicedToDate + ptfeRows.filter(r => String(r.lastDay || '').toLowerCase() !== 'x').reduce((sum, r) => sum + Number(r.StockValue || 0), 0)
      },
      numFmt: '#,##0.00',
      desc: 'Invoiced plus Expected to Invoice Value for everything NOT flagged Last Day or Won\'t Get, and with no Risk Value shortfall (Last Day items are in Final Day Total below instead; Won\'t Get and at-risk items are excluded so this stays a conservative minimum).'
    });

    placeCard(1, 1, {
      label: 'FINAL DAY TOTAL (PTFE)',
      value: {
        formula: `$${plannedCellAddr}+SUMIFS(${dataPlannedValueRange},${dataStreamRange},"PTFE",${dataLastDayRange},"x",${dataWontGetRange},"<>x")`,
        result: 0
      },
      numFmt: '#,##0.00',
      desc: 'Invoiced + Expected to Invoice (left) plus the Expected to Invoice Value of everything flagged Last Day but NOT Won\'t Get.'
    });

    // Value Confirmed to Bring Forward (Next Month) — moved up into this
    // slot, replacing the old Value Due (PTFE) — Last Day card (removed
    // per request). Next Month tab's Bring Forward Value column is 0 unless
    // a planner has flagged the Bring Forward column "x" on that row, so
    // this SUM only ever totals confirmed lines, not everything with stock.
    placeCard(1, 2, {
      label: 'VALUE CONFIRMED TO BRING FORWARD (NEXT MONTH)',
      value: nextMonthBringForwardRange
        ? { formula: `SUM(${nextMonthBringForwardRange})`, result: 0 }
        : 0,
      numFmt: '#,##0.00',
      desc: nextMonthBringForwardRange
        ? {
            formula: `COUNTIF(${nextMonthBringForwardRange},">0")&" line(s) confirmed. Stock Value of Next Month tab rows flagged ""x"" in the Bring Forward column — use that column to confirm which orders will actually be pulled into this month."`,
            result: '0 line(s) confirmed.'
          }
        : '0 line(s) confirmed (no Next Month tab on a Full Breakdown export).'
    });

    // Value at Risk — Shortfall — bottom of the risk section (M:P), aligned
    // with row 2 of the main grid. Calculated, not a manual flag: SUM(Risk
    // Value) on the Data tab, where Risk Value = MAX(Order Qty - Expected
    // to Invoice Qty, 0) priced at the order's unit value — the £ value of
    // whatever we now expect to fall short of the order. This is the only
    // "value at risk" card on the dashboard now; the old manual Risk="x"
    // flag card has been removed rather than kept alongside it. Swapped out
    // of the main grid's row-2 slot (now Value Due — Last Day) and into
    // this dedicated risk section, next to Confirmed Not Getting above.
    placeCard(1, 3, {
      label: 'VALUE AT RISK — SHORTFALL (PTFE)',
      value: { formula: `SUMIFS(${dataRiskValueRange},${dataStreamRange},"PTFE")`, result: 0 },
      numFmt: '#,##0.00',
      desc: {
        formula: `COUNTIFS(${dataStreamRange},"PTFE",${dataRiskQtyRange},">0")&" line(s) with a shortfall. The £ value of Order Qty minus Expected to Invoice Qty, summed across every PTFE line — calculated automatically, not a manual flag; already excluded from Invoiced + Expected to Invoice by construction."`,
        result: '0 line(s) with a shortfall.'
      },
      risk: true
    });

    // Row 3 of the grid is gone — Bring Forward moved up into row 2 (see
    // above), and Confirmed Not Getting / Value at Risk — Shortfall already
    // live in the risk section (M:P), so there's nothing left to place here.
    // Grid is now 2 rows tall (gridRowStarts = [3, 7]); the At-Risk Lines
    // section below starts right after it rather than leaving a dead row.

    // Per request: the two card rows' description rows (60px by default,
    // set inside placeCard above) are overridden here to different, smaller
    // heights now that row 2 is gone and the grid sits higher on the sheet.
    dashboardWs.getRow(5).height = 40;
    dashboardWs.getRow(9).height = 50;

    // ── Risk / Not-Getting lines detail — half width each, below the card
    // grid ───────────────────────────────────────────────────────────────
    // Excel has no true "hover tooltip" that can show live, formula-driven
    // content (native cell comments only hold static text), so each list
    // pairs a hyperlink to the filtered Data tab (works on every Excel
    // version) with a short static list of the flagged lines themselves —
    // built with plain INDEX/MATCH against a hidden helper column on the
    // Data tab, not TEXTJOIN/dynamic arrays, so it evaluates correctly on
    // any Excel version (2007 and up), not just 365/2021+. At-Risk Lines
    // (left half, A:H) and Confirmed Not Getting (right half, I:P) sit side
    // by side in exactly the same layout/style so they read as a matched
    // pair — same header fill, same hyperlink style, same list row count
    // and formatting, same footer wording.
    function buildFlaggedLinesList({ startCol, endCol, title, hyperlinkText, seqCol, valueCol, unitLabel }) {
      setMergedCell(`${startCol}11:${endCol}11`, title, cardLabelFont, cardLabelFill);
      setMergedCell(
        `${startCol}12:${endCol}12`,
        { text: hyperlinkText, hyperlink: "#'Data'!A1" },
        { name: 'Arial', size: 10, color: { argb: 'FF1F3864' }, underline: true },
        null,
        { horizontal: 'left', vertical: 'middle' }
      );

      const listStartRow = 13;
      const listCount = 10;
      for (let idx = 0; idx < listCount; idx++) {
        const r = listStartRow + idx;
        const n = idx + 1;
        dashboardWs.getRow(r).height = 16;
        dashboardWs.mergeCells(`${startCol}${r}:${endCol}${r}`);
        const cell = dashboardWs.getCell(`${startCol}${r}`);
        cell.value = {
          formula: `IFERROR(INDEX(Data!$${materialCol}:$${materialCol},MATCH(${n},Data!$${seqCol}:$${seqCol},0))&" | Order "&INDEX(Data!$${referenceDocumentCol}:$${referenceDocumentCol},MATCH(${n},Data!$${seqCol}:$${seqCol},0))&" | £"&TEXT(INDEX(Data!$${valueCol}:$${valueCol},MATCH(${n},Data!$${seqCol}:$${seqCol},0)),"#")&" ${unitLabel}","")`,
          result: ''
        };
        cell.font = { name: 'Arial', size: 9, color: { argb: 'FF444444' } };
        cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
      }
      setMergedCell(
        `${startCol}${listStartRow + listCount}:${endCol}${listStartRow + listCount}`,
        `Shows the first ${listCount} flagged lines, in the order they appear on the Data tab — works on every Excel version. More than ${listCount}? Use the link above for the full list. Blank rows above just mean fewer than ${listCount} are flagged.`,
        cardDescFont, null
      );
    }

    // Left half — Risk Value (the calculated shortfall), rounded to the
    // nearest whole pound so the figure reads cleanly at a glance — not
    // Stock Value, consistent with the Value at Risk — Shortfall card above.
    buildFlaggedLinesList({
      startCol: 'A', endCol: 'H',
      title: 'AT-RISK LINES (PTFE)',
      hyperlinkText: 'Open the Data tab and sort/filter by Risk Value to show every flagged row',
      seqCol: atRiskSeqCol,
      valueCol: riskValueCol,
      unitLabel: 'at risk'
    });

    // Right half — Expected to Invoice Value for rows flagged Won't Get="x",
    // matching the £ figure the Confirmed Not Getting card above sums.
    buildFlaggedLinesList({
      startCol: 'I', endCol: 'P',
      title: 'CONFIRMED NOT GETTING (PTFE)',
      hyperlinkText: "Open the Data tab and sort/filter by Won't Get to show every flagged row",
      seqCol: notGettingSeqCol,
      valueCol: plannedProductionValueCol,
      unitLabel: 'not getting'
    });

    // Value-by-hour table removed per request (wasn't working reliably).
    // Value Due (PTFE) — Last Day, in the main grid above, still surfaces
    // the total due on the last day; the hour-level breakdown is gone.

    // Landscape print orientation, fit to page width — matches the wide grid
    // layout above so a printed copy doesn't get sliced into narrow strips.
    dashboardWs.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
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
// Reads the Data sheet back out with ExcelJS and upserts whatever a planner
// typed into Won't Get/Reason/Last Day/Last Day Time/Expected to Invoice
// Qty into dbo.OrderBookLineNotes, so the next person to download
// the sheet sees it prefilled instead of starting blank. The Next Month
// tab's Stock Qty/Value and Bring Forward Value are still live formulas,
// not manual input, but its Bring Forward column (the "x" confirm flag) IS
// read back here too — same dbo.OrderBookLineNotes.BringForward field,
// keyed the same way — so a planner's confirmation survives a re-download.
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
          // No Risk column any more — it's calculated on the Data sheet now
          // (Risk Value), not round-tripped from an uploaded flag.
          reason:                readCellText(row, dataHeaderMap['Reason']),
          wontGet:               readCellText(row, dataHeaderMap["Won't Get"]),
          lastDay:               readCellText(row, dataHeaderMap['Last Day']),
          lastDayTime:           readCellText(row, dataHeaderMap['Last Day Time']),
          // Set from the Next Month sheet below, if present — a
          // referenceDocument/material combo may not appear on the Data tab
          // at all (Data is scoped to this month or earlier; Next Month is
          // scoped to next month), so this defaults blank here.
          bringForward:          '',
          plannedProductionQty:  readCellText(row, dataHeaderMap['Expected to Invoice Qty']),
        });
      });

      // Next Month sheet — only the Bring Forward confirm flag round-trips
      // from here (Stock Qty/Value and Bring Forward Value are live
      // formulas, not planner input). A row here may not have a matching
      // Data-sheet row (Next Month orders fall outside this-month-or-earlier
      // scope), so a new notesByKey entry is created when needed rather than
      // requiring one to already exist.
      const nextMonthWs = wb.getWorksheet('Next Month');
      if (nextMonthWs) {
        const nextMonthHeaderMap = buildHeaderMap(nextMonthWs.getRow(1));
        const confirmCol = nextMonthHeaderMap['Bring Forward'];

        nextMonthWs.eachRow({ includeEmpty: false }, (row, rowNumber) => {
          if (rowNumber === 1) return; // header

          const referenceDocument = readCellText(row, nextMonthHeaderMap['Order']);
          const material          = readCellText(row, nextMonthHeaderMap['Material']);
          if (!referenceDocument || !material) return;

          const bringForwardFlag = readCellText(row, confirmCol);
          const key = `${referenceDocument}||${material}`;
          const existing = notesByKey.get(key);
          if (existing) {
            existing.bringForward = bringForwardFlag;
          } else {
            notesByKey.set(key, {
              referenceDocument,
              material,
              reason: '',
              wontGet: '',
              lastDay: '',
              lastDayTime: '',
              bringForward: bringForwardFlag,
              plannedProductionQty: '',
            });
          }
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

// ── Consignment customers ────────────────────────────────────────────────
// Customers on a consignment stock agreement — shipped but not invoiced
// until consumed. Excluded server-side from recomputeDailyInvoiced() /
// getOrderBookSummary() / getOrderBookBreakdown() (performancesql.js) so
// they stop inflating the Month End Order Book export and the Management
// page's KPI cards. This is just the admin CRUD for the flag list itself —
// see sql/migrate_consignment_customers.sql for the table and why this is
// unrelated to the existing SOBKZ=K "consignment stock" MRP feature.
// Read: any logged-in user (matches the loose gating on the rest of this
// router's orderbook-breakdown routes). Write: LOG_ADMIN — already used
// elsewhere in this router (see /turns-valclass/aggregates,
// /turns-valclass/value-by-price) as the admin-tier permission code.
router.get('/consignment-customers', async (req, res) => {
  try {
    const rows = await db.listConsignmentCustomers();
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[consignment-customers] GET failed', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.put('/consignment-customers/:customer', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const customer = String(req.params.customer || '').trim();
    if (!customer) {
      return res.status(400).json({ success: false, error: { message: 'Customer number is required.' } });
    }
    const { customerName } = req.body || {};
    await db.upsertConsignmentCustomer(customer, customerName, req.session?.user?.username);
    await auditQuery('CONSIGNMENT_CUSTOMER_SAVE', req.session?.user?.username, `Flagged customer '${customer}' as consignment`, req);
    res.json({ success: true });
  } catch (err) {
    console.error('[consignment-customers] PUT failed', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.delete('/consignment-customers/:customer', requirePermission('LOG_ADMIN'), async (req, res) => {
  try {
    const customer = String(req.params.customer || '').trim();
    await db.deleteConsignmentCustomer(customer);
    await auditQuery('CONSIGNMENT_CUSTOMER_DELETE', req.session?.user?.username, `Un-flagged customer '${customer}' as consignment`, req);
    res.json({ success: true });
  } catch (err) {
    console.error('[consignment-customers] DELETE failed', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Printable Production Plan ────────────────────────────────────────────
// Bare, standalone HTML report — same convention as routes/labels.js's
// browser-preview route (buildHTML/GET /process/:code/:id). The rest of
// the Management page has too much on it to print sensibly, so this
// deliberately skips all app chrome (sidebar, header, charts, filters) and
// is just a clean table meant to go straight to a printer, auto-firing
// window.print() on load the same way the label preview does.
//
// Scope: PTFE lines flagged Last Day = "x" in dbo.OrderBookLineNotes,
// excluding anything also flagged Won't Get, sorted by Last Day Time.
// Quantity is whatever's been uploaded as Expected to Invoice Qty for that
// line (falling back to Order Qty if nothing's been uploaded yet) — the
// same figure the Data tab itself defaults to and the Dashboard's Last Day
// cards are built from, so this always matches what's on the spreadsheet.
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// "15:00" -> 900 (minutes since midnight) for sorting; blank or anything
// that doesn't start with H:MM sorts first — same "defaults to the Hour 0
// bucket" convention as the Excel Value-by-Hour table, so a plan printed
// straight after upload lines up with what the Dashboard already implies.
function parseLastDayTimeMinutes(text) {
  const match = String(text || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return -1;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return -1;
  return hours * 60 + minutes;
}

function buildProductionPlanHTML(plan) {
  const generatedAt = new Date().toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  const totalQty   = plan.reduce((sum, p) => sum + p.quantity, 0);
  const totalValue = plan.reduce((sum, p) => sum + p.value, 0);

  const rowsHtml = plan.length
    ? plan.map(p => `
      <tr>
        <td>${esc(p.time || '—')}</td>
        <td>${esc(p.customer)}</td>
        <td>${esc(p.material)}${p.materialText ? ` — ${esc(p.materialText)}` : ''}</td>
        <td class="num">${p.quantity.toLocaleString('en-GB', { maximumFractionDigits: 3 })}</td>
        <td class="num">£${p.value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="empty">Nothing is currently flagged Last Day on the PTFE order book.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Production Plan — Last Day of Month</title>
<style>
  @page { size: A4 portrait; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, sans-serif; color: #0F172A; margin: 0; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .subtitle { font-size: 11px; color: #64748B; margin: 0 0 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 1px solid #CBD5E1; padding: 6px 8px; text-align: left; }
  th { background: #1F3864; color: #fff; font-size: 10px; text-transform: uppercase; letter-spacing: .03em; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  tbody tr:nth-child(even) { background: #F1F5F9; }
  tfoot td { font-weight: 700; border-top: 2px solid #1F3864; }
  .empty { text-align: center; color: #64748B; font-style: italic; }
  @media print {
    .no-print { display: none; }
  }
  .no-print { margin-top: 16px; font-size: 11px; color: #64748B; }
</style>
</head>
<body>
  <h1>Production Plan — Last Day of Month (PTFE)</h1>
  <p class="subtitle">Generated ${esc(generatedAt)} &middot; sorted by time &middot; ${plan.length} line(s)</p>
  <table>
    <thead>
      <tr>
        <th>Time</th>
        <th>Customer</th>
        <th>Material</th>
        <th class="num">Quantity</th>
        <th class="num">Value</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
    ${plan.length ? `<tfoot><tr><td colspan="3">Total</td><td class="num">${totalQty.toLocaleString('en-GB', { maximumFractionDigits: 3 })}</td><td class="num">£${totalValue.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td></tr></tfoot>` : ''}
  </table>
  <p class="no-print">This window should print automatically. If it doesn't, use your browser's Print command (Ctrl/Cmd+P).</p>
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 300));</script>
</body>
</html>`;
}

router.get('/orderbook-breakdown/production-plan/print', async (req, res) => {
  try {
    const [rows, lineNotesMap] = await Promise.all([
      db.getOrderBookBreakdown(),
      db.listOrderBookLineNotes(),
    ]);

    const plan = rows
      .filter(r => r.ValueStream === 'PTFE')
      .map(r => ({ r, notes: lineNotesMap.get(`${r.ReferenceDocument}||${r.Material}`) || {} }))
      .filter(({ notes }) =>
        String(notes.lastDay || '').toLowerCase() === 'x' &&
        String(notes.wontGet || '').toLowerCase() !== 'x'
      )
      .map(({ r, notes }) => {
        const orderQty   = Number(r.OrderQty || 0);
        const orderValue = Number(r.OrderValue || 0);
        const quantity   = notes.plannedProductionQty != null ? Number(notes.plannedProductionQty) : orderQty;
        const value       = orderQty > 0 ? quantity * (orderValue / orderQty) : 0;

        return {
          time:         notes.lastDayTime || '',
          sortMinutes:  parseLastDayTimeMinutes(notes.lastDayTime),
          customer:     r.CustomerName || r.Customer,
          material:     r.Material,
          materialText: r.MaterialText,
          quantity,
          value,
        };
      })
      .sort((a, b) => a.sortMinutes - b.sortMinutes || a.time.localeCompare(b.time));

    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.send(buildProductionPlanHTML(plan));

  } catch (err) {
    console.error('[production-plan/print]', err.message);
    res.status(500).send(`<pre>Failed to build production plan: ${esc(err.message)}</pre>`);
  }
});


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

// ── Refresh status (last-run timestamp + any failures) ─────────────────────
// Same dbo.RefreshLog table and same "no false confidence" pattern as the
// Management page's /refresh-status (Stock/Agreements/Invoicing/Otif) —
// scoped here to the two datasets this daily job writes: TurnsValClass and
// ValuationClasses (see routes/performancesync.js runTurnsValClassRefresh).
// If either dataset's most recent run failed, lastRefreshUtc comes back
// null and the failures array is populated instead — the tile should show
// the failure rather than a "last refreshed" date that no longer reflects
// what's on screen. Gated the same as /aggregates so Reports-only viewers
// can see it without needing LOG_MRP.
router.get('/turns-valclass/refresh-status', requireAnyPermission(['LOG_ADMIN', 'LOG_MRP', 'LOG_REPORTS']), async (req, res) => {
  try {
    const datasets = ['TurnsValClass', 'ValuationClasses'];
    const pool = await getPool();
    const { recordset } = await pool.request().query(`
      SELECT TOP 40 DatasetName, Status, CompletedAtUtc, ErrorMessage, RunId
      FROM dbo.RefreshLog
      WHERE DatasetName IN ('TurnsValClass', 'ValuationClasses')
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
// Stock Value Overview — moved from Material Planning into the Logistics
// page's Reports section (see sql/migrate_log_reports_permission.sql).
// Widened from LOG_MRP-only to also accept LOG_ADMIN/LOG_REPORTS: the
// Reports section is shared with Freight Spend/Haulier OTIF (LOG_ADMIN-
// gated) so all four tiles in that section need the same permission set,
// and LOG_REPORTS is the new report-only path in. LOG_MRP holders keep
// exactly the access they already had.
router.get('/turns-valclass/aggregates', requireAnyPermission(['LOG_ADMIN', 'LOG_MRP', 'LOG_REPORTS']), async (req, res) => {
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

    // Ordered chronologically by days-in-stock bucket (see TurnoverCategoryFor
    // in SapServer/Helpers/PerformanceHelpers.cs for where these exact strings
    // come from) rather than by value — a turnover trend is easier to read
    // left-to-right by age than sorted tallest-bar-first. The three non-numeric
    // states (no requirement to plan against, no stock, negative stock) go
    // after the timescale buckets in that order; anything unrecognised falls
    // in at the very end rather than being silently dropped.
    const byTurnoverCategory = await pool.request().query(`
      SELECT TurnoverCategory AS category, COUNT(*) AS materialCount, SUM(StockValue) AS stockValue
      FROM dbo.TurnsValClassSnapshot
      GROUP BY TurnoverCategory
      ORDER BY CASE TurnoverCategory
        WHEN '<10 days'                  THEN 1
        WHEN '10 - 30 days'               THEN 2
        WHEN '31 - 90 days'               THEN 3
        WHEN '91 - 180 days'              THEN 4
        WHEN '181 - 360 days'             THEN 5
        WHEN 'More than 360 days'         THEN 6
        WHEN 'No req. in turnover period' THEN 7
        WHEN 'No requirement'             THEN 8
        WHEN 'No stock'                   THEN 9
        WHEN 'Neg. stock'                 THEN 10
        ELSE 11
      END
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
// Stock Value by Price — same move/widening as /turns-valclass/aggregates
// directly above (see its comment).
router.get('/turns-valclass/value-by-price', requireAnyPermission(['LOG_ADMIN', 'LOG_MRP', 'LOG_REPORTS']), async (req, res) => {
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

// Raises a real purchase order in SAP (BAPI_PO_CREATE1 via SapServer's
// elevated /api/purchasing/create-po-elevated) for one or more Accepted,
// not-yet-ordered tracked orders, then writes the returned PO number back
// onto every included row and flips their status to 'Ordered' — the same
// PoNumber/Status fields the manual "I already raised this myself" flow
// (insertManualOrderRow) fills in by hand, just populated automatically.
//
// One PO per vendor: every suggestionId in the request must belong to the
// same VendorId, matching how Build Order already groups several materials
// from one vendor into one order. Runs under the calling user's own SAP
// credentials (My Account -> SAP Credentials), not the shared service
// account — see SapServer's PurchasingController.CreatePurchaseOrderElevated
// for why the shared account can't create POs at all.
//
// Body: { suggestionIds: number[], priceOverrides?: [{ suggestionId, netPrice }],
// currency?: string, docDate?: string }. priceOverrides/currency/docDate are
// all optional — price is deliberately left out per line unless explicitly
// overridden here, so SAP's own purchasing info record / condition
// determination (ME12) prices the line instead (nothing in Nexus's vendor/
// material master data stores a price) — see PurchasingModels.cs's NetPrice
// comment on the SapServer side. currency defaults to the vendor's own
// Currency field; docDate defaults to today.
router.post('/order-suggestions/create-po', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { suggestionIds, priceOverrides, currency: currencyOverride, docDate } = req.body;
    if (!Array.isArray(suggestionIds) || !suggestionIds.length) {
      return res.status(400).json({ success: false, error: { message: 'suggestionIds must be a non-empty array.' } });
    }

    const callerUserId = req.session?.user?.userID;
    const sapCreds = await getDecryptedSapCredentials(callerUserId);
    if (!sapCreds) {
      return res.status(400).json({
        success: false,
        error: { message: 'You need to save your SAP username and password in My Account before creating a PO in SAP.' },
      });
    }

    // Fresh from the DB, not trusted from whatever the client had on screen —
    // a row's status/PO could have changed since the page was last loaded.
    const idSet = new Set(suggestionIds.map(Number));
    const allTracked = await db.listOrderSuggestionsTracked();
    const rows = allTracked.filter(r => idSet.has(Number(r.SuggestionId)));

    if (rows.length !== suggestionIds.length) {
      return res.status(404).json({ success: false, error: { message: 'One or more selected orders could not be found.' } });
    }
    const alreadyOrdered = rows.filter(r => r.PoNumber || r.Status !== 'Accepted');
    if (alreadyOrdered.length) {
      return res.status(400).json({
        success: false,
        error: { message: `${alreadyOrdered.length} of the selected line(s) already have a PO number or aren't in Accepted status — refresh and try again.` },
      });
    }
    const vendorIds = new Set(rows.map(r => r.VendorId));
    if (vendorIds.size > 1) {
      return res.status(400).json({
        success: false,
        error: { message: 'All selected lines must be from the same vendor — one purchase order per vendor.' },
      });
    }

    if (!rows[0].SapVendorNumber) {
      return res.status(400).json({
        success: false,
        error: { message: `${rows[0].VendorName} has no SAP Vendor Number set — add one on the Vendor Master Data page before creating a PO in SAP.` },
      });
    }
    const currency = currencyOverride || rows[0].Currency;
    if (!currency) {
      return res.status(400).json({
        success: false,
        error: { message: `${rows[0].VendorName} has no currency set — add one on the Vendor Master Data page, or supply one when creating the PO.` },
      });
    }

    const overridesById = new Map((Array.isArray(priceOverrides) ? priceOverrides : [])
      .map(o => [Number(o.suggestionId), o.netPrice]));

    const items = rows.map(r => {
      const override = overridesById.get(Number(r.SuggestionId));
      return {
        Material:     r.Material,
        ShortText:    (r.MaterialText || r.Material || '').slice(0, 40),
        Quantity:     Number(r.OrderQty),
        Unit:         r.Uom || 'KG',
        NetPrice:     (override !== undefined && override !== null && override !== '') ? Number(override) : null,
        DeliveryDate: (r.DeliveryDate ? new Date(r.DeliveryDate) : new Date()).toISOString().slice(0, 10),
      };
    });

    const today = new Date().toISOString().slice(0, 10);
    let sapResp;
    try {
      sapResp = await axios.post(
        `${sapConfig.url}/api/purchasing/create-po-elevated`,
        {
          SapUsername: sapCreds.sapUsername,
          SapPassword: sapCreds.sapPassword,
          Vendor:      rows[0].SapVendorNumber,
          Currency:    currency,
          DocDate:     docDate || today,
          Items:       items,
        },
        { timeout: 90000, httpsAgent: sapAgent, headers: { Authorization: `Bearer ${makeSapToken(callerUserId)}` } }
      );
    } catch (err) {
      const message = extractPoErrorMessage(err.response?.data, err.message);
      return res.status(err.response?.status || 500).json({ success: false, error: { message } });
    }

    const sapBody = sapResp.data;
    if (!sapBody.success || !sapBody.data?.purchaseOrder) {
      return res.status(400).json({
        success: false,
        error: { message: extractPoErrorMessage(sapBody, 'SAP did not return a purchase order number.') },
      });
    }

    const poNumber = sapBody.data.purchaseOrder;

    // updateOrderSuggestionStatus is a full-row update (see its own comment
    // in performancesql.js) — Notes/SupplierReference are carried through
    // from the fresh rows fetched above rather than left null, so this
    // doesn't silently wipe either field on the way to marking the order
    // Ordered.
    for (const r of rows) {
      await db.updateOrderSuggestionStatus(r.SuggestionId, {
        status: 'Ordered',
        poNumber,
        notes: r.Notes || null,
        supplierReference: r.SupplierReference || null,
      });
    }

    res.json({
      success: true,
      data: {
        purchaseOrder: poNumber,
        suggestionIds: rows.map(r => r.SuggestionId),
        messages: sapBody.data.messages || [],
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

router.put('/order-suggestions/:suggestionId', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { status, orderQty, deliveryDate, readyToCollectDate } = req.body;
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
    // Same optional shape — only present when the Tracked Orders Due Date
    // field was edited. Whichever of the two comes through, catch an
    // unparseable value here rather than letting it reach the DB as an
    // invalid-date error.
    if (deliveryDate != null && isNaN(new Date(deliveryDate).getTime())) {
      return res.status(400).json({ success: false, error: { message: 'deliveryDate is not a valid date.' } });
    }
    if (readyToCollectDate != null && isNaN(new Date(readyToCollectDate).getTime())) {
      return res.status(400).json({ success: false, error: { message: 'readyToCollectDate is not a valid date.' } });
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

// Manual Inbound Shipment — a shipment not derived from any tracked-order
// selection (e.g. a customer return). Registered BEFORE the :shipmentId
// routes below so 'manual' can't be mistaken for a shipment id — same
// route-ordering caution used elsewhere in this file (see the supplier
// invoice upload section's comment). Body: { originDestinationID,
// forwarderID, modeOfTransport, dispatchDate, expectedEta, trackingNumber,
// notes, price?, costCentre?, tier? }. price/costCentre/tier are optional —
// supplying a price auto-creates one Associated Costs line for the new
// shipment via insertInboundCostLine (see routes/inboundcosts.js).
router.post('/order-suggestions/shipments/manual', requirePermission('LOG_MRP'), async (req, res) => {
  try {
    const { originDestinationID, forwarderID, modeOfTransport, dispatchDate, expectedEta, trackingNumber, notes, price, costCentre, tier } = req.body;

    const data = await db.createManualOrderShipment({
      originDestinationID: originDestinationID || null,
      forwarderID: forwarderID || null,
      modeOfTransport: modeOfTransport || null,
      dispatchDate: dispatchDate || null,
      expectedEta: expectedEta || null,
      trackingNumber: trackingNumber || null,
      notes: notes || null,
    });

    let cost = null;
    if (price && Number(price) > 0) {
      const pool = await getPool();
      cost = await insertInboundCostLine(pool, {
        poShipmentID: data.shipmentId,
        costCenter: costCentre || null,
        tier: tier === 'premium' ? 'premium' : 'standard',
        amount: Number(price),
        information: `Manual inbound shipment — ${data.shipmentReference}`,
      });
    }

    res.json({ success: true, data: { ...data, cost } });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: { message: err.message } });
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
