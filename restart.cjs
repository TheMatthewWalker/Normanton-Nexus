/**
 * restart.cjs
 *
 * Manual, on-demand restart of the "Normanton Nexus" Windows Service —
 * stop then start, verified by process identity, not just by Windows
 * acknowledging the commands. Shares its verification logic with
 * deploy-runner.cjs (the automated scheduled-deploy runner) via
 * restart-lib.cjs, specifically so the two can't silently drift apart —
 * which is exactly what happened before: deploy-runner.cjs was hardened
 * with identity-aware liveness checking, a force-kill fallback, and a
 * post-restart stability window, but this script was left as a naive
 * stop() -> start() with no verification at all. Running it showed the
 * failure directly: a new node.exe would flash into Task Manager and
 * disappear, while the ORIGINAL server.js process — and any browser
 * session connected to it — just carried on unaffected, because the old
 * process never actually died (node-windows stops it via a Windows-
 * emulated SIGINT, which is not reliably delivered — see the big comment
 * at the top of restart-lib.cjs for the full explanation).
 *
 * Usage: node restart.cjs
 */

const path = require('path');
const { Service } = require('node-windows');
const {
  sleep,
  getHealth,
  waitForPortFree,
  waitForNewInstance,
  forceKillPort443,
  svcCommandAndWaitAck,
  HEALTH_PATH,
  LIVENESS_PORT,
} = require('./restart-lib.cjs');

const REPO_DIR = __dirname;

const STOP_VERIFY_MAX_WAIT_MS  = 25 * 1000;
const STOP_VERIFY_POLL_MS      = 2 * 1000;
const START_VERIFY_MAX_WAIT_MS = 45 * 1000;
const START_VERIFY_POLL_MS     = 3 * 1000;
const SVC_EVENT_TIMEOUT_MS     = 60 * 1000;
// Shorter than deploy-runner.cjs's — this is an interactive script; someone
// is watching it run, rather than it needing to self-supervise unattended.
const STABILITY_CHECKS_MS = [30 * 1000, 60 * 1000];

async function main() {
  const svc = new Service({ name: 'Normanton Nexus', script: path.join(REPO_DIR, 'server.js') });
  svc.on('error', err => console.error('[restart] service event error:', err?.message || err));

  const before = await getHealth();
  if (before) console.log(`[restart] instance before restart: pid=${before.pid} bootId=${before.bootId}`);
  else console.log('[restart] no instance currently answering /api/health.');

  console.log('[restart] stopping service…');
  await svcCommandAndWaitAck(svc, 'stop', 'stop', SVC_EVENT_TIMEOUT_MS);
  console.log('[restart] Windows acknowledged the stop — confirming the old process actually exited…');

  const portFree = await waitForPortFree(STOP_VERIFY_MAX_WAIT_MS, STOP_VERIFY_POLL_MS);
  if (!portFree) {
    console.warn('[restart] old process is still answering after stop — forcing it to exit…');
    forceKillPort443();
    await sleep(3000);
    const stillUp = await getHealth();
    if (stillUp) {
      console.error(`[restart] FAILED: old process (pid ${stillUp.pid}) would not exit even after a forced kill. Manual intervention needed.`);
      process.exitCode = 1;
      return;
    }
  }
  console.log('[restart] old process confirmed gone.');

  let fresh = null;
  for (let attempt = 1; attempt <= 2 && !fresh; attempt++) {
    console.log(`[restart] starting service (attempt ${attempt}/2)…`);
    await svcCommandAndWaitAck(svc, 'start', 'start', SVC_EVENT_TIMEOUT_MS);
    console.log('[restart] Windows acknowledged the start — waiting for a new instance identity to answer…');
    fresh = await waitForNewInstance(before?.bootId || null, START_VERIFY_MAX_WAIT_MS, START_VERIFY_POLL_MS);
    if (!fresh && attempt < 2) console.warn('[restart] no new instance identity appeared in time — retrying start once…');
  }
  if (!fresh) {
    console.error(`[restart] FAILED: service start was acknowledged but no new process ever answered https://127.0.0.1:${LIVENESS_PORT}${HEALTH_PATH} with a fresh identity (tried twice). Check daemon/normantonnexus.err.log.`);
    process.exitCode = 1;
    return;
  }
  console.log(`[restart] new instance confirmed live: pid=${fresh.pid} bootId=${fresh.bootId}. Monitoring briefly…`);

  for (const waitMs of STABILITY_CHECKS_MS) {
    await sleep(waitMs);
    const check = await getHealth();
    if (check && check.bootId === fresh.bootId) {
      console.log(`[restart] stability check OK at +${waitMs / 1000}s (pid=${check.pid}).`);
      continue;
    }
    console.error(`[restart] WARNING: instance did not survive to +${waitMs / 1000}s — check the service manually (it may have restarted again on its own via SCM failure-recovery — see install.cjs).`);
    process.exitCode = 1;
    return;
  }

  console.log(`[restart] service restarted and verified stable (pid=${fresh.pid}, bootId=${fresh.bootId}).`);
}

main().catch(err => {
  console.error('[restart] fatal error:', err);
  process.exitCode = 1;
});
