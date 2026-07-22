/**
 * private/js/production-schedule.js
 *
 * Shared "Production Schedule" report component — one implementation, wired
 * into two different department pages (production-nexus.html's Supervisor
 * section, and sales.html), since Sales and Production both need to see and
 * work the same report but reach it through different permission gates.
 *
 * Wrapped in an IIFE and exposed as a single window.ProductionScheduleReport
 * global with one entry point (mount()) — every page that uses this expects
 * a #result-title / #result-hint / #result-row-badge / #result-body shell
 * (the same convention private/js/production-nexus.js already uses for its
 * tile dispatch — see openFunction() there). Deliberately does not reuse
 * esc()/fmt()-style globals from whichever page loads it, since both
 * sales.js and production-nexus.js may declare their own of the same name —
 * everything this file needs is scoped inside the IIFE.
 *
 * Backend: routes/productionschedule.js (mounted at /api/production-schedule
 * in server.js). See that file and routes/productionschedulesql.js for the
 * data model — PTFE-only, 5 working days out with a 2 working-day offset,
 * plus an Arrears view and an OTIF KPI view.
 */

(function () {
  'use strict';

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtNum(v) {
    const n = Number(v);
    if (!n) return '0';
    return n.toLocaleString('en-GB', { maximumFractionDigits: 3 });
  }

  function fmtMoney(v, currency) {
    const n = Number(v) || 0;
    return n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (currency ? ' ' + currency : '');
  }

  function fmtDateHeader(isoDate) {
    if (!isoDate || isoDate === 'unknown') return 'No date';
    const d = new Date(isoDate + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  function daysOverdue(isoDate) {
    if (!isoDate) return null;
    const due = new Date(isoDate.slice(0, 10) + 'T00:00:00Z');
    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
    return Math.round((todayUtc - due) / 86400000);
  }

  async function psApi(path, opts) {
    const r = await fetch('/api/production-schedule' + path, opts);
    let json = null;
    try { json = await r.json(); } catch { /* non-JSON body */ }
    if (json?.success === false || !r.ok) {
      throw new Error(json?.error || `Request failed (HTTP ${r.status})`);
    }
    return json;
  }

  // ── Module state ──────────────────────────────────────────────────────────
  let canEdit       = false;
  let currentView   = 'schedule';   // 'schedule' | 'arrears' | 'kpi'
  let currentRows   = [];
  let selectedKeys  = new Set();
  let kpiChart      = null;

  function rowKey(r) { return `${r.ReferenceDocument}||${r.Item}`; }

  // ── Mount ─────────────────────────────────────────────────────────────────
  async function mount() {
    const titleEl = document.getElementById('result-title');
    const hintEl  = document.getElementById('result-hint');
    if (titleEl) titleEl.textContent = 'Production Schedule';
    if (hintEl)  hintEl.textContent  = 'Open PTFE order lines due in the next 5 working days — edit comments/ETA, tick rows, and Save Selected';

    const body = document.getElementById('result-body');
    if (body) body.innerHTML = '<div class="psched-loading"><div class="psched-spinner"></div>Loading…</div>';

    try {
      const session = await fetch('/session-check').then(r => r.json());
      const perms = session.permissions || [];
      canEdit = session.role === 'superadmin' || perms.includes('PROD_SUPERVISOR') || perms.includes('SALES_SUPERVISOR');
    } catch {
      canEdit = false;
    }

    currentView = 'schedule';
    selectedKeys = new Set();
    await renderCurrentView();
  }

  // ── Shell (tabs) ──────────────────────────────────────────────────────────
  function renderShell() {
    return `
      <div class="psched-toolbar">
        <div class="psched-tabs">
          <button type="button" class="psched-tab${currentView === 'schedule' ? ' psched-tab--active' : ''}" data-view="schedule">Schedule</button>
          <button type="button" class="psched-tab${currentView === 'arrears' ? ' psched-tab--active' : ''}" data-view="arrears">Arrears</button>
          <button type="button" class="psched-tab${currentView === 'kpi' ? ' psched-tab--active' : ''}" data-view="kpi">OTIF KPI</button>
        </div>
        <div id="psched-actions" class="psched-actions"></div>
      </div>
      <div id="psched-view-body"></div>`;
  }

  function wireTabs() {
    document.querySelectorAll('.psched-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.view === currentView) return;
        currentView = btn.dataset.view;
        selectedKeys = new Set();
        renderCurrentView();
      });
    });
  }

  async function renderCurrentView() {
    const body = document.getElementById('result-body');
    body.innerHTML = renderShell();
    wireTabs();

    const badge = document.getElementById('result-row-badge');
    const viewBody = document.getElementById('psched-view-body');
    viewBody.innerHTML = '<div class="psched-loading"><div class="psched-spinner"></div>Loading…</div>';

    try {
      if (currentView === 'kpi') {
        if (badge) badge.classList.add('hidden');
        await renderKpiView(viewBody);
        return;
      }

      const path = currentView === 'arrears' ? '/arrears' : '/';
      const json = await psApi(path);
      currentRows = json.data || [];

      if (badge) {
        badge.textContent = `${currentRows.length} line${currentRows.length === 1 ? '' : 's'}`;
        badge.classList.remove('hidden');
      }

      renderTableView(viewBody);
    } catch (err) {
      viewBody.innerHTML = `<div class="psched-empty">${esc(err.message)}</div>`;
    }
  }

  // ── Table view (Schedule / Arrears) ──────────────────────────────────────
  function renderActions() {
    const actions = document.getElementById('psched-actions');
    if (!actions) return;
    if (!canEdit) { actions.innerHTML = ''; return; }
    actions.innerHTML = `
      <span id="psched-selection-hint" class="psched-selection-hint">Select rows to save edits together.</span>
      <button type="button" id="psched-select-all-btn" class="psched-btn-secondary">Select All</button>
      <button type="button" id="psched-save-selected-btn" class="psched-btn-primary" disabled>Save Selected</button>`;

    document.getElementById('psched-select-all-btn').addEventListener('click', toggleSelectAll);
    document.getElementById('psched-save-selected-btn').addEventListener('click', saveSelected);
  }

  // Bucket UI — reuses the exact .ps-section/.ps-section-header/.ps-sections
  // classes from logistics.css's Inbound Log ("Late/Today/Upcoming") pattern,
  // already loaded on every page this component runs on (production-nexus.html
  // and sales.html both link logistics.css for their base tile system). Using
  // those classes as-is, rather than inventing new ones, is what makes this
  // look identical wherever it's mounted — no custom bucket CSS to keep in
  // sync. See ilBucketFor/IL_BUCKET_DEFS/renderInboundLog in
  // private/js/logistics.js for the source pattern this mirrors.
  function renderTableView(container) {
    if (!currentRows.length) {
      container.innerHTML = '<div class="psched-empty" style="color:var(--accent)">✓ Nothing here.</div>';
      const actions = document.getElementById('psched-actions');
      if (actions) actions.innerHTML = '';
      return;
    }

    renderActions();

    // Group by date. Schedule rows carry a DisplayDate (RequestDate shifted
    // back by the working-day offset — see getProductionSchedule's comment
    // in productionschedulesql.js): the user only ever sees the date they
    // need to have finished by, not the real SAP RequestDate two working
    // days later. Arrears rows have no offset (there's nothing to
    // lead-time-adjust for something already overdue) and fall back to
    // RequestDate.
    const groups = new Map();
    currentRows.forEach(r => {
      const groupDate = r.DisplayDate || r.RequestDate;
      const key = groupDate ? String(groupDate).slice(0, 10) : 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });
    const sortedKeys = [...groups.keys()].sort();

    const showOverdue = currentView === 'arrears';

    const sectionsHtml = sortedKeys.map((key, idx) => {
      const rows = groups.get(key);
      // Arrears buckets are all inherently overdue — red dot, same semantic
      // as Inbound Log's "Late" bucket. Schedule buckets: the soonest date
      // gets the "today" green dot (most urgent), the rest "week" blue —
      // same dot colours Inbound Log uses for its Today/Upcoming buckets.
      const dot = showOverdue ? 'priority' : (idx === 0 ? 'today' : 'week');

      return `
        <div class="ps-section" data-group-key="${esc(key)}">
          <div class="ps-section-header">
            <span class="ps-section-dot ps-section-dot--${dot}"></span>
            <span class="ps-section-title">${esc(fmtDateHeader(key))}</span>
            <span class="ps-section-count">${rows.length}</span>
            <span class="ps-chevron">v</span>
          </div>
          <div class="ps-section-body">
            <div style="overflow-x:auto">
              <table class="psched-table">
                <thead><tr>
                  ${canEdit ? '<th></th>' : ''}
                  <th>Customer</th><th>Agreement</th><th>Item</th><th>Material</th><th>Description</th>
                  <th style="text-align:right">Qty</th><th style="text-align:right">Stock</th><th style="text-align:right">Picked</th>
                  <th style="text-align:right">Unit Price</th><th style="text-align:right">Value</th>
                  ${showOverdue ? '<th>Overdue</th>' : ''}
                  <th>ETA</th><th>Comment</th>
                </tr></thead>
                <tbody>${rows.map(r => rowHtml(r, showOverdue)).join('')}</tbody>
              </table>
            </div>
          </div>
        </div>`;
    }).join('');

    container.innerHTML = `<div class="ps-sections">${sectionsHtml}</div>`;

    // Same one-line toggle-on-click-anywhere-in-header pattern as
    // logistics.js — no state persistence, every bucket opens fresh
    // (defaultOpen) on each render, matching Inbound Log's behaviour.
    container.querySelectorAll('.ps-section-header').forEach(h =>
      h.addEventListener('click', () => h.closest('.ps-section').classList.toggle('ps-section--collapsed'))
    );

    if (canEdit) {
      container.querySelectorAll('.psched-check').forEach(cb => cb.addEventListener('change', onCheckToggle));
    }
  }

  function rowHtml(r, showOverdue) {
    const key = rowKey(r);
    const etaVal = r.eta ? String(r.eta).slice(0, 10) : '';
    const overdue = showOverdue ? daysOverdue(r.RequestDate) : null;

    // "In full" — enough stock already allocated to cover the whole order,
    // nothing further needs producing. Mirrors the source Excel, where
    // fully-stocked lines were manually marked "COMPLETED" in the Comment
    // column — this makes that visible at a glance instead of requiring a
    // comment.
    const orderQty = Number(r.OrderQty) || 0;
    const inFull = orderQty > 0 && Number(r.StockQty) >= orderQty;

    return `<tr data-key="${esc(key)}" class="${inFull ? 'psched-row--full' : ''}">
      ${canEdit ? `<td><input type="checkbox" class="psched-check" data-key="${esc(key)}"></td>` : ''}
      <td>${esc(r.CustomerName || '—')}<div class="psched-sub">${esc(r.Customer || '')}</div></td>
      <td class="psched-mono">${esc(r.ReferenceDocument)}</td>
      <td class="psched-mono">${esc(r.Item)}</td>
      <td class="psched-mono">${esc(r.Material)}</td>
      <td>${esc(r.MaterialText || '—')}</td>
      <td style="text-align:right">${fmtNum(r.OrderQty)} ${esc(r.Uom || '')}</td>
      <td style="text-align:right">${fmtNum(r.StockQty)}</td>
      <td style="text-align:right">${fmtNum(r.PickedQty)}</td>
      <td style="text-align:right">${r.StandardPrice ? fmtMoney(r.StandardPrice, '') : '—'}</td>
      <td style="text-align:right">${r.Amount ? fmtMoney(r.Amount, r.Currency) : '—'}</td>
      ${showOverdue ? `<td style="color:var(--error)">${overdue != null && overdue > 0 ? overdue + 'd' : '—'}</td>` : ''}
      <td>${canEdit
        ? `<input type="date" class="psched-eta-input" data-key="${esc(key)}" value="${etaVal}">`
        : esc(etaVal || '—')}</td>
      <td>${canEdit
        ? `<input type="text" class="psched-comment-input" data-key="${esc(key)}" value="${esc(r.comment || '')}" placeholder="Comment…">`
        : esc(r.comment || '—')}</td>
    </tr>`;
  }

  // ── Selection ─────────────────────────────────────────────────────────────
  function onCheckToggle(e) {
    const key = e.target.dataset.key;
    if (e.target.checked) selectedKeys.add(key); else selectedKeys.delete(key);
    updateSelectionUi();
  }

  function toggleSelectAll() {
    const boxes = document.querySelectorAll('.psched-check');
    const allSelected = [...boxes].every(cb => cb.checked);
    boxes.forEach(cb => {
      cb.checked = !allSelected;
      if (cb.checked) selectedKeys.add(cb.dataset.key); else selectedKeys.delete(cb.dataset.key);
    });
    updateSelectionUi();
  }

  function updateSelectionUi() {
    const hint = document.getElementById('psched-selection-hint');
    if (hint) hint.textContent = selectedKeys.size
      ? `${selectedKeys.size} line${selectedKeys.size === 1 ? '' : 's'} selected`
      : 'Select rows to save edits together.';
    const btn = document.getElementById('psched-save-selected-btn');
    if (btn) btn.disabled = selectedKeys.size === 0;
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  // Reads the on-screen comment/ETA inputs for one row and PUTs them — shared
  // by the bulk "Save Selected" action (same idiom as osSaveOneTracked/
  // saveSelectedTrackedOrders in private/js/logistics.js's Tracked Orders
  // bulk-save). Returns a result object rather than throwing, so the bulk
  // caller can collect per-row failures instead of stopping at the first one.
  async function saveOneRow(key) {
    const etaInput = document.querySelector(`.psched-eta-input[data-key="${CSS.escape(key)}"]`);
    const commentInput = document.querySelector(`.psched-comment-input[data-key="${CSS.escape(key)}"]`);
    if (!etaInput || !commentInput) return { success: false, error: 'Row not on screen.' };

    const [referenceDocument, item] = key.split('||');
    try {
      await psApi(`/${encodeURIComponent(referenceDocument)}/${encodeURIComponent(item)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comment: commentInput.value.trim() || null,
          eta: etaInput.value || null,
        }),
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function saveSelected() {
    const btn = document.getElementById('psched-save-selected-btn');
    if (!btn || selectedKeys.size === 0) return;
    const keys = [...selectedKeys];
    btn.disabled = true; btn.textContent = 'Saving…';

    const results = [];
    for (const key of keys) {
      const r = await saveOneRow(key);
      results.push({ key, ...r });
    }

    const failed = results.filter(r => !r.success);
    if (failed.length) {
      alert(`Saved ${results.length - failed.length} of ${results.length} line(s).\n\nFailed:\n` + failed.map(f => `${f.key}: ${f.error}`).join('\n'));
    }
    selectedKeys = new Set();
    await renderCurrentView();
  }

  // ── OTIF KPI view ─────────────────────────────────────────────────────────
  function destroyKpiChart() {
    if (kpiChart) { kpiChart.destroy(); kpiChart = null; }
  }

  async function renderKpiView(container) {
    try {
      const [historyJson, lateJson] = await Promise.all([
        psApi('/kpi'),
        psApi('/kpi/late'),
      ]);
      const history = historyJson.data || [];
      const late = lateJson.data || [];

      container.innerHTML = `
        <div style="padding:16px 20px">
          <div style="max-height:320px;margin-bottom:20px"><canvas id="psched-kpi-chart"></canvas></div>
          <div class="psched-kpi-hdr">Completed Late — with Reason</div>
          <div style="overflow-x:auto">
          <table class="psched-table">
            <thead><tr>
              <th>Customer</th><th>Agreement</th><th>Item</th><th>Material</th>
              <th style="text-align:right">Qty</th><th>Due</th><th>Completed</th><th>Reason</th>
            </tr></thead>
            <tbody>${late.length ? late.map(lateRowHtml).join('') : `<tr><td colspan="8" class="psched-empty" style="color:var(--accent)">✓ Nothing completed late.</td></tr>`}</tbody>
          </table></div>
        </div>`;

      destroyKpiChart();
      const canvas = document.getElementById('psched-kpi-chart');
      if (canvas && window.Chart && history.length) {
        const labels = history.map(h => `${MONTH_NAMES[h.month - 1] || h.month} ${h.year}`);
        const pct = history.map(h => h.onTimePct == null ? null : Math.round(h.onTimePct * 10) / 10);
        kpiChart = new Chart(canvas, {
          type: 'bar',
          data: {
            labels,
            datasets: [{
              label: 'On-Time %',
              data: pct,
              backgroundColor: 'rgba(37,99,235,0.55)',
              borderColor: 'rgba(37,99,235,1)',
              borderWidth: 1,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: { y: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' } } },
            plugins: { legend: { display: false } },
          },
        });
      } else if (canvas && !history.length) {
        canvas.replaceWith(document.createTextNode('No completed lines tracked yet — the OTIF diff job runs once daily.'));
      }
    } catch (err) {
      container.innerHTML = `<div class="psched-empty">${esc(err.message)}</div>`;
    }
  }

  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function lateRowHtml(r) {
    return `<tr>
      <td>${esc(r.CustomerName || '—')}</td>
      <td class="psched-mono">${esc(r.ReferenceDocument)}</td>
      <td class="psched-mono">${esc(r.Item)}</td>
      <td class="psched-mono">${esc(r.Material)}</td>
      <td style="text-align:right">${fmtNum(r.OrderQty)} ${esc(r.Uom || '')}</td>
      <td>${r.DueDate ? esc(String(r.DueDate).slice(0, 10)) : '—'}</td>
      <td>${r.CompletedDate ? esc(String(r.CompletedDate).slice(0, 10)) : '—'}</td>
      <td>${esc(r.Reason || '—')}</td>
    </tr>`;
  }

  window.ProductionScheduleReport = { mount };
})();
