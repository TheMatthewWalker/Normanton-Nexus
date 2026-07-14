/**
 * deploy-runner.cjs
 *
 * Executes a single scheduled deployment: `git pull` the app's repo, then
 * stop/start the "Normanton Nexus" Windows Service (extends restart.cjs's
 * stop -> start pattern with a git pull step beforehand).
 *
 * IMPORTANT — why this has to run as a DETACHED process:
 * This script is triggered by a node-cron job running inside server.js,
 * which itself runs under the very "Normanton Nexus" service this script
 * stops and restarts. If this script were spawned as an ordinary (attached)
 * child process, the moment svc.stop() takes down server.js, the OS/service
 * manager could tear this script down right along with it — mid-restart,
 * before svc.start() ever fires. The cron checker in server.js spawns this
 * with { detached: true, stdio: 'ignore' } + .unref() specifically so it
 * keeps running independently of server.js's lifecycle.
 *
 * Usage: node deploy-runner.cjs <DeploymentID>
 * (DeploymentID must already exist in kongsberg.dbo.ScheduledDeployments
 * with Status = 'running' — the server.js cron checker sets that atomically
 * before spawning this script.)
 */

'use strict';

const { execSync } = require('child_process');
const path         = require('path');
const fs           = require('fs');
const sql          = require('mssql');
const { Service }  = require('node-windows');

const REPO_DIR = __dirname;

async function main() {
  const deploymentID = parseInt(process.argv[2], 10);
  if (!deploymentID) {
    console.error('[deploy-runner] missing DeploymentID argument');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'config.json'), 'utf8'));
  const sqlConfig = {
    user:     config.sqlConfig.user,
    password: config.sqlConfig.password,
    server:   config.sqlConfig.server,
    database: config.sqlConfig.database,
    options:  { encrypt: false, trustServerCertificate: true },
  };

  const pool = await sql.connect(sqlConfig);

  const rowResult = await pool.request()
    .input('id', sql.Int, deploymentID)
    .query('SELECT GitRef FROM kongsberg.dbo.ScheduledDeployments WHERE DeploymentID = @id');
  const gitRef = rowResult.recordset[0]?.GitRef || 'main';

  // Mirrors routes/useradmin.js's audit() helper — logged as 'system' since
  // this runs unattended, outside of any HTTP request/session.
  async function audit(eventType, detail) {
    try {
      await pool.request()
        .input('username',  sql.NVarChar(80),  'system')
        .input('eventType', sql.NVarChar(50),  eventType)
        .input('detail',    sql.NVarChar(500), detail)
        .query(`INSERT INTO kongsberg.dbo.PortalAuditLog (Username, EventType, Detail)
                VALUES (@username, @eventType, @detail)`);
    } catch (err) {
      console.error('[deploy-runner] audit insert failed:', err.message);
    }
  }

  async function markFailed(detail) {
    console.error('[deploy-runner] FAILED:', detail);
    try {
      await pool.request()
        .input('id',  sql.Int, deploymentID)
        .input('err', sql.NVarChar(sql.MAX), String(detail).slice(0, 8000))
        .query(`UPDATE kongsberg.dbo.ScheduledDeployments
                SET Status = 'failed', CompletedAt = GETDATE(), ErrorMessage = @err
                WHERE DeploymentID = @id`);
      await audit('DEPLOY_FAILED', `Deployment #${deploymentID} failed: ${String(detail).slice(0, 400)}`);
    } catch (err) {
      console.error('[deploy-runner] also failed to record failure:', err.message);
    } finally {
      await pool.close();
      process.exit(1);
    }
  }

  // ── git pull (fast-forward only — refuses to silently discard any local
  // commits/changes rather than force-resetting over them) ────────────────
  let gitOutput = '';
  try {
    console.log(`[deploy-runner] pulling ${gitRef} (fast-forward only)…`);
    gitOutput = execSync(`git pull --ff-only origin ${gitRef}`, {
      cwd: REPO_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log('[deploy-runner] git pull complete:\n' + gitOutput);
  } catch (err) {
    await markFailed((err.stdout || '') + (err.stderr || '') + err.message);
    return;
  }

  // ── Restart the Windows Service ───────────────────────────────────────
  const svc = new Service({
    name:   'Normanton Nexus',
    script: path.join(REPO_DIR, 'server.js'),
  });

  svc.on('stop', () => {
    console.log('[deploy-runner] service stopped — restarting…');
    svc.start();
  });

  svc.on('start', async () => {
    console.log('[deploy-runner] service restarted successfully.');
    try {
      await pool.request()
        .input('id',  sql.Int, deploymentID)
        .input('log', sql.NVarChar(sql.MAX), gitOutput.slice(0, 8000))
        .query(`UPDATE kongsberg.dbo.ScheduledDeployments
                SET Status = 'completed', CompletedAt = GETDATE(), OutputLog = @log
                WHERE DeploymentID = @id`);
      await audit('DEPLOY_COMPLETED', `Deployment #${deploymentID} completed (${gitRef})`);
    } catch (err) {
      console.error('[deploy-runner] failed to record completion:', err.message);
    } finally {
      await pool.close();
      process.exit(0);
    }
  });

  svc.on('error', err => {
    markFailed('Service error: ' + (err?.message || err));
  });

  console.log('[deploy-runner] stopping service…');
  svc.stop();
}

main().catch(err => {
  console.error('[deploy-runner] fatal error:', err);
  process.exit(1);
});
