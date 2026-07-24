'use strict';

// ── My Account modal — My SAP Credentials ───────────────────────────────────
// Self-service: a user sets/updates their own SAP username+password so
// elevated SAP actions (PO creation — see routes/shipmentcost.js's
// /post-migo and SapServer's PurchasingController) can run under their own
// SAP authorization instead of the shared service account. See
// routes/profile.js / lib/sapCredentials.js for the backend side.
const acctBtn        = document.getElementById('btn-my-account');
const acctOverlay     = document.getElementById('account-modal-overlay');
const acctCloseBtn    = document.getElementById('account-modal-close');
const sapCredStatus   = document.getElementById('sap-cred-status');
const sapCredForm     = document.getElementById('sap-cred-form');
const sapCredUsername = document.getElementById('sap-cred-username');
const sapCredPassword = document.getElementById('sap-cred-password');
const sapCredResult   = document.getElementById('sap-cred-result');
const sapCredSaveBtn  = document.getElementById('sap-cred-save-btn');
const sapCredClearBtn = document.getElementById('sap-cred-clear-btn');

async function loadSapCredStatus() {
  sapCredStatus.textContent = 'Loading…';
  sapCredResult.textContent = '';
  sapCredResult.className = 'account-result';
  try {
    const res = await fetch('/api/profile/sap-credentials');
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load status');
    const { sapUsername, hasCredentials, updatedAt } = json.data;
    if (hasCredentials) {
      const when = updatedAt ? new Date(updatedAt).toLocaleString('en-GB') : '';
      sapCredStatus.textContent = `Configured — SAP username "${sapUsername}"${when ? ` (saved ${when})` : ''}`;
      sapCredUsername.value = sapUsername || '';
      sapCredClearBtn.classList.remove('hidden');
    } else {
      sapCredStatus.textContent = 'Not configured yet — required for actions like creating a purchase order.';
      sapCredUsername.value = '';
      sapCredClearBtn.classList.add('hidden');
    }
    sapCredPassword.value = '';
  } catch (err) {
    sapCredStatus.textContent = `Failed to load status: ${err.message}`;
  }
}

function openAccountModal() {
  acctOverlay.classList.remove('hidden');
  loadSapCredStatus();
}
function closeAccountModal() {
  acctOverlay.classList.add('hidden');
}

if (acctBtn) acctBtn.addEventListener('click', openAccountModal);
if (acctCloseBtn) acctCloseBtn.addEventListener('click', closeAccountModal);
if (acctOverlay) acctOverlay.addEventListener('click', e => { if (e.target === acctOverlay) closeAccountModal(); });

if (sapCredForm) sapCredForm.addEventListener('submit', async e => {
  e.preventDefault();
  const sapUsername = sapCredUsername.value.trim();
  const sapPassword = sapCredPassword.value;
  if (!sapUsername || !sapPassword) {
    sapCredResult.textContent = 'Both SAP username and password are required.';
    sapCredResult.className = 'account-result account-result--error';
    return;
  }
  sapCredSaveBtn.disabled = true; sapCredSaveBtn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/profile/sap-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sapUsername, sapPassword }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to save');
    sapCredResult.textContent = 'Saved.';
    sapCredResult.className = 'account-result account-result--ok';
    await loadSapCredStatus();
  } catch (err) {
    sapCredResult.textContent = err.message;
    sapCredResult.className = 'account-result account-result--error';
  } finally {
    sapCredSaveBtn.disabled = false; sapCredSaveBtn.textContent = 'Save';
  }
});

