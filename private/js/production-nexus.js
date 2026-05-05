'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let currentFn       = null;
let activeBatches   = [];
let selectedStation = null;
let selectedBatch   = null;
let liveTimer       = null;
let refreshTimer    = null;

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function api(path, opts) {
  return fetch('/api/productionnexus' + path, opts).then(r => r.json());
}

function fmt(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
}

function fmtTime(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
}

function runTimer(startedAt, el) {
  if (!el) return;
  if (liveTimer) clearInterval(liveTimer);
  if (!startedAt) { el.textContent = '—'; return; }
  const tick = () => {
    const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
    const h = String(Math.floor(secs / 3600)).padStart(2, '0');
    const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    el.textContent = `${h}:${m}:${s}`;
  };
  tick();
  liveTimer = setInterval(tick, 1000);
}

function statusBadge(statusId) {
  const map    = { 1:'open', 2:'in-progress', 3:'on-hold', 4:'complete', 5:'cancelled', 6:'cancelled' };
  const labels = { 1:'Open', 2:'Running', 3:'On Hold', 4:'Complete', 5:'Cancelled', 6:'SAP Failed' };
  const cls = map[statusId] || 'open';
  return `<span class="pn-status pn-status--${cls}">${esc(labels[statusId] || String(statusId))}</span>`;
}

function batchStatusBadge(statusId, isReversed) {
  if (isReversed) return `<span class="pn-status pn-status--on-hold">Reversed</span>`;
  return statusBadge(statusId);
}

function stateColor(s) {
  if (s === 2) return 'var(--accent)';
  if (s === 3) return '#D97706';
  return 'var(--text-muted)';
}

// ── Initialise ────────────────────────────────────────────────────────────────
(async () => {
  try {
    const session = await fetch('/session-check').then(r => r.json());
    if (!session.loggedIn) { window.location.href = '/'; return; }
    document.getElementById('session-user').textContent = session.username;
    applyRoleVisibility(session.role, session.permissions || []);
  } catch { window.location.href = '/'; }
})();

// ── Navigation ────────────────────────────────────────────────────────────────
document.querySelectorAll('.sap-tile[data-fn]').forEach(tile => {
  if (tile.classList.contains('sap-tile--placeholder')) return;
  tile.addEventListener('click', () => openFunction(tile.dataset.fn));
});

document.getElementById('btn-back-tiles').addEventListener('click', backToTiles);

// ── Role-based and permission-based tile visibility ───────────────────────────
const ROLE_LEVELS = { operator: 1, admin: 2, superadmin: 3 };
let _userRoleLevel   = 1;
let _userPermissions = [];

function applyRoleVisibility(role, permissions) {
  _userRoleLevel   = ROLE_LEVELS[role] || 1;
  _userPermissions = Array.isArray(permissions) ? permissions : [];

  // Role-gated elements
  document.querySelectorAll('[data-min-role]').forEach(el => {
    const required = ROLE_LEVELS[el.dataset.minRole] || 1;
    el.style.display = _userRoleLevel < required ? 'none' : '';
  });

  // Permission-gated elements (superadmin bypasses)
  document.querySelectorAll('[data-permission]').forEach(el => {
    const code = el.dataset.permission;
    const allowed = role === 'superadmin' || _userPermissions.includes(code);
    el.style.display = allowed ? '' : 'none';
  });
}

// ── Collapsible sections ──────────────────────────────────────────────────────
document.querySelectorAll('.pn-section-hdr').forEach(hdr => {
  const section = hdr.closest('.pn-section');
  const key = `pn-collapsed:${hdr.textContent.trim()}`;
  if (localStorage.getItem(key) === '1') section.classList.add('pn-section--collapsed');
  hdr.addEventListener('click', () => {
    section.classList.toggle('pn-section--collapsed');
    localStorage.setItem(key, section.classList.contains('pn-section--collapsed') ? '1' : '0');
  });
});

function openFunction(fn) {
  currentFn = fn;
  document.getElementById('tile-section').classList.add('hidden');
  document.getElementById('result-section').classList.remove('hidden');

  const titles = {
    mixingEntry:     ['Mixing Entry',      'Enter a completed mixing batch and post directly to SAP'],
    drummingEntry:   ['Drumming Entry',    'Step-by-step drum entry wizard with BOM validation'],
    extrusionEntry:  ['Extrusion Entry',   'Enter a completed extrusion run and post to SAP'],
    convolutingEntry:['Convoluting Entry', 'Enter a completed convoluting run and post to SAP'],
    braidingEntry:   ['Braiding Entry',    'Enter a completed braiding run and post to SAP'],
    coverlineEntry:  ['Coverline Entry',   'Enter a completed coverline run and post to SAP'],
    tapewrapEntry:   ['Tape Wrap Entry',   'Enter a completed tape wrap run and post to SAP'],
    mixingData:      ['Mixing Data',       'Filter and export mixing records for analysis'],
    drummingData:    ['Drumming Data',     'Filter and export drumming records for analysis'],
    extrusionData:   ['Extrusion Data',    'Filter and export extrusion records for analysis'],
    convolutingData: ['Convoluting Data',  'Filter and export convoluting records for analysis'],
    braidingData:    ['Braiding Data',     'Filter and export braiding records for analysis'],
    coverlineData:   ['Coverline Data',    'Filter and export coverline records for analysis'],
    tapewrapData:    ['Tape Wrap Data',    'Filter and export tape wrap records for analysis'],
    batchHistory:    ['Batch History',     'Search completed and cancelled batches by reference, material or date'],
    traceability:    ['Traceability',      'Trace a batch back through the full production chain'],
    approveScrap:    ['Approve Scrap',     'Supervisor approval queue — review and post operator scrap entries to SAP'],
    postedScrap:     ['Posted Scrap',      'Approved and SAP-posted scrap summary by work centre and reason'],
    failedBackflush: ['Failed Backflush',  'Records saved locally but rejected by SAP'],
    sapReversals:    ['SAP Reversals',     'Search by material document or batch ref — select and bulk-reverse postings'],
    reportOutput:    ['Production Output',  'Metres and KG produced by process, over time'],
    reportScrap:     ['Scrap Analysis',     'Scrap KG by reason, process and trend'],
    reportSapPerf:   ['SAP Performance',    'Backflush success rate, failures and 190 alerts'],
    reportBatches:   ['Batch Summary',      'Batch counts by status across all work centres'],
    reportShift:     ['Shift Performance',  'Output and scrap compared across Days, Afters and Nights'],
    reportOperator:  ['Operator Output',    'Production output ranked by primary operator'],
    reportMaterial:  ['Material Throughput','Output volume ranked by material code'],
  };
  const [title, hint] = titles[fn] || [fn, ''];
  document.getElementById('result-title').textContent = title;
  document.getElementById('result-hint').textContent  = hint;

  const body = document.getElementById('result-body');
  body.innerHTML = '<div class="pn-loading"><div class="spinner"></div>Loading…</div>';

  const fns = {
    mixingEntry:     runMixingEntry,
    drummingEntry:   runDrummingEntry,
    extrusionEntry:  runExtrusionEntry,
    convolutingEntry:runConvolutingEntry,
    braidingEntry:   runBraidingEntry,
    coverlineEntry:  runCoverlineEntry,
    tapewrapEntry:   runTapeWrapEntry,
    mixingData:      runMixingData,
    drummingData:    runDrummingData,
    extrusionData:   runExtrusionData,
    convolutingData: runConvolutingData,
    braidingData:    runBraidingData,
    coverlineData:   runCoverlineData,
    tapewrapData:    runTapeWrapData,
    batchHistory:    runBatchHistory,
    traceability:    runTraceability,
    approveScrap:    runApproveScrap,
    postedScrap:     runPostedScrap,
    failedBackflush: runFailedBackflush,
    sapReversals:    runSapReversals,
    reportOutput:    runReportOutput,
    reportScrap:     runReportScrap,
    reportSapPerf:   runReportSapPerf,
    reportBatches:   runReportBatches,
    reportShift:     runReportShift,
    reportOperator:  runReportOperator,
    reportMaterial:  runReportMaterial,
  };
  if (fns[fn]) fns[fn]();
}

function backToTiles() {
  if (liveTimer)    { clearInterval(liveTimer);   liveTimer    = null; }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  document.getElementById('result-section').classList.add('hidden');
  document.getElementById('tile-section').classList.remove('hidden');
  document.getElementById('result-row-badge').classList.add('hidden');
  currentFn = null;
}

// ── Modal helpers ────────────────────────────────────────────────────────────

function openModal(html) {
  const overlay = document.getElementById('ps-modal-overlay');
  overlay.innerHTML = html;
  overlay.classList.remove('hidden');
}
function closeModal() {
  const overlay = document.getElementById('ps-modal-overlay');
  overlay.classList.add('hidden');
  overlay.innerHTML = '';
}

// ── LINE FLOOR ────────────────────────────────────────────────────────────────

const PROCESS_LABELS = {
  MX:'Mixing', EX:'Extrusion', CO:'Convoluting', BR:'Braiding',
  CL:'Coverline', TW:'Tape Wrap', DR:'Drumming', EW:'Ewald', HA:'Hose Assembly',
  FW:'Firewall', PV:'Passenger Vehicle',
};

async function runLineFloor() {
  // Start auto-refresh if not already running
  if (!refreshTimer) {
    refreshTimer = setInterval(() => { if (currentFn === 'lineFloor') runLineFloor(); }, 30000);
  }
  try {
    const json = await api('/active');
    if (!json.success) throw new Error(json.error);
    activeBatches = json.data || [];

    if (!activeBatches.length) {
      document.getElementById('result-body').innerHTML = '<div class="pn-empty">No active batches at the moment.</div>';
      return;
    }

    // Group by process for station display
    const byProcess = {};
    activeBatches.forEach(b => {
      if (!byProcess[b.ProcessCode]) byProcess[b.ProcessCode] = [];
      byProcess[b.ProcessCode].push(b);
    });

    const processOrder = ['MX','EX','CO','BR','CL','TW','DR','EW','HA'];
    const activeProcesses = processOrder.filter(p => byProcess[p]);

    // Pick initial selected station
    if (!selectedStation) selectedStation = activeProcesses[0];

    renderLineFloor(byProcess, activeProcesses);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`;
  }
}

function renderLineFloor(byProcess, activeProcesses) {
  // KPI strip
  const total    = activeBatches.length;
  const running  = activeBatches.filter(b => b.Status === 2).length;
  const onHold   = activeBatches.filter(b => b.Status === 3).length;

  const kpis = `
    <div class="pf-kpis">
      <div class="pf-kpi">
        <div class="pf-kpi-label">Active batches</div>
        <div class="pf-kpi-val" style="color:var(--accent)">${total}</div>
      </div>
      <div class="pf-kpi">
        <div class="pf-kpi-label">Running</div>
        <div class="pf-kpi-val" style="color:#059669">${running}</div>
      </div>
      <div class="pf-kpi">
        <div class="pf-kpi-label">On hold</div>
        <div class="pf-kpi-val" style="color:#D97706">${onHold}</div>
      </div>
      <div class="pf-kpi">
        <div class="pf-kpi-label">Work centres</div>
        <div class="pf-kpi-val">${activeProcesses.length}</div>
      </div>
      <div class="pf-kpi">
        <div class="pf-kpi-label" id="pf-clock-label">Runtime</div>
        <div class="pf-kpi-val" style="font-family:'JetBrains Mono',monospace;color:var(--accent);font-size:20px" id="pf-clock">—</div>
      </div>
    </div>`;

  // Station flow
  const stationCards = activeProcesses.map(pc => {
    const batches = byProcess[pc];
    const b = batches[0]; // show the first/primary batch
    const isFocused = pc === selectedStation;
    const color = stateColor(b.Status);
    const pct   = b.StartedAt ? Math.min(99, Math.floor((Date.now() - new Date(b.StartedAt).getTime()) / 1000 / 60)) : 0;

    return `<div class="pf-station ${isFocused ? 'pf-station--on' : ''}" data-pc="${esc(pc)}">
      <div class="pf-station-top">
        <div style="display:flex;align-items:center;gap:7px">
          <span class="pf-dot" style="background:${color};box-shadow:${b.Status!==1?`0 0 7px ${color}`:'none'}"></span>
          <span class="pf-station-name">${esc(PROCESS_LABELS[pc] || pc)}</span>
        </div>
        <span class="pf-station-state" style="color:${color};background:${color.replace(')', ',0.1)').replace('var(','rgba(').replace(/[a-z-]+\)/, '0.1)')}">${b.Status===2?'RUNNING':b.Status===3?'ON HOLD':'OPEN'}</span>
      </div>
      <div class="pf-station-ref">${esc(b.BatchRef)}</div>
      <div class="pf-station-op">OPERATOR · ${esc(b.PrimaryOperator || '—')}</div>
      <div class="pf-station-bar"><div class="pf-station-bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <div class="pf-station-meta">
        <span>${batches.length} batch${batches.length>1?'es':''}</span>
        <span>${esc(b.Material)}</span>
      </div>
    </div>`;
  });

  const connectors = activeProcesses.slice(0, -1).map(() =>
    `<div class="pf-connector"><svg viewBox="0 0 60 12" preserveAspectRatio="none">
      <line x1="0" y1="6" x2="60" y2="6" stroke="var(--border2)" stroke-width="1.5" stroke-dasharray="3 3"/>
      <circle cx="30" cy="6" r="2.5" fill="var(--accent)" opacity="0.6"/>
    </svg></div>`
  );

  const flowTrack = [];
  stationCards.forEach((card, i) => { flowTrack.push(card); if (connectors[i]) flowTrack.push(connectors[i]); });

  const flow = `<div class="pf-flow">
    <div class="pf-flow-eyebrow">Batch flow · live</div>
    <div class="pf-flow-track">${flowTrack.join('')}</div>
  </div>`;

  // Lower: batch ticker + station detail
  const selectedBatches = byProcess[selectedStation] || [];
  const tickerRows = activeBatches.map(b => `
    <div class="pf-tr ${selectedBatch === b.RecordID + b.ProcessCode ? 'pf-tr--on' : ''}" data-pc="${esc(b.ProcessCode)}" data-rid="${esc(String(b.RecordID))}">
      <span class="pf-tr-ref">${esc(b.BatchRef)}</span>
      <span class="pf-tr-mono">${esc(b.Material)}</span>
      <span>${esc(String(b.Quantity ?? '—'))} ${esc(b.UOM)}</span>
      <span class="pf-tr-mono">${fmtTime(b.StartedAt)}</span>
      <span class="pf-tr-mono">${esc(b.MachineCode || '—')}</span>
      <span>${statusBadge(b.Status)}</span>
    </div>`).join('');

  const ticker = `<div class="pf-card">
    <div class="pf-card-hdr">
      <div>
        <div class="pf-card-eyebrow">Active &amp; queued batches</div>
        <div class="pf-card-title">Batch ticker</div>
      </div>
    </div>
    <div class="pf-table">
      <div class="pf-th"><span>Batch</span><span>Material</span><span>Qty</span><span>Started</span><span>Machine</span><span>Status</span></div>
      ${tickerRows}
    </div>
  </div>`;

  // Station detail panel
  const sb = selectedBatches[0];
  const detail = sb ? `<div class="pf-card">
    <div class="pf-card-hdr">
      <div>
        <div class="pf-card-eyebrow">Station detail</div>
        <div class="pf-card-title">${esc(PROCESS_LABELS[selectedStation] || selectedStation)} — ${esc(sb.BatchRef)}</div>
      </div>
      <span class="pn-status pn-status--in-progress">${esc(sb.ShiftName || '')}</span>
    </div>
    <div class="pf-detail-grid">
      <div><div class="pf-detail-label">Operator</div><div class="pf-detail-val">${esc(sb.PrimaryOperator || '—')}</div></div>
      <div><div class="pf-detail-label">Machine</div><div class="pf-detail-val">${esc(sb.MachineName || sb.MachineCode || '—')}</div></div>
      <div><div class="pf-detail-label">Material</div><div class="pf-detail-val">${esc(sb.Material)}</div></div>
      <div><div class="pf-detail-label">Quantity</div><div class="pf-detail-val">${esc(String(sb.Quantity ?? '—'))} ${esc(sb.UOM)}</div></div>
      <div><div class="pf-detail-label">Started</div><div class="pf-detail-val">${fmt(sb.StartedAt)}</div></div>
      <div><div class="pf-detail-label">Runtime</div><div class="pf-detail-val" id="pf-detail-clock">—</div></div>
    </div>
    <div class="pf-event-log">
      <div class="pf-event-log-hdr">Event log</div>
      <div id="pf-event-log-body"><div class="pn-loading"><div class="spinner"></div>Loading…</div></div>
    </div>
  </div>` : `<div class="pf-card"><div class="pn-empty">Select a station to view details.</div></div>`;

  const lower = `<div class="pf-lower">${ticker}${detail}</div>`;

  document.getElementById('result-body').innerHTML = kpis + flow + lower;

  // Wire station click
  document.querySelectorAll('.pf-station[data-pc]').forEach(el => {
    el.addEventListener('click', () => {
      selectedStation = el.dataset.pc;
      renderLineFloor(byProcess, activeProcesses);
    });
  });

  // Wire batch row click — single click selects station, double-click opens modal
  document.querySelectorAll('.pf-tr[data-pc]').forEach(el => {
    el.addEventListener('click', () => {
      selectedStation = el.dataset.pc;
      selectedBatch = el.dataset.rid + el.dataset.pc;
      renderLineFloor(byProcess, activeProcesses);
    });
    el.addEventListener('dblclick', () => openBatchModal(el.dataset.pc, Number(el.dataset.rid)));
  });

  // Live runtime clock
  if (sb?.StartedAt) {
    runTimer(sb.StartedAt, document.getElementById('pf-detail-clock'));
    const clockLbl = document.getElementById('pf-clock-label');
    const clockEl  = document.getElementById('pf-clock');
    if (clockLbl) clockLbl.textContent = `${sb.BatchRef} runtime`;
    if (clockEl && sb.StartedAt) {
      const tick = () => {
        const s = Math.floor((Date.now() - new Date(sb.StartedAt).getTime()) / 1000);
        const h = String(Math.floor(s/3600)).padStart(2,'0');
        const m = String(Math.floor((s%3600)/60)).padStart(2,'0');
        const sec = String(s%60).padStart(2,'0');
        clockEl.textContent = `${h}:${m}:${sec}`;
      };
      tick();
    }
  }

  // Load event log for selected station
  if (sb) loadEventLog(sb.ProcessCode, sb.RecordID, 'pf-event-log-body');
}

async function loadEventLog(processCode, recordId, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  try {
    const json = await api(`/batch/${processCode}/${recordId}/events`);
    const events = json.data || [];
    if (!events.length) { el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0">No events recorded yet.</div>'; return; }
    el.innerHTML = events.slice(0, 20).map(e => {
      const dot = e.Severity === 2 ? 'err' : e.Severity === 1 ? 'warn' : e.EventType === 'SAP_POST' ? 'info' : 'ok';
      return `<div class="pf-log-row">
        <span class="pf-log-time">${fmtTime(e.CreatedAt)}</span>
        <span class="pf-log-dot pf-log-dot--${dot}"></span>
        <span class="pf-log-text">${esc(e.EventMessage)}</span>
      </div>`;
    }).join('');
  } catch (_) { if (el) el.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">Could not load events.</div>'; }
}

// ── ACTIVE BATCHES ────────────────────────────────────────────────────────────

async function runActiveBatches() {
  try {
    const json = await api('/active');
    if (!json.success) throw new Error(json.error);
    const rows = json.data || [];

    const badge = document.getElementById('result-row-badge');
    badge.textContent = `${rows.length} active`;
    badge.classList.remove('hidden');

    if (!rows.length) {
      document.getElementById('result-body').innerHTML = '<div class="pn-empty">No active batches.</div>';
      return;
    }

    const tableRows = rows.map(b => `<tr class="pn-row" data-pc="${esc(b.ProcessCode)}" data-rid="${esc(String(b.RecordID))}">
      <td class="pn-batch-ref">${esc(b.BatchRef)}</td>
      <td>${esc(PROCESS_LABELS[b.ProcessCode] || b.ProcessCode)}</td>
      <td class="pn-batch-mono">${esc(b.Material)}</td>
      <td>${esc(String(b.Quantity ?? '—'))} <span class="pn-batch-mono">${esc(b.UOM)}</span></td>
      <td class="pn-batch-mono">${esc(b.PrimaryOperator || '—')}</td>
      <td class="pn-batch-mono">${esc(b.ShiftName || '—')}</td>
      <td>${fmt(b.StartedAt)}</td>
      <td>${statusBadge(b.Status)}</td>
    </tr>`).join('');

    document.getElementById('result-body').innerHTML = `
      <div style="padding:16px 20px;overflow:auto">
        <table class="pn-batch-table">
          <thead><tr>
            <th>Batch Ref</th><th>Process</th><th>Material</th><th>Quantity</th>
            <th>Operator</th><th>Shift</th><th>Started</th><th>Status</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>`;

    document.querySelectorAll('.pn-row[data-pc]').forEach(row => {
      row.addEventListener('click', () => openBatchModal(row.dataset.pc, Number(row.dataset.rid)));
    });
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`;
  }
}

// ── BATCH HISTORY ─────────────────────────────────────────────────────────────

