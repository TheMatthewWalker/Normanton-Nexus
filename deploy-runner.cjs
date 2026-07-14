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
 * with { detached: true } + .unref() specifically so it keeps running
 * independently of server.js's lifecycle. Its stdout/stderr are redirected
 * to deploy-runner.log (NOT 'ignore') — this file is your primary source of
 * truth if a deployment gets stuck; the ScheduledDeployments.OutputLog /
 * ErrorMessage columns only get populated for the specific failure modes
 * this script anticipates and catches, whereas the log file captures
 * everything, including crashes this script never gets a chance to record
 * to the database.
 *
 * IMPORTANT — auth: the "Normanton Nexus" service has no `user` set in
 * install.cjs, so Windows runs it as LocalSystem — a completely different
 * account from whoever is logged in interactively, with its own (normally
 * empty) profile and no access to your personal SSH agent/keys. Testing
 * `git pull` or `ssh -T git@github.com` in your own terminal proves nothing
 * about whether THIS script can authenticate. To fix that without needing
 * to run the whole service under a real user account, this script looks
 * for, in order:
 *   1. .deploykey/github_token — a GitHub fine-grained PAT, scoped to just
 *      this repo with Contents: Read-only. Preferred — tightest scope,
 *      independently revocable. Used over HTTPS via deploy-askpass.cmd.
 *   2. .deploykey/id_ed25519 — a dedicated, passphrase-less SSH deploy key
 *      (register the .pub as a GitHub deploy key on this repo).
 *   3. Whatever ambient auth (if any) the LocalSystem account already has
 *      — almost certainly nothing, so this will likely fail until 1 or 2
 *      is set up. GIT_TERMINAL_PROMPT=0 and SSH BatchMode=yes are set even
 *      in this fallback case so a missing-credential failure comes back
 *      as a fast, visible error instead of hanging forever waiting on an
 *      interactive prompt that can never be answered (host-key
 *      confirmation, username/password, etc.) — this is what was silently
 *      swallowing deployments before: no credential, an unattended
 *      terminal prompt with nothing able to answer it, and stdio:'ignore'
 *      upstream meant nothing about it was ever visible.
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
const https         = require('https');
const sql          = require('mssql');
const { Service }  = require('node-windows');

const REPO_DIR       = __dirname;
const TOKEN_PATH      = path.join(REPO_DIR, '.deploykey', 'github_token');
const ASKPASS_PATH    = path.join(REPO_DIR, 'deploy-askpass.cmd');
const SSH_DEPLOY_KEY  = path.join(REPO_DIR, '.deploykey', 'id_ed25519');
const REPO_HTTPS_URL  = 'https://x-access-token@github.com/TheMatthewWalker/Normanton-Nexus.git';

// Git must NEVER fall back to an interactive prompt — there is nothing and
// no one able to answer one when this runs unattended under a service
// account. Without this, a missing/misconfigured credential doesn't fail
// fast, it just hangs forever waiting for input that will never arrive.
const BASE_GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

// How long the git pull itself is allowed to take before it's killed and
// treated as a failure (this is what actually protects against a hang —
// execSync is synchronous/blocking, so nothing else in this script can run
// while it's in progress, including any JS-level timer-based watchdog).
const GIT_PULL_TIMEOUT_MS = 2 * 60 * 1000;

// How long svc.stop()/svc.start() are allowed to take (that part IS
// event-driven/async, so a normal setTimeout-based watchdog works here).
const SERVICE_RESTART_TIMEOUT_MS = 3 * 60 * 1000;

// node-windows' svc.on('start') fires as soon as Windows ACKNOWLEDGES the
// start command (net start / SCM StartService returning) — that is NOT the
// same thing as server.js actually finishing its own startup (reading
// certs, binding port 443, connecting to SQL). Any failure in that window
// previously went unnoticed: the deployment was marked 'completed' the
// instant the OS accepted the start command, even if the process then
// immediately crashed or never finished booting. So after 'start' fires we
// actively poll the site itself before declaring victory.
const LIVENESS_PORT          = 443;
const LIVENESS_TIMEOUT_MS    = 30 * 1000;   // per-request timeout
const LIVENESS_MAX_WAIT_MS   = 45 * 1000;   // total time to wait for a 2xx-5xx response
const LIVENESS_RETRY_DELAY_MS = 3 * 1000;   // gap between liveness attempts

// Polls https://127.0.0.1:443/ until it gets ANY HTTP response (self-signed
// cert, so rejectUnauthorized: false — we only care that something is
// actually listening and answering, not about certificate trust) or the
// overall time budget runs out. Resolves true/false, never throws.
function waitForServerUp(maxWaitMs, intervalMs) {
  const deadline = Date.now() + maxWaitMs;
  return new Promise(resolve => {
    const attempt = () => {
      const req = https.get(
        { host: '127.0.0.1', port: LIVENESS_PORT, path: '/', rejectUnauthorized: false, timeout: LIVENESS_TIMEOUT_MS },
        res => {
          res.resume(); // drain, don't care about the body
          resolve(true);
        }
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => {
        if (Date.now() >= deadline) { resolve(false); return; }
        setTimeout(attempt, LIVENESS_RETRY_DELAY_MS);
      });
    };
    attempt();
  });
}

