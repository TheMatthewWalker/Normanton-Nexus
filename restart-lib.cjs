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
 *
 * WHY runCommand() EXISTS INSTEAD OF execSync/execFileSync:
 * A real deployment got stuck here — the log stopped dead right after
 * "force-killing stale process PID ... still bound to port 443", with
 * nothing further for several minutes. Root cause: execSync's own
 * `timeout` option is NOT reliable on Windows for commands that end up
 * running through a shell (execSync's default). Node spawns
 * `cmd.exe /d /s /c "<command>"`, and on timeout it kills THAT immediate
 * child — but if cmd.exe has already spawned taskkill.exe as its OWN
 * child and that grandchild still holds the stdout/stderr pipe open (or
 * is itself slow to exit), killing cmd.exe does not kill the grandchild,
 * and Node's SYNCHRONOUS read keeps blocking forever waiting for a pipe
 * EOF that never arrives — the advertised timeout never actually fires.
 * Worse, because execSync blocks the entire event loop by design, nothing
 * else in the process can run while this happens — including any of our
 * OWN setTimeout-based watchdogs, which need the event loop to be free to
 * fire at all. A synchronous call that can hang forever therefore
 * defeats every other layer of protection in this codebase simultaneously.
 *
 * runCommand() fixes this at the root: it uses the ASYNC execFile (no
 * shell — args are passed as an array straight to CreateProcess, so there
 * is no cmd.exe layer to leave orphaned children behind) and enforces its
 * OWN timeout via a plain JS timer that calls child.kill() directly. Since
 * this all happens on the event loop rather than blocking it, the rest of
 * the script (including deploy-runner.cjs's outer restart watchdog) keeps
 * running no matter what the child process does.
 */

'use strict';

const { execFile } = require('child_process');
const https         = require('https');

const HEALTH_PATH               = '/api/health';
const LIVENESS_PORT             = 443;
const HEALTH_REQUEST_TIMEOUT_MS = 10 * 1000; // single health-check request

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Runs `file args...` with NO shell involved (so no cmd.exe layer that can
// orphan a grandchild and hold pipes open) and enforces timeoutMs itself by
// killing the child process directly — never relies on execFile/execSync's
// own built-in timeout handling. Always resolves (never rejects/throws);
// callers check `.ok`.
function runCommand(file, args, { timeoutMs = 15000, cwd, env } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let timer = null;

    // Explicitly passing `env: undefined` to execFile is NOT the same as
    // omitting the key — depending on the Node version this can suppress
    // the normal "inherit process.env" default and hand the child a
    // stripped-down environment (missing PATH/SystemRoot, which Windows'
    // CreateProcess needs to resolve a bare command name and which some
    // system utilities behave unpredictably without). Always fall back to
    // process.env explicitly so this can never be a variable.
    const child = execFile(
      file, args,
      { cwd, env: env || process.env, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        if (settled) return; // already resolved via the timeout path below
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', error: err || null });
      }
    );

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) { /* best effort */ }
      resolve({
        ok: false, stdout: '', stderr: '',
        error: new Error(`${file} ${args.join(' ')} did not complete within ${timeoutMs / 1000}s — killed.`),
      });
    }, timeoutMs);
    // Deliberately NOT unref'd: this timer is the only thing guaranteeing
    // forward progress if the child process handle doesn't keep the event
    // loop alive for some reason. An unref'd timer here can let Node exit
    // the whole process silently before it ever fires (verified directly:
    // a bare unref'd timer racing a promise with no other pending work
    // causes an immediate, silent process exit instead of waiting for the
    // timeout) — a silent exit is worse than a hang, since nothing is left
    // alive to mark the deployment failed or clean anything up.
  });
}

// Races an arbitrary promise against a hard, INDEPENDENT deadline —
// deliberately not trusting any timeout logic inside the promise itself.
// A real deployment hung inside forceKillPort443() well past runCommand()'s
// own 10s timeout on a `taskkill` call, for reasons that couldn't be
// pinned down from the log alone (a plain netstat call through the exact
// same runCommand() mechanism completed normally moments earlier). Rather
// than assume any single timeout mechanism is trustworthy, every call site
// that invokes forceKillPort443() also wraps it in this — so no matter
// what the underlying cause turns out to be, the caller is guaranteed to
// get control back and can fail the deployment cleanly instead of hanging
// forever.
function withTimeout(promise, ms, fallbackValue) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallbackValue);
    }, ms);
    // See the comment on runCommand()'s own timer above — deliberately not
    // unref'd, for the same reason.
    promise.then(value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(fallbackValue);
    });
  });
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
// failed, not just a slow shutdown. Uses runCommand() throughout (see the
// big comment at the top of this file) so a stuck/unresponsive taskkill
// can never freeze the whole script the way it did before.
async function forceKillPort443() {
  let killedAny = false;

  const netstatResult = await runCommand('netstat', ['-ano', '-p', 'tcp'], { timeoutMs: 15000 });
  if (!netstatResult.ok) {
    console.error('[restart-lib] netstat lookup failed:', netstatResult.error?.message);
    return killedAny;
  }

  const pids = new Set();
  for (const line of netstatResult.stdout.split(/\r?\n/)) {
    if (/:443\s/.test(line) && /LISTENING/i.test(line)) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid)) pids.add(pid);
    }
  }

  for (const pid of pids) {
    console.warn(`[restart-lib] force-killing stale process PID ${pid} still bound to port 443…`);
    const killResult = await runCommand('taskkill', ['/F', '/PID', pid], { timeoutMs: 10000 });
    if (killResult.ok) {
      killedAny = true;
    } else {
      console.error(`[restart-lib] taskkill PID ${pid} failed or timed out:`, killResult.error?.message);
    }
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
  runCommand,
  withTimeout,
  getHealth,
  waitForPortFree,
  waitForNewInstance,
  forceKillPort443,
  svcCommandAndWaitAck,
};