async function runBatchHistory() {
  document.getElementById('result-body').innerHTML = `
    <div style="padding:16px 20px">
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <input id="hist-ref" class="tf-input" placeholder="Batch ref…" style="width:140px">
        <input id="hist-mat" class="tf-input" placeholder="Material…" style="width:160px">
        <input id="hist-from" class="tf-input" type="date" style="width:150px">
        <input id="hist-to"   class="tf-input" type="date" style="width:150px">
        <button class="btn-filter-search" id="hist-search-btn">Search</button>
      </div>
      <div id="hist-results"><div class="pn-empty">Enter search criteria and click Search.</div></div>
    </div>`;

  document.getElementById('hist-search-btn').addEventListener('click', async () => {
    const ref  = document.getElementById('hist-ref').value.trim();
    const mat  = document.getElementById('hist-mat').value.trim();
    const from = document.getElementById('hist-from').value;
    const to   = document.getElementById('hist-to').value;
    const params = new URLSearchParams();
    if (ref)  params.set('ref', ref);
    if (mat)  params.set('material', mat);
    if (from) params.set('fromDate', from);
    if (to)   params.set('toDate', to);

    const el = document.getElementById('hist-results');
    el.innerHTML = '<div class="pn-loading"><div class="spinner"></div>Searching…</div>';
    try {
      const json = await api(`/history?${params}`);
      const rows = json.data || [];
      if (!rows.length) { el.innerHTML = '<div class="pn-empty">No results found.</div>'; return; }
      el.innerHTML = `<table class="pn-batch-table">
        <thead><tr><th>Ref</th><th>Process</th><th>Material</th><th>Qty</th><th>Status</th><th>Created</th><th>Completed</th></tr></thead>
        <tbody>${rows.map(b => `<tr>
          <td class="pn-batch-ref">${esc(b.BatchRef)}</td>
          <td>${esc(PROCESS_LABELS[b.ProcessCode] || b.ProcessCode)}</td>
          <td class="pn-batch-mono">${esc(b.Material)}</td>
          <td>${esc(String(b.Quantity??'—'))} <span class="pn-batch-mono">${esc(b.UOM)}</span></td>
          <td>${statusBadge(b.Status)}</td>
          <td class="pn-batch-mono">${fmt(b.CreatedAt)}</td>
          <td class="pn-batch-mono">${fmt(b.CompletedAt)}</td>
        </tr>`).join('')}</tbody>
      </table>`;
    } catch (err) { el.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`; }
  });
}

// ── TRACEABILITY ──────────────────────────────────────────────────────────────

async function runTraceability() {
  document.getElementById('result-body').innerHTML = `
    <div style="padding:16px 20px">
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <input id="trace-ref" class="tf-input" placeholder="Batch ref e.g. EX00000031" style="width:240px">
        <select id="trace-pc" class="tf-input" style="width:160px">
          <option value="">All processes</option>
          ${Object.entries(PROCESS_LABELS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}
        </select>
        <button class="btn-filter-search" id="trace-btn">Trace</button>
      </div>
      <div id="trace-results"><div class="pn-empty">Enter a batch reference to trace its full production history.</div></div>
    </div>`;

  document.getElementById('trace-btn').addEventListener('click', async () => {
    const ref = document.getElementById('trace-ref').value.trim();
    const pc  = document.getElementById('trace-pc').value;
    if (!ref && !pc) return;
    const el = document.getElementById('trace-results');
    el.innerHTML = '<div class="pn-loading"><div class="spinner"></div>Tracing…</div>';
    try {
      // Find the record by ref: search active + history
      const hist = await api(`/history?ref=${encodeURIComponent(ref)}${pc?'&processCode='+pc:''}`);
      const batch = (hist.data || [])[0];
      if (!batch) { el.innerHTML = '<div class="pn-empty">Batch not found.</div>'; return; }

      const traceJson = await api(`/trace/${batch.ProcessCode}/${batch.RecordID}`);
      const chain = traceJson.data || [];

      if (!chain.length) {
        el.innerHTML = `<div class="pn-empty"><strong>${esc(batch.BatchRef)}</strong> — no trace links recorded for this batch.</div>`;
        return;
      }

      el.innerHTML = `<div style="font-size:13px;margin-bottom:12px">
        Showing ${chain.length} trace link(s) for <strong>${esc(batch.BatchRef)}</strong></div>
        <table class="pn-batch-table">
          <thead><tr><th>Depth</th><th>Child Batch</th><th>Parent Batch</th></tr></thead>
          <tbody>${chain.map(t => `<tr>
            <td class="pn-batch-mono">${t.Depth}</td>
            <td class="pn-batch-ref">${esc(t.ChildProcessCode)}${String(t.ChildRecordID).padStart(8,'0')}</td>
            <td class="pn-batch-ref">${esc(t.ParentProcessCode)}${String(t.ParentRecordID).padStart(8,'0')}</td>
          </tr>`).join('')}</tbody>
        </table>`;
    } catch (err) { el.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`; }
  });
}

// ── REPORTS — shared helpers ──────────────────────────────────────────────────

const _charts = {};
function mkChart(id, cfg) {
  if (_charts[id]) { try { _charts[id].destroy(); } catch(_) {} delete _charts[id]; }
  const el = document.getElementById(id);
  if (!el) return;
  _charts[id] = new Chart(el, cfg);
}

const RPT_PALETTE = ['#0D9488','#14B8A6','#2563EB','#7C3AED','#DB2777','#D97706','#059669','#0891B2','#DC2626','#6B7280'];
const RPT_SUCCESS = '#059669'; const RPT_WARN = '#D97706'; const RPT_ERR = '#DC2626'; const RPT_MUT = '#6B7280';

const PROC_LABELS_SHORT = { MX:'Mixing',EX:'Extrusion',CO:'Convoluting',BR:'Braiding',CL:'Coverline',TW:'Tape Wrap',DR:'Drumming',EW:'Ewald',HA:'Hose Assembly' };

function rptFiltersHtml(defaults = {}) {
  const today = new Date().toISOString().slice(0,10);
  const ago30 = new Date(Date.now()-30*86400000).toISOString().slice(0,10);
  return `
    <div class="rpt-filters">
      <div class="tf-field"><label class="tf-label">From</label>
        <input class="tf-input" id="rpt-from" type="date" value="${defaults.from||ago30}" style="width:140px"></div>
      <div class="tf-field"><label class="tf-label">To</label>
        <input class="tf-input" id="rpt-to" type="date" value="${defaults.to||today}" style="width:140px"></div>
      <div class="tf-field"><label class="tf-label">Process</label>
        <select class="tf-input" id="rpt-pc" style="width:150px">
          <option value="">All processes</option>
          ${Object.entries(PROC_LABELS_SHORT).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}
        </select></div>
      <div class="tf-field"><label class="tf-label">Group by</label>
        <div class="rpt-groupby" id="rpt-groupby">
          <button data-g="day"   class="${(defaults.groupBy||'day')==='day'  ?'active':''}">Day</button>
          <button data-g="week"  class="${(defaults.groupBy||'day')==='week' ?'active':''}">Week</button>
          <button data-g="month" class="${(defaults.groupBy||'day')==='month'?'active':''}">Month</button>
        </div></div>
      <button class="btn-filter-search" id="rpt-search">Run Report</button>
    </div>
    <div id="rpt-output"><div class="pn-empty">Click Run Report to load data.</div></div>`;
}

function rptWireFilters(onRun) {
  let groupBy = document.querySelector('#rpt-groupby .active')?.dataset.g || 'day';
  document.querySelectorAll('#rpt-groupby button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#rpt-groupby button').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); groupBy = b.dataset.g;
    });
  });
  const collectFilters = () => ({
    from: document.getElementById('rpt-from')?.value,
    to:   document.getElementById('rpt-to')?.value,
    pc:   document.getElementById('rpt-pc')?.value,
    groupBy,
  });
  document.getElementById('rpt-search')?.addEventListener('click', () => onRun(collectFilters()));
  return collectFilters;
}

function rptParams(f) {
  const p = new URLSearchParams();
  if (f.from)    p.set('dateFrom', f.from);
  if (f.to)      p.set('dateTo',   f.to);
  if (f.pc)      p.set('processCode', f.pc);
  if (f.groupBy) p.set('groupBy',  f.groupBy);
  return p.toString();
}

function kpiCard(label, value, sub = '') {
  return `<div class="rpt-kpi">
    <div class="rpt-kpi-label">${label}</div>
    <div class="rpt-kpi-val">${value}</div>
    ${sub ? `<div class="rpt-kpi-sub">${sub}</div>` : ''}
  </div>`;
}

function rptTable(headers, rows, filename) {
  if (!rows.length) return `<div class="pn-empty">No data for the selected filters.</div>`;
  return `
    <div style="display:flex;justify-content:flex-end;margin-bottom:6px">
      <button class="btn-secondary rpt-export-btn" data-file="${filename}">Export CSV</button>
    </div>
    <div style="overflow-x:auto">
    <table class="pn-batch-table">
      <thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table></div>`;
}

function wireExport(rows, keys, filename) {
  document.querySelectorAll('.rpt-export-btn').forEach(btn => {
    btn.addEventListener('click', () => downloadCsv(rows.map(r => {
      const o = {}; keys.forEach(k => { o[k] = r[k]; }); return o;
    }), btn.dataset.file || filename));
  });
}

// ── Report 1 — Production Output ─────────────────────────────────────────────

async function runReportOutput() {
  document.getElementById('result-body').innerHTML = `<div style="padding:16px 20px">${rptFiltersHtml()}</div>`;
  const collect = rptWireFilters(doRun);
  async function doRun(f) {
    const el = document.getElementById('rpt-output');
    el.innerHTML = '<div class="pn-loading"><div class="spinner"></div>Loading…</div>';
    try {
      const json = await api(`/reports/output?${rptParams(f)}`);
      if (!json.success) throw new Error(json.error);
      const { summary, timeSeries } = json.data;

      const totalM  = summary.filter(r=>r.UOM==='M').reduce((s,r)=>s+Number(r.TotalOutput),0);
      const totalKG = summary.filter(r=>r.UOM==='KG').reduce((s,r)=>s+Number(r.TotalOutput),0);
      const totalB  = summary.reduce((s,r)=>s+r.BatchCount,0);

      const periods  = [...new Set(timeSeries.map(r=>r.Period))].sort();
      const procs    = [...new Set(timeSeries.map(r=>r.ProcessCode))];

      el.innerHTML = `
        <div class="rpt-kpi-row">
          ${kpiCard('Total Metres Produced', totalM.toFixed(1)+' M', `${summary.filter(r=>r.UOM==='M').length} processes`)}
          ${kpiCard('Total KG Mixed', totalKG.toFixed(1)+' KG', 'Mixing only')}
          ${kpiCard('Completed Batches', totalB, 'All processes')}
        </div>
        <div class="rpt-charts">
          <div class="rpt-chart-card">
            <div class="rpt-chart-eyebrow">Output by Process</div>
            <div class="rpt-chart-wrap"><canvas id="ch-out-proc"></canvas></div>
          </div>
          <div class="rpt-chart-card rpt-chart-card--wide">
            <div class="rpt-chart-eyebrow">Output over Time (Metres)</div>
            <div class="rpt-chart-wrap rpt-chart-wrap--tall"><canvas id="ch-out-ts"></canvas></div>
          </div>
        </div>
        ${rptTable(
          ['Process','UOM','Batches','Total Output','Avg per Batch'],
          summary.map(r=>`<tr>
            <td>${esc(PROC_LABELS_SHORT[r.ProcessCode]||r.ProcessCode)}</td>
            <td class="pn-batch-mono">${esc(r.UOM)}</td>
            <td class="pn-batch-mono">${r.BatchCount}</td>
            <td class="pn-batch-mono">${Number(r.TotalOutput).toFixed(3)}</td>
            <td class="pn-batch-mono">${Number(r.AvgPerBatch).toFixed(3)}</td>
          </tr>`),
          'production-output.csv'
        )}`;

      mkChart('ch-out-proc', { type:'bar', data:{
        labels: summary.map(r=>`${PROC_LABELS_SHORT[r.ProcessCode]||r.ProcessCode} (${r.UOM})`),
        datasets:[{ label:'Total Output', data: summary.map(r=>Number(r.TotalOutput)),
          backgroundColor: RPT_PALETTE.slice(0, summary.length), borderRadius:4 }],
      }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}} }});

      const mProcs = procs.filter(p => timeSeries.find(r=>r.ProcessCode===p&&r.UOM==='M'));
      mkChart('ch-out-ts', { type:'line', data:{
        labels: periods,
        datasets: mProcs.map((p,i)=>({
          label: PROC_LABELS_SHORT[p]||p,
          data: periods.map(per => { const r=timeSeries.find(x=>x.ProcessCode===p&&x.Period===per); return r?Number(r.TotalOutput):null; }),
          borderColor: RPT_PALETTE[i%RPT_PALETTE.length],
          backgroundColor: 'transparent', tension:0.3, spanGaps:true,
        })),
      }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'bottom'}} }});

      wireExport(summary, ['ProcessCode','UOM','BatchCount','TotalOutput','AvgPerBatch'], 'production-output.csv');
    } catch(err) { el.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`; }
  }
}

// ── Report 2 — Scrap Analysis ─────────────────────────────────────────────────

async function runReportScrap() {
  document.getElementById('result-body').innerHTML = `<div style="padding:16px 20px">${rptFiltersHtml()}</div>`;
  rptWireFilters(doRun);
  async function doRun(f) {
    const el = document.getElementById('rpt-output');
    el.innerHTML = '<div class="pn-loading"><div class="spinner"></div>Loading…</div>';
    try {
      const json = await api(`/reports/scrap?${rptParams(f)}`);
      if (!json.success) throw new Error(json.error);
      const { totals, byReason, byProcess, timeSeries } = json.data;

      el.innerHTML = `
        <div class="rpt-kpi-row">
          ${kpiCard('Total Scrap (KG)', Number(totals.TotalKG).toFixed(1)+' KG')}
          ${kpiCard('Scrap Entries', totals.EntryCount)}
          ${kpiCard('Top Reason', esc(totals.TopReason||'—'))}
        </div>
        <div class="rpt-charts">
          <div class="rpt-chart-card">
            <div class="rpt-chart-eyebrow">Scrap by Reason (KG)</div>
            <div class="rpt-chart-wrap"><canvas id="ch-scr-reason"></canvas></div>
          </div>
          <div class="rpt-chart-card">
            <div class="rpt-chart-eyebrow">Scrap by Process (KG)</div>
            <div class="rpt-chart-wrap"><canvas id="ch-scr-proc"></canvas></div>
          </div>
          <div class="rpt-chart-card rpt-chart-card--wide">
            <div class="rpt-chart-eyebrow">Scrap Trend (KG)</div>
            <div class="rpt-chart-wrap"><canvas id="ch-scr-ts"></canvas></div>
          </div>
        </div>
        ${rptTable(
          ['Reason','Process','KG','Entries'],
          byReason.map(r=>`<tr>
            <td>${esc(r.ReasonDescription)}</td>
            <td>${esc(PROC_LABELS_SHORT[r.ProcessCode]||r.ProcessCode||'All')}</td>
            <td class="pn-batch-mono" style="color:var(--error)">${Number(r.TotalKG).toFixed(3)}</td>
            <td class="pn-batch-mono">${r.EntryCount}</td>
          </tr>`),
          'scrap-analysis.csv'
        )}`;

      mkChart('ch-scr-reason', { type:'doughnut', data:{
        labels: byReason.map(r=>r.ReasonDescription),
        datasets:[{ data: byReason.map(r=>Number(r.TotalKG)),
          backgroundColor: RPT_PALETTE.slice(0,byReason.length) }],
      }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'right'}} }});

      mkChart('ch-scr-proc', { type:'bar', data:{
        labels: byProcess.map(r=>PROC_LABELS_SHORT[r.ProcessCode]||r.ProcessCode),
        datasets:[{ label:'Scrap (KG)', data: byProcess.map(r=>Number(r.TotalKG)),
          backgroundColor: RPT_ERR+'cc', borderRadius:4 }],
      }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}} }});

      mkChart('ch-scr-ts', { type:'bar', data:{
        labels: timeSeries.map(r=>r.Period),
        datasets:[{ label:'Scrap (KG)', data: timeSeries.map(r=>Number(r.TotalKG)),
          backgroundColor: RPT_WARN+'99', borderRadius:3 }],
      }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}} }});

      wireExport(byReason, ['ReasonCode','ReasonDescription','ProcessCode','TotalKG','EntryCount'], 'scrap-analysis.csv');
    } catch(err) { el.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`; }
  }
}

// ── Report 3 — SAP Performance ────────────────────────────────────────────────

async function runReportSapPerf() {
  document.getElementById('result-body').innerHTML = `<div style="padding:16px 20px">${rptFiltersHtml()}</div>`;
  rptWireFilters(doRun);
  async function doRun(f) {
    const el = document.getElementById('rpt-output');
    el.innerHTML = '<div class="pn-loading"><div class="spinner"></div>Loading…</div>';
    try {
      const json = await api(`/reports/sap-performance?${rptParams(f)}`);
      if (!json.success) throw new Error(json.error);
      const { byProcess, timeSeries, alerts } = json.data;

      const total   = byProcess.reduce((s,r)=>s+r.Total,0);
      const success = byProcess.reduce((s,r)=>s+r.Success,0);
      const failed  = byProcess.reduce((s,r)=>s+r.Failed,0);
      const rev     = byProcess.reduce((s,r)=>s+r.Reversed,0);
      const alertCt = alerts.reduce((s,r)=>s+r.AlertCount,0);
      const rate    = total > 0 ? ((success/total)*100).toFixed(1) : '—';

      el.innerHTML = `
        <div class="rpt-kpi-row">
          ${kpiCard('Total Backflushes', total)}
          ${kpiCard('Success Rate', rate+'%', `${success} posted`)}
          ${kpiCard('Failed', failed, 'Status 6 records')}
          ${kpiCard('Reversed', rev)}
          ${kpiCard('190 Alerts', alertCt, 'No component consumption')}
        </div>
        <div class="rpt-charts">
          <div class="rpt-chart-card">
            <div class="rpt-chart-eyebrow">Overall Status Split</div>
            <div class="rpt-chart-wrap"><canvas id="ch-sap-donut"></canvas></div>
          </div>
          <div class="rpt-chart-card">
            <div class="rpt-chart-eyebrow">Success vs Failed by Process</div>
            <div class="rpt-chart-wrap"><canvas id="ch-sap-proc"></canvas></div>
          </div>
          <div class="rpt-chart-card rpt-chart-card--wide">
            <div class="rpt-chart-eyebrow">Success vs Failed over Time</div>
            <div class="rpt-chart-wrap"><canvas id="ch-sap-ts"></canvas></div>
          </div>
        </div>
        ${rptTable(
          ['Process','Total','Success','Failed','Reversed','Success %'],
          byProcess.map(r=>`<tr>
            <td>${esc(PROC_LABELS_SHORT[r.ProcessCode]||r.ProcessCode)}</td>
            <td class="pn-batch-mono">${r.Total}</td>
            <td class="pn-batch-mono" style="color:var(--accent)">${r.Success}</td>
            <td class="pn-batch-mono" style="color:var(--error)">${r.Failed}</td>
            <td class="pn-batch-mono">${r.Reversed}</td>
            <td class="pn-batch-mono">${r.Total>0?((r.Success/r.Total)*100).toFixed(1)+'%':'—'}</td>
          </tr>`),
          'sap-performance.csv'
        )}`;

      mkChart('ch-sap-donut', { type:'doughnut', data:{
        labels:['Success','Failed','Reversed'],
        datasets:[{ data:[success,failed,rev],
          backgroundColor:[RPT_SUCCESS,RPT_ERR,RPT_MUT] }],
      }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'right'}} }});

      mkChart('ch-sap-proc', { type:'bar', data:{
        labels: byProcess.map(r=>PROC_LABELS_SHORT[r.ProcessCode]||r.ProcessCode),
        datasets:[
          { label:'Success', data: byProcess.map(r=>r.Success), backgroundColor: RPT_SUCCESS+'cc', borderRadius:3 },
          { label:'Failed',  data: byProcess.map(r=>r.Failed),  backgroundColor: RPT_ERR+'cc',     borderRadius:3 },
        ],
      }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'bottom'}}, scales:{x:{stacked:false}} }});

      mkChart('ch-sap-ts', { type:'line', data:{
        labels: timeSeries.map(r=>r.Period),
        datasets:[
          { label:'Success', data: timeSeries.map(r=>r.Success), borderColor:RPT_SUCCESS, backgroundColor:'transparent', tension:0.3 },
          { label:'Failed',  data: timeSeries.map(r=>r.Failed),  borderColor:RPT_ERR,     backgroundColor:'transparent', tension:0.3 },
        ],
      }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'bottom'}} }});

      wireExport(byProcess, ['ProcessCode','Total','Success','Failed','Reversed'], 'sap-performance.csv');
    } catch(err) { el.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`; }
  }
}

// ── Report 4 — Batch Summary ──────────────────────────────────────────────────

async function runReportBatches() {
  document.getElementById('result-body').innerHTML = `<div style="padding:16px 20px">${rptFiltersHtml()}</div>`;
  rptWireFilters(doRun);
  async function doRun(f) {
    const el = document.getElementById('rpt-output');
    el.innerHTML = '<div class="pn-loading"><div class="spinner"></div>Loading…</div>';
    try {
      const json = await api(`/reports/batches?${rptParams(f)}`);
      if (!json.success) throw new Error(json.error);
      const rows = json.data;

      // Pivot: one row per process
      const byProc = {};
      rows.forEach(r => { byProc[r.ProcessCode] = byProc[r.ProcessCode] || { Complete:0,SAPFailed:0,Cancelled:0,Reversed:0,Total:0 }; Object.assign(byProc[r.ProcessCode], r); });
      const procs = Object.keys(byProc).sort();

      const totComplete  = rows.reduce((s,r)=>s+(r.Complete||0),0);
      const totFailed    = rows.reduce((s,r)=>s+(r.SAPFailed||0),0);
      const totReversed  = rows.reduce((s,r)=>s+(r.Reversed||0),0);

      el.innerHTML = `
        <div class="rpt-kpi-row">
          ${kpiCard('Completed', totComplete)}
          ${kpiCard('SAP Failed', totFailed, 'Pending retry')}
          ${kpiCard('Reversed', totReversed)}
        </div>
        <div class="rpt-charts">
          <div class="rpt-chart-card rpt-chart-card--wide">
            <div class="rpt-chart-eyebrow">Batches by Status per Process</div>
            <div class="rpt-chart-wrap rpt-chart-wrap--tall"><canvas id="ch-bat-stacked"></canvas></div>
          </div>
        </div>
        ${rptTable(
          ['Process','Complete','SAP Failed','Cancelled','Reversed','Total'],
          procs.map(p=>`<tr>
            <td>${esc(PROC_LABELS_SHORT[p]||p)}</td>
            <td class="pn-batch-mono" style="color:var(--accent)">${byProc[p].Complete||0}</td>
            <td class="pn-batch-mono" style="color:var(--error)">${byProc[p].SAPFailed||0}</td>
            <td class="pn-batch-mono">${byProc[p].Cancelled||0}</td>
            <td class="pn-batch-mono">${byProc[p].Reversed||0}</td>
            <td class="pn-batch-mono" style="font-weight:700">${byProc[p].Total||0}</td>
          </tr>`),
          'batch-summary.csv'
        )}`;

      mkChart('ch-bat-stacked', { type:'bar', data:{
        labels: procs.map(p=>PROC_LABELS_SHORT[p]||p),
        datasets:[
          { label:'Complete',   data: procs.map(p=>byProc[p].Complete||0),  backgroundColor:RPT_SUCCESS+'cc', borderRadius:3 },
          { label:'SAP Failed', data: procs.map(p=>byProc[p].SAPFailed||0), backgroundColor:RPT_ERR+'cc',     borderRadius:3 },
          { label:'Reversed',   data: procs.map(p=>byProc[p].Reversed||0),  backgroundColor:RPT_MUT+'99',     borderRadius:3 },
          { label:'Cancelled',  data: procs.map(p=>byProc[p].Cancelled||0), backgroundColor:RPT_WARN+'99',    borderRadius:3 },
        ],
      }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'bottom'}}, scales:{ x:{stacked:false} } }});

      wireExport(procs.map(p=>({ProcessCode:p,...byProc[p]})), ['ProcessCode','Complete','SAPFailed','Cancelled','Reversed','Total'], 'batch-summary.csv');
    } catch(err) { el.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`; }
  }
}

