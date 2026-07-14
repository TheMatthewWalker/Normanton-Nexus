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
router.get('/next', async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
    const result = await pool.request().query(`
      SELECT TOP 1 DeploymentID, ScheduledAt, WarningMinutes, Notes
      FROM kongsberg.dbo.ScheduledDeployments
      WHERE Status = 'pending'
      ORDER BY ScheduledAt ASC
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
        DeploymentID, ScheduledAt, GitRef, WarningMinutes, Status, Notes,
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

  if (!scheduledAt || isNaN(Date.parse(scheduledAt))) {
    return res.status(400).json({ success: false, error: 'A valid scheduledAt date/time is required.' });
  }
  const when = new Date(scheduledAt);
  if (when.getTime() <= Date.now()) {
    return res.status(400).json({ success: false, error: 'Scheduled time must be in the future.' });
  }
  const warnMin = parseInt(warningMinutes, 10);
  if (!Number.isFinite(warnMin) || warnMin < 0 || warnMin > 1440) {
    return res.status(400).json({ success: false, error: 'warningMinutes must be between 0 and 1440.' });
  }
  const branch = String(gitRef || 'main').trim();
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch)) {
    return res.status(400).json({ success: false, error: 'Invalid git branch/ref name.' });
  }

  try {
    const pool  = await sql.connect(sqlConfig);
    const actor = req.session.user.username;

    const result = await pool.request()
      .input('scheduledAt',   sql.DateTime,      when)
      .input('gitRef',        sql.NVarChar(100), branch)
      .input('warningMin',    sql.Int,           warnMin)
      .input('notes',         sql.NVarChar(500), notes?.trim() || null)
      .input('createdByID',   sql.Int,           req.session.user.userID)
      .input('createdByUser', sql.NVarChar(80),  actor)
      .query(`
        INSERT INTO kongsberg.dbo.ScheduledDeployments
          (ScheduledAt, GitRef, WarningMinutes, Notes, CreatedByUserID, CreatedByUsername)
        OUTPUT INSERTED.DeploymentID
        VALUES (@scheduledAt, @gitRef, @warningMin, @notes, @createdByID, @createdByUser)
      `);

    const deploymentID = result.recordset[0].DeploymentID;

    await audit('DEPLOY_SCHEDULED', actor,
      `Scheduled deployment #${deploymentID}: ${branch} @ ${when.toISOString()}`, req);

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
