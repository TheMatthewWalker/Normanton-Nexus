/**
 * routes/deploy.js
 *
 * Scheduled deployment management — lets a superadmin schedule a
 * "git pull + restart the Normanton Nexus service" for a specific date/time,
 * so upgrades can go out during a planned maintenance window without anyone
 * needing to log into the server.
 *
 * A node-cron checker in server.js polls for due rows every minute and hands
 * them off to deploy-runner.cjs (git pull + Windows Service restart, then —
 * once that's confirmed stable — a git pull + scripts/deploy.ps1 restart of
 * the sibling SapServer repo too, see deploy-runner.cjs's own header for
 * the details/assumptions), which runs as a detached process — see that
 * file for why it has to be detached.
 *
 * TIMEZONE HANDLING — important, and the reason ScheduledAt is treated
 * specially throughout this file: dbo.ScheduledDeployments.ScheduledAt
 * is a plain SQL Server DATETIME column, which has NO timezone concept, and
 * the cron checker in server.js compares it directly against "now" in SQL,
 * so ScheduledAt has to be written as a literal wall-clock value in the SAME
 * frame that comparison uses — NOT converted to/from UTC via a JS Date
 * object. Round-tripping a JS Date through node-mssql (which defaults to
 * useUTC: true) silently shifts the stored value by the server's UTC offset
 * (e.g. an admin entering 15:10 BST would get "14:10:00" stored, so the cron
 * checker would fire an hour early). To avoid that, ScheduledAt is written
 * via a hand-built literal string (CONVERT(datetime, @str, 120)) and read
 * back the same way (CONVERT(varchar, ScheduledAt, 126)) — never through a
 * JS Date object on either side of the SQL boundary.
 *
 * SQL SERVER'S OWN CLOCK — dbo.ScheduledDeployments now lives on a shared
 * corporate SQL DC in the EU, not a box co-located with the Normanton (UK)
 * site — confirmed directly: GETDATE() there reads about an hour AHEAD of
 * true UK wall-clock time (it's on CET/CEST, not GMT/BST), which used to
 * make the cron checker treat a just-scheduled future deployment as already
 * due and fire it almost immediately. Since the UK and the EU both shift
 * DST on the same calendar dates (last Sunday of March/October), the DC is
 * ALWAYS exactly one hour ahead of the UK site, year-round — so bare
 * GETDATE() is never used directly for "now" in this file; every read/write
 * that means "the current UK wall-clock time" goes through SITE_NOW_SQL
 * (DATEADD(HOUR, -1, GETDATE())) instead, which cancels that fixed offset.
 * The DC's own timezone can't be changed (shared corporate resource — other
 * applications depend on it), so this correction has to live here. (A more
 * "proper" fix would be SQL Server's AT TIME ZONE, but that needs the
 * server's Windows time zone database and a version guarantee this shared
 * box can't offer — a fixed DATEADD needs neither.) deploy-runner.cjs and
 * server.js each keep their own copy of this same SITE_NOW_SQL constant —
 * see the matching comment in each of those files if this ever needs to
 * change.
 *
 * Mount in server.js:
 *   import deployRoutes from './routes/deploy.js';
 *   app.use('/api/deploy', requireLogin, deployRoutes);
 *
 * All routes below additionally require superadmin, EXCEPT:
 *   GET /next — any logged-in user, powers the in-app countdown banner.
 *
 * Endpoints:
 *   GET  /            — list scheduled deployments, most recent first (superadmin)
 *   POST /             — schedule a new deployment { scheduledAt, gitRef, warningMinutes, notes } (superadmin)
 *   POST /:id/cancel   — cancel a pending deployment (superadmin)
 *   GET  /next         — next pending deployment, for the countdown banner (any logged-in user)
 */

import express from 'express';
import sql     from 'mssql';
import { getNexusPool } from '../config.js';

const router = express.Router();

// The DC hosting this table's own GETDATE() runs ~1hr ahead of the UK site
// (shared corporate SQL DC, not co-located) — see the TIMEZONE HANDLING /
// SQL SERVER'S OWN CLOCK comment at the top of this file. Use this wherever
// a query needs "the current UK wall-clock time," never bare GETDATE().
const SITE_NOW_SQL = 'DATEADD(HOUR, -1, GETDATE())';