if (sapCredClearBtn) sapCredClearBtn.addEventListener('click', async () => {
  if (!confirm('Clear your saved SAP credentials? Actions that need them (like creating a purchase order) will stop working until you set them again.')) return;
  sapCredClearBtn.disabled = true;
  try {
    const res = await fetch('/api/profile/sap-credentials', { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to clear');
    sapCredResult.textContent = 'Cleared.';
    sapCredResult.className = 'account-result account-result--ok';
    await loadSapCredStatus();
  } catch (err) {
    sapCredResult.textContent = err.message;
    sapCredResult.className = 'account-result account-result--error';
  } finally {
    sapCredClearBtn.disabled = false;
  }
});


const shell = document.getElementById('gemini-shell');
const openBtn = document.getElementById('btn-gemini-chat');
const closeBtn = document.getElementById('gemini-close');
const form = document.getElementById('gemini-form');
const input = document.getElementById('gemini-input');
const messages = document.getElementById('gemini-messages');
const statusEl = document.getElementById('gemini-status');
const sendBtn = document.getElementById('gemini-send');



(async () => {
  try {
    const session = await fetch('/session-check').then(r => r.json());
    if (!session.loggedIn) {
      window.location.href = '/';
      return;
    }
    document.getElementById('session-user').textContent = session.username.split('.')[0].toProperCase(); // Show the first name (username before the dot)
    const heroName = document.getElementById('hero-username');
    if (heroName) heroName.textContent = session.username.split('.')[0].toProperCase(); // Show first name in hero section, properly capitalized
    filterDeptTiles(session);
    loadProductionSparkline();
    loadSalesSparkline();
    loadWarehouseSparkline();
    loadLogisticsSparkline();
    checkSapAvailability();
    setInterval(checkSapAvailability, 60000);
    armSessionTimer(session.expiresAt, session.idleTimeoutMinutes);
    tickSessionTimer();
    setInterval(tickSessionTimer, 1000);
  } catch {
    window.location.href = '/';
  }
})();

// ── Filter department tiles to what this user can actually open ─────────────
// Mirrors server.js's page-serving gate exactly (requireDepartment via
// config.js's DEPT_PAGE_MAP, requireRole('admin') for admin.html) so a tile
// is shown here if and only if clicking it would actually get in — no dead
// tiles, no clutter for departments/roles the user doesn't have.
// Same ROLE_LEVEL ordering as middleware/auth.js (not exported, so mirrored
// here rather than reached into from the frontend).
const ROLE_LEVEL = { operator: 1, admin: 2, superadmin: 3 };

function filterDeptTiles(session) {
  const departments = Array.isArray(session.departments) ? session.departments : [];
  const userLevel    = ROLE_LEVEL[session.role] ?? 0;
  const isSuperadmin = session.role === 'superadmin';

  let visibleCount = 0;
  document.querySelectorAll('.dept-card').forEach(card => {
    const dept    = card.dataset.dept;
    const roleMin = card.dataset.roleMin;

    let allowed = true;
    if (dept && !isSuperadmin)    allowed = departments.includes(dept);
    if (roleMin && !isSuperadmin) allowed = allowed && userLevel >= (ROLE_LEVEL[roleMin] ?? 99);

    card.classList.toggle('hidden', !allowed);
    if (allowed) visibleCount++;
  });

  document.getElementById('dept-grid-empty')?.classList.toggle('hidden', visibleCount > 0);
}

// ── Live session countdown ────────────────────────────────────────────────────
// Shows time remaining before the idle timeout (server.js/config.js —
// 30 min default, 5 min for users flagged ShortIdleTimeout in User
// Administration) signs the user out. Purely client-side ticking between
// syncs: sessionExpiresAt is set once from /session-check's server-computed
// value, then nudged forward by idleTimeoutMs on every subsequent
// same-origin fetch this page makes — mirroring what the server's own
// `rolling: true` session already does (any request refreshes the idle
// timer), so the display matches what will actually happen rather than
// drifting from it or resetting the real timer just to redraw a number.
let sessionExpiresAt = null;
let idleTimeoutMs    = null;

function armSessionTimer(expiresAt, idleTimeoutMinutes) {
  if (!expiresAt || !idleTimeoutMinutes) return; // older/unexpected response shape — leave the pill at its default "--:--"
  sessionExpiresAt = new Date(expiresAt).getTime();
  idleTimeoutMs     = idleTimeoutMinutes * 60000;
}

(function watchFetchForSessionTimer() {
  const wrapped = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const res = await wrapped(...args);
    if (sessionExpiresAt && idleTimeoutMs && res.ok) {
      sessionExpiresAt = Date.now() + idleTimeoutMs;
    }
    return res;
  };
})();

function tickSessionTimer() {
  const textEl = document.getElementById('session-timer-text');
  const dotEl  = document.getElementById('session-timer-dot');
  if (!textEl || !sessionExpiresAt) return;

  const remainingMs = sessionExpiresAt - Date.now();
  if (remainingMs <= 0) {
    textEl.textContent = '0:00';
    window.location.href = '/?error=session_expired';
    return;
  }

  const totalSec = Math.floor(remainingMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  textEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;

  if (dotEl) {
    dotEl.className = 'hero-pill-dot ' + (
      remainingMs < 60000  ? 'hero-pill-dot--error' :
      remainingMs < 120000 ? 'hero-pill-dot--warn'  :
                              'hero-pill-dot--ok'
    );
  }
}

async function checkSapAvailability() {
  const dot = document.getElementById('sap-dot');
  if (!dot) return;
  try {
    const res = await fetch('/api/sap/availability').then(r => r.json());
    dot.className = 'hero-pill-dot ' + (res.reachable ? 'hero-pill-dot--ok' : 'hero-pill-dot--error');
  } catch {
    dot.className = 'hero-pill-dot hero-pill-dot--error';
  }
}

async function loadSalesSparkline() {
  try {
    const res = await fetch('/api/sap/sales-sparkline').then(r => r.json());
    if (!res.success || !res.data) return;

    const { thisTotal, pctChange, dailyValues } = res.data;

    const svg     = document.getElementById('sales-spark-svg');
    const deltaEl = document.getElementById('sales-spark-delta');
    const valueEl = document.getElementById('sales-spark-value');
    const wrap    = document.getElementById('sales-spark');
    if (!svg || !deltaEl || !valueEl || !wrap) return;

    // Format £ value
    const fmtSales = n => {
      if (n >= 1000000) return `£${(n / 1000000).toFixed(2)}M`;
      if (n >= 10000)   return `£${(n / 1000).toFixed(1)}k`;
      return `£${Math.round(n).toLocaleString('en-GB')}`;
    };
    valueEl.textContent = fmtSales(thisTotal) + ' MTD';

    const W = 280, H = 28, padY = 3;
    const n   = dailyValues.length;
    const max = Math.max(...dailyValues, 1);

    const pts = dailyValues.map((v, i) => [
      n < 2 ? W / 2 : (i / (n - 1)) * W,
      H - padY - ((v / max) * (H - padY * 2)),
    ]);

    const lineD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
    const fillD = `${lineD} L${W},${H} L0,${H} Z`;

    const isUp   = pctChange === null || pctChange >= 0;
    const isFlat = pctChange !== null && Math.abs(pctChange) < 0.1;
    const col    = isFlat ? '#8DA3BE' : isUp ? '#059669' : '#DC2626';

    svg.innerHTML = `
      <defs>
        <linearGradient id="sssg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="${col}" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${fillD}" fill="url(#sssg)"/>
      <path d="${lineD}" fill="none" stroke="${col}" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round"/>`;

    const sign   = (!isFlat && isUp && pctChange > 0) ? '+' : '';
    const pctStr = pctChange === null ? '—' : `${sign}${pctChange}%`;
    deltaEl.textContent = `${pctStr} vs last month`;
    deltaEl.className   = `dept-spark-delta dept-spark-delta--${isFlat ? 'flat' : isUp ? 'up' : 'down'}`;
    deltaEl.style.opacity = '1';

    wrap.style.display = '';   // reveal the spark section now data is ready
  } catch (_) {}
}

async function loadProductionSparkline() {
  try {
    const res = await fetch('/api/productionnexus/landing-sparkline').then(r => r.json());
    if (!res.success) return;
    const { values, thisWeek, pctChange } = res.data;

    const svg     = document.getElementById('pn-spark-svg');
    const deltaEl = document.getElementById('pn-spark-delta');
    const valueEl = document.getElementById('pn-spark-value');
    if (!svg || !deltaEl || !valueEl) return;

    // Format metres: 1,234 M or 12.4k M
    const fmtM = n => (n >= 10000
      ? (n / 1000).toFixed(1) + 'k M'
      : n.toLocaleString('en-GB') + ' M');
    valueEl.textContent = fmtM(thisWeek) + ' this week';

    const W = 280, H = 28, padY = 3;
    const n   = values.length;
    const max = Math.max(...values, 1);

    const pts = values.map((v, i) => [
      (i / (n - 1)) * W,
      H - padY - ((v / max) * (H - padY * 2)),
    ]);

    const lineD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
    const fillD = `${lineD} L${W},${H} L0,${H} Z`;

    const isUp   = pctChange === null || pctChange >= 0;
    const isFlat = pctChange !== null && Math.abs(pctChange) < 0.1;
    const col    = isFlat ? '#8DA3BE' : isUp ? '#2563EB' : '#DC2626';

    svg.innerHTML = `
      <defs>
        <linearGradient id="pnsg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="${col}" stop-opacity="0.15"/>
          <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${fillD}" fill="url(#pnsg)"/>
      <path d="${lineD}" fill="none" stroke="${col}" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round"/>`;

    const sign   = (!isFlat && isUp && pctChange > 0) ? '+' : '';
    const pctStr = pctChange === null ? '—' : `${sign}${pctChange}%`;
    deltaEl.textContent = `${pctStr} vs last week`;
    deltaEl.className = `dept-spark-delta dept-spark-delta--${isFlat ? 'flat' : isUp ? 'up' : 'down'}`;
    deltaEl.style.opacity = '1';
  } catch (_) {}
}

async function loadWarehouseSparkline() {
  try {
    const res = await fetch('/api/palletmain/landing-sparkline').then(r => r.json());
    if (!res.success || !res.data) return;

    const { dailyValues, thisWeek, pctChange, overduePicksheets } = res.data;

    const svg     = document.getElementById('wh-spark-svg');
    const deltaEl = document.getElementById('wh-spark-delta');
    const valueEl = document.getElementById('wh-spark-value');
    const wrap    = document.getElementById('wh-spark');
    if (!svg || !deltaEl || !valueEl || !wrap) return;

    valueEl.textContent = `${thisWeek} pallet${thisWeek !== 1 ? 's' : ''} this week`;

    const W = 280, H = 28, padY = 3;
    const n   = dailyValues.length;
    const max = Math.max(...dailyValues, 1);

    const pts = dailyValues.map((v, i) => [
      n < 2 ? W / 2 : (i / (n - 1)) * W,
      H - padY - ((v / max) * (H - padY * 2)),
    ]);

    const lineD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
    const fillD = `${lineD} L${W},${H} L0,${H} Z`;

    const isFlat = pctChange !== null && Math.abs(pctChange) < 0.1;
    const isUp   = pctChange === null || pctChange >= 0;
    const col    = isFlat ? '#8DA3BE' : isUp ? '#7C3AED' : '#DC2626';

    svg.innerHTML = `
      <defs>
        <linearGradient id="whsg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="${col}" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${fillD}" fill="url(#whsg)"/>
      <path d="${lineD}" fill="none" stroke="${col}" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round"/>`;

    if (overduePicksheets > 0) {
      deltaEl.textContent = `⚠ ${overduePicksheets} overdue`;
      deltaEl.className   = 'dept-spark-delta dept-spark-delta--down';
    } else {
      const sign   = (!isFlat && isUp && pctChange > 0) ? '+' : '';
      const pctStr = pctChange === null ? '—' : `${sign}${pctChange}%`;
      deltaEl.textContent = `${pctStr} vs last week`;
      deltaEl.className   = `dept-spark-delta dept-spark-delta--${isFlat ? 'flat' : isUp ? 'up' : 'down'}`;
    }
    deltaEl.style.opacity = '1';

    wrap.style.display = '';
  } catch (_) {}
}

async function loadLogisticsSparkline() {
  try {
    const res = await fetch('/api/deliverymain/landing-sparkline').then(r => r.json());
    if (!res.success || !res.data) return;

    const { dailyValues, onTimeRate, pctChange } = res.data;

    const svg     = document.getElementById('log-spark-svg');
    const deltaEl = document.getElementById('log-spark-delta');
    const valueEl = document.getElementById('log-spark-value');
    const wrap    = document.getElementById('log-spark');
    if (!svg || !deltaEl || !valueEl || !wrap) return;

    if (onTimeRate === null || dailyValues.length < 2) {
      valueEl.textContent = 'No data yet';
      wrap.style.display = '';
      return;
    }

    valueEl.textContent = `${onTimeRate}% on time`;

    const W = 280, H = 28, padY = 3;
    const n = dailyValues.length;

    const pts = dailyValues.map((v, i) => [
      (i / (n - 1)) * W,
      H - padY - ((v / 100) * (H - padY * 2)),
    ]);

    const lineD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
    const fillD = `${lineD} L${W},${H} L0,${H} Z`;

    const isFlat = pctChange !== null && Math.abs(pctChange) < 1;
    const isUp   = pctChange === null || pctChange >= 0;
    const col    = isFlat ? '#8DA3BE' : isUp ? '#0891B2' : '#DC2626';

    svg.innerHTML = `
      <defs>
        <linearGradient id="logsg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="${col}" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${fillD}" fill="url(#logsg)"/>
      <path d="${lineD}" fill="none" stroke="${col}" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round"/>`;

    if (pctChange !== null && !isFlat) {
      const sign = isUp ? '+' : '';
      deltaEl.textContent = `${sign}${pctChange}pp vs last week`;
    } else {
      deltaEl.textContent = isFlat ? 'stable vs last week' : '';
    }
    deltaEl.className   = `dept-spark-delta dept-spark-delta--${isFlat ? 'flat' : isUp ? 'up' : 'down'}`;
    deltaEl.style.opacity = '1';

    wrap.style.display = '';
  } catch (_) {}
}


openBtn.addEventListener('click', () => {
  shell.classList.remove('hidden');
  input.focus();
});

closeBtn.addEventListener('click', () => {
  shell.classList.add('hidden');
  statusEl.textContent = '';
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  const question = input.value.trim();
  if (!question) return;

  appendMessage(question, 'user');
  input.value = '';
  statusEl.textContent = 'Waiting for Gemini...';
  sendBtn.disabled = true;

  try {
    const res = await fetch('/api/gemini/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.error || res.statusText || `HTTP ${res.status}`);
    }

    appendMessage(data.answer || 'No response returned.', 'assistant');
    statusEl.textContent = '';
  } catch (err) {
    appendMessage('Sorry, it appears I am currently unavailable. Please try again later.', 'assistant');
    statusEl.textContent = 'Request failed';
    console.log('Gemini API error:', err.message);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

function appendMessage(text, role) {
  const row = document.createElement('div');
  row.className = `gemini-row gemini-row--${role}`;

  const bubble = document.createElement('div');
  bubble.className = `gemini-bubble gemini-bubble--${role}`;
  bubble.textContent = text;

  row.appendChild(bubble);
  messages.appendChild(row);
  messages.scrollTop = messages.scrollHeight;
}


// Source - https://stackoverflow.com/a/5574446
// Posted by Tuan
// Retrieved 2026-05-08, License - CC BY-SA 2.5

String.prototype.toProperCase = function () {
    return this.replace(/\w\S*/g, function(txt){return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();});
};