// ── Report 5 — Shift Performance ─────────────────────────────────────────────

async function runReportShift() {
  document.getElementById('result-body').innerHTML = `<div style="padding:16px 20px">${rptFiltersHtml()}</div>`;
  rptWireFilters(doRun);
  async function doRun(f) {
    const el = document.getElementById('rpt-output');
    el.innerHTML = '<div class="pn-loading"><div class="spinner"></div>Loading…</div>';
    try {
      const json = await api(`/reports/shift-comparison?${rptParams(f)}`);
      if (!json.success) throw new Error(json.error);
      const { output, scrapByProcess } = json.data;

      const shifts = [...new Set(output.map(r=>r.ShiftName))].sort();
      const procs  = [...new Set(output.map(r=>r.ProcessCode))].sort();
      const mRows  = output.filter(r=>r.UOM==='M');

      const shiftTotals = {};
      shifts.forEach(s => {
        shiftTotals[s] = { M: mRows.filter(r=>r.ShiftName===s).reduce((a,r)=>a+Number(r.TotalOutput),0), B: output.filter(r=>r.ShiftName===s).reduce((a,r)=>a+r.BatchCount,0) };
      });

      el.innerHTML = `
        <div class="rpt-kpi-row">
          ${shifts.map(s=>`${kpiCard(s, shiftTotals[s].M.toFixed(1)+' M', shiftTotals[s].B+' batches')}`).join('')}
        </div>
        <div class="rpt-charts">
          <div class="rpt-chart-card rpt-chart-card--wide">
            <div class="rpt-chart-eyebrow">Output (Metres) by Shift &amp; Process</div>
            <div class="rpt-chart-wrap rpt-chart-wrap--tall"><canvas id="ch-shf-out"></canvas></div>
          </div>
        </div>
        ${rptTable(
          ['Shift','Process','UOM','Batches','Total Output'],
          output.map(r=>`<tr>
            <td>${esc(r.ShiftName)}</td>
            <td>${esc(PROC_LABELS_SHORT[r.ProcessCode]||r.ProcessCode)}</td>
            <td class="pn-batch-mono">${esc(r.UOM)}</td>
            <td class="pn-batch-mono">${r.BatchCount}</td>
            <td class="pn-batch-mono">${Number(r.TotalOutput).toFixed(3)}</td>
          </tr>`),
          'shift-performance.csv'
        )}`;

      mkChart('ch-shf-out', { type:'bar', data:{
        labels: procs.map(p=>PROC_LABELS_SHORT[p]||p),
        datasets: shifts.map((s,i)=>({
          label: s,
          data: procs.map(p=>{ const r=mRows.find(x=>x.ShiftName===s&&x.ProcessCode===p); return r?Number(r.TotalOutput):0; }),
          backgroundColor: RPT_PALETTE[i%RPT_PALETTE.length]+'cc', borderRadius:3,
        })),
      }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'bottom'}}, scales:{x:{stacked:false}} }});

      wireExport(output, ['ShiftName','ProcessCode','UOM','BatchCount','TotalOutput'], 'shift-performance.csv');
    } catch(err) { el.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`; }
  }
}

// ── Report 6 — Operator Output ────────────────────────────────────────────────

async function runReportOperator() {
  document.getElementById('result-body').innerHTML = `<div style="padding:16px 20px">${rptFiltersHtml()}</div>`;
  rptWireFilters(doRun);
  async function doRun(f) {
    const el = document.getElementById('rpt-output');
    el.innerHTML = '<div class="pn-loading"><div class="spinner"></div>Loading…</div>';
    try {
      const json = await api(`/reports/operator-output?${rptParams(f)}`);
      if (!json.success) throw new Error(json.error);
      const rows = json.data;

      // Roll up to total per operator
      const byOp = {};
      rows.forEach(r => {
        if (!byOp[r.Username]) byOp[r.Username] = { totalM:0, totalKG:0, batches:0 };
        if (r.UOM==='M')  byOp[r.Username].totalM  += Number(r.TotalOutput);
        if (r.UOM==='KG') byOp[r.Username].totalKG += Number(r.TotalOutput);
        byOp[r.Username].batches += r.BatchCount;
      });
      const ranked = Object.entries(byOp).sort((a,b)=>(b[1].totalM+b[1].totalKG)-(a[1].totalM+a[1].totalKG)).slice(0,15);

      el.innerHTML = `
        <div class="rpt-kpi-row">
          ${kpiCard('Operators Active', Object.keys(byOp).length)}
          ${kpiCard('Top Operator', esc(ranked[0]?.[0]||'—'), ranked[0]?ranked[0][1].totalM.toFixed(1)+' M':'')}
        </div>
        <div class="rpt-charts">
          <div class="rpt-chart-card rpt-chart-card--wide">
            <div class="rpt-chart-eyebrow">Top Operators by Output (Metres)</div>
            <div class="rpt-chart-wrap rpt-chart-wrap--tall"><canvas id="ch-op-rank"></canvas></div>
          </div>
        </div>
        ${rptTable(
          ['Operator','Process','UOM','Batches','Total Output'],
          rows.map(r=>`<tr>
            <td>${esc(r.Username)}</td>
            <td>${esc(PROC_LABELS_SHORT[r.ProcessCode]||r.ProcessCode)}</td>
            <td class="pn-batch-mono">${esc(r.UOM)}</td>
            <td class="pn-batch-mono">${r.BatchCount}</td>
            <td class="pn-batch-mono">${Number(r.TotalOutput).toFixed(3)}</td>
          </tr>`),
          'operator-output.csv'
        )}`;

      mkChart('ch-op-rank', { type:'bar', data:{
        labels: ranked.map(([n])=>n),
        datasets:[{ label:'Metres', data: ranked.map(([,v])=>v.totalM), backgroundColor:RPT_PALETTE[0]+'cc', borderRadius:4 }],
      }, options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}} }});

      wireExport(rows, ['Username','ProcessCode','UOM','BatchCount','TotalOutput'], 'operator-output.csv');
    } catch(err) { el.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`; }
  }
}

// ── Report 7 — Material Throughput ───────────────────────────────────────────

async function runReportMaterial() {
  document.getElementById('result-body').innerHTML = `<div style="padding:16px 20px">${rptFiltersHtml()}</div>`;
  rptWireFilters(doRun);
  async function doRun(f) {
    const el = document.getElementById('rpt-output');
    el.innerHTML = '<div class="pn-loading"><div class="spinner"></div>Loading…</div>';
    try {
      const json = await api(`/reports/material-output?${rptParams(f)}`);
      if (!json.success) throw new Error(json.error);
      const rows = json.data;

      const top15 = rows.filter(r=>r.UOM==='M').slice(0,15);
      const uniq  = [...new Set(rows.map(r=>r.Material))].length;

      el.innerHTML = `
        <div class="rpt-kpi-row">
          ${kpiCard('Unique Materials', uniq)}
          ${kpiCard('Top Material', esc(top15[0]?.Material||'—'), top15[0]?Number(top15[0].TotalOutput).toFixed(1)+' M':'')}
          ${kpiCard('Total Batches', rows.reduce((s,r)=>s+r.BatchCount,0))}
        </div>
        <div class="rpt-charts">
          <div class="rpt-chart-card rpt-chart-card--wide">
            <div class="rpt-chart-eyebrow">Top 15 Materials by Output (Metres)</div>
            <div class="rpt-chart-wrap rpt-chart-wrap--tall"><canvas id="ch-mat-rank"></canvas></div>
          </div>
        </div>
        ${rptTable(
          ['Material','Process','UOM','Batches','Total Output','Avg per Batch'],
          rows.map(r=>`<tr>
            <td class="pn-batch-mono">${esc(r.Material)}</td>
            <td>${esc(PROC_LABELS_SHORT[r.ProcessCode]||r.ProcessCode)}</td>
            <td class="pn-batch-mono">${esc(r.UOM)}</td>
            <td class="pn-batch-mono">${r.BatchCount}</td>
            <td class="pn-batch-mono">${Number(r.TotalOutput).toFixed(3)}</td>
            <td class="pn-batch-mono">${Number(r.AvgPerBatch).toFixed(3)}</td>
          </tr>`),
          'material-throughput.csv'
        )}`;

      mkChart('ch-mat-rank', { type:'bar', data:{
        labels: top15.map(r=>r.Material),
        datasets:[{ label:'Metres', data: top15.map(r=>Number(r.TotalOutput)),
          backgroundColor: RPT_PALETTE.map(c=>c+'cc').slice(0,top15.length), borderRadius:4 }],
      }, options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}} }});

      wireExport(rows, ['Material','ProcessCode','UOM','BatchCount','TotalOutput','AvgPerBatch'], 'material-throughput.csv');
    } catch(err) { el.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`; }
  }
}

// ── METRE PROCESS ENTRY  (EX / CO / BR / CL / TW) ────────────────────────────

async function runMeterProcessEntry(processCode) {
  const state = {
    phase: 1,
    material: '', lengthMetres: null, machineID: null,
    parentBatches: [], additionalOperators: [],
    hasScrap: false, scrapTotalKG: 0, scrapReasons: [],
    notes: '',
  };

  const [wcJson, reasonsJson] = await Promise.all([
    api('/work-centres'),
    api(`/scrap-reasons?pc=${processCode}`),
  ]);

  const machines = (wcJson.data || [])
    .filter(wc => wc.ProcessCode === processCode && wc.MachineID)
    .sort((a, b) => (a.MachineName||'').localeCompare(b.MachineName||''));
  const reasons = reasonsJson.data || [];
  const steps   = ['Material & Output', 'Traceability & Operators', 'Scrap', 'Review & Submit'];

  const render = () => {
    document.getElementById('result-body').innerHTML = `
      <div style="padding:20px;max-width:600px">
        <div class="pn-wizard-steps" id="mp-steps"></div>
        <div id="mp-phase-body"></div>
        <div style="display:flex;gap:8px;margin-top:16px">
          ${state.phase > 1 ? `<button class="btn-secondary" id="mp-back">← Back</button>` : ''}
          <button class="btn-submit" id="mp-next">${state.phase === 4 ? 'Submit & Post to SAP' : 'Next →'}</button>
          <span id="mp-msg" style="font-size:12px;color:var(--error);align-self:center"></span>
        </div>
      </div>`;

    document.getElementById('mp-steps').innerHTML = steps.map((s, i) => `
      <span style="font-family:'JetBrains Mono',monospace;font-size:10px;padding:3px 10px;border-radius:20px;
        background:${i+1===state.phase?'var(--accent)':i+1<state.phase?'rgba(13,148,136,0.15)':'var(--surface2)'};
        color:${i+1===state.phase?'#fff':i+1<state.phase?'var(--accent)':'var(--text-muted)'};
        border:1px solid ${i+1<=state.phase?'var(--accent)':'var(--border)'}">${i+1}. ${s}</span>`).join('');

    renderMeterProcessPhase(state, machines, reasons, processCode);
    document.getElementById('mp-next')?.addEventListener('click', () => advanceMeterProcess(state, machines, reasons, processCode, render));
    document.getElementById('mp-back')?.addEventListener('click', () => { state.phase--; render(); });
  };

  render();
}

function renderMeterProcessPhase(state, machines, reasons, processCode) {
  const body = document.getElementById('mp-phase-body');

  if (state.phase === 1) {
    body.innerHTML = `
      <div class="bm-section" style="margin-bottom:0">
        <div class="bm-section-title">Phase 1 — Material &amp; Output</div>
        <div class="tf-field" style="margin-bottom:12px">
          <label class="tf-label">SAP Material Number</label>
          <input class="tf-input" id="mp-material" value="${esc(state.material)}" placeholder="e.g. K-NBR-87-1234" autocomplete="off">
        </div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Total Length (M)</label>
            <input class="tf-input" id="mp-length" type="number" step="0.001" min="0.001" placeholder="0.000" value="${state.lengthMetres||''}">
          </div>
          ${machines.length ? `
          <div class="tf-field">
            <label class="tf-label">Machine</label>
            <select class="tf-input" id="mp-machine">
              <option value="">No machine</option>
              ${machines.map(m=>`<option value="${m.MachineID}" ${state.machineID===m.MachineID?'selected':''}>${esc(m.MachineName||m.MachineCode)}</option>`).join('')}
            </select>
          </div>` : ''}
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:8px">Shift is detected automatically from the current time.</div>
      </div>`;

  } else if (state.phase === 2) {
    const batchTags = state.parentBatches.length
      ? state.parentBatches.map((pb, i) =>
          `<span style="display:inline-flex;align-items:center;gap:5px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:12px;font-family:'JetBrains Mono',monospace">
            ${esc(pb.processCode)}${String(pb.recordID).padStart(8,'0')}
            <button class="mp-remove-batch" data-idx="${i}" style="background:none;border:none;color:var(--error);cursor:pointer;font-size:14px">×</button>
           </span>`).join(' ')
      : `<span style="font-size:12px;color:var(--text-muted)">No batches added yet</span>`;

    const opTags = state.additionalOperators.map(u =>
      `<span style="display:inline-flex;align-items:center;gap:5px;background:var(--accent-dim);border:1px solid var(--accent);border-radius:4px;padding:2px 8px;font-size:12px">
        ${esc(u.username)} <button class="mp-remove-op" data-uid="${u.uid}" style="background:none;border:none;color:var(--error);cursor:pointer;font-size:14px">×</button>
       </span>`).join(' ');

    body.innerHTML = `
      <div class="bm-section" style="margin-bottom:0">
        <div class="bm-section-title">Phase 2 — Traceability &amp; Operators</div>
        <div style="margin-bottom:12px">
          <label class="tf-label">Previous Stage Batches</label>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Add each input batch — this run can consume multiple upstream records.</div>
          <div style="display:flex;gap:6px;margin-bottom:8px">
            <select class="tf-input" id="mp-parent-pc" style="width:150px">
              ${Object.entries(PROCESS_LABELS).filter(([k])=>k!==processCode).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}
            </select>
            <input class="tf-input" id="mp-parent-rid" type="number" placeholder="Record ID" style="width:130px">
            <button class="btn-secondary" id="mp-add-batch">+ Add</button>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">${batchTags}</div>
        </div>
        <div>
          <label class="tf-label">Additional Operators</label>
          <div style="display:flex;gap:6px;margin-top:4px">
            <input class="tf-input" id="mp-op-q" placeholder="Search username…" style="flex:1">
            <button class="btn-secondary" id="mp-op-search">Search</button>
          </div>
          <div id="mp-op-results" style="margin-top:6px"></div>
          <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">${opTags}</div>
        </div>
      </div>`;

    document.getElementById('mp-add-batch')?.addEventListener('click', () => {
      const pc  = document.getElementById('mp-parent-pc')?.value;
      const rid = Number(document.getElementById('mp-parent-rid')?.value);
      if (!pc || !rid) return;
      if (!state.parentBatches.find(pb => pb.processCode === pc && pb.recordID === rid))
        state.parentBatches.push({ processCode: pc, recordID: rid });
      renderMeterProcessPhase(state, machines, reasons, processCode);
    });
    document.querySelectorAll('.mp-remove-batch').forEach(btn => {
      btn.addEventListener('click', () => { state.parentBatches.splice(Number(btn.dataset.idx), 1); renderMeterProcessPhase(state, machines, reasons, processCode); });
    });
    document.querySelectorAll('.mp-remove-op').forEach(btn => {
      btn.addEventListener('click', () => { state.additionalOperators = state.additionalOperators.filter(u => u.uid !== Number(btn.dataset.uid)); renderMeterProcessPhase(state, machines, reasons, processCode); });
    });
    document.getElementById('mp-op-search')?.addEventListener('click', async () => {
      const q  = document.getElementById('mp-op-q').value.trim();
      const el = document.getElementById('mp-op-results');
      const r  = await api(`/users?q=${encodeURIComponent(q)}`);
      el.innerHTML = (r.data||[]).map(u => `
        <div style="display:flex;justify-content:space-between;padding:3px 0">
          <span style="font-size:13px">${esc(u.DisplayName||u.Username)}</span>
          <button class="btn-secondary mp-add-op" data-uid="${u.UserID}" data-name="${esc(u.DisplayName||u.Username)}" style="padding:2px 8px;font-size:11px">Add</button>
        </div>`).join('');
      el.querySelectorAll('.mp-add-op').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!state.additionalOperators.find(u => u.uid === Number(btn.dataset.uid)))
            state.additionalOperators.push({ uid: Number(btn.dataset.uid), username: btn.dataset.name });
          renderMeterProcessPhase(state, machines, reasons, processCode);
        });
      });
    });

  } else if (state.phase === 3) {
    const reasonRows = state.scrapReasons.map((r, i) => `
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <select class="tf-input mp-scrap-reason" data-idx="${i}" style="flex:1">
          <option value="">Select reason…</option>
          ${reasons.map(sr=>`<option value="${sr.ReasonID}" ${Number(r.reasonID)===sr.ReasonID?'selected':''}>${esc(sr.ReasonCode)} — ${esc(sr.ReasonDescription)}</option>`).join('')}
        </select>
        <input class="tf-input mp-scrap-occ" type="number" min="1" step="1" value="${r.occurrences||1}" data-idx="${i}" style="width:90px" placeholder="Count">
        <button class="mp-remove-reason btn-secondary" data-idx="${i}" style="padding:2px 8px;font-size:11px">×</button>
      </div>`).join('');

    body.innerHTML = `
      <div class="bm-section" style="margin-bottom:0">
        <div class="bm-section-title">Phase 3 — Scrap</div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:12px">
          <input type="checkbox" id="mp-has-scrap" ${state.hasScrap?'checked':''}> Scrap to record for this run
        </label>
        <div id="mp-scrap-fields" style="display:${state.hasScrap?'block':'none'}">
          <div class="tf-field" style="margin-bottom:8px">
            <label class="tf-label">Total Scrap Weight (KG)</label>
            <input class="tf-input" id="mp-scrap-kg" type="number" min="0" step="0.001" value="${state.scrapTotalKG||''}" style="width:160px">
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Weight is split proportionally by occurrence count.</div>
          <div id="mp-reason-rows">${reasonRows}</div>
          <button class="btn-secondary" id="mp-add-reason" style="margin-top:8px">+ Add Reason</button>
        </div>
      </div>`;

    document.getElementById('mp-has-scrap')?.addEventListener('change', e => {
      state.hasScrap = e.target.checked;
      document.getElementById('mp-scrap-fields').style.display = e.target.checked ? 'block' : 'none';
    });
    document.getElementById('mp-add-reason')?.addEventListener('click', () => {
      state.scrapReasons.push({ reasonID: '', occurrences: 1 });
      renderMeterProcessPhase(state, machines, reasons, processCode);
    });
    document.querySelectorAll('.mp-remove-reason').forEach(btn => {
      btn.addEventListener('click', () => { state.scrapReasons.splice(Number(btn.dataset.idx),1); renderMeterProcessPhase(state, machines, reasons, processCode); });
    });
    document.querySelectorAll('.mp-scrap-reason').forEach(sel => {
      sel.addEventListener('change', e => { state.scrapReasons[Number(e.target.dataset.idx)].reasonID = Number(e.target.value); });
    });
    document.querySelectorAll('.mp-scrap-occ').forEach(inp => {
      inp.addEventListener('change', e => { state.scrapReasons[Number(e.target.dataset.idx)].occurrences = Number(e.target.value); });
    });

  } else if (state.phase === 4) {
    const machine = machines.find(m => m.MachineID === state.machineID);
    body.innerHTML = `
      <div class="bm-section" style="margin-bottom:0">
        <div class="bm-section-title">Phase 4 — Review &amp; Submit</div>
        <div class="tf-field" style="margin-bottom:14px">
          <label class="tf-label">Comments (optional)</label>
          <input class="tf-input" id="mp-notes" value="${esc(state.notes)}" placeholder="Any notes for this run…">
        </div>
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px">
          <div style="font-weight:700;margin-bottom:8px">Summary</div>
          <div class="pn-batch-mono">Material: ${esc(state.material)}</div>
          <div class="pn-batch-mono">Length: ${state.lengthMetres ? Number(state.lengthMetres).toFixed(3)+' M' : '—'}</div>
          <div class="pn-batch-mono">Machine: ${machine ? esc(machine.MachineName||machine.MachineCode) : 'None'}</div>
          <div class="pn-batch-mono">Prev batches: ${state.parentBatches.length ? state.parentBatches.map(pb=>`${pb.processCode}${String(pb.recordID).padStart(8,'0')}`).join(', ') : 'None'}</div>
          <div class="pn-batch-mono">Scrap: ${state.hasScrap ? state.scrapTotalKG+' KG across '+state.scrapReasons.length+' reason(s)' : 'None'}</div>
        </div>
        <div id="mp-submit-result" style="margin-top:10px;font-size:13px"></div>
      </div>`;
  }
}

