/**
 * deploy-runner.cjs
 *
 * Executes a single scheduled deployment: `git pull` the app's repo, then
 * stop/start the "Normanton Nexus" Windows Service (extends restart.cjs's
 * stop -> start pattern with a git pull step beforehand — both scripts now
 * share the actual restart-verification logic via restart-lib.cjs, so they
 * can't silently drift apart again).
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
 *      confirmation, username/password, etc.).
 *
 * IMPORTANT — restart verification: see the big comment at the top of
 * restart-lib.cjs for why the stop/start events alone can't be trusted, and
 * why every restart here is verified by process identity (bootId) rather
 * than mere port reachability, with a post-restart stability window before
 * declaring success.
 *
 * IMPORTANT — SapServer: once Normanton-Nexus itself is confirmed restarted
 * and stable, this ALSO pulls + republishes + restarts the sibling SapServer
 * repo (deploySapServer() below), via ITS OWN scripts/deploy.ps1 (stop the
 * Task Scheduler task -> dotnet publish -> start it again) rather than a
 * Windows Service restart — SapServer can't run as a Windows Service at all
 * (the SAP GUI COM component needs an interactive session; see that repo's
 * own CLAUDE.md). This assumes SapServer lives on the SAME machine as
 * Normanton-Nexus (true for this on-prem, single-site setup) and reuses the
 * SAME GitRef the admin scheduled THIS deployment with, since
 * ScheduledDeployments only has one GitRef column — if the two repos ever
 * need independently-chosen branches for a given deploy, that needs its own
 * column instead of this assumption. If SapServer isn't checked out on this
 * box at all (e.g. a dev/test host), the step is skipped with a log line
 * rather than failing the deployment; once it IS present, a failure here
 * fails the whole deployment (Normanton-Nexus having restarted fine doesn't
 * matter if SapServer is now down or stuck on old code — see the
 * architecture overview in the workspace root CLAUDE.md for why the two are
 * one production system).
 *
 * IMPORTANT — no execSync anywhere in this file: a real deployment once
 * froze permanently mid-run because execSync's `timeout` option is not
 * reliable on Windows for shell-wrapped commands (see restart-lib.cjs's
 * runCommand() for the full explanation) — and because execSync blocks the
 * entire event loop, a stuck call also silently defeats every watchdog
 * timer in this script, including the outer one below. Both the git pull
 * and every OS command in restart-lib.cjs now go through runCommand(),
 * which is async and enforces its own timeout by killing the child process
 * directly, so the event loop — and every watchdog relying on it — keeps
 * running no matter what the underlying command does.
 *
 * Usage: node deploy-runner.cjs <DeploymentID>
 * (DeploymentID must already exist in kongsberg.dbo.ScheduledDeployments
 * with Status = 'running' — the server.js cron checker sets that atomically
 * before spawning this script.)
 */

'use strict';

const path         = require('path');
const fs           = require('fs');
const sql          = require('mssql');
const { Service }  = require('node-windows');
const {
  sleep,
  runCommand,
  withTimeout,
  getHealth,
  waitForPortFree,
  waitForNewInstance,
  forceKillPort443,
  svcCommandAndWaitAck,
  HEALTH_PATH,
  LIVENESS_PORT,
} = require('./restart-lib.cjs');

const REPO_DIR       = __dirname;
const TOKEN_PATH      = path.join(REPO_DIR, '.deploykey', 'github_token');
const ASKPASS_PATH    = path.join(REPO_DIR, 'deploy-askpass.cmd');
const SSH_DEPLOY_KEY  = path.join(REPO_DIR, '.deploykey', 'id_ed25519');
const REPO_HTTPS_URL  = 'https://x-access-token@github.com/TheMatthewWalker/Normanton-Nexus.git';

// ── SapServer (sibling repo/service) ────────────────────────────────────
const SAP_SERVER_DIR     = path.join(REPO_DIR, '..', 'SapServer');
const SAP_TOKEN_PATH     = path.join(SAP_SERVER_DIR, '.deploykey', 'github_token');
const SAP_ASKPASS_PATH   = path.join(SAP_SERVER_DIR, 'deploy-askpass.cmd');
const SAP_SSH_DEPLOY_KEY = path.join(SAP_SERVER_DIR, '.deploykey', 'id_ed25519');
const SAP_REPO_HTTPS_URL = 'https://x-access-token@github.com/TheMatthewWalker/SapServer.git';
const SAP_DEPLOY_PS1     = path.join(SAP_SERVER_DIR, 'scripts', 'deploy.ps1');

// Git must NEVER fall back to an interactive prompt — there is nothing and
// no one able to answer one when this runs unattended under a service
// account. Without this, a missing/misconfigured credential doesn't fail
// fast, it just hangs forever waiting for input that will never arrive.
const BASE_GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

