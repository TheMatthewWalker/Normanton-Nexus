'use strict';

/**
 * Scheduled-deployment countdown banner — self-mounting, like notifications.js.
 * Include this script on any private page. Polls /api/deploy/next and, once
 * the current time enters the deployment's warning window, shows a fixed
 * banner across the top of the viewport counting down to the automatic
 * git-pull + service restart, so logged-in users get advance warning of the
 * upcoming downtime.
 *
 * Everything below is wrapped in an IIFE so none of its names (poll, esc,
 * pollTimer, POLL_INTERVAL_MS, etc.) leak into the shared global scope —
 * this file is loaded alongside notifications.js (and, on admin.html,
 * admin.js) as a classic <script>, all sharing one global object, and those
 * other files already declare several of the same identifier names.
 */
(function () {

  const POLL_INTERVAL_MS = 30_000;
  const API_URL           = '/api/deploy/next';

  let deployment = null; // { DeploymentID, ScheduledAt, WarningMinutes, Notes }
  let tickTimer  = null;
  let pollTimer  = null;

  // ── Bootstrap ───────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    injectStyle();
    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') poll();
    });
  });

  // ── Poll ────────────────────────────────────────────────────────────────────

  async function poll() {
    try {
      const res  = await fetch(API_URL);
      const json = await res.json();
      if (!json.success) return;
      deployment = json.deployment || null;
      refresh();
    } catch (_) { /* network — silent, same as notifications.js */ }
  }

  // ── Countdown ───────────────────────────────────────────────────────────────

  function refresh() {
    clearInterval(tickTimer);
    tickTimer = null;

    if (!deployment) {
      removeBanner();
      return;
    }

    const scheduledMs = new Date(deployment.ScheduledAt).getTime();
    const warnMs       = (deployment.WarningMinutes || 0) * 60_000;

    const tick = () => {
      const remainingMs = scheduledMs - Date.now();
      if (remainingMs > warnMs) {
        removeBanner();
        return;
      }
      renderBanner(remainingMs);
    };

    tick();
    tickTimer = setInterval(tick, 1000);
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  function renderBanner(remainingMs) {
    let bar = document.getElementById('deploy-banner');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'deploy-banner';
      document.body.prepend(bar);
    }
    document.body.classList.add('deploy-banner-active');

    if (remainingMs <= 0) {
      bar.classList.add('deploy-banner--imminent');
      bar.innerHTML =
        '<span class="deploy-banner-icon">⏳</span>' +
        '<span class="deploy-banner-text"><strong>Maintenance restart in progress…</strong> ' +
        'The system will be back in a moment — please avoid submitting changes right now.</span>';
      return;
    }

    bar.classList.toggle('deploy-banner--imminent', remainingMs <= 60_000);
    const countdown = formatCountdown(remainingMs);
    const notes     = deployment.Notes
      ? `<span class="deploy-banner-notes">${esc(deployment.Notes)}</span>`
      : '';
    bar.innerHTML =
      '<span class="deploy-banner-icon">⏳</span>' +
      `<span class="deploy-banner-text"><strong>Scheduled maintenance in ${countdown}</strong> — ` +
      `the system will restart automatically.${notes}</span>`;
  }

  function removeBanner() {
    document.getElementById('deploy-banner')?.remove();
    document.body.classList.remove('deploy-banner-active');
  }

  // ── Utilities ───────────────────────────────────────────────────────────────

  function formatCountdown(ms) {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function injectStyle() {
    if (document.getElementById('deploy-banner-style')) return;
    const style = document.createElement('style');
    style.id = 'deploy-banner-style';
    style.textContent = `
#deploy-banner {
  position: fixed; top: 0; left: 0; right: 0; z-index: 9000;
  display: flex; align-items: center; justify-content: center; gap: 10px;
  padding: 9px 16px;
  background: #D97706; color: #fff;
  font-family: 'Manrope', -apple-system, sans-serif;
  font-size: 13px; font-weight: 500;
  box-shadow: 0 2px 10px rgba(0,0,0,0.18);
  text-align: center;
}
#deploy-banner.deploy-banner--imminent { background: #DC2626; }
#deploy-banner .deploy-banner-icon { flex-shrink: 0; font-size: 14px; }
#deploy-banner .deploy-banner-notes { margin-left: 8px; opacity: 0.85; font-weight: 400; }
body.deploy-banner-active { padding-top: 38px; }
`;
    document.head.appendChild(style);
  }

})();