async function advanceMeterProcess(state, machines, reasons, processCode, render) {
  const msg = document.getElementById('mp-msg');
  if (msg) msg.textContent = '';

  if (state.phase === 1) {
    const mat = document.getElementById('mp-material')?.value.trim();
    const len = document.getElementById('mp-length')?.value;
    if (!mat) { if (msg) msg.textContent = 'Material number is required.'; return; }
    if (!len || Number(len) <= 0) { if (msg) msg.textContent = 'Total length is required.'; return; }
    state.material     = mat;
    state.lengthMetres = Number(len);
    state.machineID    = Number(document.getElementById('mp-machine')?.value) || null;

  } else if (state.phase === 2) {
    // parentBatches + additionalOperators maintained via add/remove buttons

  } else if (state.phase === 3) {
    state.hasScrap = document.getElementById('mp-has-scrap')?.checked || false;
    if (state.hasScrap) {
      state.scrapTotalKG = Number(document.getElementById('mp-scrap-kg')?.value) || 0;
      if (!state.scrapTotalKG) { if (msg) msg.textContent = 'Enter total scrap weight.'; return; }
    }

  } else if (state.phase === 4) {
    state.notes = document.getElementById('mp-notes')?.value.trim() || '';
    const submitBtn = document.getElementById('mp-next');
    const resultEl  = document.getElementById('mp-submit-result');
    submitBtn.disabled = true; submitBtn.textContent = 'Submitting…';

    try {
      const json = await api(`/process/${processCode}/entry`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          material:              state.material,
          lengthMetres:          state.lengthMetres,
          machineID:             state.machineID,
          parentBatches:         state.parentBatches,
          additionalOperatorIDs: state.additionalOperators.map(u => u.uid),
          hasScrap:              state.hasScrap,
          scrapTotalKG:          state.hasScrap ? state.scrapTotalKG : 0,
          scrapReasons:          state.hasScrap ? state.scrapReasons : [],
          notes:                 state.notes,
        }),
      });

      const d = json.data || {};
      if (d.status === 'SAP_FAILED') {
        resultEl.style.color = '#D97706';
        resultEl.innerHTML = `⚠ Saved as ${esc(d.batchRef||'')} but SAP failed.<br>
          <span style="font-size:12px">${esc(d.error)}</span><br>
          <span style="font-size:12px">Now in the Failed Backflush queue for supervisor review.</span>`;
      } else {
        resultEl.style.color = 'var(--accent)';
        resultEl.innerHTML = `✓ ${esc(d.batchRef||'')} posted successfully — MatDoc: ${esc(d.materialDocument||'—')}
          ${d.warning ? `<br><span style="font-size:12px;color:#D97706">⚠ ${esc(d.warning)}</span>` : ''}`;
      }
      submitBtn.disabled = false; submitBtn.textContent = 'Submit & Post to SAP';
    } catch (err) {
      resultEl.style.color = 'var(--error)';
      resultEl.textContent = err.message;
      submitBtn.disabled = false; submitBtn.textContent = 'Submit & Post to SAP';
    }
    return;
  }

  state.phase++;
  render();
}

// ── METRE PROCESS DATA  (EX / CO / BR / CL / TW) ─────────────────────────────

