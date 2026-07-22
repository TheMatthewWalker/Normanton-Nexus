// routes/productionschedule.js
//
// Production Schedule report — open PTFE order lines due in the next 5
// working days (2 working-day offset) — plus its Arrears view (everything
// overdue and still open) and the OTIF KPI report. One shared report, wired
// into two different department pages (production-nexus.html's Supervisor
// section, and sales.html) — see private/js/production-schedule.js for the
// shared frontend component both pages call into.
//
// View access: Production OR Sales department (requireAnyDepartment).
// Edit access (comment/ETA): PROD_SUPERVISOR OR SALES_SUPERVISOR
// (requireAnyPermission) — either supervisor can confirm/flag a line, same
// report either side sees.
//
// See sql/migrate_production_schedule.sql for the schema this reads/writes,
// and routes/productionschedulesql.js for the DB layer.

import express from 'express';
import { requireAnyDepartment, requireAnyPermission } from '../middleware/auth.js';
import * as db from './productionschedulesql.js';

const router = express.Router();

const canView = requireAnyDepartment(['production', 'sales']);
const canEdit = requireAnyPermission(['PROD_SUPERVISOR', 'SALES_SUPERVISOR']);

function actor(req) {
  return req.session?.user?.username || 'unknown';
}

// Merges the comments/ETA map onto each AgreementSnapshot row, keyed
// (ReferenceDocument, Item) — same grain as dbo.ProductionScheduleComments.
function attachComments(rows, commentsMap) {
  return rows.map(r => {
    const c = commentsMap.get(`${r.ReferenceDocument}||${r.Item}`);
    return {
      ...r,
      comment:           c?.comment || '',
      eta:               c?.eta || null,
      commentUpdatedUtc: c?.lastUpdatedUtc || null,
      commentUpdatedBy:  c?.updatedByUsername || '',
    };
  });
}

// GET / — the 5-working-day (2-day offset) Production Schedule.
router.get('/', canView, async (req, res) => {
  try {
    const [{ rows, windowStart, windowEnd }, comments] = await Promise.all([
      db.getProductionSchedule(),
      db.listProductionScheduleComments(),
    ]);
    res.json({ success: true, data: attachComments(rows, comments), windowStart, windowEnd });
  } catch (err) {
    console.error('[production-schedule] GET / failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /arrears — every open PTFE line already past its RequestDate.
router.get('/arrears', canView, async (req, res) => {
  try {
    const [rows, comments] = await Promise.all([
      db.getProductionArrears(),
      db.listProductionScheduleComments(),
    ]);
    res.json({ success: true, data: attachComments(rows, comments) });
  } catch (err) {
    console.error('[production-schedule] GET /arrears failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /:referenceDocument/:item — save/update a comment and/or ETA for one line.
router.put('/:referenceDocument/:item', canEdit, async (req, res) => {
  try {
    const { referenceDocument, item } = req.params;
    const { comment, eta } = req.body || {};
    await db.upsertProductionScheduleComment({ referenceDocument, item, comment, eta }, actor(req));
    res.json({ success: true });
  } catch (err) {
    console.error('[production-schedule] PUT save failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /kpi — monthly OTIF % history, for the KPI chart.
router.get('/kpi', canView, async (req, res) => {
  try {
    const history = await db.getOtifKpiHistory();
    const data = history.map(r => ({
      year:  r.Year,
      month: r.Month,
      onTimeCount: r.OnTimeCount,
      totalCount:  r.TotalCount,
      onTimePct:   r.TotalCount > 0 ? (r.OnTimeCount / r.TotalCount) * 100 : null,
    }));
    res.json({ success: true, data });
  } catch (err) {
    console.error('[production-schedule] GET /kpi failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /kpi/late — drill-down list of completed-late lines with their reasons.
router.get('/kpi/late', canView, async (req, res) => {
  try {
    const data = await db.getOtifLateList();
    res.json({ success: true, data });
  } catch (err) {
    console.error('[production-schedule] GET /kpi/late failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Exported for server.js's daily cron slot — see the cron comment there for
// why this runs once a day rather than on the 30-min AgreementSnapshot cycle.
export async function runProductionScheduleOtifDiff() {
  return db.diffProductionScheduleOtif();
}

export default router;