// How long the git pull itself is allowed to take before it's killed and
// treated as a failure. Enforced by runCommand()'s own timer (see the
// top-of-file comment) — NOT by execSync's timeout option, which proved
// unreliable on Windows.
const GIT_PULL_TIMEOUT_MS = 2 * 60 * 1000;

// SapServer's own git pull — same reasoning as GIT_PULL_TIMEOUT_MS above.
const SAP_GIT_PULL_TIMEOUT_MS = 2 * 60 * 1000;

// scripts/deploy.ps1 does stop -> dotnet publish (self-contained win-x64,
// the slow part) -> start. Generous on purpose — same rationale as
// SERVICE_RESTART_TIMEOUT_MS below: runCommand()'s own timer is what
// guarantees this can never hang the script even if it does eventually
// time out, so there's no cost to giving a slow publish room to finish
// rather than getting killed mid-build and leaving a half-written
// publish/ directory behind.
const SAP_DEPLOY_PS1_TIMEOUT_MS = 10 * 60 * 1000;

// Overall ceiling for the entire stop -> verify -> start -> verify ->
// stability-monitor sequence below. Generous on purpose: this is a detached
// background process, nothing is blocked waiting on it, and the whole point
// of the stability-monitoring window is to sit and watch for several
// minutes before declaring victory. This watchdog is only meaningful
// because nothing else in this script blocks the event loop anymore — see
// the top-of-file note about execSync.
const SERVICE_RESTART_TIMEOUT_MS = 10 * 60 * 1000;

// ── Restart-verification tuning ─────────────────────────────────────────
const STOP_VERIFY_MAX_WAIT_MS  = 25 * 1000;    // wait this long for the OLD process to actually go quiet
const STOP_VERIFY_POLL_MS      = 2 * 1000;

const START_VERIFY_MAX_WAIT_MS = 45 * 1000;    // wait this long, per attempt, for a NEW bootId to appear
const START_VERIFY_POLL_MS     = 3 * 1000;

const SVC_EVENT_TIMEOUT_MS     = 60 * 1000;    // wait this long for Windows to even acknowledge stop/start

// Re-checks after the new instance is first confirmed live — matches the
// reported failure mode of "came up fine, then died a couple of minutes
// later with nothing left running to notice."
const STABILITY_CHECKS_MS = [30 * 1000, 60 * 1000, 120 * 1000];