async function runMeterProcessData(processCode) {
  const body = document.getElementById('result-body');
  body.innerHTML = `
    <div style="padding:16px 20px">
      <div class="bm-section" style="margin-bottom:14px">
        <div class="bm-section-title">Filters</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">
          <div class="tf-field"><label class="tf-label">Material</label><input class="tf-input" id="mpd-mat" placeholder="e.g. K-NBR%" style="width:180px"></div>
          <div class="tf-field"><label class="tf-label">From</label><input class="tf-input" id="mpd-from" type="date" style="width:140px"></div>
          <div class="tf-field"><label class="tf-label">To</label><input class="tf-input" id="mpd-to" type="date" style="width:140px"></div>
          <button class="btn-filter-search" id="mpd-search">Search</button>
        </div>
      </div>
      <div id="mpd-results"><div class="pn-empty">Enter filters above and click Search.</div></div>
    </div>`;

  let lastRows = [];
  document.getElementById('mpd-search').addEventListener('click', async () => {
    const el = document.getElementById('mpd-results');
    const params = new URLSearchParams({
      ...(document.getElementById('mpd-mat').value.trim()  ? { material: document.getElementById('mpd-mat').value.trim() } : {}),
      ...(document.getElementById('mpd-from').value        ? { dateFrom:  document.getElementById('mpd-from').value       } : {}),
      ...(document.getElementById('mpd-to').value          ? { dateTo:    document.getElementById('mpd-to').value         } : {}),
    });
    el.innerHTML = '<div class="pn-loading"><div class="spinner"></div>Loading…</div>';
    try {
      const json = await api(`/process/${processCode}/data?${params}`);
      lastRows = json.data || [];
      if (!lastRows.length) { el.innerHTML = '<div class="pn-empty">No records match the selected filters.</div>'; return; }

      const badge = document.getElementById('result-row-badge');
      badge.textContent = `${lastRows.length} records`; badge.classList.remove('hidden');

      el.innerHTML = `
        <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
          <button class="btn-secondary" id="mpd-export">Export CSV</button>
        </div>
        <div style="overflow-x:auto">
        <table class="pn-batch-table">
          <thead><tr><th>Ref</th><th>Material</th><th>Length (M)</th><th>Machine</th><th>Shift</th><th>Status</th><th>Started</th><th>Completed</th><th>Created By</th></tr></thead>
          <tbody>${lastRows.map(r => `<tr class="pn-row" data-pc="${processCode}" data-rid="${r.RecordID}" style="cursor:pointer">
            <td class="pn-batch-ref">${esc(r.BatchRef)}</td>
            <td class="pn-batch-mono">${esc(r.Material)}</td>
            <td class="pn-batch-mono">${Number(r.LengthMetres).toFixed(3)}</td>
            <td>${esc(r.MachineName||r.MachineCode||'—')}</td>
            <td>${esc(r.ShiftName||'—')}</td>
            <td>${batchStatusBadge(r.Status, r.IsReversed)}</td>
            <td class="pn-batch-mono">${fmt(r.StartedAt)}</td>
            <td class="pn-batch-mono">${fmt(r.CompletedAt)}</td>
            <td>${esc(r.CreatedBy||'—')}</td>
          </tr>`).join('')}</tbody>
        </table></div>`;

      document.getElementById('mpd-export').addEventListener('click', () =>
        downloadCsv(lastRows, `${processCode.toLowerCase()}-data.csv`));
      el.querySelectorAll('.pn-row[data-rid]').forEach(row => {
        row.addEventListener('click', () => openMeterProcessDetail(
          row.dataset.pc, Number(row.dataset.rid),
          lastRows.find(r => r.RecordID === Number(row.dataset.rid))
        ));
      });
    } catch (err) { el.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`; }
  });
}

async function openMeterProcessDetail(processCode, recordID, row) {
  openModal(`<div class="ps-modal" style="max-width:540px">
    <div class="ps-modal-header">
      <div>
        <div class="ps-modal-title">${esc(row?.BatchRef || `${processCode}${String(recordID).padStart(8,'0')}`)}</div>
        <div class="ps-modal-sub">${esc(PROCESS_LABELS[processCode]||processCode)} &nbsp;·&nbsp; ${esc(row?.Material||'')} &nbsp;·&nbsp; ${row?Number(row.LengthMetres).toFixed(3)+' M':''}</div>
      </div>
      <button class="ps-modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="ps-modal-body" id="mpd-detail-body">
      <div class="pn-loading"><div class="spinner"></div>Loading…</div>
    </div>
  </div>`);

  try {
    const [postingsJson, scrapJson] = await Promise.all([
      api(`/reversal/by-batch/${encodeURIComponent(processCode)}/${recordID}`),
      api(`/scrap/entries?processCode=${encodeURIComponent(processCode)}&processRecordID=${recordID}`),
    ]);

    const postings = postingsJson.data || [];
    const scrap    = scrapJson.data   || [];
    const bodyEl   = document.getElementById('mpd-detail-body');
    if (!bodyEl) return;

    const postingHtml = postings.length
      ? `<table class="pn-batch-table" style="margin:0">
          <thead><tr><th>Material Document</th><th>Type</th><th>Qty (M)</th><th>Posted</th><th>Status</th></tr></thead>
          <tbody>${postings.map(p=>`<tr>
            <td class="pn-batch-mono" style="font-weight:700">${esc(p.MaterialDocumentSAP)}</td>
            <td class="pn-batch-mono">${esc(p.PostingType)}</td>
            <td class="pn-batch-mono">${Number(p.Quantity).toFixed(3)}</td>
            <td class="pn-batch-mono">${fmt(p.PostedAt)}</td>
            <td>${p.IsReversed?`<span class="pn-status pn-status--cancelled">Reversed</span>`:`<span class="pn-status pn-status--complete">Active</span>`}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : `<div style="font-size:13px;color:var(--text-muted);padding:6px 0">No SAP postings recorded.</div>`;

    const scrapHtml = scrap.length
      ? `<table class="pn-batch-table" style="margin:0">
          <thead><tr><th>Reason</th><th>Qty (KG)</th><th>Material Document</th><th>SAP Status</th></tr></thead>
          <tbody>${scrap.map(s=>`<tr>
            <td>${esc(s.ReasonDescription||s.ReasonCode)}</td>
            <td class="pn-batch-mono" style="color:var(--error)">${Number(s.Quantity).toFixed(3)}</td>
            <td class="pn-batch-mono">${esc(s.SAPMaterialDocument||'—')}</td>
            <td>${s.SAPPosted?`<span class="pn-status pn-status--complete">Posted</span>`:s.IsApproved?`<span class="pn-status pn-status--cancelled" title="${esc(s.SAPErrorMessage||'')}">Failed</span>`:`<span class="pn-status pn-status--on-hold">Pending</span>`}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : `<div style="font-size:13px;color:var(--text-muted);padding:6px 0">No scrap recorded.</div>`;

    bodyEl.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px">
        <div><div class="pn-section-hdr" style="margin-bottom:8px">SAP Backflush</div>${postingHtml}</div>
        <div><div class="pn-section-hdr" style="margin-bottom:8px">Scrap &nbsp;<span style="font-weight:400;font-size:10px">${scrap.length} entr${scrap.length!==1?'ies':'y'}</span></div>${scrapHtml}</div>
      </div>`;
  } catch (err) {
    const bodyEl = document.getElementById('mpd-detail-body');
    if (bodyEl) bodyEl.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`;
  }
}

// Named entry wrappers
async function runExtrusionEntry()   { await runMeterProcessEntry('EX'); }
async function runConvolutingEntry() { await runMeterProcessEntry('CO'); }
async function runBraidingEntry()    { await runMeterProcessEntry('BR'); }
async function runCoverlineEntry()   { await runMeterProcessEntry('CL'); }
async function runTapeWrapEntry()    { await runMeterProcessEntry('TW'); }

// Named data wrappers
async function runExtrusionData()   { await runMeterProcessData('EX'); }
async function runConvolutingData() { await runMeterProcessData('CO'); }
async function runBraidingData()    { await runMeterProcessData('BR'); }
async function runCoverlineData()   { await runMeterProcessData('CL'); }
async function runTapeWrapData()    { await runMeterProcessData('TW'); }

// ── MIXING DATA ───────────────────────────────────────────────────────────────

async function openMixingTubsModal(mixingID, row) {
  openModal(`<div class="ps-modal" style="max-width:520px">
    <div class="ps-modal-header">
      <div>
        <div class="ps-modal-title">${esc(row?.MixRef || `MX${String(mixingID).padStart(8,'0')}`)}</div>
        <div class="ps-modal-sub">${esc(row?.Material || '')} &nbsp;·&nbsp; ${row ? Number(row.TotalWeightKG).toFixed(3) + ' KG total' : ''}</div>
      </div>
      <button class="ps-modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="ps-modal-body" id="mxd-tubs-body">
      <div class="pn-loading"><div class="spinner"></div>Loading tubs…</div>
    </div>
  </div>`);

  try {
    const json = await api(`/mixing/${mixingID}/tubs`);
    const tubs = json.data || [];
    const bodyEl = document.getElementById('mxd-tubs-body');

    if (!tubs.length) {
      bodyEl.innerHTML = '<div class="pn-empty">No tub records found for this mixing batch.</div>';
      return;
    }

    bodyEl.innerHTML = `
      <table class="pn-batch-table" style="margin:0">
        <thead>
          <tr>
            <th>Tub</th>
            <th>Weight (KG)</th>
            <th>Material Document</th>
            <th>SAP Status</th>
          </tr>
        </thead>
        <tbody>
          ${tubs.map(t => `
            <tr>
              <td class="pn-batch-mono" style="color:var(--text-muted)">${t.TubSeq}</td>
              <td class="pn-batch-mono">${Number(t.TubWeightKG).toFixed(3)}</td>
              <td class="pn-batch-mono">${esc(t.MaterialDocumentSAP || '—')}</td>
              <td>${t.SAPSuccess
                ? `<span class="pn-status pn-status--complete">Posted</span>`
                : t.SAPErrorMessage
                  ? `<span class="pn-status pn-status--cancelled" title="${esc(t.SAPErrorMessage)}">Failed</span>`
                  : `<span class="pn-status pn-status--open">Pending</span>`}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      <div style="margin-top:12px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted);text-align:right">
        ${tubs.length} tub${tubs.length !== 1 ? 's' : ''} &nbsp;·&nbsp;
        Total: ${tubs.reduce((s, t) => s + Number(t.TubWeightKG), 0).toFixed(3)} KG
      </div>`;
  } catch (err) {
    const bodyEl = document.getElementById('mxd-tubs-body');
    if (bodyEl) bodyEl.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`;
  }
}

function downloadCsv(rows, filename) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const lines = [keys.join(','), ...rows.map(r => keys.map(k => JSON.stringify(r[k] ?? '')).join(','))];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  a.click(); URL.revokeObjectURL(a.href);
}

async function runMixingData() {
  const body = document.getElementById('result-body');
  body.innerHTML = `
    <div style="padding:16px 20px">
      <div class="bm-section" style="margin-bottom:14px">
        <div class="bm-section-title">Filters</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">
          <div class="tf-field"><label class="tf-label">Material</label><input class="tf-input" id="mxd-mat" placeholder="e.g. K-NBR%" style="width:160px"></div>
          <div class="tf-field"><label class="tf-label">From</label><input class="tf-input" id="mxd-from" type="date" style="width:140px"></div>
          <div class="tf-field"><label class="tf-label">To</label><input class="tf-input" id="mxd-to" type="date" style="width:140px"></div>
          <div class="tf-field"><label class="tf-label">Supplier Batch</label><input class="tf-input" id="mxd-sbn" placeholder="Supplier batch" style="width:150px"></div>
          <button class="btn-filter-search" id="mxd-search">Search</button>
        </div>
      </div>
      <div id="mxd-results"><div class="pn-empty">Enter filters above and click Search.</div></div>
    </div>`;

  let lastRows = [];
  document.getElementById('mxd-search').addEventListener('click', async () => {
    const el  = document.getElementById('mxd-results');
    const params = new URLSearchParams({
      ...(document.getElementById('mxd-mat').value.trim()  ? { material:       document.getElementById('mxd-mat').value.trim()  } : {}),
      ...(document.getElementById('mxd-from').value        ? { dateFrom:        document.getElementById('mxd-from').value        } : {}),
      ...(document.getElementById('mxd-to').value          ? { dateTo:          document.getElementById('mxd-to').value          } : {}),
      ...(document.getElementById('mxd-sbn').value.trim()  ? { supplierBatchNo: document.getElementById('mxd-sbn').value.trim()  } : {}),
    });
    el.innerHTML = '<div class="pn-loading"><div class="spinner"></div>Loading…</div>';
    try {
      const json = await api(`/mixing/data?${params}`);
      lastRows = json.data || [];
      if (!lastRows.length) { el.innerHTML = '<div class="pn-empty">No records match the selected filters.</div>'; return; }

      const badge = document.getElementById('result-row-badge');
      badge.textContent = `${lastRows.length} records`;
      badge.classList.remove('hidden');

      el.innerHTML = `
        <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
          <button class="btn-secondary" id="mxd-export">Export CSV</button>
        </div>
        <div style="overflow-x:auto">
        <table class="pn-batch-table">
          <thead><tr><th>Ref</th><th>Material</th><th>Mix Code</th><th>Weight (KG)</th><th>Supplier Batch</th><th>Supplier Tub</th><th>Shift</th><th>Status</th><th>Started</th><th>Completed</th><th>Created By</th></tr></thead>
          <tbody>${lastRows.map(r => `<tr class="pn-row" data-mixid="${r.MixingID}" style="cursor:pointer">
            <td class="pn-batch-ref">${esc(r.MixRef)}</td>
            <td class="pn-batch-mono">${esc(r.Material)}</td>
            <td class="pn-batch-mono">${esc(r.MixCode)}</td>
            <td class="pn-batch-mono">${Number(r.TotalWeightKG).toFixed(3)}</td>
            <td class="pn-batch-mono">${esc(r.SupplierBatchNo||'—')}</td>
            <td class="pn-batch-mono">${esc(r.SupplierTubNo||'—')}</td>
            <td>${esc(r.ShiftName||'—')}</td>
            <td>${batchStatusBadge(r.Status, r.IsReversed)}</td>
            <td class="pn-batch-mono">${fmt(r.StartedAt)}</td>
            <td class="pn-batch-mono">${fmt(r.CompletedAt)}</td>
            <td>${esc(r.CreatedBy||'—')}</td>
          </tr>`).join('')}</tbody>
        </table></div>`;

      document.getElementById('mxd-export').addEventListener('click', () => downloadCsv(lastRows, 'mixing-data.csv'));

      el.querySelectorAll('.pn-row[data-mixid]').forEach(row => {
        row.addEventListener('click', () => openMixingTubsModal(
          Number(row.dataset.mixid),
          lastRows.find(r => r.MixingID === Number(row.dataset.mixid))
        ));
      });
    } catch (err) { el.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`; }
  });
}

// ── DRUMMING DATA ─────────────────────────────────────────────────────────────

async function runDrummingData() {
  const body = document.getElementById('result-body');
  body.innerHTML = `
    <div style="padding:16px 20px">
      <div class="bm-section" style="margin-bottom:14px">
        <div class="bm-section-title">Filters</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">
          <div class="tf-field"><label class="tf-label">Material</label><input class="tf-input" id="drd-mat" placeholder="e.g. TCEV9%" style="width:160px"></div>
          <div class="tf-field"><label class="tf-label">From</label><input class="tf-input" id="drd-from" type="date" style="width:140px"></div>
          <div class="tf-field"><label class="tf-label">To</label><input class="tf-input" id="drd-to" type="date" style="width:140px"></div>
          <div class="tf-field"><label class="tf-label">Customer</label><input class="tf-input" id="drd-cust" placeholder="Customer" style="width:140px"></div>
          <div class="tf-field"><label class="tf-label">Sales Order</label><input class="tf-input" id="drd-so" placeholder="SO number" style="width:130px"></div>
          <button class="btn-filter-search" id="drd-search">Search</button>
        </div>
      </div>
      <div id="drd-results"><div class="pn-empty">Enter filters above and click Search.</div></div>
    </div>`;

  let lastRows = [];
  document.getElementById('drd-search').addEventListener('click', async () => {
    const el = document.getElementById('drd-results');
    const params = new URLSearchParams({
      ...(document.getElementById('drd-mat').value.trim()  ? { material:      document.getElementById('drd-mat').value.trim()  } : {}),
      ...(document.getElementById('drd-from').value        ? { dateFrom:       document.getElementById('drd-from').value        } : {}),
      ...(document.getElementById('drd-to').value          ? { dateTo:         document.getElementById('drd-to').value          } : {}),
      ...(document.getElementById('drd-cust').value.trim() ? { customerID:     document.getElementById('drd-cust').value.trim() } : {}),
      ...(document.getElementById('drd-so').value.trim()   ? { salesOrderSAP:  document.getElementById('drd-so').value.trim()   } : {}),
    });
    el.innerHTML = '<div class="pn-loading"><div class="spinner"></div>Loading…</div>';
    try {
      const json = await api(`/drumming/data?${params}`);
      lastRows = json.data || [];
      if (!lastRows.length) { el.innerHTML = '<div class="pn-empty">No records match the selected filters.</div>'; return; }

      const badge = document.getElementById('result-row-badge');
      badge.textContent = `${lastRows.length} records`;
      badge.classList.remove('hidden');

      el.innerHTML = `
        <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
          <button class="btn-secondary" id="drd-export">Export CSV</button>
        </div>
        <div style="overflow-x:auto">
        <table class="pn-batch-table">
          <thead><tr><th>Ref</th><th>Material</th><th>Length (M)</th><th>Packaging</th><th>Test PSI</th><th>Sales Order</th><th>Customer</th><th>Shift</th><th>Status</th><th>Started</th><th>Completed</th><th>Created By</th></tr></thead>
          <tbody>${lastRows.map(r => `<tr class="pn-row" data-drumid="${r.DrummingID}" style="cursor:pointer">
            <td class="pn-batch-ref">${esc(r.DrumRef)}</td>
            <td class="pn-batch-mono">${esc(r.Material)}</td>
            <td class="pn-batch-mono">${Number(r.LengthMetres).toFixed(3)}</td>
            <td class="pn-batch-mono">${esc(r.PackagingType||'—')}</td>
            <td class="pn-batch-mono">${r.TestPressurePSI != null ? r.TestPressurePSI : '—'}</td>
            <td class="pn-batch-mono">${esc(r.SalesOrderSAP||'—')}</td>
            <td>${esc(r.CustomerID||'—')}</td>
            <td>${esc(r.ShiftName||'—')}</td>
            <td>${batchStatusBadge(r.Status, r.IsReversed)}</td>
            <td class="pn-batch-mono">${fmt(r.StartedAt)}</td>
            <td class="pn-batch-mono">${fmt(r.CompletedAt)}</td>
            <td>${esc(r.CreatedBy||'—')}</td>
          </tr>`).join('')}</tbody>
        </table></div>`;

      document.getElementById('drd-export').addEventListener('click', () => downloadCsv(lastRows, 'drumming-data.csv'));

      el.querySelectorAll('.pn-row[data-drumid]').forEach(row => {
        row.addEventListener('click', () => openDrummingDetailModal(
          Number(row.dataset.drumid),
          lastRows.find(r => r.DrummingID === Number(row.dataset.drumid))
        ));
      });
    } catch (err) { el.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`; }
  });
}

async function openDrummingDetailModal(drummingID, row) {
  openModal(`<div class="ps-modal" style="max-width:580px">
    <div class="ps-modal-header">
      <div>
        <div class="ps-modal-title">${esc(row?.DrumRef || `DR${String(drummingID).padStart(8,'0')}`)}</div>
        <div class="ps-modal-sub">${esc(row?.Material || '')} &nbsp;·&nbsp; ${row ? Number(row.LengthMetres).toFixed(3) + ' M' : ''} &nbsp;·&nbsp; ${esc(row?.PackagingType||'')}</div>
      </div>
      <button class="ps-modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="ps-modal-body" id="drd-detail-body">
      <div class="pn-loading"><div class="spinner"></div>Loading…</div>
    </div>
  </div>`);

  try {
    const [postingsJson, coilsJson, scrapJson] = await Promise.all([
      api(`/reversal/by-batch/DR/${drummingID}`),
      api(`/drumming/${drummingID}/coils`),
      api(`/scrap/entries?processCode=DR&processRecordID=${drummingID}`),
    ]);

    const postings = postingsJson.data || [];
    const coils    = coilsJson.data   || [];
    const scrap    = scrapJson.data   || [];

    const bodyEl = document.getElementById('drd-detail-body');
    if (!bodyEl) return;

    // SAP Postings section
    const postingHtml = postings.length
      ? `<table class="pn-batch-table" style="margin:0">
          <thead><tr><th>Material Document</th><th>Type</th><th>Qty (M)</th><th>Posted</th><th>Status</th></tr></thead>
          <tbody>${postings.map(p => `<tr>
            <td class="pn-batch-mono" style="font-weight:700">${esc(p.MaterialDocumentSAP)}</td>
            <td class="pn-batch-mono">${esc(p.PostingType)}</td>
            <td class="pn-batch-mono">${Number(p.Quantity).toFixed(3)}</td>
            <td class="pn-batch-mono">${fmt(p.PostedAt)}</td>
            <td>${p.IsReversed
              ? `<span class="pn-status pn-status--cancelled">Reversed</span>`
              : `<span class="pn-status pn-status--complete">Active</span>`}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : `<div style="font-size:13px;color:var(--text-muted);padding:6px 0">No SAP postings recorded.</div>`;

    // Coils section
    const totalLen = coils.reduce((s, c) => s + Number(c.LengthM), 0);
    const coilHtml = coils.length
      ? `<table class="pn-batch-table" style="margin:0">
          <thead><tr><th>Coil</th><th>Length (M)</th></tr></thead>
          <tbody>${coils.map(c => `<tr>
            <td class="pn-batch-mono" style="color:var(--text-muted)">${c.CoilSeq}</td>
            <td class="pn-batch-mono">${Number(c.LengthM).toFixed(3)}</td>
          </tr>`).join('')}
          <tr style="border-top:1px solid var(--border);font-weight:700">
            <td class="pn-batch-mono">Total</td>
            <td class="pn-batch-mono">${totalLen.toFixed(3)}</td>
          </tr></tbody>
        </table>`
      : `<div style="font-size:13px;color:var(--text-muted);padding:6px 0">No coil lengths recorded.</div>`;

    // Scrap section
    const scrapHtml = scrap.length
      ? `<table class="pn-batch-table" style="margin:0">
          <thead><tr><th>Reason</th><th>Qty (KG)</th><th>Material Document</th><th>SAP Status</th></tr></thead>
          <tbody>${scrap.map(s => `<tr>
            <td>${esc(s.ReasonDescription || s.ReasonCode)}</td>
            <td class="pn-batch-mono" style="color:var(--error)">${Number(s.Quantity).toFixed(3)}</td>
            <td class="pn-batch-mono">${esc(s.SAPMaterialDocument || '—')}</td>
            <td>${s.SAPPosted
              ? `<span class="pn-status pn-status--complete">Posted</span>`
              : s.IsApproved && !s.SAPPosted
                ? `<span class="pn-status pn-status--cancelled" title="${esc(s.SAPErrorMessage||'')}">Failed</span>`
                : `<span class="pn-status pn-status--on-hold">Pending Approval</span>`}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : `<div style="font-size:13px;color:var(--text-muted);padding:6px 0">No scrap recorded for this drum.</div>`;

    bodyEl.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px">
        <div>
          <div class="pn-section-hdr" style="margin-bottom:8px">SAP Backflush</div>
          ${postingHtml}
        </div>
        <div>
          <div class="pn-section-hdr" style="margin-bottom:8px">Coil Lengths &nbsp;<span style="font-weight:400;font-size:10px">${coils.length} coil${coils.length!==1?'s':''}</span></div>
          ${coilHtml}
        </div>
        <div>
          <div class="pn-section-hdr" style="margin-bottom:8px">Scrap &nbsp;<span style="font-weight:400;font-size:10px">${scrap.length} entr${scrap.length!==1?'ies':'y'}</span></div>
          ${scrapHtml}
        </div>
      </div>`;
  } catch (err) {
    const bodyEl = document.getElementById('drd-detail-body');
    if (bodyEl) bodyEl.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`;
  }
}

// ── APPROVE SCRAP ─────────────────────────────────────────────────────────────

async function runApproveScrap() {
  const body = document.getElementById('result-body');
  body.innerHTML = '<div class="pn-loading"><div class="spinner"></div>Loading pending scrap…</div>';
  try {
    const json = await api('/scrap/pending');
    if (!json.success) throw new Error(json.error || 'Failed to load pending scrap entries.');
    const rows = json.data || [];

    const badge = document.getElementById('result-row-badge');
    badge.textContent = `${rows.length} pending`;
    badge.classList.remove('hidden');
    if (rows.length) badge.style.background = 'rgba(217,119,6,0.15)';

    if (!rows.length) {
      body.innerHTML = '<div class="pn-empty" style="color:var(--accent)">✓ No scrap entries pending approval.</div>';
      return;
    }

    const tableRows = rows.map(r => `
      <tr class="pn-row" data-scrapid="${r.ScrapID}">
        <td><input type="checkbox" class="scrap-chk" data-scrapid="${r.ScrapID}" checked></td>
        <td class="pn-batch-ref">${esc(r.BatchRef || `${r.ProcessCode}${String(r.ProcessRecordID).padStart(8,'0')}`)}</td>
        <td>${esc(PROCESS_LABELS[r.ProcessCode] || r.ProcessCode)}</td>
        <td class="pn-batch-mono">${esc(r.Material || '—')}</td>
        <td>${esc(r.ReasonDescription || r.ReasonCode)}</td>
        <td class="pn-batch-mono" style="color:var(--error)">${Number(r.Quantity).toFixed(3)} ${esc(r.UnitOfMeasure)}</td>
        <td>${esc(r.EnteredBy || '—')}</td>
        <td class="pn-batch-mono">${fmt(r.EnteredAt)}</td>
        <td class="scrap-row-result" id="scrap-result-${r.ScrapID}"></td>
      </tr>`).join('');

    body.innerHTML = `
      <div style="padding:16px 20px">
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px">
          Review operator-entered scrap entries below. Checked entries will be approved and posted to SAP.
        </div>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
            <input type="checkbox" id="scrap-select-all" checked> Select All
          </label>
          <span style="flex:1"></span>
          <button class="btn-submit" id="scrap-approve-btn">Approve &amp; Post Selected to SAP</button>
        </div>
        <div style="overflow-x:auto">
        <table class="pn-batch-table">
          <thead><tr><th style="width:32px"></th><th>Batch</th><th>Process</th><th>Material</th><th>Reason</th><th>Quantity</th><th>Entered By</th><th>Entered At</th><th></th></tr></thead>
          <tbody id="scrap-approve-tbody">${tableRows}</tbody>
        </table></div>
        <div id="scrap-approve-msg" style="margin-top:10px;font-size:13px"></div>
      </div>`;

    document.getElementById('scrap-select-all').addEventListener('change', e => {
      document.querySelectorAll('.scrap-chk').forEach(c => { c.checked = e.target.checked; });
    });

    document.getElementById('scrap-approve-btn').addEventListener('click', async () => {
      const btn     = document.getElementById('scrap-approve-btn');
      const msg     = document.getElementById('scrap-approve-msg');
      const checked = [...document.querySelectorAll('.scrap-chk:checked')].map(c => Number(c.dataset.scrapid));
      if (!checked.length) { msg.style.color = 'var(--error)'; msg.textContent = 'No entries selected.'; return; }

      btn.disabled = true; btn.textContent = `Posting ${checked.length} entr${checked.length === 1 ? 'y' : 'ies'} to SAP…`;
      msg.textContent = '';

      try {
        const res = await api('/scrap/approve', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scrapIDs: checked }),
        });

        let ok = 0, fail = 0;
        (res.results || []).forEach(r => {
          const el = document.getElementById(`scrap-result-${r.scrapID}`);
          if (r.success) {
            ok++;
            if (el) el.innerHTML = `<span style="color:var(--accent);font-size:11px;font-family:'JetBrains Mono',monospace">✓ ${esc(r.materialDocument||'')}</span>`;
          } else {
            fail++;
            if (el) el.innerHTML = `<span style="color:var(--error);font-size:11px" title="${esc(r.error)}">✗ Failed</span>`;
          }
        });

        msg.style.color = fail ? '#D97706' : 'var(--accent)';
        msg.textContent = fail
          ? `${ok} posted successfully, ${fail} failed — see inline results.`
          : `✓ All ${ok} entries posted to SAP successfully.`;
        btn.disabled = false; btn.textContent = 'Approve & Post Selected to SAP';
      } catch (err) {
        msg.style.color = 'var(--error)'; msg.textContent = err.message;
        btn.disabled = false; btn.textContent = 'Approve & Post Selected to SAP';
      }
    });
  } catch (err) {
    body.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`;
  }
}

// ── SCRAP ─────────────────────────────────────────────────────────────────────

async function runPostedScrap() {
  const body = document.getElementById('result-body');
  body.innerHTML = '<div class="pn-loading"><div class="spinner"></div>Loading scrap data…</div>';
  try {
    const [summaryJson, failedJson] = await Promise.all([
      api('/scrap/summary'),
      api('/scrap/failed'),
    ]);
    const summary = summaryJson.data || [];
    const failed  = failedJson.data  || [];

    const badge = document.getElementById('result-row-badge');
    badge.textContent = failed.length ? `${failed.length} failed` : 'Posted scrap';
    badge.classList.remove('hidden');
    if (failed.length) badge.style.background = 'rgba(220,38,38,0.12)';

    // ── Posted scrap summary ──────────────────────────────────────────────────
    let postedHtml = '';
    if (!summary.length) {
      postedHtml = '<div class="pn-empty">No SAP-posted scrap recorded yet.</div>';
    } else {
      const byProcess = {};
      summary.forEach(r => { (byProcess[r.ProcessCode] = byProcess[r.ProcessCode] || []).push(r); });

      postedHtml = Object.entries(byProcess).map(([pc, rows]) => {
        const total = rows.reduce((s, r) => s + Number(r.TotalScrap || 0), 0);
        const uom   = rows[0].UnitOfMeasure;
        return `
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <div style="font-weight:700;font-size:14px">${esc(PROCESS_LABELS[pc] || pc)}</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--error)">${total.toFixed(3)} ${esc(uom)} total</div>
            </div>
            <table class="pn-batch-table" style="margin:0">
              <thead><tr><th>Reason</th><th>Entries</th><th>Total Scrap</th><th>UOM</th><th></th></tr></thead>
              <tbody>${rows.map(r => `
                <tr class="pn-row scrap-summary-row" data-pc="${esc(pc)}" data-rc="${esc(r.ReasonCode)}" data-rd="${esc(r.ReasonDescription||r.ReasonCode)}" style="cursor:pointer">
                  <td>${esc(r.ReasonDescription || r.ReasonCode || '—')}</td>
                  <td class="pn-batch-mono">${r.EntryCount}</td>
                  <td class="pn-batch-mono" style="color:var(--error)">${Number(r.TotalScrap).toFixed(3)}</td>
                  <td class="pn-batch-mono">${esc(r.UnitOfMeasure)}</td>
                  <td style="color:var(--text-muted);font-size:11px">↗ drill down</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>`;
      }).join('');
    }

    // ── Failed scrap section ──────────────────────────────────────────────────
    let failedHtml = '';
    if (failed.length) {
      const scrapReasons = (await api('/scrap-reasons')).data || [];
      const reasonOptions = scrapReasons.map(r =>
        `<option value="${r.ReasonID}">${esc(r.ReasonCode)} — ${esc(r.ReasonDescription)}</option>`).join('');

      failedHtml = `
        <div style="margin-bottom:24px">
          <div class="pn-section-hdr" style="color:var(--error)">Failed SAP Postings &nbsp;<span style="font-weight:400;font-size:10px">${failed.length} entr${failed.length!==1?'ies':'y'} approved but not posted</span></div>
          ${failed.map(f => `
            <div id="failed-scrap-${f.ScrapID}" style="background:var(--surface);border:1px solid rgba(220,38,38,0.3);border-radius:10px;padding:14px 16px;margin-bottom:10px">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px">
                <div>
                  <div style="font-weight:700;font-size:14px">${esc(f.BatchRef || f.ProcessCode+String(f.ProcessRecordID).padStart(8,'0'))} &nbsp;·&nbsp; ${esc(PROCESS_LABELS[f.ProcessCode]||f.ProcessCode)}</div>
                  <div class="pn-batch-mono" style="font-size:11px;margin-top:2px">${esc(f.Material||'—')} &nbsp;·&nbsp; ${esc(f.ReasonDescription||f.ReasonCode)} &nbsp;·&nbsp; ${Number(f.Quantity).toFixed(3)} ${esc(f.UnitOfMeasure)}</div>
                </div>
                <span class="pn-status pn-status--cancelled">SAP Failed</span>
              </div>
              <div style="background:rgba(254,226,226,0.6);border-radius:6px;padding:8px 10px;font-size:12px;margin-bottom:10px;font-family:'JetBrains Mono',monospace">
                ${esc(f.SAPErrorMessage || 'No error message recorded')}
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">
                <div class="tf-field">
                  <label class="tf-label">Quantity</label>
                  <input class="tf-input scrap-retry-qty" data-scrapid="${f.ScrapID}" type="number" step="0.001" min="0.001" value="${Number(f.Quantity).toFixed(3)}" style="width:120px">
                </div>
                <div class="tf-field">
                  <label class="tf-label">Reason</label>
                  <select class="tf-input scrap-retry-reason" data-scrapid="${f.ScrapID}" style="width:220px">
                    ${reasonOptions.replace(`value="${f.ReasonID}"`, `value="${f.ReasonID}" selected`)}
                  </select>
                </div>
                <button class="btn-secondary scrap-retry-btn" data-scrapid="${f.ScrapID}">Retry</button>
                <span class="scrap-retry-msg" id="scrap-retry-msg-${f.ScrapID}" style="font-size:12px;align-self:center"></span>
              </div>
            </div>`).join('')}
        </div>`;
    }

    body.innerHTML = `
      <div style="padding:16px 20px">
        ${failedHtml}
        <div class="pn-section-hdr">Posted Scrap (SAP confirmed)</div>
        ${postedHtml}
      </div>`;

    // Wire up drill-down clicks
    document.querySelectorAll('.scrap-summary-row').forEach(row => {
      row.addEventListener('click', () =>
        openScrapDrilldown(row.dataset.pc, row.dataset.rc, row.dataset.rd));
    });

    // Wire up retry buttons
    document.querySelectorAll('.scrap-retry-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const scrapID  = Number(btn.dataset.scrapid);
        const qty      = document.querySelector(`.scrap-retry-qty[data-scrapid="${scrapID}"]`)?.value;
        const reasonEl = document.querySelector(`.scrap-retry-reason[data-scrapid="${scrapID}"]`);
        const msgEl    = document.getElementById(`scrap-retry-msg-${scrapID}`);

        btn.disabled = true; btn.textContent = 'Retrying…';
        if (msgEl) { msgEl.style.color = 'var(--text-muted)'; msgEl.textContent = 'Posting to SAP…'; }

        try {
          const res = await api(`/scrap/${scrapID}/retry`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              quantity: qty ? Number(qty) : undefined,
              reasonID: reasonEl?.value ? Number(reasonEl.value) : undefined,
            }),
          });
          if (!res.success) throw new Error(res.error);
          if (msgEl) { msgEl.style.color = 'var(--accent)'; msgEl.textContent = `✓ Posted — MatDoc: ${res.data?.materialDocument || '—'}`; }
          btn.disabled = false; btn.textContent = 'Retry';
          // Fade out the card after success
          const card = document.getElementById(`failed-scrap-${scrapID}`);
          if (card) { card.style.opacity = '0.4'; card.style.pointerEvents = 'none'; }
        } catch (err) {
          if (msgEl) { msgEl.style.color = 'var(--error)'; msgEl.textContent = err.message; }
          btn.disabled = false; btn.textContent = 'Retry';
        }
      });
    });

  } catch (err) {
    body.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`;
  }
}

async function openScrapDrilldown(processCode, reasonCode, reasonDescription) {
  openModal(`<div class="ps-modal" style="max-width:600px">
    <div class="ps-modal-header">
      <div>
        <div class="ps-modal-title">${esc(reasonDescription)}</div>
        <div class="ps-modal-sub">${esc(PROCESS_LABELS[processCode]||processCode)} &nbsp;·&nbsp; breakdown by material</div>
      </div>
      <button class="ps-modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="ps-modal-body" id="scrap-drill-body">
      <div class="pn-loading"><div class="spinner"></div>Loading…</div>
    </div>
  </div>`);

  try {
    const json    = await api(`/scrap/entries?processCode=${encodeURIComponent(processCode)}&reasonCode=${encodeURIComponent(reasonCode)}`);
    const entries = json.data || [];
    const bodyEl  = document.getElementById('scrap-drill-body');
    if (!bodyEl) return;

    if (!entries.length) {
      bodyEl.innerHTML = '<div class="pn-empty">No entries found.</div>';
      return;
    }

    // Group by material
    const byMaterial = {};
    entries.forEach(e => {
      const mat = e.Material || '—';
      if (!byMaterial[mat]) byMaterial[mat] = [];
      byMaterial[mat].push(e);
    });

    const sections = Object.entries(byMaterial).map(([mat, rows]) => {
      const total = rows.reduce((s, r) => s + Number(r.Quantity), 0);
      const uom   = rows[0].UnitOfMeasure;
      return `
        <div style="margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <div style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:13px">${esc(mat)}</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--error)">${total.toFixed(3)} ${esc(uom)}</div>
          </div>
          <table class="pn-batch-table" style="margin:0">
            <thead><tr><th>Batch</th><th>Qty</th><th>Material Doc</th><th>Entered</th><th>By</th></tr></thead>
            <tbody>${rows.map(r => `<tr>
              <td class="pn-batch-ref">${esc(r.BatchRef || r.ProcessCode+String(r.ProcessRecordID).padStart(8,'0'))}</td>
              <td class="pn-batch-mono" style="color:var(--error)">${Number(r.Quantity).toFixed(3)}</td>
              <td class="pn-batch-mono">${esc(r.SAPMaterialDocument || '—')}</td>
              <td class="pn-batch-mono">${fmt(r.EnteredAt)}</td>
              <td>${esc(r.EnteredBy||'—')}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>`;
    }).join('');

    const grandTotal = entries.reduce((s, e) => s + Number(e.Quantity), 0);
    bodyEl.innerHTML = `
      ${sections}
      <div style="border-top:1px solid var(--border);padding-top:10px;display:flex;justify-content:space-between;font-family:'JetBrains Mono',monospace;font-size:12px">
        <span style="color:var(--text-muted)">${entries.length} entr${entries.length!==1?'ies':'y'} across ${Object.keys(byMaterial).length} material${Object.keys(byMaterial).length!==1?'s':''}</span>
        <span style="color:var(--error);font-weight:700">Grand total: ${grandTotal.toFixed(3)} ${entries[0].UnitOfMeasure}</span>
      </div>`;
  } catch (err) {
    const bodyEl = document.getElementById('scrap-drill-body');
    if (bodyEl) bodyEl.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`;
  }
}

// ── SAP REVERSALS ─────────────────────────────────────────────────────────────

async function runSapReversals() {
  let searchMode = 'matdoc'; // 'matdoc' | 'batch'
  let resultRows = [];

  function renderSearch() {
    document.getElementById('result-body').innerHTML = `
      <div style="padding:16px 20px">
        <div class="bm-section" style="margin-bottom:14px">
          <div class="bm-section-title">Search Mode</div>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <button class="btn-secondary rev-mode-btn ${searchMode==='matdoc'?'btn-secondary--active':''}" data-mode="matdoc">By Material Document</button>
            <button class="btn-secondary rev-mode-btn ${searchMode==='batch'?'btn-secondary--active':''}" data-mode="batch">By Batch Reference</button>
          </div>
          <div id="rev-search-inputs" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
            ${searchMode === 'matdoc' ? `
              <div class="tf-field"><label class="tf-label">Material Document</label>
              <input class="tf-input" id="rev-matdoc" placeholder="e.g. 4973004925" style="width:200px" autocomplete="off"></div>
            ` : `
              <div class="tf-field"><label class="tf-label">Process</label>
              <select class="tf-input" id="rev-pc" style="width:150px">
                ${Object.entries(PROCESS_LABELS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}
              </select></div>
              <div class="tf-field"><label class="tf-label">Record ID</label>
              <input class="tf-input" id="rev-rid" type="number" placeholder="Record ID" style="width:140px"></div>
            `}
            <button class="btn-filter-search" id="rev-search-btn">Search</button>
          </div>
        </div>
        <div id="rev-results"></div>
      </div>`;

    document.querySelectorAll('.rev-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => { searchMode = btn.dataset.mode; renderSearch(); });
    });

    document.getElementById('rev-search-btn').addEventListener('click', doSearch);

    if (searchMode === 'matdoc') {
      document.getElementById('rev-matdoc')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    }
  }

  async function doSearch() {
    const el = document.getElementById('rev-results');
    el.innerHTML = '<div class="pn-loading"><div class="spinner"></div>Searching…</div>';

    try {
      let json;
      if (searchMode === 'matdoc') {
        const doc = document.getElementById('rev-matdoc')?.value.trim();
        if (!doc) { el.innerHTML = '<div class="pn-empty">Enter a material document number.</div>'; return; }
        json = await api(`/reversal/search?materialDocument=${encodeURIComponent(doc)}`);
      } else {
        const pc  = document.getElementById('rev-pc')?.value;
        const rid = document.getElementById('rev-rid')?.value.trim();
        if (!pc || !rid) { el.innerHTML = '<div class="pn-empty">Select a process and enter the record ID.</div>'; return; }
        json = await api(`/reversal/by-batch/${encodeURIComponent(pc)}/${encodeURIComponent(rid)}`);
      }

      resultRows = json.data || [];
      if (!resultRows.length) { el.innerHTML = '<div class="pn-empty">No SAP postings found.</div>'; return; }

      renderResults(el);
    } catch (err) { el.innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`; }
  }

  function renderResults(el) {
    const reversible = resultRows.filter(r => !r.IsReversed && r.MaterialDocumentSAP);
    const badge = document.getElementById('result-row-badge');
    badge.textContent = `${resultRows.length} posting${resultRows.length !== 1 ? 's' : ''}`;
    badge.classList.remove('hidden');

    const tableRows = resultRows.map(r => `
      <tr>
        <td style="width:32px;text-align:center">
          ${!r.IsReversed && r.MaterialDocumentSAP
            ? `<input type="checkbox" class="rev-chk" data-matdoc="${esc(r.MaterialDocumentSAP)}" checked>`
            : ''}
        </td>
        <td class="pn-batch-mono" style="font-weight:700">${esc(r.MaterialDocumentSAP || '—')}</td>
        <td>${esc(r.PostingType)}</td>
        <td class="pn-batch-mono">${Number(r.Quantity||0).toFixed(3)} ${esc(r.UnitOfMeasure||'')}</td>
        <td class="pn-batch-mono">${fmt(r.PostedAt)}</td>
        <td>${esc(r.PostedBy||'—')}</td>
        <td>${r.IsReversed
          ? `<span class="pn-status pn-status--cancelled">Reversed</span><span class="pn-batch-mono" style="font-size:10px;margin-left:4px">${esc(r.ReversalDocumentSAP||'')}</span>`
          : `<span class="pn-status pn-status--open">Not Reversed</span>`}</td>
        <td id="rev-row-${esc(r.MaterialDocumentSAP||r.SAPPostingID)}"></td>
      </tr>`).join('');

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
          <input type="checkbox" id="rev-select-all" checked> Select All
        </label>
        <span style="flex:1"></span>
        <button class="btn-submit" id="rev-bulk-btn" ${!reversible.length?'disabled':''}>
          Reverse Selected
        </button>
      </div>
      <div style="overflow-x:auto">
      <table class="pn-batch-table">
        <thead><tr><th style="width:32px"></th><th>Material Doc</th><th>Type</th><th>Quantity</th><th>Posted</th><th>Posted By</th><th>Status</th><th></th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>
      <div id="rev-bulk-msg" style="margin-top:10px;font-size:13px"></div>`;

    document.getElementById('rev-select-all').addEventListener('change', e => {
      document.querySelectorAll('.rev-chk').forEach(c => { c.checked = e.target.checked; });
    });

    document.getElementById('rev-bulk-btn')?.addEventListener('click', async () => {
      const btn  = document.getElementById('rev-bulk-btn');
      const msg  = document.getElementById('rev-bulk-msg');
      const docs = [...document.querySelectorAll('.rev-chk:checked')].map(c => c.dataset.matdoc);
      if (!docs.length) { msg.style.color = 'var(--error)'; msg.textContent = 'No entries selected.'; return; }

      btn.disabled = true; btn.textContent = `Reversing ${docs.length} document${docs.length!==1?'s':''}…`;
      msg.style.color = 'var(--text-muted)';
      msg.textContent = `Sending ${docs.length} request${docs.length!==1?'s':''} to SAP — this may take ${Math.ceil(docs.length * 12)}s…`;

      try {
        const res = await api('/reversal/bulk', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ materialDocuments: docs }),
        });

        let ok = 0, fail = 0;
        (res.results || []).forEach(r => {
          const rowEl = document.getElementById(`rev-row-${r.materialDocument}`);
          const alreadyReversed = r.error && r.error.includes('Already reversed');
          if (r.success) {
            ok++;
            if (rowEl) rowEl.innerHTML = `<span style="color:var(--accent);font-size:11px;font-family:'JetBrains Mono',monospace">✓ ${esc(r.reversalDocument||'')}</span>`;
          } else if (alreadyReversed) {
            ok++;
            if (rowEl) rowEl.innerHTML = `<span style="color:var(--text-muted);font-size:11px" title="Was reversed in SAP — DB updated">↺ Synced</span>`;
          } else {
            fail++;
            if (rowEl) rowEl.innerHTML = `<span style="color:var(--error);font-size:11px" title="${esc(r.error)}">✗ ${esc(r.error)}</span>`;
          }
        });

        msg.style.color = fail ? '#D97706' : 'var(--accent)';
        msg.textContent = fail
          ? `${ok} reversed successfully, ${fail} failed — see inline results.`
          : `✓ All ${ok} document${ok!==1?'s':''} reversed successfully.`;
        btn.disabled = false; btn.textContent = 'Reverse Selected';
      } catch (err) {
        msg.style.color = 'var(--error)'; msg.textContent = err.message;
        btn.disabled = false; btn.textContent = 'Reverse Selected';
      }
    });
  }

  renderSearch();
}

// ── NEW BATCH ─────────────────────────────────────────────────────────────────

async function runNewBatch() {
  document.getElementById('result-body').innerHTML = '<div class="pn-loading"><div class="spinner"></div>Loading…</div>';
  try {
    const [shiftsJson, wcJson] = await Promise.all([
      api('/shifts'),
      api('/work-centres'),
    ]);
    const shifts = shiftsJson.data || [];
    const wcs    = wcJson.data    || [];

    const processGroups = {};
    wcs.forEach(row => {
      if (!processGroups[row.ProcessCode]) processGroups[row.ProcessCode] = { wc: row, machines: [] };
      if (row.MachineID) processGroups[row.ProcessCode].machines.push(row);
    });

    const processOptions = Object.entries(PROCESS_LABELS)
      .map(([k,v]) => `<option value="${k}">${v} (${k})</option>`).join('');

    const shiftOptions = shifts.map(s => `<option value="${s.ShiftID}">${s.ShiftName} (${s.StartTime}–${s.EndTime})</option>`).join('');

    document.getElementById('result-body').innerHTML = `
      <div style="padding:20px;max-width:600px">
        <div class="transfer-form">
          <div class="tf-row">
            <div class="tf-field">
              <label class="tf-label">Process / Work Centre</label>
              <select class="tf-input" id="nb-process">${processOptions}</select>
            </div>
            <div class="tf-field">
              <label class="tf-label">Shift</label>
              <select class="tf-input" id="nb-shift">${shiftOptions}</select>
            </div>
          </div>
          <div class="tf-row">
            <div class="tf-field tf-field--wide">
              <label class="tf-label">SAP Material Number</label>
              <input class="tf-input" id="nb-material" placeholder="e.g. TSHV3-4B01">
            </div>
          </div>
          <div id="nb-process-extra"></div>
          <div class="tf-row">
            <div class="tf-field tf-field--wide">
              <label class="tf-label">Notes</label>
              <input class="tf-input" id="nb-notes" placeholder="Optional">
            </div>
          </div>
          <div id="nb-result" style="margin-top:8px;font-size:13px"></div>
          <div class="tf-row" style="margin-top:4px">
            <button class="btn-submit" id="nb-create-btn">Create Batch</button>
          </div>
        </div>
      </div>`;

    // Show extra fields based on process
    const updateExtraFields = () => {
      const pc = document.getElementById('nb-process').value;
      let extra = '';
      if (pc === 'MX') {
        extra = `<div class="tf-row">
          <div class="tf-field"><label class="tf-label">Mix Code</label><input class="tf-input" id="nb-mixcode" placeholder="e.g. 10101"></div>
          <div class="tf-field"><label class="tf-label">Supplier Batch No</label><input class="tf-input" id="nb-suppbatch"></div>
          <div class="tf-field"><label class="tf-label">Supplier Tub No</label><input class="tf-input" id="nb-supptub"></div>
        </div>`;
      } else if (pc === 'DR') {
        extra = `<div class="tf-row">
          <div class="tf-field"><label class="tf-label">Product Barcode</label><input class="tf-input" id="nb-barcode"></div>
          <div class="tf-field"><label class="tf-label">SAP Sales Order</label><input class="tf-input" id="nb-salesorder"></div>
        </div>`;
      } else if (pc === 'FW') {
        extra = `<div class="tf-row"><div class="tf-field tf-field--wide"><label class="tf-label">Ewald Batch ID</label><input class="tf-input" id="nb-ewaldid" type="number" placeholder="Enter Ewald record ID"></div></div>`;
      }
      document.getElementById('nb-process-extra').innerHTML = extra;
    };

    document.getElementById('nb-process').addEventListener('change', updateExtraFields);
    updateExtraFields();

    document.getElementById('nb-create-btn').addEventListener('click', async () => {
      const btn      = document.getElementById('nb-create-btn');
      const resultEl = document.getElementById('nb-result');
      const pc       = document.getElementById('nb-process').value;
      const shiftID  = Number(document.getElementById('nb-shift').value);
      const material = document.getElementById('nb-material').value.trim();
      const notes    = document.getElementById('nb-notes').value.trim() || undefined;

      if (!material) { resultEl.textContent = 'Material number is required.'; resultEl.style.color = 'var(--error)'; return; }

      const body = { processCode: pc, shiftID, material, notes };
      if (pc === 'MX') {
        body.mixCode       = document.getElementById('nb-mixcode')?.value.trim();
        body.supplierBatchNo = document.getElementById('nb-suppbatch')?.value.trim();
        body.supplierTubNo   = document.getElementById('nb-supptub')?.value.trim();
      } else if (pc === 'DR') {
        body.productBarcode = document.getElementById('nb-barcode')?.value.trim();
        body.salesOrderSAP  = document.getElementById('nb-salesorder')?.value.trim();
      } else if (pc === 'FW') {
        body.ewaldID = Number(document.getElementById('nb-ewaldid')?.value);
      }

      btn.disabled = true; btn.textContent = 'Creating…';
      try {
        const json = await api('/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!json.success) throw new Error(json.error);
        resultEl.style.color = 'var(--accent)';
        resultEl.textContent = `✓ Created ${json.data.processCode}-${json.data.recordId}`;
        btn.disabled = false; btn.textContent = 'Create Batch';
      } catch (err) {
        resultEl.style.color = 'var(--error)';
        resultEl.textContent = err.message;
        btn.disabled = false; btn.textContent = 'Create Batch';
      }
    });
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`;
  }
}

// ── BATCH MANAGEMENT MODAL ────────────────────────────────────────────────────
// Opened by clicking any batch row in Active Batches or double-clicking in the
// Line Floor ticker. Gives operators full control over a batch in one place.

const QTY_LABELS = {
  MX: 'Weight (KG)', EX:'Length (M)', CO:'Length (M)', BR:'Length (M)',
  CL: 'Length (M)',  TW: 'Length (M)', DR:'Length (M)',
  EW: 'Pieces (EA)', FW: 'Inspected (EA)', HA: 'Quantity (EA)',
};

async function openBatchModal(processCode, recordId) {
  const pc = processCode.toUpperCase();

  // Show loading shell immediately
  openModal(`<div class="ps-modal" style="max-width:680px;width:96vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Loading batch…</div></div>
      <button class="ps-modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="ps-modal-body"><div class="pn-loading"><div class="spinner"></div>Loading…</div></div>
  </div>`);

  try {
    const [batchJson, scrapJson, reasonsJson] = await Promise.all([
      api(`/batch/${pc}/${recordId}`),
      api(`/scrap/entries?processCode=${pc}&processRecordID=${recordId}`),
      api('/scrap-reasons'),
    ]);

    if (!batchJson.success) throw new Error(batchJson.error);

    const { batch, operators } = batchJson.data;
    const scrapEntries = scrapJson.data || [];
    const reasons      = reasonsJson.data || [];

    renderBatchModal(batch, pc, recordId, operators, scrapEntries, reasons);
  } catch (err) {
    document.querySelector('#ps-modal-overlay .ps-modal-body').innerHTML =
      `<div class="pn-empty" style="color:var(--error)">${esc(err.message)}</div>`;
  }
}

function renderBatchModal(batch, pc, recordId, operators, scrapEntries, reasons) {
  const statusNames = { 1:'Open', 2:'Running', 3:'On Hold', 4:'Complete', 5:'Cancelled' };
  const qtyLabel    = QTY_LABELS[pc] || 'Quantity';
  const processName = PROCESS_LABELS[pc] || pc;

  // Status action buttons — show what makes sense for the current status
  const statusActions = (() => {
    const s = batch.Status;
    const btns = [];
    if (s === 1) btns.push(`<button class="btn-submit bm-status-btn"  data-status="2">▶ Start Run</button>`);
    if (s === 2) btns.push(`<button class="btn-secondary bm-status-btn" data-status="3">⏸ Hold</button>`,
                            `<button class="btn-submit bm-status-btn"   data-status="4">✓ Complete</button>`);
    if (s === 3) btns.push(`<button class="btn-submit bm-status-btn"  data-status="2">▶ Resume</button>`,
                            `<button class="btn-secondary bm-status-btn" data-status="5">✕ Cancel</button>`);
    return btns.join('');
  })();

  // Active operators list
  const activeOps = operators.filter(o => !o.RemovedAt);
  const opRows = activeOps.map(o => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px dashed var(--border-soft)">
      <span style="font-size:13px">${esc(o.Username)} ${o.IsPrimary ? '<span class="pn-status pn-status--in-progress" style="font-size:8px">PRIMARY</span>' : ''}</span>
      ${!o.IsPrimary ? `<button class="bm-remove-op btn-secondary" data-uid="${o.UserID}" style="padding:2px 8px;font-size:11px">Remove</button>` : ''}
    </div>`).join('') || '<div style="font-size:12px;color:var(--text-muted);padding:5px 0">No operators assigned.</div>';

  // Scrap entries list
  const scrapRows = scrapEntries.slice(0, 5).map(s => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px dashed var(--border-soft)">
      <span>${esc(s.ReasonDescription || s.ReasonCode)}</span>
      <span class="pn-batch-mono" style="color:var(--error)">${Number(s.Quantity).toFixed(3)} ${esc(s.UnitOfMeasure)}</span>
    </div>`).join('') || '<div style="font-size:12px;color:var(--text-muted);padding:4px 0">No scrap entries yet.</div>';

  const reasonOptions = reasons.map(r => `<option value="${r.ReasonID}">${esc(r.ReasonCode)} — ${esc(r.ReasonDescription)}</option>`).join('');

  // EW-specific: show box count
  const ewaldExtra = pc === 'EW' ? `
    <div class="bm-section">
      <div class="bm-section-title">Boxes Posted</div>
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:8px">
        <div>
          <div class="pf-detail-label">Total Boxes</div>
          <div class="pf-detail-val">${batch.TotalBoxes ?? 0}</div>
        </div>
        <div>
          <div class="pf-detail-label">Total Pieces</div>
          <div class="pf-detail-val">${batch.TotalPiecesEA ?? 0} EA</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:flex-end">
        <div>
          <label class="tf-label">Pieces this box (EA)</label>
          <input class="tf-input" id="bm-box-pieces" type="number" min="1" style="width:120px">
        </div>
        <div>
          <label class="tf-label">Customer Code</label>
          <input class="tf-input" id="bm-box-customer" style="width:120px">
        </div>
        <div>
          <label class="tf-label">SAP Batch</label>
          <input class="tf-input" id="bm-box-sap" style="width:130px">
        </div>
        <button class="btn-submit" id="bm-post-box-btn">Post Box</button>
      </div>
      <div id="bm-box-result" style="font-size:12px;margin-top:6px"></div>
    </div>` : '';

  const html = `<div class="ps-modal" style="max-width:680px;width:96vw">
    <div class="ps-modal-header">
      <div>
        <div class="ps-modal-title">${esc(batch.MixRef || batch.ExtRef || batch.BraidRef || batch.ConvRef || batch.CovRef || batch.TWRef || batch.DrumRef || batch.EwaldRef || batch.FWRef || batch.HARef || `${pc}-${recordId}`)}</div>
        <div class="ps-modal-sub">${esc(processName)} &nbsp;·&nbsp; ${esc(batch.Material)} &nbsp;·&nbsp; ${statusBadge(batch.Status)}</div>
      </div>
      <button class="ps-modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="ps-modal-body" style="display:flex;flex-direction:column;gap:16px">

      <!-- Status actions -->
      ${statusActions ? `<div style="display:flex;gap:8px;flex-wrap:wrap">${statusActions}<span id="bm-status-msg" style="font-size:12px;color:var(--text-muted);align-self:center"></span></div>` : ''}

      <!-- Details grid -->
      <div class="pf-detail-grid" style="border-bottom:none;padding-bottom:0">
        <div><div class="pf-detail-label">Shift</div><div class="pf-detail-val">${esc(batch.ShiftName || String(batch.ShiftID ?? '—'))}</div></div>
        <div><div class="pf-detail-label">Machine</div><div class="pf-detail-val">${esc(batch.MachineCode || '—')}</div></div>
        <div><div class="pf-detail-label">Created</div><div class="pf-detail-val">${fmt(batch.CreatedAt)}</div></div>
        <div><div class="pf-detail-label">Started</div><div class="pf-detail-val">${fmt(batch.StartedAt)}</div></div>
      </div>

      <!-- Quantity update -->
      <div class="bm-section">
        <div class="bm-section-title">${esc(qtyLabel)}</div>
        <div style="display:flex;gap:8px;align-items:center">
          <input class="tf-input" id="bm-qty" type="number" min="0" step="0.001"
                 value="${batch.TotalWeightKG ?? batch.LengthMetres ?? batch.TotalPiecesEA ?? batch.QuantityEA ?? batch.TotalInspectedEA ?? 0}"
                 style="width:160px">
          <button class="btn-submit" id="bm-qty-btn">Update</button>
          <span id="bm-qty-msg" style="font-size:12px;color:var(--text-muted)"></span>
        </div>
      </div>

      ${ewaldExtra}

      <!-- Trace link (scan previous batch) -->
      <div class="bm-section">
        <div class="bm-section-title">Link Previous Batch</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Scan or enter the batch ref of the input batch (e.g. MX00000003)</div>
        <div style="display:flex;gap:6px">
          <select class="tf-input" id="bm-trace-parent-pc" style="width:130px">
            ${Object.entries(PROCESS_LABELS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}
          </select>
          <input class="tf-input" id="bm-trace-rid" type="number" placeholder="Record ID" style="width:130px">
          <button class="btn-submit" id="bm-trace-btn">Link</button>
          <span id="bm-trace-msg" style="font-size:12px;color:var(--text-muted);align-self:center"></span>
        </div>
      </div>

      <!-- Scrap entry -->
      <div class="bm-section">
        <div class="bm-section-title">Scrap</div>
        ${scrapRows}
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
          <select class="tf-input" id="bm-scrap-reason" style="flex:1;min-width:180px">
            <option value="">Select reason…</option>${reasonOptions}
          </select>
          <input class="tf-input" id="bm-scrap-qty" type="number" min="0" step="0.001" placeholder="Quantity" style="width:110px">
          <button class="btn-submit" id="bm-scrap-btn">Add Scrap</button>
        </div>
        <div id="bm-scrap-msg" style="font-size:12px;margin-top:4px"></div>
      </div>

      <!-- Operators -->
      <div class="bm-section">
        <div class="bm-section-title">Operators on this run</div>
        <div id="bm-op-list">${opRows}</div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <input class="tf-input" id="bm-op-search" placeholder="Search username…" style="flex:1">
          <button class="btn-secondary" id="bm-op-search-btn">Search</button>
        </div>
        <div id="bm-op-results" style="margin-top:4px"></div>
        <div id="bm-op-msg" style="font-size:12px;margin-top:4px"></div>
      </div>

      <!-- Event log -->
      <div class="bm-section">
        <div class="bm-section-title">Event log</div>
        <div id="bm-events"><div class="pn-loading"><div class="spinner"></div>Loading…</div></div>
      </div>

    </div>
    <div class="ps-modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Close</button>
    </div>
  </div>`;

  openModal(html);

  // ── Wire up actions ───────────────────────────────────────────────────────

  // Status buttons
  document.querySelectorAll('.bm-status-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newStatus = Number(btn.dataset.status);
      const msg = document.getElementById('bm-status-msg');
      btn.disabled = true;
      try {
        const r = await api(`/batch/${pc}/${recordId}/status`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus }),
        });
        if (!r.success) throw new Error(r.error);
        msg.textContent = 'Updated.';
        // Refresh modal with new data
        await openBatchModal(pc, recordId);
      } catch (err) { msg.textContent = err.message; btn.disabled = false; }
    });
  });

  // Quantity update
  document.getElementById('bm-qty-btn').addEventListener('click', async () => {
    const qty = Number(document.getElementById('bm-qty').value);
    const msg = document.getElementById('bm-qty-msg');
    try {
      const r = await api(`/batch/${pc}/${recordId}/quantity`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: qty }),
      });
      if (!r.success) throw new Error(r.error);
      msg.style.color = 'var(--accent)'; msg.textContent = 'Saved.';
    } catch (err) { msg.style.color = 'var(--error)'; msg.textContent = err.message; }
  });

  // Ewald box posting
  if (pc === 'EW') {
    document.getElementById('bm-post-box-btn')?.addEventListener('click', async () => {
      const pieces   = Number(document.getElementById('bm-box-pieces').value);
      const customer = document.getElementById('bm-box-customer').value.trim() || undefined;
      const sapBatch = document.getElementById('bm-box-sap').value.trim() || undefined;
      const msg      = document.getElementById('bm-box-result');
      if (!pieces) { msg.style.color='var(--error)'; msg.textContent='Pieces required.'; return; }
      try {
        const r = await api(`/ewald/${recordId}/boxes`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ piecesEA: pieces, customerCode: customer, sapBatchNumber: sapBatch }),
        });
        if (!r.success) throw new Error(r.error);
        msg.style.color = 'var(--accent)';
        msg.textContent = `Box posted: ${pieces} EA`;
        document.getElementById('bm-box-pieces').value   = '';
        document.getElementById('bm-box-customer').value = '';
        document.getElementById('bm-box-sap').value      = '';
        await openBatchModal(pc, recordId); // refresh to show updated totals
      } catch (err) { msg.style.color='var(--error)'; msg.textContent=err.message; }
    });
  }

  // Trace link
  document.getElementById('bm-trace-btn').addEventListener('click', async () => {
    const parentPc  = document.getElementById('bm-trace-parent-pc').value;
    const parentRid = Number(document.getElementById('bm-trace-rid').value);
    const msg       = document.getElementById('bm-trace-msg');
    if (!parentRid) { msg.style.color='var(--error)'; msg.textContent='Record ID required.'; return; }
    try {
      const r = await api('/trace', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ childProcessCode: pc, childRecordID: recordId, parentProcessCode: parentPc, parentRecordID: parentRid }),
      });
      if (!r.success) throw new Error(r.error);
      msg.style.color = 'var(--accent)'; msg.textContent = `Linked to ${parentPc}${String(parentRid).padStart(8,'0')}.`;
      document.getElementById('bm-trace-rid').value = '';
    } catch (err) { msg.style.color='var(--error)'; msg.textContent=err.message; }
  });

  // Scrap entry
  document.getElementById('bm-scrap-btn').addEventListener('click', async () => {
    const reasonID = document.getElementById('bm-scrap-reason').value;
    const qty      = Number(document.getElementById('bm-scrap-qty').value);
    const msg      = document.getElementById('bm-scrap-msg');
    if (!reasonID || !qty) { msg.style.color='var(--error)'; msg.textContent='Select a reason and enter a quantity.'; return; }
    const uom = pc === 'MX' ? 'KG' : (pc === 'EW' || pc === 'HA') ? 'EA' : 'M';
    try {
      const r = await api('/scrap', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processCode: pc, processRecordID: recordId, reasonID: Number(reasonID), quantity: qty, unitOfMeasure: uom }),
      });
      if (!r.success) throw new Error(r.error);
      msg.style.color = 'var(--accent)'; msg.textContent = `Scrap recorded: ${qty} ${uom}.`;
      document.getElementById('bm-scrap-qty').value    = '';
      document.getElementById('bm-scrap-reason').value = '';
      await openBatchModal(pc, recordId); // refresh scrap list
    } catch (err) { msg.style.color='var(--error)'; msg.textContent=err.message; }
  });

  // Remove operator buttons
  document.querySelectorAll('.bm-remove-op').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this operator from the batch?')) return;
      btn.disabled = true;
      try {
        const r = await api(`/batch/${pc}/${recordId}/operators/${btn.dataset.uid}`, { method: 'DELETE' });
        if (!r.success) throw new Error(r.error);
        await openBatchModal(pc, recordId); // refresh
      } catch (err) { btn.disabled = false; alert(err.message); }
    });
  });

  // Operator search & add
  document.getElementById('bm-op-search-btn').addEventListener('click', async () => {
    const q   = document.getElementById('bm-op-search').value.trim();
    const el  = document.getElementById('bm-op-results');
    const msg = document.getElementById('bm-op-msg');
    el.innerHTML = '';
    try {
      const r = await api(`/users?q=${encodeURIComponent(q)}`);
      const users = r.data || [];
      if (!users.length) { el.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">No users found.</div>'; return; }
      el.innerHTML = users.map(u => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">
          <span style="font-size:13px">${esc(u.DisplayName||u.Username)}</span>
          <button class="btn-secondary bm-add-op-btn" data-uid="${u.UserID}" style="padding:3px 10px;font-size:11px">Add</button>
        </div>`).join('');
      el.querySelectorAll('.bm-add-op-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const addResult = await api(`/batch/${pc}/${recordId}/operators`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ addUserID: Number(btn.dataset.uid) }),
            });
            if (!addResult.success) throw new Error(addResult.error);
            await openBatchModal(pc, recordId); // refresh
          } catch (err) { msg.style.color='var(--error)'; msg.textContent=err.message; btn.disabled=false; }
        });
      });
    } catch (err) { el.innerHTML = `<div style="font-size:12px;color:var(--error)">${esc(err.message)}</div>`; }
  });

  // Load event log
  loadEventLog(pc, recordId, 'bm-events');
}

// ── MIXING ENTRY ──────────────────────────────────────────────────────────────

async function runMixingEntry() {
  const tubList = [{ supplierTubNo: '', weightKG: '' }];

  function renderTubs() {
    const rows = tubList.map((t, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0">
        <span class="pn-batch-mono" style="width:22px;text-align:right;color:var(--text-muted)">${i+1}.</span>
        <input class="tf-input mx-tub-wt" type="number" placeholder="Weight (KG)" value="${t.weightKG}" data-idx="${i}" step="0.001" min="0.001" style="width:160px">
        <span style="font-size:12px;color:var(--text-muted)">KG</span>
        ${tubList.length > 1 ? `<button class="mx-remove-tub btn-secondary" data-idx="${i}" style="padding:2px 8px;font-size:11px">×</button>` : ''}
      </div>`).join('');

    const total = tubList.reduce((s, t) => s + (Number(t.weightKG) || 0), 0);
    document.getElementById('mx-tub-list').innerHTML = rows;
    document.getElementById('mx-total').textContent = total.toFixed(3) + ' KG';

    document.querySelectorAll('.mx-tub-wt').forEach(inp => {
      inp.addEventListener('input', e => {
        tubList[Number(e.target.dataset.idx)].weightKG = e.target.value;
        const total = tubList.reduce((s, t) => s + (Number(t.weightKG) || 0), 0);
        document.getElementById('mx-total').textContent = total.toFixed(3) + ' KG';
      });
    });
    document.querySelectorAll('.mx-remove-tub').forEach(btn => {
      btn.addEventListener('click', () => { tubList.splice(Number(btn.dataset.idx), 1); renderTubs(); });
    });
  }

  document.getElementById('result-body').innerHTML = `
    <div style="padding:20px;max-width:600px">
      <div style="margin-bottom:14px;font-size:13px;color:var(--text-muted)">
        Enter mixing details and each supplier tub. A separate SAP posting and label is generated per tub.
        Shift is determined automatically from the current time.
      </div>
      <div class="transfer-form">
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Mix Code / Material</label>
            <input class="tf-input" id="mx-mixcode" placeholder="e.g. 10101" autocomplete="off">
          </div>
          <div class="tf-field">
            <label class="tf-label">Supplier Batch No</label>
            <input class="tf-input" id="mx-suppbatch" placeholder="Supplier batch ref">
          </div>
          <div class="tf-field">
            <label class="tf-label">Supplier Tub No</label>
            <input class="tf-input" id="mx-supptub" placeholder="Tub reference">
          </div>
        </div>
        <div class="bm-section" style="margin:10px 0">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div class="bm-section-title" style="margin:0">Tubs</div>
            <span style="font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;color:var(--accent)" id="mx-total">0.000 KG</span>
          </div>
          <div id="mx-tub-list"></div>
          <button class="btn-secondary" id="mx-add-tub" style="margin-top:8px">+ Add Tub</button>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Notes (optional)</label>
            <input class="tf-input" id="mx-notes" placeholder="Any comments…">
          </div>
        </div>
        <div id="mx-result" style="margin:8px 0;font-size:13px;min-height:20px"></div>
        <div class="tf-row">
          <button class="btn-submit" id="mx-submit-btn" style="min-width:160px">Post to SAP</button>
          <span style="font-size:11px;color:var(--text-muted);align-self:center">Shift detected automatically</span>
        </div>
      </div>
    </div>`;

  renderTubs();

  document.getElementById('mx-add-tub').addEventListener('click', () => {
    tubList.push({ supplierTubNo: '', weightKG: '' });
    renderTubs();
  });

  document.getElementById('mx-submit-btn').addEventListener('click', async () => {
    const btn     = document.getElementById('mx-submit-btn');
    const result  = document.getElementById('mx-result');
    const mixCode = document.getElementById('mx-mixcode').value.trim();

    // Collect latest values from DOM before submission
    document.querySelectorAll('.mx-tub-wt').forEach(inp => { tubList[Number(inp.dataset.idx)].weightKG = inp.value; });
    const validTubs = tubList.filter(t => Number(t.weightKG) > 0);

    if (!mixCode) {
      result.style.color = 'var(--error)'; result.textContent = 'Mix Code is required.'; return;
    }
    if (!validTubs.length) {
      result.style.color = 'var(--error)'; result.textContent = 'At least one tub weight is required.'; return;
    }

    btn.disabled = true; btn.textContent = 'Posting to SAP…';
    result.style.color = 'var(--text-muted)';
    result.textContent = `Inserting record and posting ${validTubs.length} tub(s) to SAP…`;

    try {
      const json = await api('/mixing/entry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mixCode,
          supplierBatchNo: document.getElementById('mx-suppbatch').value.trim(),
          supplierTubNo:   document.getElementById('mx-supptub').value.trim(),
          tubs: validTubs.map(t => ({ weightKG: Number(t.weightKG) })),
          notes: document.getElementById('mx-notes').value.trim() || undefined,
        }),
      });

      const d   = json.data || {};
      const ref = `MX${String(d.MixingID || 0).padStart(8,'0')}`;

      if (d.status === 'SAP_FAILED') {
        const failCount = (d.tubs || []).filter(t => !t.success).length;
        result.style.color = '#D97706';
        result.innerHTML = `⚠ ${ref} saved but ${failCount} tub(s) failed SAP.<br>
          <span style="font-size:12px">See Failed Backflush queue for supervisor retry.</span>`;
        btn.disabled = false; btn.textContent = 'Post to SAP';
      } else if (json.success) {
        const docs = (d.tubs || []).map(t => t.materialDocument).filter(Boolean).join(', ');
        result.style.color = 'var(--accent)';
        result.innerHTML = `✓ ${ref} — ${validTubs.length} tub(s) posted · MatDocs: ${esc(docs || '—')}`;
        tubList.length = 0;
        tubList.push({ weightKG: '' });
        ['mx-mixcode','mx-suppbatch','mx-supptub','mx-notes'].forEach(id => { document.getElementById(id).value = ''; });
        renderTubs();
        btn.disabled = false; btn.textContent = 'Post to SAP';
      } else {
        throw new Error(json.error || 'Unknown error');
      }
    } catch (err) {
      result.style.color = 'var(--error)'; result.textContent = err.message;
      btn.disabled = false; btn.textContent = 'Post to SAP';
    }
  });
}

// ── DRUMMING WIZARD ───────────────────────────────────────────────────────────

const PACKAGING_TYPES = ['SB','MB','LB','XB','SD','MD','LD','XD'];
const PACKAGING_LABELS = {
  SB:'Small Box', MB:'Medium Box', LB:'Large Box', XB:'Pizza Box',
  SD:'Small Drum', MD:'Medium Drum', LD:'Large Drum', XD:'Extra Large Drum',
};

async function runDrummingEntry() {
  // Wizard state
  const state = {
    phase: 1,
    material: '', bomComponents: [],
    parentBatches: [],
    additionalOperators: [],
    packagingType: '', testPressurePSI: null,
    coilLengths: [],
    hasScrap: false, scrapTotalKG: 0, scrapReasons: [],
    salesOrderSAP: '', customerID: '', notes: '',
  };

  const reasons = (await api('/scrap-reasons?pc=DR')).data || [];

  const render = () => {
    document.getElementById('result-body').innerHTML = `
      <div style="padding:20px;max-width:600px">
        <div class="pn-wizard-steps" id="dw-steps"></div>
        <div id="dw-phase-body"></div>
        <div style="display:flex;gap:8px;margin-top:16px">
          ${state.phase > 1 ? `<button class="btn-secondary" id="dw-back">← Back</button>` : ''}
          <button class="btn-submit" id="dw-next">${state.phase === 6 ? 'Submit & Post to SAP' : 'Next →'}</button>
          <span id="dw-msg" style="font-size:12px;color:var(--error);align-self:center"></span>
        </div>
      </div>`;

    renderDrummingPhase(state, reasons);

    document.getElementById('dw-next')?.addEventListener('click', () => advanceDrumming(state, reasons, render));
    document.getElementById('dw-back')?.addEventListener('click', () => { state.phase--; render(); });
  };

  render();
}

function renderDrummingPhase(state, reasons) {
  const steps = ['Material','Traceability & Operators','Packaging','Coil Lengths','Scrap','Review & Submit'];
  document.getElementById('dw-steps').innerHTML = steps.map((s, i) => `
    <span style="font-family:'JetBrains Mono',monospace;font-size:10px;padding:3px 10px;border-radius:20px;
      background:${i+1===state.phase?'var(--accent)':i+1<state.phase?'rgba(13,148,136,0.15)':'var(--surface2)'};
      color:${i+1===state.phase?'#fff':i+1<state.phase?'var(--accent)':'var(--text-muted)'};
      border:1px solid ${i+1<=state.phase?'var(--accent)':'var(--border)'}">${i+1}. ${s}</span>`).join('');

  const body = document.getElementById('dw-phase-body');

  if (state.phase === 1) {
    body.innerHTML = `
      <div class="bm-section" style="margin-bottom:0">
        <div class="bm-section-title">Phase 1 — Material</div>
        <div class="tf-field" style="margin-bottom:12px">
          <label class="tf-label">SAP Material Number</label>
          <input class="tf-input" id="dw-material" value="${esc(state.material)}" placeholder="e.g. TSHV3-4B01">
        </div>
        <div id="dw-bom-result" style="font-size:12px;color:var(--text-muted)">
          ${state.bomComponents.length ? `BOM loaded: ${state.bomComponents.length} component(s)` : ''}
        </div>
      </div>`;

  } else if (state.phase === 2) {
    const opTags = state.additionalOperators.map(u =>
      `<span style="display:inline-flex;align-items:center;gap:5px;background:var(--accent-dim);border:1px solid var(--accent);border-radius:4px;padding:2px 8px;font-size:12px">
        ${esc(u.username)} <button class="dw-remove-op" data-uid="${u.uid}" style="background:none;border:none;color:var(--error);cursor:pointer;font-size:14px">×</button>
       </span>`).join(' ');

    const batchTags = state.parentBatches.length
      ? state.parentBatches.map((pb, i) =>
          `<span style="display:inline-flex;align-items:center;gap:5px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:12px;font-family:'JetBrains Mono',monospace">
            ${esc(pb.processCode)}${String(pb.recordID).padStart(8,'0')}
            <button class="dw-remove-batch" data-idx="${i}" style="background:none;border:none;color:var(--error);cursor:pointer;font-size:14px">×</button>
           </span>`).join(' ')
      : `<span style="font-size:12px;color:var(--text-muted)">No batches added yet</span>`;

    const bomInfo = state.bomComponents.length
      ? `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px;font-size:12px;margin-bottom:12px">
          <div style="font-weight:700;margin-bottom:4px">BOM for ${esc(state.material)}</div>
          ${state.bomComponents.map(c=>`<div class="pn-batch-mono">${esc(c.material || c.componentMaterial || '')} — ${c.quantityPer} per unit</div>`).join('')}
         </div>` : '';

    body.innerHTML = `
      <div class="bm-section" style="margin-bottom:0">
        <div class="bm-section-title">Phase 2 — Traceability &amp; Operators</div>
        ${bomInfo}
        <div style="margin-bottom:12px">
          <label class="tf-label">Previous Stage Batches</label>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Add each input batch — a drum can consume multiple upstream records.</div>
          <div style="display:flex;gap:6px;margin-bottom:8px">
            <select class="tf-input" id="dw-parent-pc" style="width:140px">
              ${Object.entries(PROCESS_LABELS).filter(([k])=>k!=='DR').map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}
            </select>
            <input class="tf-input" id="dw-parent-rid" type="number" placeholder="Record ID" style="width:130px">
            <button class="btn-secondary" id="dw-add-batch">+ Add</button>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">${batchTags}</div>
        </div>
        <div style="margin-bottom:10px">
          <label class="tf-label">Additional Operators</label>
          <div style="display:flex;gap:6px;margin-top:4px">
            <input class="tf-input" id="dw-op-q" placeholder="Search username…" style="flex:1">
            <button class="btn-secondary" id="dw-op-search">Search</button>
          </div>
          <div id="dw-op-results" style="margin-top:6px"></div>
          <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">${opTags}</div>
        </div>
      </div>`;

    document.getElementById('dw-add-batch')?.addEventListener('click', () => {
      const pc  = document.getElementById('dw-parent-pc')?.value;
      const rid = Number(document.getElementById('dw-parent-rid')?.value);
      if (!pc || !rid) return;
      if (!state.parentBatches.find(pb => pb.processCode === pc && pb.recordID === rid)) {
        state.parentBatches.push({ processCode: pc, recordID: rid });
      }
      renderDrummingPhase(state, reasons);
    });

    document.querySelectorAll('.dw-remove-batch').forEach(btn => {
      btn.addEventListener('click', () => {
        state.parentBatches.splice(Number(btn.dataset.idx), 1);
        renderDrummingPhase(state, reasons);
      });
    });

    document.querySelectorAll('.dw-remove-op').forEach(btn => {
      btn.addEventListener('click', () => {
        state.additionalOperators = state.additionalOperators.filter(u => u.uid !== Number(btn.dataset.uid));
        renderDrummingPhase(state, reasons);
      });
    });

    document.getElementById('dw-op-search')?.addEventListener('click', async () => {
      const q = document.getElementById('dw-op-q').value.trim();
      const el = document.getElementById('dw-op-results');
      const r = await api(`/users?q=${encodeURIComponent(q)}`);
      el.innerHTML = (r.data||[]).map(u => `
        <div style="display:flex;justify-content:space-between;padding:3px 0">
          <span style="font-size:13px">${esc(u.DisplayName||u.Username)}</span>
          <button class="btn-secondary dw-add-op" data-uid="${u.UserID}" data-name="${esc(u.DisplayName||u.Username)}" style="padding:2px 8px;font-size:11px">Add</button>
        </div>`).join('');
      el.querySelectorAll('.dw-add-op').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!state.additionalOperators.find(u => u.uid === Number(btn.dataset.uid))) {
            state.additionalOperators.push({ uid: Number(btn.dataset.uid), username: btn.dataset.name });
          }
          renderDrummingPhase(state, reasons);
        });
      });
    });

  } else if (state.phase === 3) {
    body.innerHTML = `
      <div class="bm-section" style="margin-bottom:0">
        <div class="bm-section-title">Phase 3 — Packaging &amp; Test Pressure</div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Packaging Type</label>
            <select class="tf-input" id="dw-pkg">
              <option value="">Select…</option>
              ${PACKAGING_TYPES.map(t=>`<option value="${t}" ${state.packagingType===t?'selected':''}>${t} — ${PACKAGING_LABELS[t]}</option>`).join('')}
            </select>
          </div>
          <div class="tf-field">
            <label class="tf-label">Pressure Test</label>
            <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px">
              <input type="checkbox" id="dw-test-chk" ${state.testPressurePSI!==null?'checked':''}> Apply pressure test
            </label>
          </div>
        </div>
        <div id="dw-psi-row" style="display:${state.testPressurePSI!==null?'block':'none'}">
          <div class="tf-field">
            <label class="tf-label">Test Pressure (PSI)</label>
            <input class="tf-input" id="dw-psi" type="number" min="0" step="0.1" value="${state.testPressurePSI||''}" style="width:160px">
          </div>
        </div>
      </div>`;

    document.getElementById('dw-test-chk')?.addEventListener('change', e => {
      document.getElementById('dw-psi-row').style.display = e.target.checked ? 'block' : 'none';
      if (!e.target.checked) state.testPressurePSI = null;
    });

  } else if (state.phase === 4) {
    const coilRows = state.coilLengths.map((l, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0">
        <span class="pn-batch-mono" style="width:28px;text-align:right;color:var(--text-muted)">${i+1}.</span>
        <input class="tf-input dw-coil-input" type="number" min="0.001" step="0.001" value="${l}" data-idx="${i}" style="width:140px">
        <span style="font-size:12px;color:var(--text-muted)">M</span>
        <button class="dw-remove-coil btn-secondary" data-idx="${i}" style="padding:2px 8px;font-size:11px">×</button>
      </div>`).join('');

    const total = state.coilLengths.reduce((s, l) => s + Number(l), 0);

    body.innerHTML = `
      <div class="bm-section" style="margin-bottom:0">
        <div class="bm-section-title">Phase 4 — Coil Lengths</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Enter each coil length in metres. The total is calculated automatically.</div>
        <div id="dw-coil-list">${coilRows}</div>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
          <input class="tf-input" id="dw-new-coil" type="number" min="0.001" step="0.001" placeholder="Length (M)" style="width:140px">
          <button class="btn-secondary" id="dw-add-coil">+ Add Coil</button>
          <span style="font-size:13px;font-weight:700;color:var(--accent);margin-left:auto">Total: ${total.toFixed(3)} M</span>
        </div>
      </div>`;

    document.getElementById('dw-add-coil')?.addEventListener('click', () => {
      const v = Number(document.getElementById('dw-new-coil').value);
      if (v > 0) { state.coilLengths.push(v); renderDrummingPhase(state, reasons); }
    });
    document.querySelectorAll('.dw-coil-input').forEach(inp => {
      inp.addEventListener('change', e => { state.coilLengths[Number(e.target.dataset.idx)] = Number(e.target.value); });
    });
    document.querySelectorAll('.dw-remove-coil').forEach(btn => {
      btn.addEventListener('click', () => { state.coilLengths.splice(Number(btn.dataset.idx), 1); renderDrummingPhase(state, reasons); });
    });

  } else if (state.phase === 5) {
    const reasonRows = state.scrapReasons.map((r, i) => `
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <select class="tf-input dw-scrap-reason" data-idx="${i}" style="flex:1">
          <option value="">Select reason…</option>
          ${reasons.map(sr=>`<option value="${sr.ReasonID}" ${Number(r.reasonID)===sr.ReasonID?'selected':''}>${esc(sr.ReasonCode)} — ${esc(sr.ReasonDescription)}</option>`).join('')}
        </select>
        <input class="tf-input dw-scrap-occ" type="number" min="1" step="1" value="${r.occurrences||1}" data-idx="${i}" style="width:90px" placeholder="Count">
        <button class="dw-remove-reason btn-secondary" data-idx="${i}" style="padding:2px 8px;font-size:11px">×</button>
      </div>`).join('');

    body.innerHTML = `
      <div class="bm-section" style="margin-bottom:0">
        <div class="bm-section-title">Phase 5 — Scrap</div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:12px">
          <input type="checkbox" id="dw-has-scrap" ${state.hasScrap?'checked':''}> Scrap to record for this drum
        </label>
        <div id="dw-scrap-fields" style="display:${state.hasScrap?'block':'none'}">
          <div class="tf-field" style="margin-bottom:8px">
            <label class="tf-label">Total Scrap Weight (KG)</label>
            <input class="tf-input" id="dw-scrap-kg" type="number" min="0" step="0.001" value="${state.scrapTotalKG||''}" style="width:160px">
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Add each scrap reason and enter how many times it occurred. The weight is split proportionally by occurrence count.</div>
          <div id="dw-reason-rows">${reasonRows}</div>
          <button class="btn-secondary" id="dw-add-reason" style="margin-top:8px">+ Add Reason</button>
        </div>
      </div>`;

    document.getElementById('dw-has-scrap')?.addEventListener('change', e => {
      state.hasScrap = e.target.checked;
      document.getElementById('dw-scrap-fields').style.display = e.target.checked ? 'block' : 'none';
    });
    document.getElementById('dw-add-reason')?.addEventListener('click', () => {
      state.scrapReasons.push({ reasonID: '', occurrences: 1 });
      renderDrummingPhase(state, reasons);
    });
    document.querySelectorAll('.dw-remove-reason').forEach(btn => {
      btn.addEventListener('click', () => { state.scrapReasons.splice(Number(btn.dataset.idx),1); renderDrummingPhase(state, reasons); });
    });
    document.querySelectorAll('.dw-scrap-reason').forEach(sel => {
      sel.addEventListener('change', e => { state.scrapReasons[Number(e.target.dataset.idx)].reasonID = Number(e.target.value); });
    });
    document.querySelectorAll('.dw-scrap-occ').forEach(inp => {
      inp.addEventListener('change', e => { state.scrapReasons[Number(e.target.dataset.idx)].occurrences = Number(e.target.value); });
    });

  } else if (state.phase === 6) {
    const total = state.coilLengths.reduce((s,l) => s+Number(l), 0);
    body.innerHTML = `
      <div class="bm-section" style="margin-bottom:0">
        <div class="bm-section-title">Phase 6 — Sales Order, Customer &amp; Comments</div>
        <div class="tf-row" style="margin-bottom:10px">
          <div class="tf-field">
            <label class="tf-label">Sales Order (optional)</label>
            <input class="tf-input" id="dw-salesorder" value="${esc(state.salesOrderSAP)}" placeholder="e.g. 4500012345">
          </div>
          <div class="tf-field">
            <label class="tf-label">Customer (optional)</label>
            <input class="tf-input" id="dw-customer" value="${esc(state.customerID)}" placeholder="Customer name or ID">
          </div>
        </div>
        <div class="tf-field" style="margin-bottom:14px">
          <label class="tf-label">Comments (optional)</label>
          <input class="tf-input" id="dw-comments" value="${esc(state.notes)}" placeholder="Any notes for this drum…">
        </div>
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px">
          <div style="font-weight:700;margin-bottom:8px">Summary</div>
          <div class="pn-batch-mono">Material: ${esc(state.material)}</div>
          <div class="pn-batch-mono">Packaging: ${esc(state.packagingType)} (${esc(PACKAGING_LABELS[state.packagingType]||'—')})</div>
          <div class="pn-batch-mono">Test Pressure: ${state.testPressurePSI ? state.testPressurePSI+' PSI' : 'None'}</div>
          <div class="pn-batch-mono">Coils: ${state.coilLengths.length} — Total: ${total.toFixed(3)} M</div>
          <div class="pn-batch-mono">Scrap: ${state.hasScrap ? state.scrapTotalKG+' KG across '+state.scrapReasons.length+' reason(s)' : 'None'}</div>
          <div class="pn-batch-mono">Prev batches: ${state.parentBatches.length ? state.parentBatches.map(pb=>`${pb.processCode}${String(pb.recordID).padStart(8,'0')}`).join(', ') : 'None'}</div>
          <div class="pn-batch-mono">Sales Order: ${esc(state.salesOrderSAP || '—')}</div>
          <div class="pn-batch-mono">Customer: ${esc(state.customerID || '—')}</div>
        </div>
        <div id="dw-submit-result" style="margin-top:10px;font-size:13px"></div>
      </div>`;
  }
}

async function advanceDrumming(state, reasons, render) {
  const msg = document.getElementById('dw-msg');
  if (msg) msg.textContent = '';

  if (state.phase === 1) {
    const mat = document.getElementById('dw-material')?.value.trim();
    if (!mat) { if(msg) msg.textContent = 'Material number is required.'; return; }
    state.material = mat;
    // Fetch BOM
    const bomEl = document.getElementById('dw-bom-result');
    if (bomEl) bomEl.textContent = 'Fetching BOM…';
    try {
      const bomJson = await api('/drumming/bom', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ material: mat }),
      });
      state.bomComponents = bomJson.data || [];
      if (bomEl) bomEl.textContent = state.bomComponents.length
        ? `BOM loaded: ${state.bomComponents.map(c=>`${c.material||c.componentMaterial||''} (${c.quantityPer}/unit)`).join(', ')}`
        : 'No BOM components returned — proceeding.';
    } catch (_) {
      if (bomEl) bomEl.textContent = 'BOM lookup unavailable — proceeding without validation.';
    }

  } else if (state.phase === 2) {
    // parentBatches already maintained in state via add/remove buttons — nothing to read here

  } else if (state.phase === 3) {
    const pkg = document.getElementById('dw-pkg')?.value;
    if (!pkg) { if(msg) msg.textContent = 'Please select a packaging type.'; return; }
    state.packagingType = pkg;
    const psiChecked = document.getElementById('dw-test-chk')?.checked;
    state.testPressurePSI = psiChecked ? (Number(document.getElementById('dw-psi')?.value) || null) : null;

  } else if (state.phase === 4) {
    // Collect latest values from inputs before advancing
    document.querySelectorAll('.dw-coil-input').forEach(inp => {
      state.coilLengths[Number(inp.dataset.idx)] = Number(inp.value);
    });
    if (!state.coilLengths.length) { if(msg) msg.textContent = 'At least one coil length is required.'; return; }

  } else if (state.phase === 5) {
    state.hasScrap = document.getElementById('dw-has-scrap')?.checked || false;
    if (state.hasScrap) {
      state.scrapTotalKG = Number(document.getElementById('dw-scrap-kg')?.value) || 0;
      if (!state.scrapTotalKG) { if(msg) msg.textContent = 'Enter total scrap weight.'; return; }
    }

  } else if (state.phase === 6) {
    // Final submission
    state.salesOrderSAP = document.getElementById('dw-salesorder')?.value.trim() || '';
    state.customerID    = document.getElementById('dw-customer')?.value.trim() || '';
    state.notes         = document.getElementById('dw-comments')?.value.trim() || '';

    const submitBtn = document.getElementById('dw-next');
    const resultEl  = document.getElementById('dw-submit-result');
    submitBtn.disabled = true; submitBtn.textContent = 'Submitting…';

    try {
      const json = await api('/drumming/entry', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          material:             state.material,
          parentBatches:        state.parentBatches,
          additionalOperatorIDs: state.additionalOperators.map(u => u.uid),
          packagingType:        state.packagingType,
          testPressurePSI:      state.testPressurePSI,
          coilLengths:          state.coilLengths,
          hasScrap:             state.hasScrap,
          scrapTotalKG:         state.hasScrap ? state.scrapTotalKG : 0,
          scrapReasons:         state.hasScrap ? state.scrapReasons : [],
          salesOrderSAP:        state.salesOrderSAP || undefined,
          customerID:           state.customerID    || undefined,
          notes:                state.notes,
        }),
      });

      if (json.data?.status === 'SAP_FAILED') {
        resultEl.style.color = '#D97706';
        resultEl.innerHTML = `⚠ Saved as DR${String(json.data.drummingID).padStart(8,'0')} but SAP failed.<br>
          <span style="font-size:12px">${esc(json.data.error)}</span><br>
          <span style="font-size:12px">Now in the Failed Backflush queue for supervisor review.</span>`;
      } else {
        resultEl.style.color = 'var(--accent)';
        resultEl.innerHTML = `✓ DR${String(json.data.drummingID).padStart(8,'0')} posted successfully.<br>
          <span style="font-size:12px">MatDoc: ${esc(json.data.materialDocument||'—')}</span>
          ${json.data.warning ? `<br><span style="font-size:12px;color:#D97706">⚠ ${esc(json.data.warning)}</span>` : ''}`;
      }
      submitBtn.disabled = false; submitBtn.textContent = 'Submit & Post to SAP';
    } catch (err) {
      resultEl.style.color = 'var(--error)';
      resultEl.textContent = err.message;
      submitBtn.disabled = false; submitBtn.textContent = 'Submit & Post to SAP';
    }
    return; // don't advance phase
  }

  state.phase++;
  render();
}

// ── FAILED BACKFLUSH QUEUE ────────────────────────────────────────────────────

async function runFailedBackflush() {
  document.getElementById('result-body').innerHTML = '<div class="pn-loading"><div class="spinner"></div>Loading…</div>';
  try {
    const json = await api('/failed-backflush');
    const rows = json.data || [];

    const badge = document.getElementById('result-row-badge');
    badge.textContent = `${rows.length} failed`;
    badge.classList.remove('hidden');
    if (badge.parentElement) badge.style.background = rows.length ? 'rgba(220,38,38,0.12)' : '';

    if (!rows.length) {
      document.getElementById('result-body').innerHTML = '<div class="pn-empty" style="color:var(--accent)">✓ No failed backflushes — all clear.</div>';
      return;
    }

    const cards = rows.map(r => `
      <div style="background:var(--surface);border:1px solid rgba(220,38,38,0.3);border-radius:10px;padding:14px 16px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:8px">
          <div>
            <div style="font-weight:700;font-size:14px">${esc(r.BatchRef)} · ${esc(PROCESS_LABELS[r.ProcessCode]||r.ProcessCode)}</div>
            <div class="pn-batch-mono" style="font-size:11px;margin-top:2px">${esc(r.Material)} · ${Number(r.Quantity).toFixed(3)} ${esc(r.UOM)} · ${fmt(r.CreatedAt)}</div>
          </div>
          <span class="pn-status pn-status--cancelled">SAP Failed</span>
        </div>
        <div style="background:var(--red-dim,rgba(254,226,226,0.6));border-radius:6px;padding:8px 10px;font-size:12px;margin-bottom:10px;font-family:'JetBrains Mono',monospace">
          ${esc(r.ErrorMessage || 'No error message recorded')}
        </div>
        <button class="btn-submit fbf-retry-btn" data-pc="${esc(r.ProcessCode)}" data-rid="${r.RecordID}" data-ref="${esc(r.BatchRef)}">
          Retry / Edit &amp; Re-submit
        </button>
      </div>`).join('');

    document.getElementById('result-body').innerHTML = `<div style="padding:16px 20px">${cards}</div>`;

    document.querySelectorAll('.fbf-retry-btn').forEach(btn => {
      btn.addEventListener('click', () => openRetryModal(btn.dataset.pc, Number(btn.dataset.rid), btn.dataset.ref));
    });
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="pn-empty">${esc(err.message)}</div>`;
  }
}

async function openRetryModal(processCode, recordId, batchRef) {
  const pc = processCode.toUpperCase();
  const METRE_PCS = new Set(['EX','CO','BR','CL','TW']);

  // Load current record data
  const batchJson = await api(`/batch/${pc}/${recordId}`);
  const b = batchJson.data?.batch || {};

  // Build full edit form for each process type
  let editFields = '';
  let collectBody = () => ({});

  if (pc === 'MX') {
    editFields = `
      <div class="tf-row">
        <div class="tf-field tf-field--wide"><label class="tf-label">Mix Code / Material</label>
          <input class="tf-input" id="rt-mixcode" value="${esc(b.MixCode||'')}"></div>
      </div>
      <div class="tf-row">
        <div class="tf-field"><label class="tf-label">Supplier Batch No</label>
          <input class="tf-input" id="rt-sbn" value="${esc(b.SupplierBatchNo||'')}"></div>
        <div class="tf-field"><label class="tf-label">Supplier Tub No</label>
          <input class="tf-input" id="rt-stn" value="${esc(b.SupplierTubNo||'')}"></div>
      </div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide"><label class="tf-label">Notes</label>
          <input class="tf-input" id="rt-notes" value="${esc(b.Notes||'')}" placeholder="Any comments…"></div>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">All failed tubs will be re-submitted to SAP automatically.</div>`;
    collectBody = () => ({
      mixCode:         document.getElementById('rt-mixcode')?.value.trim() || undefined,
      supplierBatchNo: document.getElementById('rt-sbn')?.value.trim()     || undefined,
      supplierTubNo:   document.getElementById('rt-stn')?.value.trim()     || undefined,
      notes:           document.getElementById('rt-notes')?.value.trim()   || undefined,
    });

  } else if (pc === 'DR') {
    editFields = `
      <div class="tf-row">
        <div class="tf-field tf-field--wide"><label class="tf-label">Material</label>
          <input class="tf-input" id="rt-material" value="${esc(b.Material||'')}"></div>
        <div class="tf-field"><label class="tf-label">Packaging Type</label>
          <input class="tf-input" id="rt-pkg" value="${esc(b.PackagingType||'')}" placeholder="e.g. MD" style="width:90px"></div>
      </div>
      <div class="tf-row">
        <div class="tf-field"><label class="tf-label">Test Pressure (PSI)</label>
          <input class="tf-input" id="rt-psi" type="number" step="0.1" value="${b.TestPressurePSI!=null?b.TestPressurePSI:''}" placeholder="—"></div>
        <div class="tf-field"><label class="tf-label">Sales Order</label>
          <input class="tf-input" id="rt-so" value="${esc(b.SalesOrderSAP||'')}"></div>
        <div class="tf-field"><label class="tf-label">Customer</label>
          <input class="tf-input" id="rt-customer" value="${esc(b.CustomerID||'')}"></div>
      </div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide"><label class="tf-label">Notes</label>
          <input class="tf-input" id="rt-notes" value="${esc(b.Notes||'')}" placeholder="Any comments…"></div>
      </div>`;
    collectBody = () => ({
      material:       document.getElementById('rt-material')?.value.trim() || undefined,
      packagingType:  document.getElementById('rt-pkg')?.value.trim()      || undefined,
      testPressurePSI:document.getElementById('rt-psi')?.value             ? Number(document.getElementById('rt-psi').value) : undefined,
      salesOrderSAP:  document.getElementById('rt-so')?.value.trim()       || undefined,
      customerID:     document.getElementById('rt-customer')?.value.trim() || undefined,
      notes:          document.getElementById('rt-notes')?.value.trim()    || undefined,
    });

  } else if (METRE_PCS.has(pc)) {
    editFields = `
      <div class="tf-row">
        <div class="tf-field tf-field--wide"><label class="tf-label">Material</label>
          <input class="tf-input" id="rt-material" value="${esc(b.Material||'')}"></div>
        <div class="tf-field"><label class="tf-label">Length (M)</label>
          <input class="tf-input" id="rt-length" type="number" step="0.001" min="0.001" value="${b.LengthMetres||''}"></div>
      </div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide"><label class="tf-label">Notes</label>
          <input class="tf-input" id="rt-notes" value="${esc(b.Notes||'')}" placeholder="Any comments…"></div>
      </div>`;
    collectBody = () => ({
      material:    document.getElementById('rt-material')?.value.trim() || undefined,
      lengthMetres:document.getElementById('rt-length')?.value          ? Number(document.getElementById('rt-length').value) : undefined,
      notes:       document.getElementById('rt-notes')?.value.trim()   || undefined,
    });

  } else {
    editFields = `<div style="font-size:13px;color:var(--text-muted)">No editable fields available for this process type yet.</div>`;
  }

  openModal(`<div class="ps-modal" style="max-width:580px">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Retry: ${esc(batchRef)}</div>
      <div class="ps-modal-sub">${esc(PROCESS_LABELS[pc]||pc)} · Supervisor re-submission</div></div>
      <button class="ps-modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:14px">
        Correct any fields below then re-submit to SAP.
      </div>
      <div class="transfer-form">${editFields}</div>
      <div id="rt-result" style="margin-top:10px;font-size:13px"></div>
    </div>
    <div class="ps-modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-submit" id="rt-submit">Re-submit to SAP</button>
    </div>
  </div>`);

  document.getElementById('rt-submit').addEventListener('click', async () => {
    const btn    = document.getElementById('rt-submit');
    const result = document.getElementById('rt-result');
    btn.disabled = true; btn.textContent = 'Submitting…';

    try {
      const json = await api(`/failed-backflush/${pc}/${recordId}/retry`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectBody()),
      });
      if (!json.success) throw new Error(json.error);
      result.style.color = 'var(--accent)';
      const docs = (json.data?.tubs || []).map(t => t.materialDocument).filter(Boolean).join(', ');
      result.textContent = `✓ Re-submission successful${docs ? ' — MatDocs: ' + docs : json.data?.materialDocument ? ' — MatDoc: ' + json.data.materialDocument : ''}`;
      btn.disabled = false; btn.textContent = 'Re-submit to SAP';
      setTimeout(() => { closeModal(); runFailedBackflush(); }, 1500);
    } catch (err) {
      result.style.color = 'var(--error)';
      result.textContent = err.message;
      btn.disabled = false; btn.textContent = 'Re-submit to SAP';
    }
  });
}
