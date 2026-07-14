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
 * IMPORTANT — auth: the "Normanton Nexus" service has no `user` set in
 * install.cjs, so Windows runs it as LocalSystem — a completely different
 * account from whoever is logged in interactively, with its own (normally
 * empty) profile and no access to your personal SSH agent/keys or git
 * credentials. Testing `git pull` or `ssh -T git@github.com` in your own
 * terminal proves nothing about whether THIS script can authenticate.
 *
 * This script supports two credential-file options, checked in this order,
 * neither of which is ever committed (both live under .deploykey/, which is
 * git-ignored):
 *
 *   1. .deploykey/github_token — a GitHub fine-grained personal access
 *      token, scoped to ONLY this repo with Contents: Read-only permission
 *      (Settings -> Developer settings -> Personal access tokens ->
 *      Fine-grained tokens on github.com). This is the tighter-scoped,
 *      preferred option — the token can do nothing except read this one
 *      repo's contents, and it's independently revocable/rotatable without
 *      touching any SSH key. Used via GIT_ASKPASS (deploy-askpass.cmd)
 *      against an explicit HTTPS URL, so it never touches the existing
 *      SSH-based 'origin' remote used for interactive pushes.
 *
 *   2. .deploykey/id_ed25519 — a dedicated, passphrase-less SSH deploy key
 *      (add the matching .pub as a GitHub deploy key on this repo). Used
 *      via GIT_SSH_COMMAND against the normal 'origin' remote. Only tried
 *      if no github_token file is present.
 *
 * If neither is present, falls back to whatever ambient SSH state (if any)
 * the LocalSystem account happens to have — which is almost certainly
 * nothing, so this will very likely fail with a publickey error until one
 * of the two options above is set up.
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

const REPO_DIR         = __dirname;
const TOKEN_PATH        = path.join(REPO_DIR, '.deploykey', 'github_token');
const ASKPASS_PATH      = path.join(REPO_DIR, 'deploy-askpass.cmd');
const SSH_DEPLOY_KEY    = path.join(REPO_DIR, '.deploykey', 'id_ed25519');
const REPO_HTTPS_URL    = 'https://x-access-token@github.com/TheMatthewWalker/Normanton-Nexus.git';

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

  // ── Work out how to authenticate the pull ───────────────────────────────
  // Preferred: fine-grained PAT (read-only, scoped to just this repo) over
  // HTTPS via GIT_ASKPASS, pulling an explicit URL rather than 'origin' so
  // the SSH-based 'origin' remote (used for interactive pushes) is never
  // touched. Falls back to the SSH deploy key, then to plain `git pull
  // origin` (whatever ambient auth this account has, almost certainly none).
  let pullCommand;
  let gitEnv = process.env;

  if (fs.existsSync(TOKEN_PATH)) {
    console.log('[deploy-runner] using fine-grained PAT (.deploykey/github_token) over HTTPS');
    gitEnv = { ...process.env, GIT_ASKPASS: ASKPASS_PATH, GIT_TERMINAL_PROMPT: '0' };
    pullCommand = `git pull --ff-only ${REPO_HTTPS_URL} ${gitRef}`;
  } else if (fs.existsSync(SSH_DEPLOY_KEY)) {
    console.log('[deploy-runner] using SSH deploy key (.deploykey/id_ed25519)');
    gitEnv = {
      ...process.env,
      GIT_SSH_COMMAND: `ssh -i "${SSH_DEPLOY_KEY}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
    };
    pullCommand = `git pull --ff-only origin ${gitRef}`;
  } else {
    console.warn(
      `[deploy-runner] no credentials found at ${TOKEN_PATH} or ${SSH_DEPLOY_KEY} — falling back to ` +
      `whatever auth (if any) this account already has (this is usually NOT the same account/agent ` +
      `you tested "ssh -T git@github.com" or "git push" with interactively). Set up a fine-grained ` +
      `GitHub token (Contents: Read-only, scoped to this repo only) at ${TOKEN_PATH} if this fails.`
    );
    pullCommand = `git pull --ff-only origin ${gitRef}`;
  }

  let gitOutput = '';
  try {
    console.log(`[deploy-runner] pulling ${gitRef} (fast-forward only)…`);
    gitOutput = execSync(pullCommand, {
      cwd: REPO_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv,
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
