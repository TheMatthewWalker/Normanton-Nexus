/**
 * restart-lib.cjs
 *
 * Shared, identity-verified Windows Service restart primitives for the
 * "Normanton Nexus" service. Used by BOTH:
 *   - deploy-runner.cjs — the automated scheduled-deployment runner
 *   - restart.cjs        — the manual on-demand restart script
 *
 * WHY THIS IS SHARED (don't inline copies of this into either script):
 * restart.cjs used to be a completely separate, much simpler stop()/start()
 * with no verification at all. When deploy-runner.cjs's restart logic was
 * hardened (identity-aware liveness checking, force-killing a stuck old
 * process, a post-restart stability window), restart.cjs was never touched
 * and silently kept the old, unreliable behavior — which was then observed
 * directly: running it left a new node.exe flashing in and out of Task
 * Manager while the ORIGINAL process kept right on serving requests,
 * because it never actually died from the stop command. Sharing this
 * module is what prevents that kind of silent drift from happening again;
 * if the verification logic changes, both callers change together.
 *
 * WHY VERIFICATION IS THIS PARANOID AT ALL:
 * node-windows stops the underlying process via a Windows-emulated
 * SIGINT — Windows has no real POSIX signal delivery to a background
 * service process, and that emulation is not always reliably received
 * (confirmed directly in daemon/normantonnexus.wrapper.log, which shows
 * this exact emulation failing and falling back to a forced kill on a
 * previous cycle). So neither the 'stop' event nor the 'start' event on
 * their own prove anything about the ACTUAL server.js process: 'stop' can
 * fire while the old process is still alive and answering requests, and
 * 'start' only means Windows acknowledged the start command, not that the
 * new process finished booting (or that it's even the process still
 * answering — a stale old instance can keep answering right through a
 * "successful" start). server.js exposes GET /api/health -> { pid,
 * bootId, startedAt }, where bootId is a fresh random value generated once
 * per process start, specifically so callers here can tell "a genuinely
 * NEW process is serving" apart from "something is still answering."
 */

'use strict';

const { execSync } = require('child_process');
const https        = require('https');

const HEALTH_PATH               = '/api/health';
const LIVENESS_PORT             = 443;
const HEALTH_REQUEST_TIMEOUT_MS = 10 * 1000; // single health-check request

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
      console.warn(`[restart-lib] force-killing stale process PID ${pid} still bound to port 443…`);
      try {
        execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf8', timeout: 10000 });
        killedAny = true;
      } catch (err) {
        console.error(`[restart-lib] taskkill PID ${pid} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('[restart-lib] netstat lookup failed:', err.message);
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

module.exports = {
  HEALTH_PATH,
  LIVENESS_PORT,
  HEALTH_REQUEST_TIMEOUT_MS,
  sleep,
  getHealth,
  waitForPortFree,
  waitForNewInstance,
  forceKillPort443,
  svcCommandAndWaitAck,
};