// Picks the same PAT -> SSH-key -> ambient-auth fallback order for any repo
// (Normanton-Nexus itself, or SapServer below) — pulled out so both stay in
// lockstep the same way restart-lib.cjs keeps restart.cjs and this script's
// restart-verification logic from drifting apart. Returns the git args (as
// a function of gitRef, since the HTTPS form embeds it differently than the
// SSH/origin form) and the env to run them with.
function resolveGitAuth(label, tokenPath, askpassPath, sshKeyPath, httpsUrl) {
  if (fs.existsSync(tokenPath)) {
    console.log(`[deploy-runner] ${label}: using fine-grained PAT (${tokenPath}) over HTTPS`);
    return {
      env: { ...BASE_GIT_ENV, GIT_ASKPASS: askpassPath },
      buildArgs: gitRef => ['pull', '--ff-only', httpsUrl, gitRef],
    };
  }
  if (fs.existsSync(sshKeyPath)) {
    console.log(`[deploy-runner] ${label}: using SSH deploy key (${sshKeyPath})`);
    return {
      env: {
        ...BASE_GIT_ENV,
        GIT_SSH_COMMAND: `ssh -i "${sshKeyPath}" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
      },
      buildArgs: gitRef => ['pull', '--ff-only', 'origin', gitRef],
    };
  }
  console.warn(
    `[deploy-runner] ${label}: no credentials found at ${tokenPath} or ${sshKeyPath} — falling back to ` +
    `whatever auth (if any) this account already has (this is usually NOT the same account/agent ` +
    `you tested "ssh -T git@github.com" or "git push" with interactively). Set up a fine-grained ` +
    `GitHub token (Contents: Read-only, scoped to this repo only) at ${tokenPath} if this fails.`
  );
  // Still force non-interactive SSH even with no dedicated key, so a
  // missing/rejected credential fails fast instead of hanging on a
  // host-key or password prompt nothing can ever answer.
  return {
    env: { ...BASE_GIT_ENV, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' },
    buildArgs: gitRef => ['pull', '--ff-only', 'origin', gitRef],
  };
}

// Pulls + republishes + restarts the sibling SapServer repo, once
// Normanton-Nexus itself is confirmed back up and stable. See the
// IMPORTANT — SapServer comment at the top of this file for the full
// rationale (same machine assumption, shared GitRef, skip-vs-fail rules).
// Returns { skipped, output }; throws on any real failure so the caller's
// existing try/catch + markFailed() handles it exactly like the
// Normanton-Nexus restart failures above it.
async function deploySapServer(gitRef) {
  if (!fs.existsSync(SAP_SERVER_DIR)) {
    console.log(`[deploy-runner] SapServer directory not found at ${SAP_SERVER_DIR} — skipping SapServer deploy.`);
    return { skipped: true, output: '' };
  }

  const auth = resolveGitAuth('SapServer', SAP_TOKEN_PATH, SAP_ASKPASS_PATH, SAP_SSH_DEPLOY_KEY, SAP_REPO_HTTPS_URL);
  console.log(`[deploy-runner] pulling SapServer ${gitRef} (fast-forward only, ${SAP_GIT_PULL_TIMEOUT_MS / 1000}s timeout)…`);
  const pullResult = await runCommand('git', auth.buildArgs(gitRef), {
    cwd: SAP_SERVER_DIR, env: auth.env, timeoutMs: SAP_GIT_PULL_TIMEOUT_MS,
  });
  if (!pullResult.ok) {
    const detail = pullResult.stdout + pullResult.stderr + (pullResult.error ? pullResult.error.message : 'git pull failed');
    throw new Error(`SapServer git pull failed: ${detail}`);
  }
  console.log('[deploy-runner] SapServer git pull complete:\n' + pullResult.stdout);

  // deploy.ps1 itself is #Requires -RunAsAdministrator — this script runs
  // under the "Normanton Nexus" service's LocalSystem account, which does
  // satisfy that check (LocalSystem's token includes the Administrators
  // role), but it's worth confirming on the first real run since nothing in
  // this dev environment can exercise the actual Task Scheduler / dotnet
  // publish path.
  console.log(`[deploy-runner] running SapServer scripts/deploy.ps1 (stop task -> publish -> start task, ${SAP_DEPLOY_PS1_TIMEOUT_MS / 1000}s timeout)…`);
  const deployResult = await runCommand(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SAP_DEPLOY_PS1],
    { cwd: SAP_SERVER_DIR, env: process.env, timeoutMs: SAP_DEPLOY_PS1_TIMEOUT_MS }
  );
  if (!deployResult.ok) {
    const detail = deployResult.stdout + deployResult.stderr + (deployResult.error ? deployResult.error.message : 'deploy.ps1 failed');
    throw new Error(`SapServer scripts/deploy.ps1 failed: ${detail}`);
  }
  console.log('[deploy-runner] SapServer scripts/deploy.ps1 complete:\n' + deployResult.stdout);

  return { skipped: false, output: pullResult.stdout + '\n' + deployResult.stdout };
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
  const auth = resolveGitAuth('Normanton-Nexus', TOKEN_PATH, ASKPASS_PATH, SSH_DEPLOY_KEY, REPO_HTTPS_URL);

  console.log(`[deploy-runner] pulling ${gitRef} (fast-forward only, ${GIT_PULL_TIMEOUT_MS / 1000}s timeout)…`);
  const pullResult = await runCommand('git', auth.buildArgs(gitRef), { cwd: REPO_DIR, env: auth.env, timeoutMs: GIT_PULL_TIMEOUT_MS });
  if (!pullResult.ok) {
    const detail = pullResult.stdout + pullResult.stderr + (pullResult.error ? pullResult.error.message : 'git pull failed');
    await markFailed(detail);
    return;
  }
  const gitOutput = pullResult.stdout;
  console.log('[deploy-runner] git pull complete:\n' + gitOutput);

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
      // Independent 30s outer deadline — a real deployment once hung well
      // past forceKillPort443()'s own internal timeouts for reasons that
      // couldn't be pinned down from the log alone. This guarantees
      // forward progress regardless of what the underlying cause is.
      await withTimeout(forceKillPort443(), 30000, false);
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

    // Normanton-Nexus itself is confirmed up — now bring SapServer along
    // with it. Runs OUTSIDE restartWatchdog (already cleared above): the
    // git pull and deploy.ps1 calls below each enforce their own timeout via
    // runCommand(), so no separate watchdog is needed for this part. Any
    // failure here throws and is caught below, same as an NN restart
    // failure — see the IMPORTANT — SapServer comment at the top of this
    // file for why that's the right call.
    const sapResult = await deploySapServer(gitRef);
    console.log(sapResult.skipped
      ? '[deploy-runner] SapServer step skipped (not checked out on this host).'
      : '[deploy-runner] SapServer redeployed and restarted.');

    finished = true;
    const combinedLog = gitOutput +
      (sapResult.skipped
        ? '\n\n[SapServer] skipped — not checked out on this host.'
        : '\n\n[SapServer]\n' + sapResult.output);
    await pool.request()
      .input('id',  sql.Int, deploymentID)
      .input('log', sql.NVarChar(sql.MAX), combinedLog.slice(0, 8000))
      .query(`UPDATE kongsberg.dbo.ScheduledDeployments
              SET Status = 'completed', CompletedAt = GETDATE(), OutputLog = @log
              WHERE DeploymentID = @id`);
    await audit('DEPLOY_COMPLETED',
      `Deployment #${deploymentID} completed (${gitRef})${sapResult.skipped ? '' : ' + SapServer redeployed'}`);
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
