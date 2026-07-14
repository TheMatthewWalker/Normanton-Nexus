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
 * IMPORTANT — restart verification: node-windows' svc.on('start') fires as
 * soon as Windows ACKNOWLEDGES the start command, not when server.js has
 * actually finished booting, and svc.on('stop') is no more trustworthy —
 * it's driven by an emulated SIGINT that Windows does not reliably deliver
 * to a background service process (daemon/normantonnexus.wrapper.log has
 * shown this exact emulation failing and falling back to a forced kill on
 * a previous cycle). The failure mode this produces: the OLD process is
 * still alive and still answering port 443 when we think we've stopped it,
 * a NEW process either never starts cleanly or crashes shortly after, and
 * nothing is left to notice or recover once this script has already exited
 * declaring success. To make this trustworthy:
 *   - server.js exposes GET /api/health -> { pid, bootId, startedAt },
 *     where bootId is a fresh random value generated once per process
 *     start. A different bootId proves a genuinely NEW process is serving,
 *     not a stale leftover one.
 *   - After 'stop', we actively poll for the OLD process to actually stop
 *     answering, and forcibly kill whatever's still bound to port 443 if it
 *     doesn't (via netstat + taskkill) before starting a new one on top.
 *   - After 'start', we poll for a NEW bootId to appear (retrying the start
 *     once if it doesn't), then keep watching for several minutes — the
 *     process can start cleanly and still crash shortly after, which is
 *     exactly what was reported — attempting one automatic recovery start
 *     if it goes down during that window before finally declaring success.
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
const https        = require('https');
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

// Overall ceiling for the entire stop -> verify -> start -> verify ->
// stability-monitor sequence below. Generous on purpose: this is a detached
// background process, nothing is blocked waiting on it, and the whole point
// of the stability-monitoring window is to sit and watch for several
// minutes before declaring victory.
const SERVICE_RESTART_TIMEOUT_MS = 10 * 60 * 1000;

// ── Restart-verification tuning ─────────────────────────────────────────
const HEALTH_PATH              = '/api/health';
const LIVENESS_PORT            = 443;
const HEALTH_REQUEST_TIMEOUT_MS = 10 * 1000;   // single health-check request

const STOP_VERIFY_MAX_WAIT_MS  = 25 * 1000;    // wait this long for the OLD process to actually go quiet
const STOP_VERIFY_POLL_MS      = 2 * 1000;

const START_VERIFY_MAX_WAIT_MS = 45 * 1000;    // wait this long, per attempt, for a NEW bootId to appear
const START_VERIFY_POLL_MS     = 3 * 1000;

const SVC_EVENT_TIMEOUT_MS     = 60 * 1000;    // wait this long for Windows to even acknowledge stop/start

// Re-checks after the new instance is first confirmed live — matches the
// reported failure mode of "came up fine, then died a couple of minutes
// later with nothing left running to notice."
const STABILITY_CHECKS_MS = [30 * 1000, 60 * 1000, 120 * 1000];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Hits GET /api/health and returns the parsed body, or null on any failure
// (connection refused, timeout, non-JSON, etc.) — null always means
// "nothing usable is answering right now," which is exactly what callers
// need to know.
function getHealth() {
  return new Promise(resolve => {
    const req = https.get(
      {
        host: '127.0.0.1', port: LIVENESS_PORT, path: HEALTH_PATH,
        rejectUnauthorized: false, timeout: HEALTH_REQUEST_TIMEOUT_MS,
      },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { resolve(null); }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// Polls until nothing answers /api/health, proving the old process has
// actually exited — not just that Windows acknowledged the stop command.
async function waitForPortFree(maxWaitMs, intervalMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const health = await getHealth();
    if (!health) return true;
    await sleep(intervalMs);
  }
  return false;
}

// Polls until /api/health reports a DIFFERENT bootId than beforeBootId (or
// any bootId at all if beforeBootId is null) — proves a genuinely NEW
// process is serving, not a stale one left over from before the restart.
async function waitForNewInstance(beforeBootId, maxWaitMs, intervalMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const health = await getHealth();
    if (health && health.bootId && health.bootId !== beforeBootId) return health;
    await sleep(intervalMs);
  }
  return null;
}

// Last-resort: find whatever's actually bound to port 443 and kill it. Only
// reached if the old process is still answering well after the Windows
// Service reported itself stopped — i.e. the emulated-SIGINT stop genuinely
// failed, not just a slow shutdown.
function forceKillPort443() {
  let killedAny = false;
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', timeout: 15000 });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (/:443\s/.test(line) && /LISTENING/i.test(line)) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid)) pids.add(pid);
      }
    }
    for (const pid of pids) {
      console.warn(`[deploy-runner] force-killing stale process PID ${pid} still bound to port 443…`);
      try {
        execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf8', timeout: 10000 });
        killedAny = true;
      } catch (err) {
        console.error(`[deploy-runner] taskkill PID ${pid} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('[deploy-runner] netstat lookup failed:', err.message);
  }
  return killedAny;
}

// Calls svc.stop()/svc.start() and resolves once Windows acknowledges it
// (the 'stop'/'start' event fires), or rejects if that acknowledgement
// itself never arrives. This is ONLY about the OS-level command completing
// — it says nothing about whether the underlying process is actually gone
// or actually serving requests yet, which is what the waitFor* helpers
// above are for.
function svcCommandAndWaitAck(svc, command, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`svc.${command}() did not fire a '${event}' event within ${timeoutMs / 1000}s`)),
      timeoutMs
    );
    svc.once(event, () => { clearTimeout(timer); resolve(); });
    svc[command]();
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

  // ── Restart the Windows Service, with real verification ────────────────
  const svc = new Service({
    name:   'Normanton Nexus',
    script: path.join(REPO_DIR, 'server.js'),
  });
  svc.on('error', err => {
    console.error('[deploy-runner] service event error:', err?.message || err);
  });

  const restartWatchdog = setTimeout(() => {
    markFailed(
      `Restart verification did not complete within ${SERVICE_RESTART_TIMEOUT_MS / 1000}s — see deploy-runner.log ` +
      `for how far it got. The "Normanton Nexus" service may need a manual check/restart.`
    );
  }, SERVICE_RESTART_TIMEOUT_MS);

  try {
    const before = await getHealth();
    if (before) {
      console.log(`[deploy-runner] instance before restart: pid=${before.pid} bootId=${before.bootId}`);
    } else {
      console.log('[deploy-runner] no instance currently answering /api/health (service may already be down).');
    }

    console.log('[deploy-runner] stopping service…');
    await svcCommandAndWaitAck(svc, 'stop', 'stop', SVC_EVENT_TIMEOUT_MS);
    console.log('[deploy-runner] Windows acknowledged the stop — confirming the old process actually exited…');

    // node-windows stops the process via an emulated SIGINT, which is not
    // always reliably delivered on Windows (wrapper.log has shown this
    // exact emulation fail and fall back to a forced kill). Don't trust the
    // 'stop' event alone — actively verify nothing is still answering
    // before starting a new instance on top of a leftover old one.
    const portFree = await waitForPortFree(STOP_VERIFY_MAX_WAIT_MS, STOP_VERIFY_POLL_MS);
    if (!portFree) {
      console.warn('[deploy-runner] old process is still answering after stop — forcing it to exit…');
      forceKillPort443();
      await sleep(3000); // give Windows a moment to actually release the port
      const stillUp = await getHealth();
      if (stillUp) {
        throw new Error(
          `Old process (pid ${stillUp.pid}) on port 443 would not exit even after a forced kill — refusing to ` +
          `start a new instance on top of it. Manual intervention needed on the server.`
        );
      }
    }
    console.log('[deploy-runner] old process confirmed gone.');

    // Start, verify a fresh bootId shows up, retry the start once if not.
    let fresh = null;
    for (let attempt = 1; attempt <= 2 && !fresh; attempt++) {
      console.log(`[deploy-runner] starting service (attempt ${attempt}/2)…`);
      await svcCommandAndWaitAck(svc, 'start', 'start', SVC_EVENT_TIMEOUT_MS);
      console.log('[deploy-runner] Windows acknowledged the start — waiting for a new instance identity to answer…');
      fresh = await waitForNewInstance(before?.bootId || null, START_VERIFY_MAX_WAIT_MS, START_VERIFY_POLL_MS);
      if (!fresh && attempt < 2) {
        console.warn('[deploy-runner] no new instance identity appeared in time — retrying start once…');
      }
    }
    if (!fresh) {
      throw new Error(
        `Service start was acknowledged by Windows but no new process ever answered ` +
        `https://127.0.0.1:${LIVENESS_PORT}${HEALTH_PATH} with a fresh identity (tried twice). The new process ` +
        `may be crash-looping on startup — check daemon/normantonnexus.err.log and confirm manually.`
      );
    }
    console.log(`[deploy-runner] new instance confirmed live: pid=${fresh.pid} bootId=${fresh.bootId}. Monitoring for early crash…`);

    // The process can start cleanly and still die shortly after (this is
    // exactly what was reported: it came up, looked fine, then exited a
    // couple of minutes later with nothing left running to notice). Stay
    // attached for a stability window, re-verifying the SAME instance is
    // still up, with one automatic recovery attempt if it isn't.
    for (const waitMs of STABILITY_CHECKS_MS) {
      await sleep(waitMs);
      const check = await getHealth();
      if (check && check.bootId === fresh.bootId) {
        console.log(`[deploy-runner] stability check OK at +${waitMs / 1000}s (pid=${check.pid} still running).`);
        continue;
      }
      console.warn(`[deploy-runner] instance did not survive to +${waitMs / 1000}s — attempting one recovery start…`);
      await svcCommandAndWaitAck(svc, 'start', 'start', SVC_EVENT_TIMEOUT_MS);
      const recovered = await waitForNewInstance(fresh.bootId, START_VERIFY_MAX_WAIT_MS, START_VERIFY_POLL_MS);
      if (!recovered) {
        throw new Error(
          `New instance crashed during the post-restart stability window and did not recover automatically after ` +
          `a retry. Check daemon/normantonnexus.err.log and confirm manually whether "Normanton Nexus" is running.`
        );
      }
      console.log(`[deploy-runner] recovered: pid=${recovered.pid} bootId=${recovered.bootId}. Continuing to monitor.`);
      fresh = recovered;
    }

    clearTimeout(restartWatchdog);
    console.log(`[deploy-runner] service restarted and verified stable (pid=${fresh.pid}, bootId=${fresh.bootId}).`);

    finished = true;
    await pool.request()
      .input('id',  sql.Int, deploymentID)
      .input('log', sql.NVarChar(sql.MAX), gitOutput.slice(0, 8000))
      .query(`UPDATE kongsberg.dbo.ScheduledDeployments
              SET Status = 'completed', CompletedAt = GETDATE(), OutputLog = @log
              WHERE DeploymentID = @id`);
    await audit('DEPLOY_COMPLETED', `Deployment #${deploymentID} completed (${gitRef})`);
    await pool.close();
    process.exit(0);

  } catch (err) {
    clearTimeout(restartWatchdog);
    await markFailed(err?.message || String(err));
  }
}

main().catch(err => {
  console.error('[deploy-runner] fatal error:', err);
  process.exit(1);
});
