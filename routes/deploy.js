/**
 * routes/deploy.js
 *
 * Scheduled deployment management — lets a superadmin schedule a
 * "git pull + restart the Normanton Nexus service" for a specific date/time,
 * so upgrades can go out during a planned maintenance window without anyone
 * needing to log into the server.
 *
 * A node-cron checker in server.js polls for due rows every minute and hands
 * them off to deploy-runner.cjs (git pull + Windows Service restart), which
 * runs as a detached process — see that file for why it has to be detached.
 *
 * TIMEZONE HANDLING — important, and the reason ScheduledAt is treated
 * specially throughout this file: kongsberg.dbo.ScheduledDeployments.ScheduledAt
 * is a plain SQL Server DATETIME column, which has NO timezone concept, and
 * the cron checker in server.js compares it directly against GETDATE(), which
 * returns the SQL Server machine's own local wall-clock time. So ScheduledAt
 * has to be written as a literal local wall-clock value in the SAME frame as
 * GETDATE() — NOT converted to/from UTC via a JS Date object. Round-tripping
 * a JS Date through node-mssql (which defaults to useUTC: true) silently
 * shifts the stored value by the server's UTC offset (e.g. an admin entering
 * 15:10 BST would get "14:10:00" stored, so the cron checker would fire an
 * hour early). To avoid that, ScheduledAt is written via a hand-built literal
 * string (CONVERT(datetime, @str, 120)) and read back the same way
 * (CONVERT(varchar, ScheduledAt, 126)) — never through a JS Date object on
 * either side of the SQL boundary. All OTHER timestamp columns here
 * (CreatedAt/StartedAt/CompletedAt/CancelledAt) are always written via
 * GETDATE() directly in SQL, so they're unaffected by this issue.
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
import { sqlConfig } from '../config.js';

const router = express.Router();

function requireSuperadmin(req, res, next) {
  if (req.session?.user?.role === 'superadmin') return next();
  return res.status(403).json({ success: false, error: 'Requires superadmin role.' });
}

// ── Audit helper (mirrors routes/useradmin.js) ──────────────────────────────
async function audit(eventType, actorUsername, detail, req) {
  try {
    const pool = await sql.connect(sqlConfig);
    const ip   = req.ip || req.socket?.remoteAddress || null;
    await pool.request()
      .input('username',  sql.NVarChar(80),  actorUsername || null)
      .input('eventType', sql.NVarChar(50),  eventType)
      .input('detail',    sql.NVarChar(500), detail || null)
      .input('ip',        sql.NVarChar(45),  ip)
      .query(`
        INSERT INTO kongsberg.dbo.PortalAuditLog (Username, EventType, Detail, IPAddress)
        VALUES (@username, @eventType, @detail, @ip)
      `);
  } catch (err) {
    console.error('[deploy audit]', err.message);
  }
}

// ── GET /next — any logged-in user, powers the countdown banner ────────────
// Prioritises a 'running' deployment (the restart is actually happening right
// now — the banner should show this unconditionally, not just within the
// warning window), falls back to the next 'pending' one, and also surfaces a
// 'failed' deployment for a short grace period afterwards so the banner
// doesn't just silently vanish if the restart didn't actually go through.
//
// ScheduledAt is pulled out via CONVERT(..., 126) — ISO8601 with a 'T'
// separator and NO timezone designator — so that when the browser parses it
// with `new Date(...)`, it's interpreted as local time (per spec, a
// date-time string with no timezone designator is local), matching what was
// literally typed into the scheduling form. See the timezone-handling note
// at the top of this file.
router.get('/next', async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
    const result = await pool.request().query(`
      SELECT TOP 1 DeploymentID, CONVERT(varchar(23), ScheduledAt, 126) AS ScheduledAt,
        WarningMinutes, Notes, Status, ErrorMessage
      FROM kongsberg.dbo.ScheduledDeployments
      WHERE Status IN ('pending', 'running')
         OR (Status = 'failed' AND CompletedAt >= DATEADD(minute, -10, GETDATE()))
      ORDER BY CASE Status WHEN 'running' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, ScheduledAt ASC
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
    const pool = await sql.connect(sqlConfig);
    const result = await pool.request().query(`
      SELECT TOP 200
        DeploymentID, CONVERT(varchar(23), ScheduledAt, 126) AS ScheduledAt,
        GitRef, WarningMinutes, Status, Notes,
        CreatedByUsername, CreatedAt, StartedAt, CompletedAt,
        OutputLog, ErrorMessage, CancelledAt, CancelledBy
      FROM kongsberg.dbo.ScheduledDeployments
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
  // Assumes this Node process runs in the same local timezone as the SQL
  // Server machine and the people scheduling deployments (true for this
  // on-prem, single-site setup). See timezone note at the top of this file.
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
    const pool  = await sql.connect(sqlConfig);
    const actor = req.session.user.username;

    const result = await pool.request()
      .input('scheduledAt',   sql.VarChar(19),   sqlLiteral)
      .input('gitRef',        sql.NVarChar(100), branch)
      .input('warningMin',    sql.Int,           warnMin)
      .input('notes',         sql.NVarChar(500), notes?.trim() || null)
      .input('createdByID',   sql.Int,           req.session.user.userID)
      .input('createdByUser', sql.NVarChar(80),  actor)
      .query(`
        INSERT INTO kongsberg.dbo.ScheduledDeployments
          (ScheduledAt, GitRef, WarningMinutes, Notes, CreatedByUserID, CreatedByUsername)
        OUTPUT INSERTED.DeploymentID
        VALUES (CONVERT(datetime, @scheduledAt, 120), @gitRef, @warningMin, @notes, @createdByID, @createdByUser)
      `);

    const deploymentID = result.recordset[0].DeploymentID;

    await audit('DEPLOY_SCHEDULED', actor,
      `Scheduled deployment #${deploymentID}: ${branch} @ ${sqlLiteral} (server local time)`, req);

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
    const pool  = await sql.connect(sqlConfig);
    const actor = req.session.user.username;

    const result = await pool.request()
      .input('id',    sql.Int,          id)
      .input('actor', sql.NVarChar(80), actor)
      .query(`
        UPDATE kongsberg.dbo.ScheduledDeployments
        SET Status = 'cancelled', CancelledAt = GETDATE(), CancelledBy = @actor
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