function requireSuperadmin(req, res, next) {
  if (req.session?.user?.role === 'superadmin') return next();
  return res.status(403).json({ success: false, error: 'Requires superadmin role.' });
}

// ── Audit helper (mirrors routes/useradmin.js) ──────────────────────────────
async function audit(eventType, actorUsername, detail, req) {
  try {
    const pool = await getNexusPool();
    const ip   = req.ip || req.socket?.remoteAddress || null;
    await pool.request()
      .input('username',  sql.NVarChar(80),  actorUsername || null)
      .input('eventType', sql.NVarChar(50),  eventType)
      .input('detail',    sql.NVarChar(500), detail || null)
      .input('ip',        sql.NVarChar(45),  ip)
      .query(`
        INSERT INTO dbo.PortalAuditLog (Username, EventType, Detail, IPAddress)
        VALUES (@username, @eventType, @detail, @ip)
      `);
  } catch (err) {
    console.error('[deploy audit]', err.message);
  }
}

// ── GET /next — any logged-in user, powers the countdown banner ────────────
// Prioritises a 'running' deployment (the restart is actually happening right
// now — the banner should show this unconditionally, not just within the
// warning window), falls back to the next 'pending' one. Deliberately does
// NOT surface 'failed' deployments here (it used to, for a short grace
// period) — a failed deploy isn't actionable by an ordinary user and just
// reads as a scary "maintenance failed" banner nobody who sees it can do
// anything about. server.js's cron checker instead sends superadmins (the
// only ones who can act on it) an in-app notification via lib/notify.js —
// see notifyDeployFailed() there.
//
// ScheduledAt is pulled out via CONVERT(..., 126) — ISO8601 with a 'T'
// separator and NO timezone designator — so that when the browser parses it
// with `new Date(...)`, it's interpreted as local time (per spec, a
// date-time string with no timezone designator is local), matching what was
// literally typed into the scheduling form. See the timezone-handling note
// at the top of this file.
router.get('/next', async (req, res) => {
  try {
    const pool = await getNexusPool();
    const result = await pool.request().query(`
      SELECT TOP 1 DeploymentID, CONVERT(varchar(23), ScheduledAt, 126) AS ScheduledAt,
        WarningMinutes, Notes, Status, ErrorMessage
      FROM dbo.ScheduledDeployments
      WHERE Status IN ('pending', 'running')
      ORDER BY CASE Status WHEN 'running' THEN 0 ELSE 1 END, ScheduledAt ASC
    `);
    res.json({ success: true, deployment: result.recordset[0] || null });
  } catch (err) {
    console.error('[deploy/next]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET / — list all (superadmin) ───────────────────────────────────────────
router.get('/', requireSuperadmin, async (req, res) => {
  try {
    const pool = await getNexusPool();
    const result = await pool.request().query(`
      SELECT TOP 200
        DeploymentID, CONVERT(varchar(23), ScheduledAt, 126) AS ScheduledAt,
        GitRef, WarningMinutes, Status, Notes,
        CreatedByUsername, CreatedAt, StartedAt, CompletedAt,
        OutputLog, ErrorMessage, CancelledAt, CancelledBy
      FROM dbo.ScheduledDeployments
      ORDER BY ScheduledAt DESC
    `);
    res.json({ success: true, deployments: result.recordset });
  } catch (err) {
    console.error('[deploy GET]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST / — schedule a new deployment (superadmin) ─────────────────────────
router.post('/', requireSuperadmin, async (req, res) => {
  const { scheduledAt, gitRef = 'main', warningMinutes = 15, notes } = req.body;

  // Expect the raw value straight from a <input type="datetime-local">
  // ("YYYY-MM-DDTHH:mm", optionally with seconds) — a literal wall-clock
  // reading with no timezone attached, exactly what we want to store as-is.
  if (!scheduledAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(scheduledAt)) {
    return res.status(400).json({ success: false, error: 'A valid scheduledAt date/time is required.' });
  }

  const warnMin = parseInt(warningMinutes, 10);
  if (!Number.isFinite(warnMin) || warnMin < 0 || warnMin > 1440) {
    return res.status(400).json({ success: false, error: 'warningMinutes must be between 0 and 1440.' });
  }

  // Courtesy validation only — NOT used for the stored value. Requires at
  // LEAST warnMin minutes of lead time so the countdown banner actually gets
  // its full advertised warning window to display before the restart fires
  // (previously nothing stopped scheduling e.g. a 5-minute warning only 30
  // seconds out, so the restart could hit with barely any notice at all).
  // Uses Date.now() rather than SQL Server's GETDATE(), unlike the actual
  // firing comparison — this Node process runs ON the Normanton (UK) site
  // itself, alongside the people scheduling deployments, so its own local
  // clock IS the site's wall-clock time; it's the SQL Server box (a shared
  // corporate EU DC — see SQL SERVER'S OWN CLOCK above) whose clock needs
  // correcting, not this one.
  const leadMs = new Date(scheduledAt).getTime() - Date.now();
  if (leadMs < warnMin * 60_000) {
    return res.status(400).json({
      success: false,
      error: `Scheduled time must be at least ${warnMin} minute(s) from now, matching the warning window — pick a later time or a shorter warning window.`,
    });
  }

  // Literal "YYYY-MM-DD HH:mm:ss" string for SQL Server's CONVERT(..., 120)
  // to parse verbatim — built by plain string manipulation, never through a
  // JS Date object, so no timezone conversion can sneak in here.
  const sqlLiteral = scheduledAt.replace('T', ' ') + (scheduledAt.length === 16 ? ':00' : '');

  const branch = String(gitRef || 'main').trim();
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch)) {
    return res.status(400).json({ success: false, error: 'Invalid git branch/ref name.' });
  }

  try {
    const pool  = await getNexusPool();
    const actor = req.session.user.username;

    const result = await pool.request()
      .input('scheduledAt',   sql.VarChar(19),   sqlLiteral)
      .input('gitRef',        sql.NVarChar(100), branch)
      .input('warningMin',    sql.Int,           warnMin)
      .input('notes',         sql.NVarChar(500), notes?.trim() || null)
      .input('createdByID',   sql.Int,           req.session.user.userID)
      .input('createdByUser', sql.NVarChar(80),  actor)
      .query(`
        INSERT INTO dbo.ScheduledDeployments
          (ScheduledAt, GitRef, WarningMinutes, Notes, CreatedByUserID, CreatedByUsername, CreatedAt)
        OUTPUT INSERTED.DeploymentID
        VALUES (CONVERT(datetime, @scheduledAt, 120), @gitRef, @warningMin, @notes, @createdByID, @createdByUser, ${SITE_NOW_SQL})
      `);

    const deploymentID = result.recordset[0].DeploymentID;

    await audit('DEPLOY_SCHEDULED', actor,
      `Scheduled deployment #${deploymentID}: ${branch} @ ${sqlLiteral} (site local time)`, req);

    res.json({ success: true, deploymentID });

  } catch (err) {
    console.error('[deploy POST]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /:id/cancel — cancel a pending deployment (superadmin) ─────────────
router.post('/:id/cancel', requireSuperadmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) {
    return res.status(400).json({ success: false, error: 'Invalid deployment ID' });
  }

  try {
    const pool  = await getNexusPool();
    const actor = req.session.user.username;

    const result = await pool.request()
      .input('id',    sql.Int,          id)
      .input('actor', sql.NVarChar(80), actor)
      .query(`
        UPDATE dbo.ScheduledDeployments
        SET Status = 'cancelled', CancelledAt = ${SITE_NOW_SQL}, CancelledBy = @actor
        OUTPUT INSERTED.DeploymentID
        WHERE DeploymentID = @id AND Status = 'pending'
      `);

    if (!result.recordset[0]) {
      return res.status(404).json({
        success: false,
        error: 'Pending deployment not found (already run, cancelled, or does not exist).',
      });
    }

    await audit('DEPLOY_CANCELLED', actor, `Cancelled scheduled deployment #${id}`, req);

    res.json({ success: true });

  } catch (err) {
    console.error('[deploy/cancel]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