async function main() {
  const deploymentID = parseInt(process.argv[2], 10);
  if (!deploymentID) {
    console.error('[deploy-runner] missing DeploymentID argument');
    process.exit(1);
  }

  console.log(`\n[deploy-runner] ==== starting run for deployment #${deploymentID} @ ${new Date().toString()} ====`);

  const config = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'config.json'), 'utf8'));
  const sqlConfig = {
    user:     config.sqlConfig.user,
    password: config.sqlConfig.password,
    server:   config.sqlConfig.server,
    database: config.sqlConfig.database,
    options:  { encrypt: false, trustServerCertificate: true },
  };

  const pool = await sql.connect(sqlConfig);
  console.log('[deploy-runner] connected to SQL Server');

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

  let finished = false;

  async function markFailed(detail) {
    if (finished) return;
    finished = true;
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
  let pullCommand;
  let gitEnv = BASE_GIT_ENV;

  if (fs.existsSync(TOKEN_PATH)) {
    console.log('[deploy-runner] using fine-grained PAT (.deploykey/github_token) over HTTPS');
    gitEnv = { ...BASE_GIT_ENV, GIT_ASKPASS: ASKPASS_PATH };
    pullCommand = `git pull --ff-only ${REPO_HTTPS_URL} ${gitRef}`;
  } else if (fs.existsSync(SSH_DEPLOY_KEY)) {
    console.log('[deploy-runner] using SSH deploy key (.deploykey/id_ed25519)');
    gitEnv = {
      ...BASE_GIT_ENV,
      GIT_SSH_COMMAND: `ssh -i "${SSH_DEPLOY_KEY}" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
    };
    pullCommand = `git pull --ff-only origin ${gitRef}`;
  } else {
    console.warn(
      `[deploy-runner] no credentials found at ${TOKEN_PATH} or ${SSH_DEPLOY_KEY} — falling back to ` +
      `whatever auth (if any) this account already has (this is usually NOT the same account/agent ` +
      `you tested "ssh -T git@github.com" or "git push" with interactively). Set up a fine-grained ` +
      `GitHub token (Contents: Read-only, scoped to this repo only) at ${TOKEN_PATH} if this fails.`
    );
    // Still force non-interactive SSH even with no dedicated key, so a
    // missing/rejected credential fails fast instead of hanging on a
    // host-key or password prompt nothing can ever answer.
    gitEnv = {
      ...BASE_GIT_ENV,
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    };
    pullCommand = `git pull --ff-only origin ${gitRef}`;
  }

  let gitOutput = '';
  try {
    console.log(`[deploy-runner] pulling ${gitRef} (fast-forward only, ${GIT_PULL_TIMEOUT_MS / 1000}s timeout)…`);
    gitOutput = execSync(pullCommand, {
      cwd: REPO_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnv, timeout: GIT_PULL_TIMEOUT_MS,
    });
    console.log('[deploy-runner] git pull complete:\n' + gitOutput);
  } catch (err) {
    const timedOut = err.signal === 'SIGTERM' && err.killed;
    const detail = (err.stdout || '') + (err.stderr || '') + err.message +
      (timedOut ? ' [git pull TIMED OUT and was killed — most likely stuck on an auth prompt or unreachable network]' : '');
    await markFailed(detail);
    return;
  }

  // ── Restart the Windows Service ───────────────────────────────────────
  const svc = new Service({
    name:   'Normanton Nexus',
    script: path.join(REPO_DIR, 'server.js'),
  });

  const restartWatchdog = setTimeout(() => {
    markFailed(
      `Service restart did not complete within ${SERVICE_RESTART_TIMEOUT_MS / 1000}s — ` +
      `svc.stop()/svc.start() never fired their completion events. Check Windows Services ` +
      `manually; the "Normanton Nexus" service may need a manual restart.`
    );
  }, SERVICE_RESTART_TIMEOUT_MS);

  svc.on('stop', () => {
    console.log('[deploy-runner] service stopped — restarting…');
    svc.start();
  });

  let startRetried = false;

  svc.on('start', async () => {
    if (finished) return; // watchdog already fired and closed the pool
    console.log('[deploy-runner] Windows acknowledged the service start — verifying it is actually answering requests…');

    const up = await waitForServerUp(LIVENESS_MAX_WAIT_MS, LIVENESS_RETRY_DELAY_MS);
    if (finished) return; // watchdog fired while we were polling

    if (!up) {
      if (!startRetried) {
        // First attempt never came up — give it exactly one more try (a slow
        // SQL connect or cert read on a loaded box can plausibly still be in
        // progress) before giving up. svc.start() again will re-fire this
        // same 'start' handler once Windows acknowledges it.
        startRetried = true;
        console.warn('[deploy-runner] service did not answer https://127.0.0.1:443/ in time — retrying start once…');
        svc.start();
        return;
      }
      clearTimeout(restartWatchdog);
      await markFailed(
        `Service start was acknowledged by Windows but the app never answered https://127.0.0.1:${LIVENESS_PORT}/ ` +
        `within the verification window (tried twice). The service process may have crashed on startup — check ` +
        `daemon/normantonnexus.err.log and confirm manually whether "Normanton Nexus" is actually running.`
      );
      return;
    }

    finished = true;
    clearTimeout(restartWatchdog);
    console.log('[deploy-runner] service restarted and verified live (https://127.0.0.1:443/ responded).');
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
    clearTimeout(restartWatchdog);
    markFailed('Service error: ' + (err?.message || err));
  });

  console.log('[deploy-runner] stopping service…');
  svc.stop();
}

main().catch(err => {
  console.error('[deploy-runner] fatal error:', err);
  process.exit(1);
});
