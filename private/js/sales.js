'use strict';

// ── Initialise ────────────────────────────────────────────────────────────────
(async () => {
  try {
    const session = await fetch('/session-check').then(r => r.json());
    if (!session.loggedIn) { window.location.href = '/'; return; }
    document.getElementById('session-user').textContent = session.username;
  } catch { window.location.href = '/'; }
})();

// ── Navigation ────────────────────────────────────────────────────────────────
document.querySelectorAll('.sap-tile[data-fn]').forEach(tile => {
  tile.addEventListener('click', () => openFunction(tile.dataset.fn));
});

document.getElementById('btn-back-tiles').addEventListener('click', backToTiles);

// ── Collapsible sections (same pattern as production-nexus.js) ────────────────
document.querySelectorAll('.pn-section-hdr').forEach(hdr => {
  const section = hdr.closest('.pn-section');
  const key = `sales-collapsed:${hdr.textContent.trim()}`;
  if (localStorage.getItem(key) === '1') section.classList.add('pn-section--collapsed');
  hdr.addEventListener('click', () => {
    section.classList.toggle('pn-section--collapsed');
    localStorage.setItem(key, section.classList.contains('pn-section--collapsed') ? '1' : '0');
  });
});

function backToTiles() {
  document.getElementById('result-section').classList.add('hidden');
  document.getElementById('tile-section').classList.remove('hidden');
  document.getElementById('result-row-badge').classList.add('hidden');
}

const TITLES = {
  productionSchedule: ['Production Schedule', 'Open PTFE order lines due in the next 5 working days — comments, ETA and OTIF KPI'],
};

const FNS = {
  productionSchedule: () => window.ProductionScheduleReport.mount(),
};

function openFunction(fn) {
  document.getElementById('tile-section').classList.add('hidden');
  document.getElementById('result-section').classList.remove('hidden');

  const [title, hint] = TITLES[fn] || [fn, ''];
  document.getElementById('result-title').textContent = title;
  document.getElementById('result-hint').textContent  = hint;

  if (FNS[fn]) FNS[fn]();
}
