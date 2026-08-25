'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let activeDT          = null;
let currentResult     = [];
let sessionPermissions = [];
let sessionRole        = '';
let sessionUsername    = '';
let pendingCSVRecords  = [];

// ── Session check on load ─────────────────────────────────────────────────────
(async () => {
  const d = await fetch('/session-check').then(r => r.json());
  if (!d.loggedIn) { window.location.href = '/'; return; }
  document.getElementById('session-user').textContent = d.username;
  sessionPermissions = d.permissions || [];
  sessionRole        = d.role       || '';
  sessionUsername    = d.username   || '';
  applyPermissionVisibility();
  setupTiles();
  setupSupervisorSection();
  pollStagingOpenCount();
  setInterval(pollStagingOpenCount, 60000);
  pollZdelflagWarnCount();
  setInterval(pollZdelflagWarnCount, 60000);
  pollGoodsIssueWarnCount();
  setInterval(pollGoodsIssueWarnCount, 60000);
  pollPackagingHoldingCount();
  setInterval(pollPackagingHoldingCount, 60000);
})();

// Staging Post tile badge — open request count, turns red the moment any
// open request is overdue (DueAtUtc already passed). Same 60s cadence as
// the notification bell and the Failed Backflush tile on production-nexus.
async function pollStagingOpenCount() {
  const badge = document.getElementById('staging-open-badge');
  if (!badge) return;
  try {
    const json = await spApi('/requests/open-summary');
    const { openCount = 0, overdueCount = 0 } = json.data || {};
    badge.textContent = openCount > 99 ? '99+' : String(openCount);
    badge.classList.toggle('tile-badge--overdue', overdueCount > 0);
    badge.classList.toggle('tile-badge--live', overdueCount === 0);
    badge.title = overdueCount > 0
      ? `${openCount} open request${openCount === 1 ? '' : 's'} — ${overdueCount} overdue`
      : `${openCount} open request${openCount === 1 ? '' : 's'}`;
  } catch { /* leave the static LIVE badge in place on failure */ }
}

// ZDELFLAG Warnings tile badge — count of deliveries whose latest
// ZDELFLAG/ZDELPACK maintenance run was Failed or Warning. Same red
// "needs attention" styling as the Staging Post overdue badge.
async function pollZdelflagWarnCount() {
  const badge = document.getElementById('zdelflag-warn-badge');
  if (!badge) return;
  try {
    const r = await fetch('/api/deliverymain/zdelflag/warnings');
    const json = await r.json();
    const count = (json.data || []).length;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('tile-badge--overdue', count > 0);
    badge.classList.toggle('tile-badge--live', count === 0);
    badge.title = count > 0
      ? `${count} delivery/deliveries need ZDELFLAG/ZDELPACK investigation`
      : 'No ZDELFLAG/ZDELPACK warnings';
  } catch { /* leave the static LIVE badge in place on failure */ }
}

// Goods Issue Warnings tile badge — count of deliveries whose latest Goods
// Issue posting (BAPI_DELIVERYPROCESSING_EXEC, fired automatically right
// after a delivery's ZDELFLAG/ZDELPACK maintenance succeeds) was Failed.
// Same red "needs attention" styling as the ZDELFLAG Warnings badge above.
async function pollGoodsIssueWarnCount() {
  const badge = document.getElementById('goods-issue-warn-badge');
  if (!badge) return;
  try {
    const r = await fetch('/api/deliverymain/goods-issue/warnings');
    const json = await r.json();
    const count = (json.data || []).length;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('tile-badge--overdue', count > 0);
    badge.classList.toggle('tile-badge--live', count === 0);
    badge.title = count > 0
      ? `${count} delivery/deliveries need Goods Issue investigation`
      : 'No Goods Issue warnings';
  } catch { /* leave the static LIVE badge in place on failure */ }
}

// Picksheets on Hold tile badge — count of deliveries the SAP sync found
// completed outside Nexus, waiting for someone to confirm packaging.
async function pollPackagingHoldingCount() {
  const badge = document.getElementById('packaging-holding-badge');
  if (!badge) return;
  try {
    const r = await fetch('/api/deliverymain/packaging-holding');
    const json = await r.json();
    const count = (json.data || []).length;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('tile-badge--overdue', count > 0);
    badge.classList.toggle('tile-badge--live', count === 0);
    badge.title = count > 0
      ? `${count} delivery/deliveries waiting for packaging data`
      : 'No deliveries modified in SAP outside Nexus have been found.';
  } catch { /* leave the static LIVE badge in place on failure */ }
}

// data-permission accepts a comma-separated list, meaning "any of these" —
// same convention as logistics.js/production-nexus.js/quality.js. Gates the
// whole Picking Operations section (Open Picksheets, Picksheets on Hold,
// Closed Picksheets, Inbound Deliveries, Outbound Deliveries) behind
// WAREHOUSE_OP; the real enforcement is server-side (requirePermission on
// the underlying routes) — this just keeps tiles a warehouse operator can't
// use out of the grid.
function applyPermissionVisibility() {
  document.querySelectorAll('[data-permission]').forEach(el => {
    const codes   = el.dataset.permission.split(',').map(c => c.trim()).filter(Boolean);
    const allowed = sessionRole === 'superadmin' || codes.some(code => sessionPermissions.includes(code));
    el.style.display = allowed ? '' : 'none';
  });
}

function setupTiles() {
  document.querySelectorAll('.sap-tile--live[data-fn]').forEach(tile => {
    tile.addEventListener('click', () => {
      const fn = tile.dataset.fn;
      if (fn === 'displayStock')   runStockManagement();
      if (fn === 'transferOrders') showTransferForm();
      if (fn === 'transferRequirements') runTransferRequirements();
      if (fn === 'openPicksheets') runOpenPicksheets();
      if (fn === 'packagingHolding') runPackagingHolding();
      if (fn === 'inboundDeliveriesOp')  runInboundDeliveriesOp();
      if (fn === 'outboundDeliveriesOp') runOutboundDeliveriesOp();
      if (fn === 'addPicksheet')   showAddPicksheetForm();
      if (fn === 'csvUpload')      showCSVUpload();
      if (fn === 'sapSync')        runSAPSync();
      if (fn === 'stagingFulfil')  runStagingFulfil();
      if (fn === 'stagingCompleted') runStagingCompleted();
      if (fn === 'stagingBinRestrictions') runStagingBinRestrictions();
      if (fn === 'zdelflagWarnings') runZdelflagWarnings();
      if (fn === 'goodsIssueWarnings') runGoodsIssueWarnings();
      if (fn === 'stockInvestigations') runStockInvestigations();
      if (fn === 'stockCountAdmin') runStockCountAdmin();
      if (fn === 'ptfeCycleCount')  runPtfeCycleCount();
      if (fn === 'rawMaterialCount') runRawMaterialCount();
      if (fn === 'productionCount') runProductionCount();
      if (fn === 'finishedGoodsCount') runFinishedGoodsCount();
    });
  });

  document.querySelectorAll('.pn-section-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => {
      hdr.closest('.pn-section').classList.toggle('pn-section--collapsed');
    });
  });
}

// ── Stock Management (search + select + transfer, split-screen) ──────────────
//
// Replaces the old Display Stock tile. Search is button-triggered (or Enter
// in a filter field) rather than an eager full-warehouse pull on open or
// instant-as-you-type filtering — each field's value is sent straight to SAP
// as a query filter (GET /api/sap/warehouse/stock → SapServer's
// BuildStockRequest, which now also supports Storage Location/Stock Category
// filters), so only the rows actually asked for come down the wire. One or
// more selected rows feed a Transfer Order panel that stays visible
// alongside the list (no modal, split-screen like the pallet builder's
// .pb-merged/.pb-stock-panel layout) — either a single row, or a mass
// movement with a shared or per-row destination. Confirming re-runs the same
// search so the list reflects the result of the transaction immediately.
let wsm = null; // { rows, lastParams, selected: Set<rowId> }

function wsmRowId(row) {
  return [row.storageLocation, row.storageType, row.bin, row.material, row.batch, row.stockCategory, row.specialStockInd, row.specialStockNum].join('¦');
}

function wsmReadFilterParams() {
  const params = {};
  document.querySelectorAll('.wsm-filter-input').forEach(input => {
    const val = input.value.trim();
    if (val) params[input.dataset.key] = val;
  });
  return params;
}

async function wsmFetchStock(params = {}) {
  const qs   = new URLSearchParams(params).toString();
  const res  = await fetch(`/api/sap/warehouse/stock${qs ? `?${qs}` : ''}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'SAP call failed');
  return (json.data || []).map(r => ({ ...r, availableQty: Number(r.availableQty) || 0 }));
}

async function runStockManagement() {
  if (!await checkSession()) return;
  wsm = { rows: [], lastParams: {}, selected: new Set() };

  if (activeDT) { try { activeDT.destroy(); } catch (_) {} activeDT = null; }
  document.getElementById('tile-section').classList.add('hidden');
  document.getElementById('result-section').classList.remove('hidden');
  document.getElementById('result-title').textContent = 'Stock Management';
  document.getElementById('result-hint').textContent  = 'Enter search criteria and press Search';
  document.getElementById('result-row-badge').classList.add('hidden');
  document.getElementById('btn-export-csv').classList.add('hidden');
  wsmRenderLayout();
}

const WSM_FILTER_FIELDS = [
  // Material supports an optional SQL-style wildcard search — '%' (any run of
  // characters) and '_' (exactly one character), e.g. "TSHV%" (starts with),
  // "%TSHV" (ends with), "%TSHV%" (contains), "TSH_V" (single-char wildcard).
  // Opt-in only — a plain material number still matches exactly as before.
  { key: 'material',        label: 'Material',      placeholder: 'e.g. TSHV% for wildcard' },
  { key: 'batch',           label: 'Batch'        },
  { key: 'storageType',     label: 'Storage Type' },
  { key: 'bin',             label: 'Bin'          },
  { key: 'storageLocation', label: 'Storage Loc.' },
  { key: 'stockCategory',   label: 'Stock Cat.'   },
  { key: 'profitCentre',    label: 'Profit Centre' },
];

function wsmRenderLayout() {
  document.getElementById('result-body').innerHTML = `
    <div class="wsm-layout">
      <div class="wsm-list-panel">
        <div class="wsm-filters">
          ${WSM_FILTER_FIELDS.map(f => `
            <div class="wsm-filter-field">
              <label class="tf-label">${esc(f.label)}</label>
              <input class="tf-input wsm-filter-input" type="text" data-key="${f.key}" placeholder="${esc(f.placeholder || f.label)}">
            </div>`).join('')}
          <button type="button" class="btn-submit wsm-search-btn" id="wsm-search-btn">Search</button>
          <button type="button" class="btn-secondary wsm-clear-btn" id="wsm-clear-filters">Clear</button>
          <button type="button" class="btn-secondary wsm-export-btn" id="wsm-export-btn">Download CSV</button>
        </div>
        <div class="wsm-table-wrap" id="wsm-table-wrap">
          <div class="wsm-empty">Enter search criteria above and press Search — nothing is pulled from SAP until you do.</div>
        </div>
      </div>
      <div class="wsm-transfer-panel" id="wsm-transfer-panel">
        ${wsmEmptyPanelHtml()}
      </div>
    </div>`;

  // Repopulate whatever was last searched, so coming back here (e.g. from
  // the Batch Discrepancies view) doesn't lose the current search.
  Object.entries(wsm.lastParams || {}).forEach(([key, val]) => {
    const input = document.querySelector(`.wsm-filter-input[data-key="${key}"]`);
    if (input) input.value = val;
  });

  document.getElementById('wsm-search-btn').addEventListener('click', () => wsmRunSearch());
  document.querySelectorAll('.wsm-filter-input').forEach(input => {
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); wsmRunSearch(); } });
  });
  document.getElementById('wsm-clear-filters').addEventListener('click', () => {
    document.querySelectorAll('.wsm-filter-input').forEach(i => { i.value = ''; });
  });
  document.getElementById('wsm-export-btn').addEventListener('click', () => wsmExportCsv());
  if (wsm.rows.length) wsmRenderTable(); // re-render the last fetched result rather than re-querying SAP
  wsmRenderTransferPanel(); // keep the panel in sync with wsm.selected even when the table itself isn't re-rendered
}

function wsmEmptyPanelHtml() {
  return `<div class="wsm-panel-empty">Select one or more rows from the list to create a Transfer Order.</div>`;
}

async function wsmRunSearch() {
  const params = wsmReadFilterParams();
  wsm.lastParams = params;
  wsm.selected   = new Set();

  const wrap = document.getElementById('wsm-table-wrap');
  wrap.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Querying SAP…</div>';
  document.getElementById('result-row-badge').classList.add('hidden');
  wsmRenderTransferPanel();

  try {
    wsm.rows = await wsmFetchStock(params);
    wsmRenderTable();
    document.getElementById('result-hint').textContent =
      `LQUA · WH 312 · ${Object.keys(params).length ? 'filtered search' : 'all stock'} · ${wsm.rows.length} rows`;
  } catch (err) {
    wrap.innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

// Downloads the full current search result (not just the visible/selected
// rows) as CSV — same field set as the on-screen table, including Profit
// Centre and GR Date.
function wsmExportCsv() {
  if (!wsm.rows.length) return;

  const columns = [
    ['storageLocation', 'Storage Location'], ['storageType', 'Storage Type'], ['bin', 'Bin'],
    ['material', 'Material'], ['availableQty', 'Available Qty'], ['batch', 'Batch'],
    ['stockCategory', 'Stock Category'], ['specialStockInd', 'Special Stock'], ['specialStockNum', 'Special Stock No.'],
    ['profitCentre', 'Profit Centre'], ['grDate', 'GR Date'],
  ];
  const lines = [
    columns.map(([, label]) => label).join(','),
    ...wsm.rows.map(row => columns.map(([key]) =>
      `"${String(row[key] ?? '').replace(/"/g, '""')}"`).join(',')),
  ];

  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `stock-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// WDATU comes back as a raw SAP yyyyMMdd string (or blank/all-zero if the
// quant has never had a goods movement) — format for display only.
function wsmFormatGrDate(v) {
  if (!v || !/^\d{8}$/.test(v) || v === '00000000') return '—';
  return `${v.slice(6, 8)}.${v.slice(4, 6)}.${v.slice(0, 4)}`;
}

function wsmRenderTable() {
  const wrap = document.getElementById('wsm-table-wrap');
  if (!wrap) return;

  const badge = document.getElementById('result-row-badge');

  if (!wsm.rows.length) {
    wrap.innerHTML = '<div class="wsm-empty">No stock matches this search.</div>';
    badge.textContent = '0 rows';
    badge.classList.remove('hidden');
    return;
  }

  const allChecked = wsm.rows.every(r => wsm.selected.has(wsmRowId(r)));

  const rowsHtml = wsm.rows.map(row => {
    const id  = wsmRowId(row);
    const neg = row.availableQty < 0;
    const checked = wsm.selected.has(id) ? ' checked' : '';
    return `<tr class="wsm-row${neg ? ' wsm-row--negative' : ''}" data-id="${esc(id)}">
      <td class="wsm-td-check"><input type="checkbox" class="wsm-row-check" data-id="${esc(id)}"${checked}></td>
      <td>${esc(row.storageLocation)}</td>
      <td>${esc(row.storageType)}</td>
      <td>${esc(row.bin)}</td>
      <td>${esc(row.material)}</td>
      <td>${row.availableQty}</td>
      <td>${esc(row.batch || '—')}</td>
      <td>${esc(row.stockCategory || '—')}</td>
      <td>${esc(row.specialStockInd || '—')}</td>
      <td>${esc(row.specialStockNum || '—')}</td>
      <td>${esc(row.profitCentre || '—')}</td>
      <td>${wsmFormatGrDate(row.grDate)}</td>
    </tr>`;
  }).join('');

  // Note: this DOM is a plain <table>, auto-paginated client-side by
  // table-paginate.js once past 20 rows. That paginator re-pages to page 1
  // whenever it sees the <table> node get swapped out for a new one, so
  // wsmRenderTable() is only ever called for an actual new/changed result
  // set (a fresh search, or Select All) — per-row selection below patches
  // the existing DOM in place via wsmSyncSelectionUI() instead of calling
  // back in here, so checking a row on page 2+ doesn't bounce you to page 1.
  wrap.innerHTML = `
    <table class="wsm-table">
      <thead>
        <tr>
          <th class="wsm-td-check"><input type="checkbox" id="wsm-select-all"${allChecked ? ' checked' : ''}></th>
          <th>Storage Loc.</th><th>Storage Type</th><th>Bin</th><th>Material</th>
          <th>Available Qty</th><th>Batch</th><th>Stock Cat.</th><th>Special Stock</th><th>Special Stock No.</th>
          <th>Profit Centre</th><th>GR Date</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;

  document.getElementById('wsm-select-all').addEventListener('change', e => {
    if (e.target.checked) wsm.rows.forEach(r => wsm.selected.add(wsmRowId(r)));
    else wsm.rows.forEach(r => wsm.selected.delete(wsmRowId(r)));
    wsmSyncSelectionUI();
  });

  wrap.querySelectorAll('.wsm-row-check').forEach(cb => {
    cb.addEventListener('change', e => {
      e.stopPropagation();
      const id = cb.dataset.id;
      if (cb.checked) wsm.selected.add(id); else wsm.selected.delete(id);
      wsmSyncSelectionUI();
    });
  });

  wrap.querySelectorAll('.wsm-row').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('.wsm-row-check')) return;
      const id = tr.dataset.id;
      if (wsm.selected.has(id)) wsm.selected.delete(id); else wsm.selected.add(id);
      wsmSyncSelectionUI();
    });
  });

  badge.textContent = `${wsm.rows.length} rows${wsm.selected.size ? ` · ${wsm.selected.size} selected` : ''}`;
  badge.classList.remove('hidden');
}

// Patches checkbox/row state and the badge/transfer panel in place, without
// touching the <table> node itself — see the comment above wsmRenderTable's
// innerHTML assignment for why (keeps table-paginate.js's page position).
function wsmSyncSelectionUI() {
  const wrap = document.getElementById('wsm-table-wrap');
  if (!wrap) return;

  wrap.querySelectorAll('.wsm-row').forEach(tr => {
    const id  = tr.dataset.id;
    const sel = wsm.selected.has(id);
    const cb  = tr.querySelector('.wsm-row-check');
    if (cb) cb.checked = sel;
  });

  const selectAll = document.getElementById('wsm-select-all');
  if (selectAll) selectAll.checked = wsm.rows.length > 0 && wsm.rows.every(r => wsm.selected.has(wsmRowId(r)));

  const badge = document.getElementById('result-row-badge');
  if (badge) badge.textContent = `${wsm.rows.length} rows${wsm.selected.size ? ` · ${wsm.selected.size} selected` : ''}`;

  wsmRenderTransferPanel();
}

function wsmSelectedRows() {
  return wsm.rows.filter(r => wsm.selected.has(wsmRowId(r)));
}

function wsmRenderTransferPanel() {
  const panel = document.getElementById('wsm-transfer-panel');
  if (!panel) return;
  const rows = wsmSelectedRows();

  if (!rows.length) { panel.innerHTML = wsmEmptyPanelHtml(); return; }
  if (rows.length === 1) { panel.innerHTML = wsmSingleTransferHtml(rows[0]); wsmWireSingleTransfer(rows[0]); return; }
  panel.innerHTML = wsmMassTransferHtml(rows);
  wsmWireMassTransfer(rows);
}

// ── Single-row transfer ────────────────────────────────────────────────────
function wsmSingleTransferHtml(row) {
  const isNegative = row.availableQty < 0;
  return `
    <div class="wsm-panel-title">Create Transfer Order</div>
    <div class="wsm-panel-sub">${esc(row.material)} · ${esc(row.storageType)}/${esc(row.bin)}</div>
    ${isNegative ? `<div class="wsm-disc-note">This bin is negative (${esc(row.availableQty)}). Stock can't be moved out of a bin that's already short, so this posts in reverse — the quantity below is pulled IN from the bin you choose below, moving the negative there instead of out of it.</div>` : ''}
    <form class="transfer-form" id="wsm-single-form">
      <div class="tf-prefill-grid">
        ${wsmPrefillItem('Storage Location', row.storageLocation)}
        ${wsmPrefillItem('Storage Type',     row.storageType)}
        ${wsmPrefillItem('Bin',              row.bin)}
        ${wsmPrefillItem('Material',         row.material)}
        ${wsmPrefillItem('Batch',            row.batch || '—')}
        ${wsmPrefillItem('Stock Category',   row.stockCategory || '—')}
        ${wsmPrefillItem('Special Stock',    row.specialStockInd || '—')}
        ${wsmPrefillItem('Special Stock No.',row.specialStockNum || '—')}
      </div>

      <div class="tf-section-label">Quantity</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Quantity <span class="tf-req">*</span></label>
          <input class="tf-input" id="wsm-qty" type="number" step="any" value="${esc(Math.abs(row.availableQty))}" required>
        </div>
      </div>

      <div class="tf-section-label">${isNegative ? 'Bin to Pull Stock From' : 'Destination Bin'}</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">${isNegative ? 'Type' : 'Dest. Bin Type'} <span class="tf-req">*</span></label>
          <input class="tf-input" id="wsm-desttype" type="text" placeholder="Auto from bin" required>
          <div id="wsm-destchoice"></div>
        </div>
        <div class="tf-field">
          <label class="tf-label">${isNegative ? 'Bin' : 'Dest. Bin'} <span class="tf-req">*</span></label>
          <input class="tf-input" id="wsm-destbin" type="text" placeholder="e.g. B-02-03" required>
        </div>
      </div>

      <div class="tf-actions">
        <div id="wsm-single-result"></div>
        <button type="submit" class="btn-submit" id="wsm-single-submit">Create Transfer Order</button>
      </div>
    </form>`;
}

function wsmPrefillItem(label, value) {
  return `<div class="tf-field"><label class="tf-label">${esc(label)}</label><div class="tf-prefill-value">${esc(value)}</div></div>`;
}

function wsmWireSingleTransfer(row) {
  const form = document.getElementById('wsm-single-form');
  if (!form) return;

  wireBinTypeAutoLookup(document.getElementById('wsm-destbin'), document.getElementById('wsm-desttype'), {
    choiceEl: document.getElementById('wsm-destchoice'),
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const submitBtn = document.getElementById('wsm-single-submit');
    const resultEl  = document.getElementById('wsm-single-result');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending to SAP…';
    resultEl.innerHTML = '';

    const params = {
      StorageLocation:       row.storageLocation,
      Material:              row.material,
      Batch:                 row.batch || '',
      Quantity:              parseFloat(document.getElementById('wsm-qty').value.replace(',', '.')),
      SourceType:            row.storageType,
      SourceBin:             row.bin,
      DestinationType:       document.getElementById('wsm-desttype').value.trim(),
      DestinationBin:        document.getElementById('wsm-destbin').value.trim(),
      StockCategory:         row.stockCategory || '',
      SpecialStockIndicator: row.specialStockInd || '',
      SpecialStockNumber:    row.specialStockNum || '',
      // Negative available qty means Source is already short — wsmCreateTransferOrder
      // swaps Source/Destination for these so the move actually pulls stock IN
      // rather than trying to move stock out of a bin that doesn't have it.
      NegativeStock:         row.availableQty < 0,
    };

    const result = await wsmCreateTransferOrder(params);
    resultEl.innerHTML = wsmResultHtml(result);
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Transfer Order';

    if (result.success) await wsmRefreshAfterTransfer();
  });
}

// ── Mass movement — supports both a shared destination for every selected
// row, and a per-row destination, per the user's requirement that both modes
// be available rather than picking just one. ────────────────────────────────
function wsmMassTransferHtml(rows) {
  const anyNegative = rows.some(r => r.availableQty < 0);
  const rowsHtml = rows.map(row => {
    const id = wsmRowId(row);
    const isNegative = row.availableQty < 0;
    return `
      <tr data-id="${esc(id)}" class="${isNegative ? 'wsm-row--negative' : ''}">
        <td>${esc(row.material)}${isNegative ? ' <span class="wsm-neg-tag" title="Negative stock — will pull IN from the bin below instead of moving out">reversed</span>' : ''}</td>
        <td class="wsm-mono">${esc(row.storageType)}/${esc(row.bin)}${row.batch ? ` · ${esc(row.batch)}` : ''}</td>
        <td><input class="tf-input wsm-mass-qty" type="number" step="any" value="${esc(Math.abs(row.availableQty))}" data-id="${esc(id)}"></td>
        <td class="wsm-mass-dest-cell" data-id="${esc(id)}">
          <input class="tf-input wsm-mass-desttype" type="text" placeholder="Type" data-id="${esc(id)}">
          <input class="tf-input wsm-mass-destbin"  type="text" placeholder="Bin"  data-id="${esc(id)}">
        </td>
        <td class="wsm-mass-result" id="wsm-mass-result-${esc(id)}"></td>
      </tr>`;
  }).join('');

  return `
    <div class="wsm-panel-title">Mass Movement</div>
    <div class="wsm-panel-sub">${rows.length} rows selected</div>
    ${anyNegative ? `<div class="wsm-disc-note">Rows marked "reversed" are negative stock — since you can't move stock out of a bin that's already short, those are posted in reverse: the quantity is pulled IN from the bin you enter, moving the negative there instead.</div>` : ''}

    <div class="wsm-mass-mode">
      <label><input type="radio" name="wsm-mass-mode" value="shared" checked> Shared destination</label>
      <label><input type="radio" name="wsm-mass-mode" value="perrow"> Per-row destination</label>
    </div>

    <div class="wsm-mass-shared" id="wsm-mass-shared">
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Dest. Bin Type <span class="tf-req">*</span></label>
          <input class="tf-input" id="wsm-mass-shared-type" type="text" placeholder="Auto from bin">
          <div id="wsm-mass-shared-choice"></div>
        </div>
        <div class="tf-field">
          <label class="tf-label">Dest. Bin <span class="tf-req">*</span></label>
          <input class="tf-input" id="wsm-mass-shared-bin" type="text" placeholder="e.g. B-02-03">
        </div>
      </div>
    </div>

    <div class="wsm-mass-table-wrap">
      <table class="wsm-mass-table">
        <thead><tr><th>Material</th><th>From</th><th>Qty</th><th>Destination</th><th></th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>

    <div class="tf-actions">
      <div id="wsm-mass-summary"></div>
      <button type="button" class="btn-submit" id="wsm-mass-submit">Create ${rows.length} Transfer Orders</button>
    </div>`;
}

// ── Shared progress banner ─────────────────────────────────────────────────
//
// Mass movement, zero-sum clean-up and multi-bin consolidation all send one
// POST per line rather than a single bulk call, so — same idea as
// production-nexus's bulk backflush-reversal progress banner — show a bar +
// live counter while it runs, then a final message naming how many
// succeeded/failed with a breakdown of the distinct error messages (not just
// a raw count), so a batch of identical rejections reads as one line instead
// of a wall of repeats.
function wsmGroupErrors(messages) {
  const counts = new Map();
  messages.forEach(msg => counts.set(msg, (counts.get(msg) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function wsmShowProgressBanner(containerEl, total, label) {
  const banner = document.createElement('div');
  banner.className = 'wsm-progress-banner';
  banner.innerHTML = `
    <div class="wsm-progress-head">
      <span class="wsm-progress-label">${esc(label)}</span>
      <span class="wsm-progress-count-wrap">
        <span class="wsm-progress-count">0 / ${total}</span>
        <span class="wsm-progress-pct">0%</span>
      </span>
    </div>
    <div class="wsm-progress-track"><div class="wsm-progress-bar"></div></div>
    <div class="wsm-progress-summary">Sending to SAP…</div>`;
  containerEl.insertBefore(banner, containerEl.firstChild);
  banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  return {
    update(done) {
      const pct = total ? Math.round((done / total) * 100) : 100;
      banner.querySelector('.wsm-progress-bar').style.width = `${pct}%`;
      banner.querySelector('.wsm-progress-count').textContent = `${done} / ${total}`;
      banner.querySelector('.wsm-progress-pct').textContent = `${pct}%`;
    },
    // failureMessages: plain (unescaped) strings — assigned via textContent
    // below, which escapes on its own, so double-escaping would show literal
    // "&amp;"-style entities rather than the real characters.
    finish(ok, fail, failureMessages) {
      const bar     = banner.querySelector('.wsm-progress-bar');
      const summary = banner.querySelector('.wsm-progress-summary');
      bar.style.width = '100%';
      bar.classList.toggle('wsm-progress-bar--warn', fail > 0);
      if (fail) {
        const breakdown = wsmGroupErrors(failureMessages)
          .map(([msg, count]) => `${count}× ${msg}`).join('; ');
        summary.classList.add('wsm-progress-summary--warn');
        summary.textContent = `${ok} succeeded, ${fail} failed — ${breakdown}`;
      } else {
        summary.classList.add('wsm-progress-summary--ok');
        summary.textContent = `✓ All ${ok} succeeded.`;
      }
    },
  };
}

function wsmWireMassTransfer(rows) {
  const modeRadios  = document.querySelectorAll('input[name="wsm-mass-mode"]');
  const sharedFields = document.getElementById('wsm-mass-shared');
  const destCells    = document.querySelectorAll('.wsm-mass-dest-cell');

  function applyMode() {
    const mode = document.querySelector('input[name="wsm-mass-mode"]:checked').value;
    sharedFields.style.display = mode === 'shared' ? '' : 'none';
    destCells.forEach(td => { td.style.display = mode === 'perrow' ? '' : 'none'; });
  }
  modeRadios.forEach(r => r.addEventListener('change', applyMode));
  applyMode();

  wireBinTypeAutoLookup(document.getElementById('wsm-mass-shared-bin'), document.getElementById('wsm-mass-shared-type'), {
    choiceEl: document.getElementById('wsm-mass-shared-choice'),
  });
  rows.forEach(row => {
    const id = wsmRowId(row);
    wireBinTypeAutoLookup(
      document.querySelector(`.wsm-mass-destbin[data-id="${CSS.escape(id)}"]`),
      document.querySelector(`.wsm-mass-desttype[data-id="${CSS.escape(id)}"]`)
    ); // no choice container in the compact per-row cell — a 2+-match row just stays editable with no auto-fill
  });

  document.getElementById('wsm-mass-submit').addEventListener('click', async () => {
    const mode       = document.querySelector('input[name="wsm-mass-mode"]:checked').value;
    const submitBtn  = document.getElementById('wsm-mass-submit');
    const summaryEl  = document.getElementById('wsm-mass-summary');
    submitBtn.disabled = true;
    summaryEl.innerHTML = '';

    let sharedType = '', sharedBin = '';
    if (mode === 'shared') {
      sharedType = document.getElementById('wsm-mass-shared-type').value.trim();
      sharedBin  = document.getElementById('wsm-mass-shared-bin').value.trim();
      if (!sharedType || !sharedBin) {
        summaryEl.innerHTML = `<div class="sap-error tf-inline-error">✕ Destination bin type and bin are required.</div>`;
        submitBtn.disabled = false;
        return;
      }
    }

    let successCount = 0, failCount = 0;
    const failMessages = [];
    const progress = wsmShowProgressBanner(summaryEl, rows.length, 'Creating transfer orders');

    // Rows with a missing qty/destination never reach the server — filtered
    // out up front rather than sent as a bad item in the bulk payload below.
    const sendable = [];
    rows.forEach(row => {
      const id          = wsmRowId(row);
      const qtyInput    = document.querySelector(`.wsm-mass-qty[data-id="${CSS.escape(id)}"]`);
      const resultCell  = document.getElementById(`wsm-mass-result-${id}`);
      const quantity    = parseFloat((qtyInput?.value || '').replace(',', '.'));

      let destType = sharedType, destBin = sharedBin;
      if (mode === 'perrow') {
        destType = document.querySelector(`.wsm-mass-desttype[data-id="${CSS.escape(id)}"]`)?.value.trim() || '';
        destBin  = document.querySelector(`.wsm-mass-destbin[data-id="${CSS.escape(id)}"]`)?.value.trim()  || '';
      }

      if (!quantity || quantity <= 0 || !destType || !destBin) {
        failCount++;
        failMessages.push('Missing qty/destination');
        if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-fail">✕ Missing qty/destination</span>`;
        return;
      }

      sendable.push({
        resultCell,
        params: {
          StorageLocation:       row.storageLocation,
          Material:              row.material,
          Batch:                 row.batch || '',
          Quantity:              quantity,
          SourceType:            row.storageType,
          SourceBin:             row.bin,
          DestinationType:       destType,
          DestinationBin:        destBin,
          StockCategory:         row.stockCategory || '',
          SpecialStockIndicator: row.specialStockInd || '',
          SpecialStockNumber:    row.specialStockNum || '',
          NegativeStock:         row.availableQty < 0,
        },
      });
    });
    progress.update(rows.length - sendable.length);

    if (sendable.length) {
      // Sent as one request, executed concurrently server-side rather than
      // awaited row-by-row — see wsmCreateTransferOrdersBulk.
      const results = await wsmCreateTransferOrdersBulk(sendable.map(s => s.params));

      results.forEach((result, i) => {
        const { resultCell } = sendable[i];
        if (result.success) {
          successCount++;
          if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-ok">✓ ${esc(result.transferOrderNumber || 'Done')}</span>`;
        } else {
          failCount++;
          failMessages.push(result.message);
          if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-fail">✕ ${esc(result.message)}</span>`;
        }
      });
    }

    progress.update(rows.length);
    progress.finish(successCount, failCount, failMessages);
    // Leave the button disabled once anything succeeded — the rows/qty this
    // form was built from are now stale, so re-clicking would replay old
    // quantities. Re-select from the refreshed table to run it again. Fully
    // failed runs re-enable so a genuine mistake (bad bin typo etc.) can be
    // fixed and retried without re-picking rows.
    if (successCount) {
      submitBtn.textContent = 'Done — reselect rows to run again';
    } else {
      submitBtn.disabled    = false;
      submitBtn.textContent = `Create ${rows.length} Transfer Orders`;
    }

    if (successCount) await wsmRefreshAfterTransfer();
  });
}

function wsmResultHtml(result) {
  if (result.success) {
    return `<div class="tf-success">
      <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
      <div><div class="tf-success-title">Transfer Order Created</div><div class="tf-success-to">${result.message}</div></div>
    </div>`;
  }
  return `<div class="sap-error tf-inline-error">✕ ${esc(result.message)}</div>`;
}

// Applies the negative-stock Source/Destination swap and decides
// transfer-vs-consignment, producing both the post-swap params (needed for
// the NegativeStock messaging in wsmInterpretTransferResult below) and the
// { kind, payload } item shape the bulk route expects. Shared by
// wsmCreateTransferOrder (single row) and wsmCreateTransferOrdersBulk.
function wsmBuildTransferItem(rawParams) {
  // Negative available qty means the "Source" bin is already short — SAP
  // can't post a transfer order moving stock OUT of a bin that doesn't have
  // it. Per the user's rule, this is handled by reversing the move instead:
  // pull the (positive) quantity IN from whatever bin was picked as the
  // "destination", so that bin absorbs the negative and the original bin
  // gets topped back up towards zero. Swap Source/Destination before doing
  // anything else with `params` (including the consignment branch below,
  // which keys off DestinationType) so every downstream use sees the real
  // direction the movement will actually post in.
  let params = rawParams;
  if (params.NegativeStock) {
    const { SourceType, SourceBin, DestinationType, DestinationBin } = params;
    params = { ...params, SourceType: DestinationType, SourceBin: DestinationBin, DestinationType: SourceType, DestinationBin: SourceBin };
  }

  const isConsignment = params.SpecialStockIndicator === 'K' && params.DestinationType === 'SA';
  return {
    params, isConsignment,
    item: {
      kind: isConsignment ? 'consignment' : 'transfer',
      payload: isConsignment ? {
        DeliveryNote: '', Header: 'Consignment',
        StorageLocation: params.StorageLocation, SpecialStockNumber: params.SpecialStockNumber,
        Material: params.Material, Quantity: params.Quantity,
        DestinationType: params.DestinationType, DestinationBin: params.DestinationBin,
        SourceType: params.SourceType, SourceBin: params.SourceBin,
      } : params,
    },
  };
}

// Interprets one SapServer result (the single route's {success,data} body,
// or one entry of the bulk route's results array) into the
// {success, message, transferOrderNumber} shape both the single-row form and
// the mass-transfer panel expect.
function wsmInterpretTransferResult(params, isConsignment, json) {
  if (!json.success) return { success: false, message: json.error || 'SAP call failed' };

  if (isConsignment) {
    const parts = [json.data?.mb1bMessage, json.data?.toNonConsignMessage, json.data?.toConsignMessage].filter(Boolean);
    return { success: true, message: parts.map(esc).join('<br>') || 'Consignment processed', transferOrderNumber: null };
  }

  const transferOrder = json.data?.transferOrderNumber || '';
  const messages       = json.data?.messages || [];
  const ok = json.data?.success && !json.error;
  if (!ok) return { success: false, message: json.error || messages.map(m => m.message || m).join('; ') || 'SAP rejected the transfer order.' };

  const lines = [];
  if (params.NegativeStock) lines.push(`Negative stock — moved ${params.Quantity} from ${esc(params.SourceType)}/${esc(params.SourceBin)} into ${esc(params.DestinationType)}/${esc(params.DestinationBin)} instead.`);
  if (transferOrder) lines.push(`Transfer Order: ${esc(transferOrder)}`);
  if (messages.length) lines.push(...messages.map(m => esc(m.message || m)));
  return { success: true, message: lines.join('<br>') || 'SAP returned no message', transferOrderNumber: transferOrder };
}

// Shared low-level SAP call — same branching runStockTransfer uses between
// the normal transfer-order proxy and the consignment MB1B+LT01 pair, but
// returns a result object instead of writing to a fixed #tf-result element,
// so it can be reused both for the single-row form and (via
// wsmCreateTransferOrdersBulk) the mass-transfer panel.
async function wsmCreateTransferOrder(rawParams) {
  const { params, isConsignment, item } = wsmBuildTransferItem(rawParams);
  try {
    const res = await fetch(isConsignment ? '/api/sap/warehouse/consignment-mb1b' : '/api/sap/warehouse/transfer-order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item.payload),
    });
    const json = await res.json();
    return wsmInterpretTransferResult(params, isConsignment, json);
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// Same as wsmCreateTransferOrder, but for a whole list of rows sent as ONE
// request instead of one round trip per row — SapServer's STA worker pool
// load-balances the RFC calls across its service threads (least-loaded
// routing), so this is what actually lets multiple transfer orders process
// in parallel rather than one at a time. Returns results in the same order
// as rawParamsList.
async function wsmCreateTransferOrdersBulk(rawParamsList) {
  const built = rawParamsList.map(wsmBuildTransferItem);
  try {
    const res = await fetch('/api/sap/warehouse/transfer-order-bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: built.map(b => b.item) }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'SAP call failed');
    return built.map((b, i) => wsmInterpretTransferResult(b.params, b.isConsignment, json.results[i]));
  } catch (err) {
    return rawParamsList.map(() => ({ success: false, message: err.message }));
  }
}

// Re-runs the same search that's currently active and refreshes the table,
// so confirming a transfer order updates the stock list while keeping the
// same filters. Deliberately does NOT clear wsm.selected or re-render the
// transfer panel — doing so would immediately blow away the progress banner
// / success-or-error breakdown the panel is still showing, before the user
// has had a chance to read it. The panel catches up to the fresh row data
// next time the user touches a checkbox or searches again.
async function wsmRefreshAfterTransfer() {
  try {
    wsm.rows = await wsmFetchStock(wsm.lastParams || {});
  } catch (err) {
    return; // keep showing the stale list + the just-shown result message
  }
  wsmRenderTable();
  document.getElementById('result-hint').textContent =
    `LQUA · WH 312 · ${Object.keys(wsm.lastParams || {}).length ? 'filtered search' : 'all stock'} · ${wsm.rows.length} rows`;
}


// ── Stock Investigations (LOG_SUPER only) ─────────────────────────────────────
//
// A supervisor-only tile: Batch Discrepancies (find/clean up negative or
// multi-bin batches) plus a Stock in Investigation card showing whatever's
// currently parked in the holding bin (999/TEMP), with actions to move it
// back out (Transfer Order) or write it off/correct it (Stock Adjustment,
// 711/712 via BAPI_GOODSMVT_CREATE).
//
// Batch Discrepancies: pulls the FULL warehouse (independent of whatever
// search is active in Stock Management), finds every batch that has a
// negative-quantity row or sits in more than one bin, and groups/subtotals
// them. Two follow-on actions:
//   - Card 1 (nets to zero): the batch's rows across every bin — including
//     any already-parked holding-bin (999/TEMP) row — sum to zero. Preview
//     the exact transfer orders needed to zero every bin out, then execute
//     them all in one confirmed batch.
//   - Card 2 (multiple bins, doesn't net to zero): resolve one batch at a
//     time, in a modal (rather than an inline panel, which was easy to lose
//     track of below a long flagged-batch table) — either consolidate every
//     other bin's positive stock into one chosen bin, or park one instance in
//     the holding bin awaiting investigation (picked up by the Stock in
//     Investigation card below). A holding-bin row is excluded from this
//     card's active-bin list/count and from what Consolidate can move
//     into/out of (it's there on purpose) unless it happens to be part of a
//     batch that nets to zero, in which case Card 1 already claims it
//     instead — but it's still shown, read-only, in the resolve modal, so the
//     quantity already sitting in holding is never hidden while deciding
//     which bin to consolidate the rest into.
// Both action paths call the LOG_SUPER-gated /api/sap/warehouse/batch-cleanup-transfer
// (or its -bulk sibling, for the multi-move flows below) route rather than
// the ungated single/mass transfer proxy used elsewhere in Stock Management,
// since this tool can move stock across many batches automatically rather
// than one row a person explicitly picked. Every multi-move flow on this
// dashboard (Card 1's zero-sum clean-up, Card 2's consolidate-into-one-bin,
// and the Stock in Investigation card's "move back out" bulk transfer) sends
// its whole move list as one request via wsmCreateBatchCleanupTransfersBulk
// rather than awaiting one TR per round trip — SapServer's STA worker pool
// load-balances concurrent RFC calls across its service threads, so this is
// what actually lets multiple TRs process in parallel instead of one at a
// time (see routes/sap.js's batch-cleanup-transfer-bulk comment).
const WSM_HOLDING_TYPE = '999';
const WSM_HOLDING_BIN  = 'TEMP';
const WSM_EPS          = 0.0005;

function wsmIsHolding(row) {
  return row.storageType === WSM_HOLDING_TYPE && row.bin === WSM_HOLDING_BIN;
}

// Identity key for "the same physical stock, just a different bin" — used to
// decide which rows within a batch can legally be netted/consolidated via a
// single plain bin-to-bin transfer order. Rows differing in stock category or
// special stock indicator/number are a different stock status in SAP (e.g.
// quality-block vs unrestricted, or consignment) and can't just be merged by
// one transfer order, so they're kept apart and surfaced separately instead
// of silently mismatched.
function wsmCategoryKey(row) {
  return [row.material, row.batch, row.storageLocation, row.stockCategory, row.specialStockInd, row.specialStockNum].join('¦');
}

function wsmAnalyzeBatches(rows) {
  const groups = new Map();
  rows.forEach(r => {
    if (!r.batch) return;
    if (!groups.has(r.batch)) groups.set(r.batch, []);
    groups.get(r.batch).push(r);
  });

  const allFlagged = [], card1 = [], card2 = [], card3 = [];

  groups.forEach((groupRows, batch) => {
    const hasNegative = groupRows.some(r => r.availableQty < 0);
    if (!(groupRows.length > 1 || hasNegative)) return;

    const subtotal   = groupRows.reduce((s, r) => s + r.availableQty, 0);
    const nonHolding = groupRows.filter(r => !wsmIsHolding(r));
    const isZeroSum  = Math.abs(subtotal) < WSM_EPS;

    allFlagged.push({ batch, rows: groupRows, subtotal, hasNegative, isZeroSum });

    // A batch with just one *active* (non-holding) line, and that line is
    // negative, has nothing else to net (card1) or consolidate against
    // (card2 needs >1 active bin) — it needs its own resolution: pull the
    // shortfall in from the holding bin instead. Deliberately keyed off
    // nonHolding.length rather than groupRows.length, so this also catches a
    // batch that already has an (unrelated-amount) holding-bin row sitting
    // alongside the single negative active line — the resolution is the same
    // either way, and gating on groupRows.length alone let that combination
    // fall through every card with no action available.
    if (isZeroSum) {
      card1.push({ batch, rows: groupRows, subtotal });
    } else if (nonHolding.length === 1 && nonHolding[0].availableQty < 0) {
      card3.push({ batch, row: nonHolding[0] });
    } else if (nonHolding.length > 1) {
      card2.push({ batch, rows: groupRows, nonHolding, subtotal });
    }
  });

  allFlagged.sort((a, b) => a.batch.localeCompare(b.batch));
  return { allFlagged, card1, card2, card3 };
}

function wsmNetSubgroup(batch, subRows) {
  const moves = [];
  const positives = subRows.filter(r => r.availableQty > 0).map(r => ({ ...r, remaining: r.availableQty }));
  const negatives = subRows.filter(r => r.availableQty < 0).map(r => ({ ...r, remaining: -r.availableQty }));
  let pi = 0, ni = 0;
  while (pi < positives.length && ni < negatives.length) {
    const p = positives[pi], n = negatives[ni];
    const qty = Math.min(p.remaining, n.remaining);
    if (qty > WSM_EPS) {
      moves.push({
        batch, material: p.material,
        sourceType: p.storageType, sourceBin: p.bin,
        destType: n.storageType, destBin: n.bin,
        qty: Math.round(qty * 1000) / 1000,
        storageLocation: p.storageLocation, stockCategory: p.stockCategory,
        specialStockInd: p.specialStockInd, specialStockNum: p.specialStockNum,
      });
      p.remaining -= qty;
      n.remaining -= qty;
    }
    if (p.remaining <= WSM_EPS) pi++;
    if (n.remaining <= WSM_EPS) ni++;
  }
  return moves;
}

// Builds the exact transfer orders needed to zero out every card-1 batch.
// Nets within each same-category subgroup only (see wsmCategoryKey) — a
// batch whose overall total is zero but whose bins span more than one
// category can't be safely auto-combined in one pass, so it's reported back
// as unresolved rather than guessed at.
function wsmBuildZeroSumPlan(card1) {
  const plan = [], unresolved = [];

  card1.forEach(({ batch, rows }) => {
    const subgroups = new Map();
    rows.forEach(r => {
      const key = wsmCategoryKey(r);
      if (!subgroups.has(key)) subgroups.set(key, []);
      subgroups.get(key).push(r);
    });

    let allZero = true;
    const moves = [];
    subgroups.forEach(subRows => {
      const subtotal = subRows.reduce((s, r) => s + r.availableQty, 0);
      if (Math.abs(subtotal) > WSM_EPS) { allZero = false; return; }
      moves.push(...wsmNetSubgroup(batch, subRows));
    });

    if (allZero && moves.length) plan.push({ batch, moves });
    else if (!allZero) unresolved.push({ batch, reason: "Nets to zero overall, but its bins span different stock categories/special stock statuses that can't be auto-combined — needs manual review." });
  });

  return { plan, unresolved };
}

// Builds the { kind, payload } shape the batch-cleanup-transfer(-bulk) routes
// expect, from the flat params object every caller on this dashboard already
// builds (StorageLocation/Material/Batch/Quantity/Source*/Destination*/...).
function wsmBuildCleanupItem(params) {
  const isConsignment = params.SpecialStockIndicator === 'K' && params.DestinationType === 'SA';
  return {
    kind: isConsignment ? 'consignment' : 'transfer',
    payload: isConsignment ? {
      DeliveryNote: '', Header: 'Batch Discrepancy Clean-up',
      StorageLocation: params.StorageLocation, SpecialStockNumber: params.SpecialStockNumber,
      Material: params.Material, Quantity: params.Quantity,
      DestinationType: params.DestinationType, DestinationBin: params.DestinationBin,
      SourceType: params.SourceType, SourceBin: params.SourceBin,
    } : params,
  };
}

// Interprets one SapServer result — either the single route's {success,data}
// body, or one entry of the bulk route's results array — into the
// {success, message} shape every progress banner on this dashboard expects.
function wsmInterpretCleanupResult(item, json) {
  if (!json.success) return { success: false, message: json.error || 'SAP call failed' };
  if (item.kind === 'consignment') {
    const parts = [json.data?.mb1bMessage, json.data?.toNonConsignMessage, json.data?.toConsignMessage].filter(Boolean);
    return { success: true, message: parts.join('; ') || 'Consignment processed' };
  }
  const transferOrder = json.data?.transferOrderNumber || '';
  const messages       = json.data?.messages || [];
  const ok = json.data?.success && !json.error;
  if (!ok) return { success: false, message: json.error || messages.map(m => m.message || m).join('; ') || 'SAP rejected the transfer order.' };
  return { success: true, message: transferOrder ? `TO ${transferOrder}` : 'Done' };
}

// Same underlying SAP calls as wsmCreateTransferOrder, but routed through the
// LOG_SUPER-gated batch-cleanup proxy instead of the ungated one.
async function wsmCreateBatchCleanupTransfer(params) {
  const item = wsmBuildCleanupItem(params);
  try {
    const res = await fetch('/api/sap/warehouse/batch-cleanup-transfer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    });
    return wsmInterpretCleanupResult(item, await res.json());
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// Same as wsmCreateBatchCleanupTransfer, but for a whole list of moves sent
// as ONE request instead of one round trip per move — SapServer's STA worker
// pool load-balances the RFC calls across its service threads (least-loaded
// routing; see routes/sap.js's batch-cleanup-transfer-bulk comment), so this
// is what actually lets multiple TRs process in parallel rather than one at a
// time. Returns results in the same order as paramsList.
async function wsmCreateBatchCleanupTransfersBulk(paramsList) {
  const items = paramsList.map(wsmBuildCleanupItem);
  try {
    const res = await fetch('/api/sap/warehouse/batch-cleanup-transfer-bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'SAP call failed');
    return items.map((item, i) => wsmInterpretCleanupResult(item, json.results[i]));
  } catch (err) {
    return paramsList.map(() => ({ success: false, message: err.message }));
  }
}

// ── Stock Investigations — home view ──────────────────────────────────────────
async function runStockInvestigations() {
  if (!await checkSession()) return;
  if (activeDT) { try { activeDT.destroy(); } catch (_) {} activeDT = null; }
  document.getElementById('tile-section').classList.add('hidden');
  document.getElementById('result-section').classList.remove('hidden');
  document.getElementById('result-title').textContent = 'Stock Investigations';
  document.getElementById('result-hint').textContent  = 'Supervisor tools — batch discrepancies and holding-bin corrections';
  document.getElementById('result-row-badge').classList.add('hidden');
  document.getElementById('btn-export-csv').classList.add('hidden');
  wsmRenderStockInvestigationsHome();
}

function wsmRenderStockInvestigationsHome() {
  document.getElementById('result-title').textContent = 'Stock Investigations';
  document.getElementById('result-hint').textContent  = 'Supervisor tools — batch discrepancies and holding-bin corrections';
  document.getElementById('result-body').innerHTML = `
    <div class="wsm-panel-title">Batch Discrepancies</div>
    <div class="wsm-panel-sub">Scans the full warehouse for any batch with a negative-quantity line, or sitting in more than one bin, and helps clean it up.</div>
    <div class="tf-actions" style="margin-bottom:24px">
      <button type="button" class="btn-submit" id="si-disc-open-btn">Open Batch Discrepancies</button>
    </div>
    <div id="si-investigation-card">
      <div class="sap-loading"><div class="spinner"></div>Loading holding-bin stock…</div>
    </div>
    <div id="si-stockcount-disc-card" style="margin-top:28px"></div>`;

  document.getElementById('si-disc-open-btn').addEventListener('click', () => wsmRunDiscrepancyScan());
  siRefreshInvestigationCard();
  siRefreshStockCountDiscrepancies();
}

// ── Stock Count Discrepancies (fed by Finished Goods Count's guided scan) ─────
//
// Separate from Batch Discrepancies above (a live SAP scan) — this reads
// log.StockCountDiscrepancy, the holding area Finished Goods Count writes to
// when a batch is scanned in the wrong bin or confirmed missing from one.

async function siRefreshStockCountDiscrepancies() {
  const container = document.getElementById('si-stockcount-disc-card');
  if (!container) return;
  container.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Loading Stock Count discrepancies…</div>';
  try {
    const json = await scApi('/discrepancies');
    siRenderStockCountDiscrepancies(json.data || []);
  } catch (err) {
    container.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

function siRenderStockCountDiscrepancies(rows) {
  const container = document.getElementById('si-stockcount-disc-card');
  if (!container) return;

  if (!rows.length) {
    container.innerHTML = `
      <div class="wsm-panel-title">Stock Count Discrepancies</div>
      <div class="wsm-panel-sub">Batches Finished Goods Count found in the wrong bin, or missing from where SAP expects them.</div>
      <div class="wsm-empty">No open Stock Count discrepancies.</div>`;
    return;
  }

  const rowsHtml = rows.map(r => `
    <tr class="pn-row" data-id="${r.DiscrepancyId}">
      <td>${r.Kind === 'WrongBin' ? '<span style="color:#B45309;font-weight:700">Wrong Bin</span>' : '<span style="color:#DC2626;font-weight:700">Missing</span>'}</td>
      <td><strong>${esc(r.Material)}</strong></td>
      <td>${esc(r.Batch)}</td>
      <td>${fgAreaCell(r.ExpectedStorageType, r.ExpectedBin)}</td>
      <td>${fgAreaCell(r.FoundStorageType, r.FoundBin)}</td>
      <td>
        ${r.Kind === 'WrongBin' && sessionPermissions.includes('LOG_SUPER') ? `<button type="button" class="btn-submit sc-disc-move-btn" data-id="${r.DiscrepancyId}">Move to Found Bin</button>` : ''}
        ${sessionPermissions.includes('LOG_SUPER') ? `<button type="button" class="btn-secondary sc-disc-holding-btn" data-id="${r.DiscrepancyId}" style="margin-left:6px">To Holding</button>
        <button type="button" class="btn-secondary sc-disc-manual-btn" data-id="${r.DiscrepancyId}" style="margin-left:6px">Manual TO</button>` : ''}
      </td>
    </tr>`).join('');

  container.innerHTML = `
    <div class="wsm-panel-title">Stock Count Discrepancies (${rows.length})</div>
    <div class="wsm-panel-sub">Batches Finished Goods Count found in the wrong bin, or missing from where SAP expects them.</div>
    <div class="wsm-mass-table-wrap">
      <table class="wsm-mass-table">
        <thead><tr><th>Kind</th><th>Material</th><th>Batch</th><th>SAP Expected</th><th>Found In</th><th></th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div id="sc-disc-action-result" style="margin-top:10px"></div>
  `;

  container.querySelectorAll('.sc-disc-move-btn').forEach(btn => btn.addEventListener('click', () => scDiscResolveMove(btn.dataset.id)));
  container.querySelectorAll('.sc-disc-holding-btn').forEach(btn => btn.addEventListener('click', () => scDiscResolveHolding(btn.dataset.id)));
  container.querySelectorAll('.sc-disc-manual-btn').forEach(btn => btn.addEventListener('click', () => scDiscManualTo(btn.dataset.id)));
}

async function scDiscResolveMove(id) {
  if (!confirm('Move this batch from where SAP thinks it is to where it was actually found?')) return;
  const resultEl = document.getElementById('sc-disc-action-result');
  try {
    const json = await scApi(`/discrepancies/${id}/resolve-move`, { method: 'POST' });
    if (resultEl) resultEl.innerHTML = `<div class="toolbar-hint">Resolved — TO ${esc(json.data.transferOrderNumber || '')} created.</div>`;
    siRefreshStockCountDiscrepancies();
  } catch (err) {
    if (resultEl) resultEl.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function scDiscResolveHolding(id) {
  if (!confirm('Move this batch to the holding bin (999/TEMP) pending write-off?')) return;
  const resultEl = document.getElementById('sc-disc-action-result');
  try {
    const json = await scApi(`/discrepancies/${id}/resolve-holding`, { method: 'POST' });
    if (resultEl) resultEl.innerHTML = `<div class="toolbar-hint">Moved to holding — TO ${esc(json.data.transferOrderNumber || '')} created.</div>`;
    siRefreshStockCountDiscrepancies();
  } catch (err) {
    if (resultEl) resultEl.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function scDiscManualTo(id) {
  const storageType = prompt('Destination storage type (where you actually found/moved it to):');
  if (!storageType) return;
  const bin = prompt('Destination bin:');
  if (!bin) return;
  const resultEl = document.getElementById('sc-disc-action-result');
  try {
    const json = await scApi(`/discrepancies/${id}/manual-to`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationStorageType: storageType.trim(), destinationBin: bin.trim() }),
    });
    if (resultEl) resultEl.innerHTML = `<div class="toolbar-hint">Resolved — TO ${esc(json.data.transferOrderNumber || '')} created.</div>`;
    siRefreshStockCountDiscrepancies();
  } catch (err) {
    if (resultEl) resultEl.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function wsmRunDiscrepancyScan() {
  if (!await checkSession()) return;
  if (activeDT) { try { activeDT.destroy(); } catch (_) {} activeDT = null; }
  document.getElementById('result-title').textContent = 'Stock Investigations · Batch Discrepancies';
  document.getElementById('result-hint').textContent  = 'Downloading full warehouse stock for analysis…';
  document.getElementById('result-row-badge').classList.add('hidden');
  document.getElementById('btn-export-csv').classList.add('hidden');
  document.getElementById('result-body').innerHTML =
    '<div class="sap-loading"><div class="spinner"></div>Connecting to SAP…</div>';

  try {
    const rows     = await wsmFetchStock({}); // full, unfiltered pull — independent of the Stock Management search
    const analysis = wsmAnalyzeBatches(rows);
    document.getElementById('result-hint').textContent = `LQUA · WH 312 · full pull · ${rows.length} rows analysed`;
    wsmRenderDiscrepancyDashboard(analysis);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

function wsmRenderDiscrepancyDashboard(analysis) {
  const { allFlagged, card1, card2, card3 } = analysis;

  const flaggedRows = allFlagged.map(g => {
    const status = g.isZeroSum ? 'Zero-sum' : (g.rows.filter(r => !wsmIsHolding(r)).length > 1 ? 'Multi-bin conflict' : '—');
    return `<tr class="${g.hasNegative ? 'wsm-row--negative' : ''}">
      <td>${esc(g.batch)}</td>
      <td>${esc(g.rows[0]?.material || '')}</td>
      <td>${g.rows.length}</td>
      <td>${Math.round(g.subtotal * 1000) / 1000}</td>
      <td>${esc(status)}</td>
    </tr>`;
  }).join('');

  document.getElementById('result-body').innerHTML = `
    <div class="wsm-disc-toolbar">
      <button type="button" class="btn-secondary" id="wsm-disc-back">&larr; Back to Stock Investigations</button>
      <button type="button" class="btn-secondary" id="wsm-disc-rescan">Rescan</button>
    </div>

    <div class="wsm-panel-title">Flagged Batches (${allFlagged.length})</div>
    <div class="wsm-panel-sub">Any batch with a negative-quantity line, or in more than one bin.</div>
    ${allFlagged.length ? `
    <div class="wsm-mass-table-wrap" style="margin-bottom:20px">
      <table class="wsm-mass-table">
        <thead><tr><th>Batch</th><th>Material</th><th>Rows</th><th>Subtotal</th><th>Status</th></tr></thead>
        <tbody>${flaggedRows}</tbody>
      </table>
    </div>` : '<div class="wsm-empty">No negative or multi-bin batches found.</div>'}

    <div class="wsm-disc-cards">
      <div class="wsm-disc-card">
        <div class="wsm-disc-card-num">${card1.length}</div>
        <div class="wsm-disc-card-label">batch(es) net to zero across their bins — can be combined to remove</div>
        <button type="button" class="btn-submit" id="wsm-disc-card1-btn" ${card1.length ? '' : 'disabled'}>Preview Combine</button>
      </div>
      <div class="wsm-disc-card">
        <div class="wsm-disc-card-num">${card2.length}</div>
        <div class="wsm-disc-card-label">batch(es) have stock in multiple bins that doesn't net to zero</div>
        <button type="button" class="btn-submit" id="wsm-disc-card2-btn" ${card2.length ? '' : 'disabled'}>Preview Combine</button>
      </div>
      <div class="wsm-disc-card">
        <div class="wsm-disc-card-num">${card3.length}</div>
        <div class="wsm-disc-card-label">batch(es) are a single negative line — nothing to net against, resolve from holding</div>
      </div>
    </div>

    <div id="wsm-disc-card1-area"></div>
    <div id="wsm-disc-card2-area"></div>
    <div id="wsm-disc-card3-area"></div>
  `;

  document.getElementById('wsm-disc-back').addEventListener('click', () => {
    wsmRenderStockInvestigationsHome();
  });
  document.getElementById('wsm-disc-rescan').addEventListener('click', () => wsmRunDiscrepancyScan());
  const card1Btn = document.getElementById('wsm-disc-card1-btn');
  if (card1Btn) card1Btn.addEventListener('click', () => wsmShowZeroSumPreview(card1));
  const card2Btn = document.getElementById('wsm-disc-card2-btn');
  if (card2Btn) card2Btn.addEventListener('click', () => wsmOpenBulkConsolidateModal(card2));

  wsmRenderCard2List(card2);
  wsmRenderCard3List(card3);
}

function wsmShowZeroSumPreview(card1) {
  const { plan, unresolved } = wsmBuildZeroSumPlan(card1);
  const container = document.getElementById('wsm-disc-card1-area');
  if (!container) return;

  const rowsHtml = plan.flatMap(({ batch, moves }) => moves.map(m => `<tr>
    <td>${esc(batch)}</td><td>${esc(m.material)}</td>
    <td class="wsm-mono">${esc(m.sourceType)}/${esc(m.sourceBin)}</td>
    <td class="wsm-mono">${esc(m.destType)}/${esc(m.destBin)}</td>
    <td>${m.qty}</td>
  </tr>`)).join('');

  const unresolvedHtml = unresolved.length ? `
    <div class="wsm-disc-warn">
      ${unresolved.length} batch(es) net to zero overall but can't be auto-combined (mixed stock category/special stock) — left untouched:
      <ul>${unresolved.map(u => `<li>${esc(u.batch)} — ${esc(u.reason)}</li>`).join('')}</ul>
    </div>` : '';

  const totalMoves = plan.reduce((s, p) => s + p.moves.length, 0);

  container.innerHTML = `
    <div class="wsm-resolve-box">
      <div class="wsm-panel-title">Preview: Zero-Sum Clean-Up</div>
      <div class="wsm-panel-sub">${plan.length} batch(es) · ${totalMoves} transfer order(s) planned</div>
      ${unresolvedHtml}
      ${totalMoves ? `
        <div class="wsm-mass-table-wrap">
          <table class="wsm-mass-table">
            <thead><tr><th>Batch</th><th>Material</th><th>From</th><th>To</th><th>Qty</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
        <div class="tf-actions">
          <div id="wsm-disc-exec-result"></div>
          <button type="button" class="btn-secondary" id="wsm-disc-cancel">Cancel</button>
          <button type="button" class="btn-submit" id="wsm-disc-confirm">Confirm &amp; Execute ${totalMoves} Move(s)</button>
        </div>` : '<div class="wsm-empty">Nothing that can be auto-combined right now.</div>'}
    </div>`;

  const cancelBtn = document.getElementById('wsm-disc-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => { container.innerHTML = ''; });
  const confirmBtn = document.getElementById('wsm-disc-confirm');
  if (confirmBtn) confirmBtn.addEventListener('click', () => wsmExecuteZeroSumPlan(plan));
}

async function wsmExecuteZeroSumPlan(plan) {
  const resultEl   = document.getElementById('wsm-disc-exec-result');
  const confirmBtn = document.getElementById('wsm-disc-confirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Executing…';

  const entries = [];
  plan.forEach(({ batch, moves }) => moves.forEach(m => entries.push({ batch, m })));

  const totalMoves = entries.length;
  const progress   = wsmShowProgressBanner(resultEl, totalMoves, 'Executing zero-sum clean-up');

  const paramsList = entries.map(({ batch, m }) => ({
    StorageLocation: m.storageLocation, Material: m.material, Batch: batch,
    Quantity: m.qty, SourceType: m.sourceType, SourceBin: m.sourceBin,
    DestinationType: m.destType, DestinationBin: m.destBin,
    StockCategory: m.stockCategory || '', SpecialStockIndicator: m.specialStockInd || '', SpecialStockNumber: m.specialStockNum || '',
  }));

  // Sent as one request, executed concurrently server-side rather than
  // awaited move-by-move — see wsmCreateBatchCleanupTransfersBulk.
  const results = await wsmCreateBatchCleanupTransfersBulk(paramsList);

  let ok = 0, fail = 0;
  const failures = [];
  results.forEach((result, i) => {
    if (result.success) { ok++; return; }
    fail++;
    const { batch, m } = entries[i];
    failures.push(`${batch} ${m.sourceType}/${m.sourceBin} → ${m.destType}/${m.destBin}: ${result.message}`);
  });

  progress.update(totalMoves);
  progress.finish(ok, fail, failures);
  confirmBtn.textContent = 'Done — press Rescan above to refresh';
  // Deliberately not auto-rescanning: wsmRunDiscrepancyScan() replaces the
  // whole dashboard (including this very message) — the existing Rescan
  // button lets the user refresh once they've read the breakdown.
}

function wsmRenderCard2List(card2) {
  const container = document.getElementById('wsm-disc-card2-area');
  if (!container) return;
  if (!card2.length) { container.innerHTML = ''; return; }

  const rowsHtml = card2.map(g => `<tr data-batch="${esc(g.batch)}">
    <td>${esc(g.batch)}</td>
    <td>${esc(g.rows[0]?.material || '')}</td>
    <td>${g.nonHolding.length}</td>
    <td>${Math.round(g.subtotal * 1000) / 1000}</td>
    <td><button type="button" class="btn-secondary wsm-disc-resolve-btn" data-batch="${esc(g.batch)}">Resolve</button></td>
  </tr>`).join('');

  container.innerHTML = `
    <div class="wsm-panel-title" style="margin-top:8px">Multiple Bins, Non-Zero</div>
    <div class="wsm-mass-table-wrap">
      <table class="wsm-mass-table" id="wsm-disc-card2-table">
        <thead><tr><th>Batch</th><th>Material</th><th>Active Bins</th><th>Subtotal</th><th></th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;

  container.querySelectorAll('.wsm-disc-resolve-btn').forEach(btn => {
    btn.addEventListener('click', () => wsmOpenResolveModal(card2.find(g => g.batch === btn.dataset.batch), card2));
  });
}

// Removes one resolved batch's row from the Card 2 (Multiple Bins, Non-Zero)
// table in place — same "don't wait for a full rescan" idiom Card 3 already
// uses for its own row removal — so a fully consolidated batch disappears
// from the list immediately and can't accidentally be resolved twice.
function wsmRemoveCard2Row(card2, batch) {
  const idx = card2.findIndex(g => g.batch === batch);
  if (idx !== -1) card2.splice(idx, 1);
  const tr = document.querySelector(`#wsm-disc-card2-table tr[data-batch="${CSS.escape(batch)}"]`);
  if (tr) tr.remove();
}

function wsmResolveSubText(group) {
  const holdingRows = group.rows.filter(wsmIsHolding);
  const holdingQty  = holdingRows.reduce((s, r) => s + r.availableQty, 0);
  return `Subtotal ${Math.round(group.subtotal * 1000) / 1000} across ${group.nonHolding.length} active bin(s)` +
    (holdingRows.length ? ` · ${Math.round(holdingQty * 1000) / 1000} already in holding (${WSM_HOLDING_TYPE}/${WSM_HOLDING_BIN}), shown below` : '');
}

// Builds the resolve table's rows: the batch's holding-bin (999/TEMP) row(s)
// first — shown so the quantity already parked in holding is never hidden
// while picking which bin to consolidate into, but not selectable/actionable
// here, since holding is a destination Move to Holding sends stock TO, not
// something this table's Consolidate action merges FROM — followed by the
// active (non-holding) bins, same as before. Rows are keyed by wsmRowId
// rather than array index so that removing one row in place (see
// wsmMoveToHolding) never shifts what an already-checked radio or a data
// attribute refers to.
function wsmResolveRowsHtml(group) {
  const holdingRows = group.rows.filter(wsmIsHolding);
  const holdingHtml = holdingRows.map(r => `<tr class="wsm-row--holding" data-row-id="${esc(wsmRowId(r))}">
      <td></td>
      <td class="wsm-mono">${esc(r.storageType)}/${esc(r.bin)}</td>
      <td>${Math.round(r.availableQty * 1000) / 1000}</td>
      <td>Already in holding</td>
    </tr>`).join('');

  const activeHtml = group.nonHolding.map(r => {
    const id = wsmRowId(r);
    return `<tr data-row-id="${esc(id)}">
      <td><input type="radio" name="wsm-resolve-target" value="${esc(id)}"></td>
      <td class="wsm-mono">${esc(r.storageType)}/${esc(r.bin)}</td>
      <td>${r.availableQty}</td>
      <td><button type="button" class="btn-secondary wsm-resolve-holding-btn" data-row-id="${esc(id)}" ${r.availableQty > 0 ? '' : 'disabled'}>Move to Holding</button></td>
    </tr>`;
  }).join('');

  return holdingHtml + activeHtml;
}

// (Re)renders the resolve table's body and rewires its listeners — used both
// when the modal first opens and after a Move to Holding action changes
// what's active vs. already in holding.
function wsmRenderResolveTable(group) {
  const tbody = document.querySelector('#wsm-resolve-table tbody');
  if (!tbody) return;
  tbody.innerHTML = wsmResolveRowsHtml(group);
  tbody.querySelectorAll('input[name="wsm-resolve-target"]').forEach(radio => {
    radio.addEventListener('change', () => wsmRenderConsolidatePrecheck(group));
  });
  tbody.querySelectorAll('.wsm-resolve-holding-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = group.nonHolding.find(r => wsmRowId(r) === btn.dataset.rowId);
      wsmMoveToHolding(group, row);
    });
  });
}

// Opens the Card 2 resolve flow as a modal overlay rather than an inline
// panel below the (potentially long) flagged-batch table — otherwise easy to
// scroll past without noticing. `card2` is passed through so a fully
// consolidated batch can be spliced out of the underlying list and its row
// dropped from the on-page table the instant it's resolved (see
// wsmConsolidateGroup), without waiting for a full Rescan.
function wsmOpenResolveModal(group, card2) {
  if (!group) return;
  document.getElementById('wsm-resolve-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id        = 'wsm-resolve-modal';
  overlay.className = 'wsm-resolve-overlay';
  overlay.innerHTML = `
    <div class="wsm-resolve-modal">
      <div class="wsm-resolve-modal-hdr">
        <div class="wsm-panel-title">Resolve Batch ${esc(group.batch)}</div>
        <button type="button" class="wsm-resolve-close" aria-label="Close">&times;</button>
      </div>
      <div class="wsm-panel-sub" id="wsm-resolve-sub">${wsmResolveSubText(group)}</div>
      <div class="wsm-mass-table-wrap">
        <table class="wsm-mass-table" id="wsm-resolve-table">
          <thead><tr><th>Keep</th><th>Bin</th><th>Qty</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div id="wsm-resolve-precheck"></div>
      <div class="tf-actions">
        <div id="wsm-resolve-result"></div>
        <button type="button" class="btn-secondary" id="wsm-resolve-cancel">Close</button>
        <button type="button" class="btn-submit" id="wsm-resolve-consolidate-btn">Consolidate Into Selected Bin</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.wsm-resolve-close').addEventListener('click', close);
  overlay.querySelector('#wsm-resolve-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  document.getElementById('wsm-resolve-consolidate-btn').addEventListener('click', () => wsmConsolidateGroup(group, card2));

  wsmRenderResolveTable(group);
}

// ── Card 2 — bulk consolidate across every batch at once ──────────────────
//
// Resolving 90+ multi-bin batches one at a time through the single-batch
// modal above doesn't scale — this is the "Preview Combine" equivalent for
// Card 2 (mirroring Card 1's zero-sum Preview Combine): pick a keep-bin for
// every batch at once (defaulted sensibly, overridable per batch), preview
// every move it implies across the whole list, then execute them all in one
// bulk request.
//
// Unlike the single-batch resolve modal (wsmComputeConsolidatePlan), which
// only ever pushes OTHER positive bins into the chosen one and leaves
// negative bins and the holding bin alone for manual handling, this bulk
// tool is bidirectional and holding-inclusive by design: negative bins get
// topped up FROM the chosen bin (same idea Card 3 already uses pulling from
// holding into a single negative line — the shortfall just lands back on the
// chosen bin instead of disappearing), and the holding bin itself can be
// picked as the keep-bin, since working through a big backlog needs full
// control over where everything ends up rather than clearing every
// holding-bin exception by hand afterwards.

// Sensible default keep-bin per batch: the largest active (non-holding)
// positive bin, since that's normally the "real" pickable location you'd
// want stock consolidated into rather than left in quarantine. Falls back to
// the overall largest-quantity bin (which could be the holding bin) only
// when there's no positive active bin to prefer.
function wsmDefaultBulkTarget(group) {
  const positiveNonHolding = group.rows.filter(r => !wsmIsHolding(r) && r.availableQty > 0);
  const pool = positiveNonHolding.length ? positiveNonHolding : group.rows;
  return pool.reduce((best, r) => (r.availableQty > best.availableQty ? r : best));
}

// Per-batch plan for a given chosen target bin — every other bin in the
// batch (including holding) either pushes its positive quantity into target,
// or pulls its shortfall in from target if negative; bins in a different
// stock category/special stock/material/location than target are left
// untouched and reported back with a reason, same categorisation
// wsmComputeConsolidatePlan already uses.
function wsmComputeBulkPlan(group, target) {
  const targetKey = wsmCategoryKey(target);
  const others = group.rows.filter(r => wsmRowId(r) !== wsmRowId(target));

  const moves = [], skipped = [];
  others.forEach(r => {
    if (Math.abs(r.availableQty) < WSM_EPS) return; // nothing to move

    if (wsmCategoryKey(r) !== targetKey) {
      const reasons = [];
      if (r.material !== target.material) reasons.push('different material');
      else if (r.stockCategory !== target.stockCategory) reasons.push('different stock category');
      else if (r.specialStockInd !== target.specialStockInd || r.specialStockNum !== target.specialStockNum) reasons.push('different special stock');
      else reasons.push('different storage location/batch');
      skipped.push({ row: r, reason: reasons.join(' & ') });
      return;
    }

    if (r.availableQty > 0) moves.push({ source: r, dest: target, qty: r.availableQty });
    else moves.push({ source: target, dest: r, qty: -r.availableQty });
  });

  return { target, moves, skipped };
}

// Builds the plan for every batch in card2 at once, using whatever's
// currently selected in `targets` (Map<batch, row>) — recomputed fresh
// wherever it's needed (live preview, and again right before executing)
// rather than cached, so it can never drift from what's actually selected.
function wsmBuildBulkPlan(card2, targets) {
  return card2
    .map(group => {
      const target = targets.get(group.batch);
      if (!target) return null;
      const { moves, skipped } = wsmComputeBulkPlan(group, target);
      return { group, target, moves, skipped };
    })
    .filter(Boolean);
}

function wsmRenderBulkPreview(card2, targets) {
  const container = document.getElementById('wsm-bulk-preview');
  if (!container) return;

  const perBatch     = wsmBuildBulkPlan(card2, targets);
  const totalMoves   = perBatch.reduce((s, p) => s + p.moves.length, 0);
  const totalSkipped = perBatch.reduce((s, p) => s + p.skipped.length, 0);

  const movesHtml = perBatch.flatMap(({ group, moves }) => moves.map(m => `<tr>
    <td>${esc(group.batch)}</td>
    <td class="wsm-mono">${esc(m.source.storageType)}/${esc(m.source.bin)}</td>
    <td class="wsm-mono">${esc(m.dest.storageType)}/${esc(m.dest.bin)}</td>
    <td>${Math.round(m.qty * 1000) / 1000}</td>
  </tr>`)).join('');

  const skippedHtml = perBatch.filter(p => p.skipped.length).map(({ group, skipped }) =>
    `<li>${esc(group.batch)}: ${skipped.map(s => `${esc(s.row.storageType)}/${esc(s.row.bin)} (qty ${s.row.availableQty}) — ${esc(s.reason)}`).join('; ')}</li>`
  ).join('');

  container.innerHTML = `
    <div class="wsm-panel-sub">${perBatch.length} batch(es) · ${totalMoves} move(s) planned${totalSkipped ? ` · ${totalSkipped} bin(s) skipped (category mismatch)` : ''}</div>
    ${totalSkipped ? `<div class="wsm-disc-warn"><ul>${skippedHtml}</ul></div>` : ''}
    ${totalMoves ? `
      <div class="wsm-mass-table-wrap" style="max-height:320px;overflow-y:auto">
        <table class="wsm-mass-table">
          <thead><tr><th>Batch</th><th>From</th><th>To</th><th>Qty</th></tr></thead>
          <tbody>${movesHtml}</tbody>
        </table>
      </div>` : '<div class="wsm-empty">Nothing to move.</div>'}`;

  const confirmBtn = document.getElementById('wsm-bulk-confirm');
  if (confirmBtn) confirmBtn.disabled = !totalMoves;
}

function wsmOpenBulkConsolidateModal(card2) {
  if (!card2.length) return;
  document.getElementById('wsm-bulk-modal')?.remove();

  // batch -> currently selected keep-bin row. A plain Map rather than
  // storing the choice on each group, so re-selecting a target never has to
  // reconcile with wsmMoveToHolding/wsmConsolidateGroup mutating the same
  // group objects elsewhere (this modal reads group.rows but never mutates
  // it, side-stepping that entirely).
  const targets = new Map();
  card2.forEach(g => targets.set(g.batch, wsmDefaultBulkTarget(g)));

  const overlay = document.createElement('div');
  overlay.id        = 'wsm-bulk-modal';
  overlay.className = 'wsm-resolve-overlay';

  const selectRowsHtml = card2.map(g => {
    const target = targets.get(g.batch);
    const binsHtml = g.rows.map(r => {
      const id = wsmRowId(r);
      const checked = wsmRowId(target) === id ? ' checked' : '';
      return `<label class="wsm-bulk-bin-opt"><input type="radio" name="wsm-bulk-target-${esc(g.batch)}" value="${esc(id)}"${checked}> ${esc(r.storageType)}/${esc(r.bin)} (${Math.round(r.availableQty * 1000) / 1000})</label>`;
    }).join('');
    return `<tr data-batch="${esc(g.batch)}">
      <td>${esc(g.batch)}</td>
      <td>${esc(g.rows[0]?.material || '')}</td>
      <td class="wsm-bulk-bins">${binsHtml}</td>
    </tr>`;
  }).join('');

  overlay.innerHTML = `
    <div class="wsm-resolve-modal wsm-resolve-modal--wide">
      <div class="wsm-resolve-modal-hdr">
        <div class="wsm-panel-title">Bulk Consolidate — ${card2.length} Batch(es)</div>
        <button type="button" class="wsm-resolve-close" aria-label="Close">&times;</button>
      </div>
      <div class="wsm-panel-sub">Pick which bin to keep for each batch — defaults to the largest active bin. Other positive bins move in; negative bins are topped up from the bin you keep.</div>
      <div class="wsm-mass-table-wrap" style="max-height:280px;overflow-y:auto">
        <table class="wsm-mass-table" id="wsm-bulk-select-table">
          <thead><tr><th>Batch</th><th>Material</th><th>Bins (pick one to keep)</th></tr></thead>
          <tbody>${selectRowsHtml}</tbody>
        </table>
      </div>

      <div class="wsm-panel-title" style="margin-top:16px">Planned Moves</div>
      <div id="wsm-bulk-preview"></div>

      <div class="tf-actions">
        <div id="wsm-bulk-exec-result"></div>
        <button type="button" class="btn-secondary" id="wsm-bulk-cancel">Close</button>
        <button type="button" class="btn-submit" id="wsm-bulk-confirm">Confirm &amp; Execute</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.wsm-resolve-close').addEventListener('click', close);
  overlay.querySelector('#wsm-bulk-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  overlay.querySelectorAll('#wsm-bulk-select-table input[type="radio"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const batch = radio.closest('tr').dataset.batch;
      const group = card2.find(g => g.batch === batch);
      const row   = group?.rows.find(r => wsmRowId(r) === radio.value);
      if (row) targets.set(batch, row);
      wsmRenderBulkPreview(card2, targets);
    });
  });

  document.getElementById('wsm-bulk-confirm').addEventListener('click', () => wsmExecuteBulkPlan(card2, targets));

  wsmRenderBulkPreview(card2, targets);
}

async function wsmExecuteBulkPlan(card2, targets) {
  const resultEl   = document.getElementById('wsm-bulk-exec-result');
  const confirmBtn = document.getElementById('wsm-bulk-confirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Executing…';

  // Recomputed fresh rather than trusting the last-rendered preview — cheap,
  // and guarantees this can never execute against a stale plan.
  const perBatch = wsmBuildBulkPlan(card2, targets);
  const entries  = [];
  perBatch.forEach(({ group, moves }) => moves.forEach(m => entries.push({ group, m })));

  const totalMoves = entries.length;
  if (!totalMoves) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm & Execute'; return; }

  const progress = wsmShowProgressBanner(resultEl, totalMoves, 'Executing bulk consolidation');

  const paramsList = entries.map(({ group, m }) => ({
    StorageLocation: m.source.storageLocation, Material: m.source.material, Batch: group.batch,
    Quantity: m.qty, SourceType: m.source.storageType, SourceBin: m.source.bin,
    DestinationType: m.dest.storageType, DestinationBin: m.dest.bin,
    StockCategory: m.source.stockCategory || '', SpecialStockIndicator: m.source.specialStockInd || '', SpecialStockNumber: m.source.specialStockNum || '',
  }));

  // Sent as one request, executed concurrently server-side rather than
  // awaited move-by-move — see wsmCreateBatchCleanupTransfersBulk.
  const results = await wsmCreateBatchCleanupTransfersBulk(paramsList);

  // A batch only counts as fully resolved if every one of ITS OWN moves
  // succeeded — one failed move (or a skipped, category-mismatched bin) means
  // that batch stays in the Multiple Bins, Non-Zero list for manual
  // follow-up rather than disappearing along with the rest.
  const batchOk = new Map();
  let ok = 0, fail = 0;
  const failures = [];
  results.forEach((result, i) => {
    const { group, m } = entries[i];
    if (!batchOk.has(group.batch)) batchOk.set(group.batch, true);
    if (result.success) { ok++; return; }
    fail++;
    batchOk.set(group.batch, false);
    failures.push(`${group.batch} ${m.source.storageType}/${m.source.bin} → ${m.dest.storageType}/${m.dest.bin}: ${result.message}`);
  });

  progress.update(totalMoves);
  progress.finish(ok, fail, failures);

  let removed = 0;
  perBatch.forEach(({ group, skipped }) => {
    if (skipped.length) return; // never a complete consolidation — leave it for manual review even if what it DID plan succeeded
    if (batchOk.get(group.batch)) { wsmRemoveCard2Row(card2, group.batch); removed++; }
  });

  const summary = document.createElement('div');
  summary.className = 'wsm-progress-summary';
  summary.textContent = `${removed} batch(es) fully resolved and removed from the list.` +
    (removed < perBatch.length ? ` ${perBatch.length - removed} remain — resolve individually above, or Rescan and retry.` : '');
  resultEl.appendChild(summary);

  confirmBtn.textContent = 'Done — press Rescan above to refresh';
  // Left open rather than auto-closing (unlike the single-batch resolve
  // modal's 1s auto-close, built for a repetitive "resolve one, move to the
  // next" flow) — this is a one-time bulk action across potentially dozens
  // of batches, so there's real value in leaving the breakdown up to review
  // rather than snapping the modal shut the moment it finishes.
}

// Shared by the live pre-consolidate check and the actual Consolidate action,
// so the warning shown before you press the button and what the button
// actually does can never drift apart. Returns which of the batch's other
// active bins would move into `target` (same material/batch/storage
// location/stock category/special stock, positive qty) and which would be
// left behind, with a human-readable reason per skipped row.
function wsmComputeConsolidatePlan(group, target) {
  const targetKey = wsmCategoryKey(target);
  const others    = group.nonHolding.filter(r => wsmRowId(r) !== wsmRowId(target));

  const movable = [], skipped = [];
  others.forEach(r => {
    if (r.availableQty > 0 && wsmCategoryKey(r) === targetKey) { movable.push(r); return; }

    const reasons = [];
    if (!(r.availableQty > 0)) reasons.push('negative/zero quantity');
    if (wsmCategoryKey(r) !== targetKey) {
      if (r.material !== target.material) reasons.push('different material');
      else if (r.stockCategory !== target.stockCategory) reasons.push('different stock category');
      else if (r.specialStockInd !== target.specialStockInd || r.specialStockNum !== target.specialStockNum) reasons.push('different special stock');
      else reasons.push('different storage location/batch');
    }
    skipped.push({ row: r, reason: reasons.join(' & ') || 'category mismatch' });
  });

  return { target, movable, skipped };
}

// Shows, before Consolidate is pressed, exactly which other bin(s) would be
// left behind and why (material/stock category/special stock mismatch, or
// negative quantity) — so a mismatch that would stop the consolidation isn't
// a surprise found out only after execution.
function wsmRenderConsolidatePrecheck(group) {
  const container = document.getElementById('wsm-resolve-precheck');
  if (!container) return;

  const radio = document.querySelector('input[name="wsm-resolve-target"]:checked');
  if (!radio) { container.innerHTML = ''; return; }

  const target = group.nonHolding.find(r => wsmRowId(r) === radio.value);
  if (!target) { container.innerHTML = ''; return; }

  const { movable, skipped } = wsmComputeConsolidatePlan(group, target);

  if (!skipped.length) {
    container.innerHTML = movable.length
      ? `<div class="wsm-disc-note">All ${movable.length} other active bin(s) match ${esc(target.storageType)}/${esc(target.bin)} and would be moved in.</div>`
      : '';
    return;
  }

  container.innerHTML = `
    <div class="wsm-disc-warn">
      ${skipped.length} bin(s) would NOT be moved into ${esc(target.storageType)}/${esc(target.bin)} if you consolidate now:
      <ul>${skipped.map(s => `<li>${esc(s.row.storageType)}/${esc(s.row.bin)} (qty ${s.row.availableQty}) — ${esc(s.reason)}</li>`).join('')}</ul>
    </div>`;
}

async function wsmConsolidateGroup(group, card2) {
  const radio    = document.querySelector('input[name="wsm-resolve-target"]:checked');
  const resultEl = document.getElementById('wsm-resolve-result');
  if (!radio) { resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ Pick a bin to keep first.</div>`; return; }

  const target = group.nonHolding.find(r => wsmRowId(r) === radio.value);
  if (!target) { resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ That bin is no longer active — pick another.</div>`; return; }

  const { movable, skipped } = wsmComputeConsolidatePlan(group, target);

  if (!movable.length) {
    resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ Nothing movable into that bin — other rows are either negative or a different stock category/special stock, which need manual handling.</div>`;
    return;
  }

  resultEl.innerHTML = '';
  const consolidateBtn = document.getElementById('wsm-resolve-consolidate-btn');
  if (consolidateBtn) consolidateBtn.disabled = true;

  const progress = wsmShowProgressBanner(resultEl, movable.length, 'Consolidating into selected bin');

  const paramsList = movable.map(r => ({
    StorageLocation: r.storageLocation, Material: r.material, Batch: group.batch,
    Quantity: r.availableQty, SourceType: r.storageType, SourceBin: r.bin,
    DestinationType: target.storageType, DestinationBin: target.bin,
    StockCategory: r.stockCategory || '', SpecialStockIndicator: r.specialStockInd || '', SpecialStockNumber: r.specialStockNum || '',
  }));

  // Sent as one request, executed concurrently server-side rather than
  // awaited move-by-move — see wsmCreateBatchCleanupTransfersBulk.
  const results = await wsmCreateBatchCleanupTransfersBulk(paramsList);

  let ok = 0, fail = 0;
  const failures = [];
  results.forEach((result, i) => {
    if (result.success) { ok++; return; }
    fail++;
    const r = movable[i];
    failures.push(`${r.storageType}/${r.bin}: ${result.message}`);
  });

  progress.update(movable.length);
  progress.finish(ok, fail, failures);
  if (skipped.length) {
    const note = document.createElement('div');
    note.className = 'wsm-progress-summary';
    note.textContent = `${skipped.length} row(s) left untouched (negative qty or different stock category/special stock).`;
    resultEl.appendChild(note);
  }

  if (fail === 0) {
    // Fully resolved — the progress banner's "✓ All N succeeded." is the
    // brief success message; leave it up for a moment, then close the modal
    // and drop this batch from the Multiple Bins, Non-Zero list in place, so
    // it can't be pressed a second time and the list visibly shrinks without
    // needing a full Rescan.
    if (consolidateBtn) consolidateBtn.textContent = 'Done';
    setTimeout(() => {
      document.getElementById('wsm-resolve-modal')?.remove();
      wsmRemoveCard2Row(card2, group.batch);
    }, 1000);
    return;
  }

  if (consolidateBtn) consolidateBtn.textContent = 'Done — press Rescan above to refresh';
  // Left open on any failure, unlike the fully-successful path above — the
  // modal isn't auto-closed so the failure breakdown stays readable, and
  // Rescan afterwards will reflect whatever actually landed in SAP.
}

async function wsmMoveToHolding(group, row) {
  if (!row) return;
  const resultEl = document.getElementById('wsm-resolve-result');
  if (!(row.availableQty > 0)) {
    if (resultEl) resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ Only a positive-quantity bin can be moved into holding.</div>`;
    return;
  }
  if (!await wConfirm({
    title: 'Move to Holding',
    message: `Move ${row.availableQty} of batch ${group.batch} from ${row.storageType}/${row.bin} into the holding bin (${WSM_HOLDING_TYPE}/${WSM_HOLDING_BIN}), awaiting stock investigation?`,
    confirmText: 'Move',
    variant: 'danger',
  })) return;

  const rowId = wsmRowId(row);
  const btn = document.querySelector(`.wsm-resolve-holding-btn[data-row-id="${CSS.escape(rowId)}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Moving…'; }

  const result = await wsmCreateBatchCleanupTransfer({
    StorageLocation: row.storageLocation, Material: row.material, Batch: group.batch,
    Quantity: row.availableQty, SourceType: row.storageType, SourceBin: row.bin,
    DestinationType: WSM_HOLDING_TYPE, DestinationBin: WSM_HOLDING_BIN,
    StockCategory: row.stockCategory || '', SpecialStockIndicator: row.specialStockInd || '', SpecialStockNumber: row.specialStockNum || '',
  });

  if (!result.success) {
    if (resultEl) resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ ${esc(result.message)}</div>`;
    if (btn) { btn.disabled = false; btn.textContent = 'Move to Holding'; }
    return;
  }

  // Success — drop the row from the active list, and fold its quantity into
  // the matching holding-bin row (same material/batch/location/stock status
  // — see wsmCategoryKey) so the "already in holding" total the resolve
  // table shows stays accurate for the rest of this session, not just what
  // was already parked there when the batch was first scanned.
  const idx = group.nonHolding.findIndex(r => wsmRowId(r) === rowId);
  if (idx !== -1) group.nonHolding.splice(idx, 1);

  const holdingMatch = group.rows.find(r => wsmIsHolding(r) && wsmCategoryKey(r) === wsmCategoryKey(row));
  if (holdingMatch) holdingMatch.availableQty += row.availableQty;
  else group.rows.push({ ...row, storageType: WSM_HOLDING_TYPE, bin: WSM_HOLDING_BIN });

  wsmRenderResolveTable(group);

  const subEl = document.getElementById('wsm-resolve-sub');
  if (subEl) subEl.textContent = wsmResolveSubText(group);

  if (resultEl) resultEl.innerHTML = `<div class="tf-success tf-inline-error">Moved ${row.availableQty} from ${esc(row.storageType)}/${esc(row.bin)} to holding.</div>`;

  const consolidateBtn = document.getElementById('wsm-resolve-consolidate-btn');
  if (group.nonHolding.length < 2) {
    // Nothing left to consolidate between — disable rather than leave a
    // one-row radio list that can't do anything useful.
    if (consolidateBtn) { consolidateBtn.disabled = true; consolidateBtn.textContent = 'Nothing left to consolidate'; }
    const precheck = document.getElementById('wsm-resolve-precheck');
    if (precheck) precheck.innerHTML = '';
  } else {
    wsmRenderConsolidatePrecheck(group); // re-check against whatever's still selected — if the row just removed WAS the selected target, no radio is checked any more and this clears down to empty
  }

  // The Stock in Investigation card lives in a different view (the Stock
  // Investigations home, not this discrepancy dashboard) — refresh it in the
  // background if it happens to be mounted, and it'll be fetched fresh next
  // time the user navigates back regardless (see siRefreshInvestigationCard).
  siRefreshInvestigationCard();
}

// ── Card 3 — single-line negative batches ─────────────────────────────────
//
// A batch that's genuinely just one line, and that line is negative, has
// nothing else in the batch to net (card1) or consolidate against (card2 —
// needs more than one active bin). Per the user: resolve it by moving the
// quantity IN from the holding bin (999/TEMP) into the negative bin, zeroing
// it out — which leaves the holding bin negative by the same amount instead,
// exactly mirroring the "park a discrepancy in holding" idea Move to Holding
// already uses, just run in reverse since there's no positive line here to
// park. Same underlying batch-cleanup transfer call as everything else on
// this dashboard, just with holding as the SOURCE instead of the destination.
function wsmRenderCard3List(card3) {
  const container = document.getElementById('wsm-disc-card3-area');
  if (!container) return;
  if (!card3.length) { container.innerHTML = ''; return; }

  const rowsHtml = card3.map(entry => {
    const { batch, row } = entry;
    const id = wsmRowId(row);
    return `<tr data-row-id="${esc(id)}">
      <td>${esc(batch)}</td>
      <td>${esc(row.material)}</td>
      <td class="wsm-mono">${esc(row.storageType)}/${esc(row.bin)}</td>
      <td>${row.availableQty}</td>
      <td id="wsm-card3-result-${esc(id)}"><button type="button" class="btn-secondary wsm-card3-resolve-btn" data-row-id="${esc(id)}">Pull From Holding</button></td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="wsm-panel-title" style="margin-top:8px">Single-Line Negative</div>
    <div class="wsm-panel-sub">Just one bin for the whole batch, and it's negative — nothing else in the batch to net or consolidate against. Resolved by pulling the shortfall in from the holding bin (${WSM_HOLDING_TYPE}/${WSM_HOLDING_BIN}), which leaves the holding bin negative by the same amount instead.</div>
    <div class="wsm-mass-table-wrap">
      <table class="wsm-mass-table" id="wsm-disc-card3-table">
        <thead><tr><th>Batch</th><th>Material</th><th>Bin</th><th>Qty</th><th></th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;

  container.querySelectorAll('.wsm-card3-resolve-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = card3.find(e => wsmRowId(e.row) === btn.dataset.rowId);
      wsmResolveNegativeLine(entry);
    });
  });
}

async function wsmResolveNegativeLine(entry) {
  if (!entry) return;
  const { batch, row } = entry;
  const qty = Math.abs(row.availableQty);
  const id = wsmRowId(row);
  const resultCell = document.getElementById(`wsm-card3-result-${id}`);

  if (!await wConfirm({
    title: 'Resolve Single-Line Negative',
    message: `Batch ${batch} has only one line, ${row.storageType}/${row.bin}, currently showing ${row.availableQty}. Pull ${qty} in from the holding bin (${WSM_HOLDING_TYPE}/${WSM_HOLDING_BIN}) to bring this bin to zero? This leaves the holding bin negative by ${qty} instead.`,
    confirmText: 'Pull From Holding',
    variant: 'danger',
  })) return;

  const btn = document.querySelector(`.wsm-card3-resolve-btn[data-row-id="${CSS.escape(id)}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Moving…'; }

  const result = await wsmCreateBatchCleanupTransfer({
    StorageLocation: row.storageLocation, Material: row.material, Batch: batch,
    Quantity: qty, SourceType: WSM_HOLDING_TYPE, SourceBin: WSM_HOLDING_BIN,
    DestinationType: row.storageType, DestinationBin: row.bin,
    StockCategory: row.stockCategory || '', SpecialStockIndicator: row.specialStockInd || '', SpecialStockNumber: row.specialStockNum || '',
  });

  if (!result.success) {
    if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-fail">✕ ${esc(result.message)}</span>`;
    if (btn) { btn.disabled = false; btn.textContent = 'Pull From Holding'; }
    return;
  }

  // Success — drop just this row's <tr> in place, same reasoning as
  // wsmMoveToHolding: the screen stays exactly where it was, the resolved
  // line simply disappears rather than the whole dashboard re-rendering.
  const tr = document.querySelector(`#wsm-disc-card3-table tr[data-row-id="${CSS.escape(id)}"]`);
  if (tr) tr.remove();

  // The holding bin's balance just moved — refresh the Stock in Investigation
  // card in the background if it's mounted, same as Move to Holding does.
  siRefreshInvestigationCard();
}

// ── Stock in Investigation card (holding bin 999/TEMP) ────────────────────────
//
// Part of the Stock Investigations home view — lists whatever's currently
// sitting in the holding bin (populated by Batch Discrepancies' "Move to
// Holding" above), with multi-select actions to either move it back out via
// a normal Transfer Order, or write it off/correct it via a Stock Adjustment
// (711/712, BAPI_GOODSMVT_CREATE). Deliberately re-fetches from scratch every
// time it's (re)rendered rather than caching — the simplest way to satisfy
// "this card should update whenever Move to Holding is pressed": there's no
// stale in-memory copy to go out of sync, so returning to this view (or
// calling siRefreshInvestigationCard() directly, which Move to Holding does
// in the background) always reflects what's actually in SAP right now.
let siInvestigation = null; // { rows, selected: Set<rowId> }

async function siRefreshInvestigationCard() {
  const container = document.getElementById('si-investigation-card');
  if (!container) return; // not currently mounted (e.g. inside the Batch Discrepancies sub-view) — the next Home render fetches fresh anyway
  container.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Loading holding-bin stock…</div>';
  try {
    const rows = await wsmFetchStock({ storageType: WSM_HOLDING_TYPE, bin: WSM_HOLDING_BIN });
    siInvestigation = { rows, selected: new Set() };
  } catch (err) {
    container.innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
    siInvestigation = null;
    return;
  }
  siRenderInvestigationCard();
}

function siRenderInvestigationCard() {
  const container = document.getElementById('si-investigation-card');
  if (!container || !siInvestigation) return;
  const { rows } = siInvestigation;

  if (!rows.length) {
    container.innerHTML = `
      <div class="wsm-panel-title">Stock in Investigation</div>
      <div class="wsm-panel-sub">Stock currently parked in the holding bin (${WSM_HOLDING_TYPE}/${WSM_HOLDING_BIN}), awaiting write-off/correction.</div>
      <div class="wsm-empty">Nothing currently in holding.</div>`;
    return;
  }

  const allChecked = rows.every(r => siInvestigation.selected.has(wsmRowId(r)));
  const rowsHtml = rows.map(row => {
    const id = wsmRowId(row);
    const neg = row.availableQty < 0;
    const checked = siInvestigation.selected.has(id) ? ' checked' : '';
    return `<tr class="wsm-row${neg ? ' wsm-row--negative' : ''}" data-id="${esc(id)}">
      <td class="wsm-td-check"><input type="checkbox" class="si-row-check" data-id="${esc(id)}"${checked}></td>
      <td>${esc(row.storageLocation)}</td>
      <td>${esc(row.material)}</td>
      <td>${row.availableQty}</td>
      <td>${esc(row.batch || '—')}</td>
      <td>${esc(row.stockCategory || '—')}</td>
      <td>${esc(row.specialStockInd || '—')}</td>
      <td>${esc(row.specialStockNum || '—')}</td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="wsm-panel-title">Stock in Investigation</div>
    <div class="wsm-panel-sub">Stock currently parked in the holding bin (${WSM_HOLDING_TYPE}/${WSM_HOLDING_BIN}), awaiting write-off/correction — select one or more rows.</div>
    <div class="wsm-mass-table-wrap">
      <table class="wsm-mass-table">
        <thead>
          <tr>
            <th class="wsm-td-check"><input type="checkbox" id="si-select-all"${allChecked ? ' checked' : ''}></th>
            <th>Storage Loc.</th><th>Material</th><th>Qty</th><th>Batch</th><th>Stock Cat.</th><th>Special Stock</th><th>Special Stock No.</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div class="tf-actions">
      <div id="si-action-result"></div>
      <button type="button" class="btn-secondary" id="si-refresh-btn">Refresh</button>
      <button type="button" class="btn-secondary" id="si-transfer-btn" ${siInvestigation.selected.size ? '' : 'disabled'}>Create Transfer Order</button>
      <button type="button" class="btn-submit" id="si-adjust-btn" ${siInvestigation.selected.size ? '' : 'disabled'}>Create Stock Adjustment</button>
    </div>
    <div id="si-action-panel"></div>`;

  document.getElementById('si-select-all').addEventListener('change', e => {
    if (e.target.checked) rows.forEach(r => siInvestigation.selected.add(wsmRowId(r)));
    else rows.forEach(r => siInvestigation.selected.delete(wsmRowId(r)));
    siRenderInvestigationCard();
  });
  container.querySelectorAll('.si-row-check').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) siInvestigation.selected.add(cb.dataset.id); else siInvestigation.selected.delete(cb.dataset.id);
      siRenderInvestigationCard();
    });
  });
  document.getElementById('si-refresh-btn').addEventListener('click', () => siRefreshInvestigationCard());
  const transferBtn = document.getElementById('si-transfer-btn');
  if (transferBtn) transferBtn.addEventListener('click', () => siShowTransferPanel());
  const adjustBtn = document.getElementById('si-adjust-btn');
  if (adjustBtn) adjustBtn.addEventListener('click', () => siShowAdjustmentPanel());
}

function siSelectedRows() {
  if (!siInvestigation) return [];
  return siInvestigation.rows.filter(r => siInvestigation.selected.has(wsmRowId(r)));
}

// "Create Transfer Order" — moves selected holding-bin rows out to a chosen
// destination. Routed through the same LOG_SUPER-gated batch-cleanup proxy
// as the rest of this tile (consistent with it being a supervisor bulk
// action rather than the one-row-at-a-time transfers in Stock Management).
function siShowTransferPanel() {
  const rows  = siSelectedRows();
  const panel = document.getElementById('si-action-panel');
  if (!panel || !rows.length) return;

  const rowsHtml = rows.map(row => {
    const id = wsmRowId(row);
    return `<tr data-id="${esc(id)}">
      <td>${esc(row.material)}</td>
      <td class="wsm-mono">${esc(row.storageLocation)}${row.batch ? ` · ${esc(row.batch)}` : ''}</td>
      <td><input class="tf-input si-transfer-qty" type="number" step="any" value="${esc(Math.abs(row.availableQty))}" data-id="${esc(id)}"></td>
      <td class="wsm-mass-result" id="si-transfer-result-${esc(id)}"></td>
    </tr>`;
  }).join('');

  panel.innerHTML = `
    <div class="wsm-resolve-box">
      <div class="wsm-panel-title">Create Transfer Order — ${rows.length} row(s) out of holding</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Dest. Bin Type <span class="tf-req">*</span></label>
          <input class="tf-input" id="si-transfer-desttype" type="text" placeholder="e.g. 001">
        </div>
        <div class="tf-field">
          <label class="tf-label">Dest. Bin <span class="tf-req">*</span></label>
          <input class="tf-input" id="si-transfer-destbin" type="text" placeholder="e.g. B-02-03">
        </div>
      </div>
      <div class="wsm-mass-table-wrap">
        <table class="wsm-mass-table">
          <thead><tr><th>Material</th><th>Loc./Batch</th><th>Qty</th><th></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div class="tf-actions">
        <div id="si-transfer-summary"></div>
        <button type="button" class="btn-secondary" id="si-transfer-cancel">Cancel</button>
        <button type="button" class="btn-submit" id="si-transfer-submit">Create ${rows.length} Transfer Order(s)</button>
      </div>
    </div>`;

  document.getElementById('si-transfer-cancel').addEventListener('click', () => { panel.innerHTML = ''; });
  document.getElementById('si-transfer-submit').addEventListener('click', async () => {
    const destType  = document.getElementById('si-transfer-desttype').value.trim();
    const destBin   = document.getElementById('si-transfer-destbin').value.trim();
    const summaryEl = document.getElementById('si-transfer-summary');
    if (!destType || !destBin) {
      summaryEl.innerHTML = `<div class="sap-error tf-inline-error">✕ Destination bin type and bin are required.</div>`;
      return;
    }

    const submitBtn = document.getElementById('si-transfer-submit');
    submitBtn.disabled = true;
    const progress = wsmShowProgressBanner(summaryEl, rows.length, 'Creating transfer orders');
    let ok = 0, fail = 0;
    const failures = [];

    // Rows with a missing/invalid qty never reach the server — filtered out
    // up front rather than sent as a bad item in the bulk payload below.
    const sendable = [];
    for (const row of rows) {
      const id         = wsmRowId(row);
      const qtyInput   = document.querySelector(`.si-transfer-qty[data-id="${CSS.escape(id)}"]`);
      const resultCell = document.getElementById(`si-transfer-result-${id}`);
      const quantity   = parseFloat((qtyInput?.value || '').replace(',', '.'));

      if (!quantity || quantity <= 0) {
        fail++; failures.push('Missing/invalid qty');
        if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-fail">✕ Missing/invalid qty</span>`;
        continue;
      }
      sendable.push({ row, resultCell, quantity });
    }
    progress.update(rows.length - sendable.length);

    if (sendable.length) {
      const paramsList = sendable.map(({ row, quantity }) => ({
        StorageLocation: row.storageLocation, Material: row.material, Batch: row.batch || '',
        Quantity: quantity, SourceType: row.storageType, SourceBin: row.bin,
        DestinationType: destType, DestinationBin: destBin,
        StockCategory: row.stockCategory || '', SpecialStockIndicator: row.specialStockInd || '', SpecialStockNumber: row.specialStockNum || '',
      }));

      // Sent as one request, executed concurrently server-side rather than
      // awaited move-by-move — see wsmCreateBatchCleanupTransfersBulk.
      const results = await wsmCreateBatchCleanupTransfersBulk(paramsList);

      results.forEach((result, i) => {
        const { resultCell } = sendable[i];
        if (result.success) { ok++; if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-ok">✓ ${esc(result.message)}</span>`; }
        else { fail++; failures.push(result.message); if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-fail">✕ ${esc(result.message)}</span>`; }
      });
    }

    progress.update(rows.length);
    progress.finish(ok, fail, failures);
    if (ok) {
      submitBtn.textContent = 'Done — refreshing…';
      await siRefreshInvestigationCard(); // rows that moved out of holding drop off the list
    } else {
      submitBtn.disabled = false;
    }
  });
}

// "Create Stock Adjustment" — writes off/corrects selected holding-bin rows
// via BAPI_GOODSMVT_CREATE (movement 711/712, or 717/718 for category 'S').
// Per the user's own rule: a negative quantity needs topping up, a positive
// quantity needs writing down — each row corrected by exactly the amount
// it's currently off by. Unit isn't sent — SAP derives it from the
// material's base unit of measure automatically. StorageType/StorageBin
// (WM storage type/bin — this stock lives inside warehouse management, not
// just an IM storage location) are also sent, since SAP needs both to post
// against a specific bin.
// Movement type depends on both direction (does the bin need topping up or
// writing down?) and stock category — plain unrestricted stock goes through
// 711/712, but SAP won't post 711/712 against category 'S' (blocked) stock;
// that needs 717 (reduce) / 718 (add back in) instead. Shared by the table
// preview below and the actual submit loop so they can't disagree.
function siMovementTypeFor(row) {
  const isBlocked = row.stockCategory === 'S';
  if (row.availableQty < 0) return isBlocked ? '718' : '712'; // negative — top the bin back up
  return isBlocked ? '717' : '711';                            // positive — write the excess down
}

function siShowAdjustmentPanel() {
  const rows  = siSelectedRows();
  const panel = document.getElementById('si-action-panel');
  if (!panel || !rows.length) return;

  const rowsHtml = rows.map(row => {
    const id = wsmRowId(row);
    const movementType = siMovementTypeFor(row);
    return `<tr data-id="${esc(id)}">
      <td>${esc(row.material)}</td>
      <td class="wsm-mono">${esc(row.storageLocation)}${row.batch ? ` · ${esc(row.batch)}` : ''}</td>
      <td>${row.availableQty}</td>
      <td class="wsm-mono">${movementType}</td>
      <td class="wsm-mass-result" id="si-adjust-result-${esc(id)}"></td>
    </tr>`;
  }).join('');

  panel.innerHTML = `
    <div class="wsm-resolve-box">
      <div class="wsm-panel-title">Create Stock Adjustment — ${rows.length} row(s)</div>
      <div class="wsm-panel-sub">Negative quantities post a 712 to bring the bin up to zero; positive quantities post a 711 to bring it down to zero — except stock category 'S' (blocked), which uses 718/717 instead, since 711/712 aren't valid against blocked stock. Each row is corrected by exactly the amount it's currently off by — nothing else is adjusted.</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Reference / Reason <span class="tf-req">*</span></label>
          <input class="tf-input" id="si-adjust-reference" type="text" placeholder="e.g. stocktake corr.">
        </div>
      </div>
      <div class="wsm-mass-table-wrap">
        <table class="wsm-mass-table">
          <thead><tr><th>Material</th><th>Loc./Batch</th><th>Qty</th><th>Movement</th><th></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div class="tf-actions">
        <div id="si-adjust-summary"></div>
        <button type="button" class="btn-secondary" id="si-adjust-cancel">Cancel</button>
        <button type="button" class="btn-submit" id="si-adjust-submit">Post ${rows.length} Adjustment(s)</button>
      </div>
    </div>`;

  document.getElementById('si-adjust-cancel').addEventListener('click', () => { panel.innerHTML = ''; });
  document.getElementById('si-adjust-submit').addEventListener('click', async () => {
    const reference = document.getElementById('si-adjust-reference').value.trim();
    const summaryEl = document.getElementById('si-adjust-summary');
    if (!reference) {
      summaryEl.innerHTML = `<div class="sap-error tf-inline-error">✕ A reference/reason is required.</div>`;
      return;
    }

    if (!await wConfirm({
      title: 'Post Stock Adjustment',
      message: `Post ${rows.length} stock adjustment(s) to zero out the selected holding-bin stock? This posts directly to SAP and can't be undone from here.`,
      confirmText: 'Post',
      variant: 'danger',
    })) return;

    const submitBtn = document.getElementById('si-adjust-submit');
    submitBtn.disabled = true;
    const progress = wsmShowProgressBanner(summaryEl, rows.length, 'Posting stock adjustments');

    const entries = rows.map(row => ({
      resultCell: document.getElementById(`si-adjust-result-${wsmRowId(row)}`),
      params: {
        Material: row.material, StorageLocation: row.storageLocation, Batch: row.batch || '',
        MovementType: siMovementTypeFor(row), Quantity: Math.abs(row.availableQty), Reference: reference,
        // Stock sits inside warehouse management, so SAP needs the actual WM
        // storage type/bin, not just the IM storage location — these rows
        // are always the holding bin (999/TEMP) since that's what this card
        // queries, but read off the row rather than hardcoding in case that
        // ever changes.
        StorageType: row.storageType, StorageBin: row.bin,
        StockCategory: row.stockCategory || '',
        SpecialStockIndicator: row.specialStockInd || '', SpecialStockNumber: row.specialStockNum || '',
      },
    }));

    // Sent as one request, executed concurrently server-side rather than
    // awaited row-by-row — see siCreateStockAdjustmentsBulk.
    const results = await siCreateStockAdjustmentsBulk(entries.map(e => e.params));

    let ok = 0, fail = 0;
    const failures = [];
    results.forEach((result, i) => {
      const { resultCell } = entries[i];
      if (result.success) { ok++; if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-ok">✓ Doc ${esc(result.materialDocument || '')}</span>`; }
      else { fail++; failures.push(result.message); if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-fail">✕ ${esc(result.message)}</span>`; }
    });

    progress.update(rows.length);
    progress.finish(ok, fail, failures);
    if (ok) {
      submitBtn.textContent = 'Done — refreshing…';
      await siRefreshInvestigationCard(); // rows successfully zeroed out drop off the list
    } else {
      submitBtn.disabled = false;
    }
  });
}

// Sends a whole page of stock adjustments as one request, executed
// concurrently server-side by SapServer's STA worker pool rather than
// awaited row-by-row — same reasoning as wsmCreateBatchCleanupTransfersBulk.
// Returns results in the same order as paramsList, each unwrapped down to
// the SAP business-level {success, materialDocument|message} shape
// siCreateStockAdjustment used to return for a single item.
async function siCreateStockAdjustmentsBulk(paramsList) {
  try {
    const res = await fetch('/api/sap/warehouse/stock-adjustment-bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: paramsList }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'SAP call failed');
    return json.results.map(result => {
      if (!result.success) return { success: false, message: result.error };
      const data = result.data || {};
      if (!data.success) return { success: false, message: (data.messages || []).map(m => m.message || m).join('; ') || 'SAP rejected the adjustment.' };
      return { success: true, materialDocument: data.materialDocument, message: 'Posted' };
    });
  } catch (err) {
    return paramsList.map(() => ({ success: false, message: err.message }));
  }
}

// ── Transfer Orders — form ────────────────────────────────────────────────────
function showTransferForm() {
  if (activeDT) { try { activeDT.destroy(); } catch (_) {} activeDT = null; }
  document.getElementById('tile-section').classList.add('hidden');
  document.getElementById('result-section').classList.remove('hidden');
  document.getElementById('result-title').textContent = 'Create Transfer Order';
  document.getElementById('result-hint').textContent  = 'L_TO_CREATE_SINGLE · Movement type 999';
  document.getElementById('result-row-badge').classList.add('hidden');
  document.getElementById('btn-export-csv').classList.add('hidden');

  document.getElementById('result-body').innerHTML = `
    <form class="transfer-form" id="transfer-form" onsubmit="submitTransferForm(event)">

      <div class="tf-section-label">Material &amp; Quantity</div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Material <span class="tf-req">*</span></label>
          <input class="tf-input" id="tf-material" type="text" placeholder="Material number" required>
        </div>
        <div class="tf-field">
          <label class="tf-label">Batch</label>
          <input class="tf-input" id="tf-batch" type="text" placeholder="Optional">
        </div>
        <div class="tf-field">
          <label class="tf-label">Quantity <span class="tf-req">*</span></label>
          <input class="tf-input" id="tf-qty" type="number" step="any" min="0.001" placeholder="e.g. 10" required>
        </div>
        <div class="tf-field">
          <label class="tf-label">Storage Location <span class="tf-req">*</span></label>
          <input class="tf-input" id="tf-sloc" type="text" placeholder="e.g. 0001" required>
        </div>
      </div>

      <div class="tf-section-label">Source Bin</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Bin Type <span class="tf-req">*</span></label>
          <input class="tf-input" id="tf-bintype" type="text" placeholder="Auto from bin" required>
          <div id="tf-bintype-choice"></div>
        </div>
        <div class="tf-field">
          <label class="tf-label">Bin <span class="tf-req">*</span></label>
          <input class="tf-input" id="tf-bin" type="text" placeholder="e.g. A-01-01" required>
        </div>
      </div>

      <div class="tf-section-label">Destination Bin</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Dest. Bin Type <span class="tf-req">*</span></label>
          <input class="tf-input" id="tf-destbintype" type="text" placeholder="Auto from bin" required>
          <div id="tf-destbintype-choice"></div>
        </div>
        <div class="tf-field">
          <label class="tf-label">Dest. Bin <span class="tf-req">*</span></label>
          <input class="tf-input" id="tf-destbin" type="text" placeholder="e.g. B-02-03" required>
        </div>
      </div>

      <div class="tf-section-label">Stock Flags <span class="tf-optional">(optional)</span></div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Stock Category</label>
          <input class="tf-input" id="tf-category" type="text" placeholder="e.g. Q, S">
        </div>
        <div class="tf-field">
          <label class="tf-label">Special Stock Indicator</label>
          <input class="tf-input" id="tf-special" type="text" placeholder="e.g. K, E">
        </div>
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Special Stock Number</label>
          <input class="tf-input" id="tf-specialnum" type="text" placeholder="e.g. order number">
        </div>
      </div>

      <div class="tf-actions">
        <div id="tf-result"></div>
        <button type="submit" class="btn-submit" id="tf-submit">Create Transfer Order</button>
      </div>
    </form>`;

  wireBinTypeAutoLookup(document.getElementById('tf-bin'), document.getElementById('tf-bintype'), {
    choiceEl: document.getElementById('tf-bintype-choice'),
  });
  wireBinTypeAutoLookup(document.getElementById('tf-destbin'), document.getElementById('tf-destbintype'), {
    choiceEl: document.getElementById('tf-destbintype-choice'),
  });
}

async function submitTransferForm(e) {
  e.preventDefault();

  const params = {
    StorageLocation:        document.getElementById('tf-sloc').value.trim(),
    Material:               document.getElementById('tf-material').value.trim(),
    Batch:                  document.getElementById('tf-batch').value.trim(),
    Quantity:               parseFloat(document.getElementById('tf-qty').value.replace(',', '.')),
    SourceType:          document.getElementById('tf-bintype').value.trim(),
    SourceBin:              document.getElementById('tf-bin').value.trim(),
    DestinationType:     document.getElementById('tf-destbintype').value.trim(),
    DestinationBin:         document.getElementById('tf-destbin').value.trim(),
    StockCategory:          document.getElementById('tf-category').value.trim(),
    SpecialStockIndicator:  document.getElementById('tf-special').value.trim(),
    SpecialStockNumber:     document.getElementById('tf-specialnum').value.trim(),
  };

  const submitBtn = document.getElementById('tf-submit');
  const resultEl  = document.getElementById('tf-result');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending to SAP…';
  resultEl.innerHTML = '';

  await runStockTransfer(params);

  submitBtn.disabled = false;
  submitBtn.textContent = 'Create Transfer Order';
}

// ── Stock Transfer — SAP call ─────────────────────────────────────────────────
async function runStockTransfer(params) {
  if (!await checkSession()) return false;
  const resultEl = document.getElementById('tf-result');
  const isConsignment = params.SpecialStockIndicator === 'K' && params.DestinationType === 'SA';

  try
  {
    var res;
    if (params.SpecialStockIndicator === 'K' && params.DestinationType === 'SA') // Consignment stock to production bin requires different RFC
    {
      res = await fetch('/api/sap/warehouse/consignment-mb1b', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          'DeliveryNote': '',
          'Header': "Consignment Usage",
          'StorageLocation': params.StorageLocation,
          'SpecialStockNumber': params.SpecialStockNumber,
          'Material': params.Material,
          'Quantity': params.Quantity,
          'DestinationType': params.DestinationType,
          'DestinationBin': params.DestinationBin,
          'SourceType': params.SourceType,
          'SourceBin': params.SourceBin
        }),
      });
    }
    else
    {
      res = await fetch('/api/sap/warehouse/transfer-order', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      });
    }

    const json = await res.json();

    if (!json.success) {
      console.error('Bridge error:', json.error);
      console.groupEnd();
      throw new Error(json.error || 'SAP call failed');
    }

    let type, msg;

    if (isConsignment) {
        const parts = [
            json.data?.mb1bMessage,
            json.data?.toNonConsignMessage,
            json.data?.toConsignMessage
        ].filter(Boolean);
        type = 'S';
        msg  = parts.map(esc).join('<br>') || 'Consignment processed';
    } else {
        const transferOrder = json.data?.transferOrderNumber || '';
        const errorMsg      = json.error || '';
        const messages      = json.data?.messages || [];

        type = (json.data?.success && !errorMsg) ? 'S' : 'E';

        const lines = [];
        if (transferOrder) lines.push(`Transfer Order: ${esc(transferOrder)}`);
        if (messages.length) lines.push(...messages.map(esc));
        msg = errorMsg ? esc(errorMsg) : (lines.join('<br>') || 'SAP returned no message');
    }

    if (type === 'S') {
      resultEl.innerHTML = `
        <div class="tf-success">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
          <div>
            <div class="tf-success-title">Transfer Order Created</div>
            <div class="tf-success-to">${msg}</div>
          </div>
        </div>`;
    } else {
      resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ ${msg}</div>`;
    }

  } catch (err) {
    resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ ${esc(err.message)}</div>`;
  }
}



// ── Bin → storage type auto-lookup (shared) ───────────────────────────────────
//
// Given a bin, looks up its storage type(s) in LAGP via SapServer so the
// operator never has to type a storage type by hand next to a bin they've
// already scanned/typed — wired into every "Bin Type"/"Bin" field pair in
// this module: the LT04 modal and scan flow below, the Stock Management
// single/mass transfer forms, and the standalone Transfer Orders tile.
// Backed by GET /api/sap/warehouse/bin-storage-types (SapServer's LAGP
// lookup by LGPLA only, no storage-type filter — usually exactly one hit).
async function fetchBinStorageTypes(bin) {
  const res  = await fetch(`/api/sap/warehouse/bin-storage-types?bin=${encodeURIComponent(bin)}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'SAP call failed');
  return json.data || [];
}

// wireBinTypeAutoLookup(binInputEl, typeInputEl, { choiceEl, onResolved })
// Fires on blur + Enter (not every keystroke, to avoid one RFC call per
// character typed). 1 match -> autofill + lock (readonly) typeInputEl.
// 2+ matches -> render a radio choice into opts.choiceEl; selecting one
// locks the field the same way. 0 matches (or a failed lookup) -> leave
// typeInputEl exactly as a normal editable input, so manual entry always
// still works.
function wireBinTypeAutoLookup(binInputEl, typeInputEl, opts = {}) {
  const { choiceEl, onResolved } = opts;
  if (!binInputEl || !typeInputEl) return;

  async function run() {
    const bin = binInputEl.value.trim();
    typeInputEl.readOnly = false;
    if (choiceEl) choiceEl.innerHTML = '';
    if (!bin) return;

    let types;
    try { types = await fetchBinStorageTypes(bin); }
    catch (_) { return; } // fail silent -> manual fallback, same as 0 matches

    if (types.length === 1) {
      typeInputEl.value = types[0];
      typeInputEl.readOnly = true;
      onResolved?.(types[0]);
    } else if (types.length > 1 && choiceEl) {
      choiceEl.innerHTML = `<div class="tf-locked">Choose storage type</div>` +
        types.map(t => `<label><input type="radio" name="bintype-${esc(binInputEl.id)}" value="${esc(t)}"> ${esc(t)}</label>`).join(' ');
      choiceEl.querySelectorAll('input[type=radio]').forEach(r => r.addEventListener('change', () => {
        typeInputEl.value = r.value;
        typeInputEl.readOnly = true;
        onResolved?.(r.value);
      }));
    }
  }

  binInputEl.addEventListener('blur', run);
  binInputEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
}


// ── Transfer Requirements (LT04) ──────────────────────────────────────────────
//
// Lists open TRs (auto-created from a 131 goods movement when production
// posts stock) and lets the operator turn one into a confirmed TO via LT04.
// Three ways in: scan TR then scan bin for continuous fast processing (the
// destination storage type is derived automatically from the bin via
// wireBinTypeAutoLookup/fetchBinStorageTypes above — no manual entry, no
// automatic bin CHOICE beyond what LAGP resolves to); click a row to open
// the same modal this always had, now with storage type auto-derived too;
// or check 2+ rows for a bulk LT04 to one shared bin or a bin per row.
// Quantity is always prefilled from the TR's open quantity but editable.
// Batch (LTBP-CHARG) is never operator-entered anywhere in this flow — a TR
// is one-to-one with a batch, so it's simply read off the row. See
// SapServer's WarehouseHelpers.BuildCreateLt04Request for the exact screen
// recording LT04 replicates, including the quality-block (LQUA BESTQ='Q')
// pre-check, and BuildDeleteTrRequest for the LB02 delete this tile also
// exposes (LOG_SUPER-gated — see trReqDelete).
let trReqRows = [];
let trReqSelected = new Set(); // Set<trNumber> — TR number alone is unique, no composite id needed
let trReqScan = { row: null }; // survives across bin-scan attempts for the current TR

async function runTransferRequirements() {
  if (!await checkSession()) return;
  if (activeDT) { try { activeDT.destroy(); } catch (_) {} activeDT = null; }
  trReqSelected = new Set();
  showResultPanel('Transfer Requirements (LT04)', 'Open TRs from production goods movements (LTBK/LTBP)');
  await trReqLoad();
}

function trReqReadFilters() {
  return {
    mrpController:   document.getElementById('tr-req-mrp-filter')?.value || '',
    material:        document.getElementById('tr-req-material-filter')?.value.trim() || '',
    storageLocation: document.getElementById('tr-req-sloc-filter')?.value.trim() || '',
    createdBy:       document.getElementById('tr-req-createdby-filter')?.value.trim() || '',
  };
}

async function trReqFetchRows(filters = {}) {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v))).toString();
  const res  = await fetch(`/api/sap/warehouse/open-transfer-requirements${qs ? `?${qs}` : ''}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'SAP call failed');
  return json.data || [];
}

async function trReqLoad(filters = {}) {
  document.getElementById('result-body').innerHTML =
    '<div class="sap-loading"><div class="spinner"></div>Loading open transfer requirements…</div>';
  try {
    trReqRows = await trReqFetchRows(filters);
    trReqRender(filters);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

function trReqRender(filters = {}) {
  // Drop selections for TRs that no longer appear (converted/deleted since last render).
  trReqSelected = new Set([...trReqSelected].filter(tr => trReqRows.some(r => r.trNumber === tr)));

  const controllers = [...new Set(trReqRows.map(r => r.mrpController).filter(Boolean))].sort();
  const canDelete = sessionPermissions.includes('LOG_SUPER');
  const allChecked = trReqRows.length > 0 && trReqRows.every(r => trReqSelected.has(r.trNumber));

  const rows = trReqRows.map((r, i) => `
    <tr class="admin-row tr-req-row" data-idx="${i}" data-tr="${esc(r.trNumber)}" style="cursor:pointer">
      <td class="wsm-td-check"><input type="checkbox" class="tr-req-row-check" data-tr="${esc(r.trNumber)}"${trReqSelected.has(r.trNumber) ? ' checked' : ''}></td>
      <td><strong>${esc(r.trNumber)}</strong></td>
      <td>${esc(r.material)}</td>
      <td>${esc(r.storageLocation)}</td>
      <td style="text-align:right">${Number(r.quantity).toLocaleString()} ${esc(r.uom)}</td>
      <td>${esc(r.batch || '—')}</td>
      <td>${esc(r.mrpController || '—')}</td>
      <td>${esc(r.documentText || '—')}</td>
      <td>${esc(r.materialDocument || '—')}</td>
      <td>${esc(r.createdBy || '—')}</td>
      <td>${esc(r.createdDate || '')} ${esc(r.createdTime || '')}</td>
      ${canDelete ? `<td><button type="button" class="btn-secondary tr-req-delete-btn" data-tr="${esc(r.trNumber)}" title="Delete TR">🗑️</button></td>` : ''}
    </tr>`).join('');

  document.getElementById('result-hint').textContent =
    `LTBK/LTBP · WH 312 · ${trReqRows.length} open TR${trReqRows.length === 1 ? '' : 's'}`;

  document.getElementById('result-body').innerHTML = `
    <div class="wsm-layout">
      <div class="wsm-list-panel">
        ${trReqScanSectionHtml()}
        <div class="tf-actions" style="margin-bottom:12px;justify-content:flex-start;gap:10px;flex-wrap:wrap">
          <div class="wsm-filter-field"><label class="tf-label">MRP Controller</label>
            <select class="tf-input" id="tr-req-mrp-filter" style="max-width:160px">
              <option value="">All</option>
              ${controllers.map(c => `<option value="${esc(c)}" ${c === filters.mrpController ? 'selected' : ''}>${esc(c)}</option>`).join('')}
            </select></div>
          <div class="wsm-filter-field"><label class="tf-label">Material</label>
            <input class="tf-input" id="tr-req-material-filter" type="text" value="${esc(filters.material || '')}" style="max-width:160px"></div>
          <div class="wsm-filter-field"><label class="tf-label">Created By</label>
            <input class="tf-input" id="tr-req-createdby-filter" type="text" value="${esc(filters.createdBy || '')}" style="max-width:110px"></div>
          <button type="button" class="btn-submit" id="tr-req-search-btn">Search</button>
          <button type="button" class="btn-secondary" id="tr-req-refresh">Refresh</button>
          <button type="button" class="btn-secondary" id="tr-req-cleanup-btn" style="margin-left:auto">Cleanup Assistant</button>
        </div>
        ${trReqRows.length ? `
          <div style="overflow-x:auto">
            <table class="pn-batch-table admin-table">
              <thead><tr>
                <th class="wsm-td-check"><input type="checkbox" id="tr-req-select-all"${allChecked ? ' checked' : ''}></th>
                <th>TR</th><th>Material</th><th>SLoc</th><th>Qty</th><th>Batch</th><th>MRP Ctrl</th>
                <th>Doc Text</th><th>Material Doc</th><th>Created By</th><th>Created</th>${canDelete ? '<th></th>' : ''}
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          <div class="toolbar-hint" style="margin-top:8px">Click a row to confirm it via LT04, or check rows for a bulk action.</div>
        ` : '<div class="sap-empty">No open transfer requirements match this search.</div>'}
      </div>
      <div class="wsm-transfer-panel" id="tr-req-bulk-panel"></div>
    </div>
  `;

  trReqWireScanSection();

  document.getElementById('tr-req-search-btn').addEventListener('click', () => trReqLoad(trReqReadFilters()));
  document.getElementById('tr-req-refresh').addEventListener('click', () => trReqLoad(trReqReadFilters()));
  document.getElementById('tr-req-cleanup-btn').addEventListener('click', () => runTrCleanupAssistant());
  ['tr-req-material-filter', 'tr-req-createdby-filter'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); trReqLoad(trReqReadFilters()); } });
  });
  document.getElementById('tr-req-mrp-filter').addEventListener('change', () => trReqLoad(trReqReadFilters()));

  const selectAll = document.getElementById('tr-req-select-all');
  if (selectAll) selectAll.addEventListener('change', e => {
    if (e.target.checked) trReqRows.forEach(r => trReqSelected.add(r.trNumber));
    else trReqSelected.clear();
    trReqRender(filters);
  });

  document.querySelectorAll('.tr-req-row-check').forEach(cb => {
    cb.addEventListener('change', e => {
      e.stopPropagation();
      if (cb.checked) trReqSelected.add(cb.dataset.tr); else trReqSelected.delete(cb.dataset.tr);
      trReqRender(filters);
    });
  });

  document.querySelectorAll('.tr-req-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const row = trReqRows.find(r => r.trNumber === btn.dataset.tr);
      if (row) trReqDelete(row, filters);
    });
  });

  document.querySelectorAll('.tr-req-row').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('.wsm-td-check') || e.target.closest('.tr-req-delete-btn')) return;
      const row = trReqRows[Number(tr.dataset.idx)];
      if (row) trReqOpenModal(row, filters);
    });
  });

  trReqRenderBulkPanel(filters);
}

// ── Bulk multi-select → LT04 (shared or per-row destination bin) ─────────────
//
// Mirrors the Stock Management mass-transfer panel (wsmMassTransferHtml/
// wsmWireMassTransfer) structurally — same shared-vs-per-row radio toggle,
// same progress banner, and (like that panel) sends every row's LT04 as ONE
// request via create-lt04-bulk rather than one POST per row — but posts to
// create-lt04(-bulk) (not transfer-order), since these are TRs, and never
// needs a Pallet/Batch field since each row already carries its own batch.
// Kept as a deliberate duplicate of the wsm pattern rather than a shared
// abstraction — the field sets differ enough (this needs Batch off the row +
// a destination only; wsm needs a full source/destination/quantity/
// stock-flags set) that forcing a shared helper for two call sites adds
// indirection for no real gain, same as showTransferForm/wsmSingleTransferHtml
// already coexisting as separate, similar-but-distinct forms in this file.

// Sends a whole page of LT04 confirmations as one request, executed
// concurrently server-side by SapServer's STA worker pool rather than
// awaited row-by-row — same reasoning as wsmCreateBatchCleanupTransfersBulk.
// Returns results in the same order as paramsList, each already shaped like
// the single create-lt04 route's own response ({success, data} or
// {success:false, error}).
async function wsmCreateLt04Bulk(paramsList) {
  try {
    const res = await fetch('/api/sap/warehouse/create-lt04-bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: paramsList }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'SAP call failed');
    return json.results;
  } catch (err) {
    return paramsList.map(() => ({ success: false, error: err.message }));
  }
}
function trReqRenderBulkPanel(filters) {
  const panel = document.getElementById('tr-req-bulk-panel');
  if (!panel) return;
  const rows = trReqRows.filter(r => trReqSelected.has(r.trNumber));

  if (!rows.length) {
    panel.innerHTML = `<div class="wsm-panel-empty">Select one or more rows to process a bulk LT04, or click a single row to confirm it directly.</div>`;
    return;
  }
  if (rows.length === 1) {
    panel.innerHTML = `<div class="wsm-panel-empty">Click TR ${esc(rows[0].trNumber)}'s row to confirm it via LT04, or check more rows for a bulk action.</div>`;
    return;
  }

  panel.innerHTML = trReqMassHtml(rows);
  trReqWireMass(rows, filters);
}

function trReqMassHtml(rows) {
  const rowsHtml = rows.map(row => `
    <tr data-tr="${esc(row.trNumber)}">
      <td>${esc(row.trNumber)}<br><span class="wsm-mono">${esc(row.material)}</span></td>
      <td class="wsm-mono">${esc(row.batch || '—')}</td>
      <td><input class="tf-input tr-mass-qty" type="number" step="any" value="${esc(row.quantity)}" data-tr="${esc(row.trNumber)}"></td>
      <td class="wsm-mass-dest-cell" data-tr="${esc(row.trNumber)}">
        <input class="tf-input tr-mass-desttype" type="text" placeholder="Type" data-tr="${esc(row.trNumber)}">
        <input class="tf-input tr-mass-destbin"  type="text" placeholder="Bin"  data-tr="${esc(row.trNumber)}">
      </td>
      <td class="wsm-mass-result" id="tr-mass-result-${esc(row.trNumber)}"></td>
    </tr>`).join('');

  return `
    <div class="wsm-panel-title">Bulk LT04</div>
    <div class="wsm-panel-sub">${rows.length} TRs selected</div>

    <div class="wsm-mass-mode">
      <label><input type="radio" name="tr-mass-mode" value="shared" checked> Shared destination</label>
      <label><input type="radio" name="tr-mass-mode" value="perrow"> Per-row destination</label>
    </div>

    <div class="wsm-mass-shared" id="tr-mass-shared">
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Dest. Bin Type</label>
          <input class="tf-input" id="tr-mass-shared-type" type="text" placeholder="Auto from bin">
          <div id="tr-mass-shared-choice"></div>
        </div>
        <div class="tf-field">
          <label class="tf-label">Dest. Bin <span class="tf-req">*</span></label>
          <input class="tf-input" id="tr-mass-shared-bin" type="text" placeholder="e.g. B-02-03">
        </div>
      </div>
    </div>

    <div class="wsm-mass-table-wrap">
      <table class="wsm-mass-table">
        <thead><tr><th>TR / Material</th><th>Batch</th><th>Qty</th><th>Destination</th><th></th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>

    <div class="tf-actions">
      <div id="tr-mass-summary"></div>
      <button type="button" class="btn-submit" id="tr-mass-submit">Confirm ${rows.length} via LT04</button>
    </div>`;
}

function trReqWireMass(rows, filters) {
  const modeRadios   = document.querySelectorAll('input[name="tr-mass-mode"]');
  const sharedFields  = document.getElementById('tr-mass-shared');
  const destCells     = document.querySelectorAll('.wsm-mass-dest-cell');

  function applyMode() {
    const mode = document.querySelector('input[name="tr-mass-mode"]:checked').value;
    sharedFields.style.display = mode === 'shared' ? '' : 'none';
    destCells.forEach(td => { td.style.display = mode === 'perrow' ? '' : 'none'; });
  }
  modeRadios.forEach(r => r.addEventListener('change', applyMode));
  applyMode();

  wireBinTypeAutoLookup(document.getElementById('tr-mass-shared-bin'), document.getElementById('tr-mass-shared-type'), {
    choiceEl: document.getElementById('tr-mass-shared-choice'),
  });
  rows.forEach(row => {
    wireBinTypeAutoLookup(
      document.querySelector(`.tr-mass-destbin[data-tr="${CSS.escape(row.trNumber)}"]`),
      document.querySelector(`.tr-mass-desttype[data-tr="${CSS.escape(row.trNumber)}"]`)
    ); // no choice container in the compact per-row cell — a 2+-match row just stays editable with no auto-fill
  });

  document.getElementById('tr-mass-submit').addEventListener('click', async () => {
    const mode      = document.querySelector('input[name="tr-mass-mode"]:checked').value;
    const submitBtn = document.getElementById('tr-mass-submit');
    const summaryEl = document.getElementById('tr-mass-summary');
    submitBtn.disabled = true;
    summaryEl.innerHTML = '';

    let sharedType = '', sharedBin = '';
    if (mode === 'shared') {
      sharedType = document.getElementById('tr-mass-shared-type').value.trim();
      sharedBin  = document.getElementById('tr-mass-shared-bin').value.trim();
      if (!sharedType || !sharedBin) {
        summaryEl.innerHTML = `<div class="sap-error tf-inline-error">✕ Destination bin is required (storage type is derived automatically once resolved).</div>`;
        submitBtn.disabled = false;
        return;
      }
    }

    let failCount = 0;
    const failMessages = [];
    const progress = wsmShowProgressBanner(summaryEl, rows.length, 'Confirming via LT04');

    // Rows with a missing qty/destination never reach the server — filtered
    // out up front rather than sent as a bad item in the bulk payload below.
    const sendable = [];
    rows.forEach(row => {
      const tr         = row.trNumber;
      const qtyInput   = document.querySelector(`.tr-mass-qty[data-tr="${CSS.escape(tr)}"]`);
      const resultCell = document.getElementById(`tr-mass-result-${tr}`);
      const quantity   = parseFloat((qtyInput?.value || '').replace(',', '.'));

      let destType = sharedType, destBin = sharedBin;
      if (mode === 'perrow') {
        destType = document.querySelector(`.tr-mass-desttype[data-tr="${CSS.escape(tr)}"]`)?.value.trim() || '';
        destBin  = document.querySelector(`.tr-mass-destbin[data-tr="${CSS.escape(tr)}"]`)?.value.trim()  || '';
      }

      if (!quantity || quantity <= 0 || !destType || !destBin) {
        failCount++;
        failMessages.push('Missing qty/destination');
        if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-fail">✕ Missing qty/destination</span>`;
        return;
      }
      sendable.push({
        resultCell,
        params: {
          TrNumber: tr, Material: row.material, Quantity: quantity,
          DestinationType: destType, DestinationBin: destBin, PalletOrBatch: row.batch,
        },
      });
    });
    progress.update(rows.length - sendable.length);

    let okCount = 0;
    if (sendable.length) {
      // Sent as one request, executed concurrently server-side rather than
      // awaited row-by-row — see wsmCreateLt04Bulk.
      const results = await wsmCreateLt04Bulk(sendable.map(s => s.params));
      results.forEach((result, i) => {
        const { resultCell } = sendable[i];
        if (result.success) {
          okCount++;
          if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-ok">✓ ${esc(result.data?.message || 'Done')}</span>`;
        } else {
          failCount++;
          failMessages.push(result.error);
          if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-fail">✕ ${esc(result.error)}</span>`;
        }
      });
    }

    progress.update(rows.length);
    progress.finish(okCount, failCount, failMessages);
    if (okCount) {
      submitBtn.textContent = 'Done — reselect rows to run again';
      // Silent refresh only — deliberately does NOT re-render the panel, so
      // the just-shown progress banner/breakdown stays visible, same
      // convention wsmRefreshAfterTransfer follows for the Stock Management
      // mass-transfer panel.
      try { trReqRows = await trReqFetchRows(filters); } catch (_) {}
    } else {
      submitBtn.disabled = false;
      submitBtn.textContent = `Confirm ${rows.length} via LT04`;
    }
  });
}

// ── Scan-first LT04 (scan TR, scan bin, done) ─────────────────────────────────
//
// Just the two steps the user asked for — no Pallet/Batch step, since a TR's
// batch (LTBP-CHARG) is already known once the TR resolves. Once the bin
// scan resolves to exactly one storage type, LT04 fires immediately with no
// confirm click, so a stack of drums can be processed back-to-back.
function trReqScanSectionHtml() {
  return `
    <div class="wsm-panel-title" style="margin-bottom:8px">Scan to Process</div>
    <div class="tf-row">
      <div class="tf-field">
        <label class="tf-label">Scan TR</label>
        <input class="tf-input" id="tr-req-scan-tr" type="text" placeholder="Scan or type TR number" autocomplete="off">
      </div>
      <div class="tf-field">
        <label class="tf-label">Scan Bin</label>
        <input class="tf-input" id="tr-req-scan-bin" type="text" placeholder="Scan destination bin" autocomplete="off" disabled>
      </div>
    </div>
    <div id="tr-req-scan-status"></div>
    <div id="tr-req-scan-type-area"></div>`;
}

function trReqWireScanSection() {
  const trInput  = document.getElementById('tr-req-scan-tr');
  const binInput = document.getElementById('tr-req-scan-bin');
  const statusEl = document.getElementById('tr-req-scan-status');
  if (!trInput) return;
  trInput.focus();

  trInput.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const tr = trInput.value.trim();
    if (!tr) return;

    let row = trReqRows.find(r => r.trNumber === tr);
    if (!row) {
      // Not found in the already-loaded list — it may just be stale.
      // Silently refresh trReqRows (no full re-render, so the scan inputs
      // the operator is mid-interaction with stay attached to the DOM) and
      // retry once before giving up.
      statusEl.innerHTML = `<div class="sap-loading"><div class="spinner"></div>Checking…</div>`;
      try { trReqRows = await trReqFetchRows(trReqReadFilters()); } catch (_) {}
      row = trReqRows.find(r => r.trNumber === tr);
    }

    if (!row) {
      statusEl.innerHTML = `<div class="sap-error tf-inline-error">✕ TR ${esc(tr)} not found in the open list.</div>`;
      trInput.value = '';
      trInput.focus();
      return;
    }

    trReqScan.row = row;
    statusEl.innerHTML = `<div class="tf-success">
      <div><div class="tf-success-title">TR ${esc(row.trNumber)}</div>
      <div class="tf-success-to">${esc(row.material)} · ${Number(row.quantity).toLocaleString()} ${esc(row.uom)} · Batch ${esc(row.batch || '—')}</div></div>
    </div>`;
    binInput.disabled = false;
    binInput.value = '';
    binInput.focus();
  });

  binInput.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    await trReqScanResolveBin();
  });
}

async function trReqScanResolveBin() {
  const binInput = document.getElementById('tr-req-scan-bin');
  const typeArea = document.getElementById('tr-req-scan-type-area');
  const bin = binInput.value.trim();
  if (!bin || !trReqScan.row) return;

  typeArea.innerHTML = '';
  let types;
  try { types = await fetchBinStorageTypes(bin); }
  catch (err) { typeArea.innerHTML = `<div class="sap-error tf-inline-error">✕ ${esc(err.message)}</div>`; return; }

  if (types.length === 1) {
    await trReqScanSubmit(types[0], bin);
  } else if (types.length > 1) {
    typeArea.innerHTML = `<div class="tf-locked">Choose storage type for ${esc(bin)}</div>` +
      types.map(t => `<label><input type="radio" name="tr-req-scan-type" value="${esc(t)}"> ${esc(t)}</label>`).join(' ');
    typeArea.querySelectorAll('input[type=radio]').forEach(r =>
      r.addEventListener('change', () => trReqScanSubmit(r.value, bin)));
  } else {
    typeArea.innerHTML = `
      <div class="sap-error tf-inline-error">No storage type found for bin ${esc(bin)} — enter it manually.</div>
      <div class="tf-row">
        <input class="tf-input" id="tr-req-scan-manual-type" type="text" placeholder="Storage type">
        <button type="button" class="btn-submit" id="tr-req-scan-manual-go">Confirm</button>
      </div>`;
    const go = () => trReqScanSubmit(document.getElementById('tr-req-scan-manual-type').value.trim(), bin);
    document.getElementById('tr-req-scan-manual-go').addEventListener('click', go);
    document.getElementById('tr-req-scan-manual-type').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  }
}

async function trReqScanSubmit(destType, destBin) {
  const row = trReqScan.row;
  const statusEl = document.getElementById('tr-req-scan-status');
  if (!row || !destType) return;

  statusEl.innerHTML = `<div class="sap-loading"><div class="spinner"></div>Sending to SAP…</div>`;
  try {
    const res = await fetch('/api/sap/warehouse/create-lt04', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        TrNumber: row.trNumber, Material: row.material, Quantity: row.quantity,
        DestinationType: destType, DestinationBin: destBin, PalletOrBatch: row.batch,
      }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'SAP call failed');

    statusEl.innerHTML = `<div class="tf-success">
      <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
      <div><div class="tf-success-title">TR ${esc(row.trNumber)} Confirmed</div><div class="tf-success-to">${esc(json.data?.message || '')}</div></div>
    </div>`;
    document.getElementById('tr-req-scan-type-area').innerHTML = '';

    // Give the operator a moment to see the confirmation, then reset for the
    // next drum — same delay convention the row-click modal flow uses below.
    setTimeout(() => {
      trReqScan.row = null;
      trReqLoad(trReqReadFilters());
    }, 1200);

  } catch (err) {
    // Deliberately does NOT reset here — the TR stays scanned and the bin
    // stays in the field so the operator can fix a bad bin and retry
    // without rescanning the TR from scratch.
    statusEl.innerHTML = `<div class="sap-error tf-inline-error">✕ ${esc(err.message)}</div>`;
  }
}

function trReqOpenModal(row, filters = {}) {
  const canDelete = sessionPermissions.includes('LOG_SUPER');
  const overlay = document.getElementById('ps-modal-overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = `<div class="ps-modal" style="max-width:520px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Confirm TR ${esc(row.trNumber)} via LT04</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-row">
        <div class="tf-field"><label class="tf-label">Material</label><div class="tf-prefill-value">${esc(row.material)}</div></div>
        <div class="tf-field"><label class="tf-label">Storage Location</label><div class="tf-prefill-value">${esc(row.storageLocation)}</div></div>
      </div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Quantity <span class="tf-req">*</span></label>
          <input class="tf-input" id="tr-req-qty" type="number" step="any" min="0.001" value="${row.quantity}">
        </div>
        <div class="tf-field">
          <label class="tf-label">Pallet / Batch No.</label>
          <div class="tf-prefill-value">${esc(row.batch || '—')}</div>
        </div>
      </div>
      <div class="tf-section-label">Destination Bin</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Storage Type</label>
          <input class="tf-input" id="tr-req-desttype" type="text" placeholder="Auto from bin">
          <div id="tr-req-destchoice"></div>
        </div>
        <div class="tf-field">
          <label class="tf-label">Bin <span class="tf-req">*</span></label>
          <input class="tf-input" id="tr-req-destbin" type="text" placeholder="e.g. A-01-01" required>
        </div>
      </div>
      <div class="tf-field tf-field--wide">
        <label class="tf-label">Reference <span class="tf-optional">(optional — defaults to pallet/batch no.)</span></label>
        <input class="tf-input" id="tr-req-reference" type="text" placeholder="Leave blank to use the pallet/batch number above">
      </div>
      <div class="tf-actions">
        <div id="tr-req-modal-result"></div>
        <div style="display:flex;gap:8px">
          ${canDelete ? `<button type="button" class="btn-secondary" id="tr-req-modal-delete-btn">Delete TR</button>` : ''}
          <button type="button" class="btn-submit" id="tr-req-confirm-btn">Confirm LT04</button>
        </div>
      </div>
    </div>
  </div>`;

  wireBinTypeAutoLookup(document.getElementById('tr-req-destbin'), document.getElementById('tr-req-desttype'), {
    choiceEl: document.getElementById('tr-req-destchoice'),
  });

  document.getElementById('tr-req-confirm-btn').addEventListener('click', () => trReqSubmit(row, filters));
  if (canDelete) {
    document.getElementById('tr-req-modal-delete-btn').addEventListener('click', async () => {
      closePickModal();
      await trReqDelete(row, filters);
    });
  }
}

async function trReqSubmit(row, filters = {}) {
  const btn      = document.getElementById('tr-req-confirm-btn');
  const resultEl = document.getElementById('tr-req-modal-result');

  const quantity        = parseFloat(String(document.getElementById('tr-req-qty').value).replace(',', '.'));
  const destinationType = document.getElementById('tr-req-desttype').value.trim();
  const destinationBin  = document.getElementById('tr-req-destbin').value.trim();
  const reference        = document.getElementById('tr-req-reference').value.trim();

  if (!quantity || quantity <= 0) { resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ Enter a valid quantity.</div>`; return; }
  if (!destinationType || !destinationBin) { resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ Destination bin (and its storage type) are both required.</div>`; return; }

  btn.disabled = true;
  btn.textContent = 'Sending to SAP…';
  resultEl.innerHTML = '';

  try {
    const res = await fetch('/api/sap/warehouse/create-lt04', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        TrNumber:        row.trNumber,
        Material:        row.material,
        Quantity:        quantity,
        DestinationType: destinationType,
        DestinationBin:  destinationBin,
        PalletOrBatch:   row.batch,
        Reference:       reference || undefined,
      }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'SAP call failed');

    const msg = json.data?.message || 'LT04 confirmed';
    resultEl.innerHTML = `
      <div class="tf-success">
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
        <div><div class="tf-success-title">TR Confirmed</div><div class="tf-success-to">${esc(msg)}</div></div>
      </div>`;

    setTimeout(() => {
      closePickModal();
      trReqLoad(filters);
    }, 1200);

  } catch (err) {
    resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ ${esc(err.message)}</div>`;
    btn.disabled = false;
    btn.textContent = 'Confirm LT04';
  }
}

// ── Delete TR (LB02) — LOG_SUPER only ─────────────────────────────────────────
//
// For TRs processed manually outside the portal (e.g. via LT01) that are now
// orphaned. Gated client-side by hiding the control entirely for non-
// LOG_SUPER users (see the canDelete checks above); the real enforcement is
// server-side (routes/sap.js's requirePermission('LOG_SUPER') on
// /warehouse/delete-tr) — this is just UX, not the security boundary.
async function trReqDelete(row, filters = {}) {
  const ok = await wConfirm({
    title: 'Delete Transfer Requirement',
    message: `Delete TR ${row.trNumber} (${row.material}, ${row.quantity} ${row.uom})?\nThis cannot be undone in SAP.`,
    confirmText: 'Delete',
    variant: 'danger',
  });
  if (!ok) return;

  try {
    const res  = await fetch('/api/sap/warehouse/delete-tr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ TrNumber: row.trNumber }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'SAP call failed');
    trReqSelected.delete(row.trNumber);
    await trReqLoad(filters);
  } catch (err) {
    await wConfirm({ title: 'Delete Failed', message: err.message, confirmText: 'OK', variant: '' });
  }
}

// ── TR Cleanup Assistant ──────────────────────────────────────────────────────
//
// Automates the judgment call wm_open_tr.xlsm's operators have always made
// by eyeballing the macro's raw batch-stock/current-bin columns: shows every
// open TR flagged for one or more of three reasons (SLoc 1710 / zero
// unrestricted stock / already transferred to a non-901 bin) as opt-in
// cards, grouped by reason, with a per-group "select all". Nothing is
// selected by default — the operator has to actively pick what to delete.
// The bulk delete step reuses trReqDelete's underlying endpoint (LOG_SUPER-
// gated) via a sequential loop driven by the same wsmShowProgressBanner/
// wsmGroupErrors components the Stock Management mass-transfer panel uses.
let trReqCleanup = { candidates: [], selected: new Set() };

const TR_CLEANUP_REASONS = [
  { key: 'sloc_1710',           label: 'Storage Location 1710' },
  { key: 'no_stock',            label: 'Zero Unrestricted Stock' },
  { key: 'already_transferred', label: 'Already Transferred' },
];

async function runTrCleanupAssistant() {
  if (!await checkSession()) return;
  showResultPanel('TR Cleanup Assistant', 'Unnecessary open TRs — SLoc 1710 / zero stock / already transferred');
  document.getElementById('result-body').innerHTML =
    '<div class="sap-loading"><div class="spinner"></div>Scanning for unnecessary TRs…</div>';
  trReqCleanup = { candidates: [], selected: new Set() };

  try {
    const res  = await fetch('/api/sap/warehouse/tr-cleanup-candidates');
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'SAP call failed');
    trReqCleanup.candidates = json.data || [];
    trReqCleanupRender();
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

function trReqCleanupRender() {
  const canDelete = sessionPermissions.includes('LOG_SUPER');

  const groupsHtml = TR_CLEANUP_REASONS.map(g => {
    const groupRows = trReqCleanup.candidates.filter(c => c.reasons.includes(g.key));
    const cardsHtml = groupRows.map(c => {
      const otherLabels = c.reasons
        .filter(r => r !== g.key)
        .map(r => TR_CLEANUP_REASONS.find(x => x.key === r)?.label || r);
      return `
        <label class="tr-cleanup-card${otherLabels.length ? ' tr-cleanup-card--multi' : ''}">
          <input type="checkbox" class="tr-cleanup-check" data-tr="${esc(c.trNumber)}"${trReqCleanup.selected.has(c.trNumber) ? ' checked' : ''}>
          <div>
            <div><strong>${esc(c.trNumber)}</strong> — ${esc(c.material)}</div>
            <div class="tf-muted">${esc(c.storageLocation)} · ${Number(c.quantity).toLocaleString()} ${esc(c.uom)} · Batch ${esc(c.batch || '—')}</div>
            ${otherLabels.length ? `<div class="tf-locked">Also: ${esc(otherLabels.join(', '))}</div>` : ''}
          </div>
        </label>`;
    }).join('');
    return `
      <div class="tr-cleanup-group">
        <div class="tf-section-label">${esc(g.label)} (${groupRows.length})
          ${groupRows.length ? `<button type="button" class="btn-secondary tr-cleanup-selectall" data-key="${g.key}">Select all</button>` : ''}
        </div>
        <div class="tr-cleanup-cards">${groupRows.length ? cardsHtml : '<div class="wsm-empty">None</div>'}</div>
      </div>`;
  }).join('');

  document.getElementById('result-body').innerHTML = `
    <div class="tf-actions" style="margin-bottom:12px;justify-content:flex-start;gap:10px">
      <button type="button" class="btn-secondary" id="tr-cleanup-back-btn">← Back to list</button>
      <button type="button" class="btn-secondary" id="tr-cleanup-refresh-btn">Rescan</button>
    </div>
    ${trReqCleanup.candidates.length ? groupsHtml : '<div class="sap-empty">No unnecessary TRs found.</div>'}
    <div class="tf-actions">
      <div id="tr-cleanup-summary"></div>
      <button type="button" class="btn-submit" id="tr-cleanup-delete-btn" disabled>Delete selected (0)</button>
    </div>`;

  document.getElementById('tr-cleanup-back-btn').addEventListener('click', () => trReqLoad(trReqReadFilters()));
  document.getElementById('tr-cleanup-refresh-btn').addEventListener('click', () => runTrCleanupAssistant());

  document.querySelectorAll('.tr-cleanup-check').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) trReqCleanup.selected.add(cb.dataset.tr); else trReqCleanup.selected.delete(cb.dataset.tr);
    trReqCleanupUpdateDeleteButton();
  }));
  document.querySelectorAll('.tr-cleanup-selectall').forEach(btn => btn.addEventListener('click', () => {
    trReqCleanup.candidates.filter(c => c.reasons.includes(btn.dataset.key)).forEach(c => trReqCleanup.selected.add(c.trNumber));
    trReqCleanupRender();
  }));

  document.getElementById('tr-cleanup-delete-btn').addEventListener('click', trReqCleanupDeleteSelected);
  trReqCleanupUpdateDeleteButton();
}

function trReqCleanupUpdateDeleteButton() {
  const btn = document.getElementById('tr-cleanup-delete-btn');
  if (!btn) return;
  const n = trReqCleanup.selected.size;
  btn.textContent = `Delete selected (${n})`;
  btn.disabled = n === 0 || !sessionPermissions.includes('LOG_SUPER');
  if (!sessionPermissions.includes('LOG_SUPER')) btn.title = 'Requires LOG_SUPER';
}

// Sends a whole page of TR deletes as one request, executed concurrently
// server-side by SapServer's STA worker pool rather than awaited TR-by-TR —
// same reasoning as wsmCreateBatchCleanupTransfersBulk. Returns results in
// the same order as trNumbers.
async function wsmDeleteTrsBulk(trNumbers) {
  try {
    const res = await fetch('/api/sap/warehouse/delete-tr-bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: trNumbers.map(TrNumber => ({ TrNumber })) }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'SAP call failed');
    return json.results;
  } catch (err) {
    return trNumbers.map(() => ({ success: false, error: err.message }));
  }
}

async function trReqCleanupDeleteSelected() {
  const trNumbers = [...trReqCleanup.selected];
  if (!trNumbers.length) return;

  const ok = await wConfirm({
    title: 'Delete Selected TRs',
    message: `Delete ${trNumbers.length} transfer requirement(s)?\nThis cannot be undone in SAP.`,
    confirmText: 'Delete',
    variant: 'danger',
  });
  if (!ok) return;

  const summaryEl = document.getElementById('tr-cleanup-summary');
  const progress  = wsmShowProgressBanner(summaryEl, trNumbers.length, 'Deleting TRs');

  // Sent as one request, executed concurrently server-side rather than
  // awaited TR-by-TR — see wsmDeleteTrsBulk.
  const results = await wsmDeleteTrsBulk(trNumbers);

  let okCount = 0, failCount = 0;
  const failMessages = [];
  results.forEach(result => {
    if (result.success) okCount++;
    else { failCount++; failMessages.push(result.error); }
  });

  progress.update(trNumbers.length);
  progress.finish(okCount, failCount, failMessages);
  setTimeout(() => runTrCleanupAssistant(), 1500);
}


// ── Show result panel, hide tiles ─────────────────────────────────────────────
function showResultPanel(title, hint) {
  if (activeDT) { try { activeDT.destroy(); } catch (_) {} activeDT = null; }
  document.getElementById('tile-section').classList.add('hidden');
  document.getElementById('result-section').classList.remove('hidden');
  document.getElementById('result-title').textContent = title;
  document.getElementById('result-hint').textContent  = hint;
  document.getElementById('result-row-badge').classList.add('hidden');
  document.getElementById('btn-export-csv').classList.add('hidden');
  document.getElementById('result-body').innerHTML =
    '<div class="sap-loading"><div class="spinner"></div>Connecting to SAP…</div>';
}

// ── Session guard ─────────────────────────────────────────────────────────────
async function checkSession() {
  try {
    const d = await fetch('/session-check').then(r => r.json());
    if (!d.loggedIn) {
      alert('Your session has expired. Please log in again.');
      window.location.href = '/';
      return false;
    }
    return true;
  } catch {
    alert('Unable to verify your session. Please log in again.');
    window.location.href = '/';
    return false;
  }
}

// ── Back to tiles ─────────────────────────────────────────────────────────────
function backToTiles() {
  if (activeDT) { try { activeDT.destroy(); } catch (_) {} activeDT = null; }
  currentResult = [];
  document.getElementById('result-section').classList.add('hidden');
  document.getElementById('tile-section').classList.remove('hidden');
}

// ── Open Picksheets ───────────────────────────────────────────────────────────
async function runOpenPicksheets() {
  if (!await checkSession()) return;
  showResultPanel('Open Picksheets', 'Loading open deliveries…');

  try {
    const res  = await fetch('/api/deliverymain/open-picksheets');
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load picksheets');

    const rows = json.data;
    if (!rows.length) {
      document.getElementById('result-body').innerHTML =
        '<div class="sap-error">No open picksheets found.</div>';
      return;
    }

    const badge = document.getElementById('result-row-badge');
    badge.textContent = `${rows.length} open`;
    badge.classList.remove('hidden');

    renderPicksheets(rows);
  } catch (err) {
    document.getElementById('result-body').innerHTML =
      `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

const BUCKETS = [
  { key: 'priority',   label: 'Priority',       dot: 'priority', defaultOpen: true  },
  { key: 'backlog',    label: 'Backlog',         dot: 'backlog',  defaultOpen: true  },
  { key: 'today',      label: 'Today',           dot: 'today',    defaultOpen: true  },
  { key: 'this-week',  label: 'This Week',       dot: 'week',     defaultOpen: true  },
  { key: 'this-month', label: 'This Month',      dot: 'month',    defaultOpen: false },
  { key: 'other',      label: 'Everything Else', dot: 'other',    defaultOpen: false },
];

function getDateBucket(dueDate) {
  if (!dueDate) return 'other';
  const now    = new Date();
  const today  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const due    = new Date(dueDate);
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());

  if (dueDay < today) return 'backlog';
  if (dueDay.getTime() === today.getTime()) return 'today';

  const dow    = today.getDay() || 7;
  const monday = new Date(today); monday.setDate(today.getDate() - dow + 1);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);

  if (dueDay <= sunday) return 'this-week';
  if (due.getFullYear() === now.getFullYear() && due.getMonth() === now.getMonth()) return 'this-month';
  return 'other';
}

function renderPicksheets(rows) {
  const bucketMap = {};
  BUCKETS.forEach(b => { bucketMap[b.key] = []; });
  rows.forEach(r => {
    const key = r.deliveryPriority === 1 ? 'priority' : getDateBucket(r.dispatchDate);
    bucketMap[key].push(r);
  });

  const html = BUCKETS
    .filter(b => bucketMap[b.key].length > 0)
    .map(b => {
      const collapsed = b.defaultOpen ? '' : ' ps-section--collapsed';
      const thead = `<tr><th>Delivery ID</th><th>Destination</th><th>Due Date</th><th>Service</th><th>Comment</th></tr>`;
      const tbody = bucketMap[b.key].map(r => {
        const due  = r.dispatchDate ? new Date(r.dispatchDate).toLocaleDateString('en-GB') : '—';
        const flag = b.key === 'priority' ? '<span class="ps-priority-flag"></span>' : '';
        return `<tr class="ps-row" data-id="${esc(String(r.deliveryID))}" data-dest="${esc(r.destinationName ?? '')}" data-custid="${esc(String(r.customerID ?? ''))}">
          <td>${flag}${esc(String(r.deliveryID))}</td>
          <td>${esc(r.destinationName ?? '—')}</td>
          <td>${esc(due)}</td>
          <td>${esc(r.deliveryService ?? '')}</td>
          <td>${esc(r.picksheetComment ?? '')}</td>
        </tr>`;
      }).join('');
      return `<div class="ps-section${collapsed}">
        <div class="ps-section-header">
          <span class="ps-section-dot ps-section-dot--${b.dot}"></span>
          <span class="ps-section-title">${b.label}</span>
          <span class="ps-section-count">${bucketMap[b.key].length}</span>
          <span class="ps-chevron">▼</span>
        </div>
        <div class="ps-section-body">
          <table class="ps-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>
        </div>
      </div>`;
    }).join('');

  document.getElementById('result-body').innerHTML = `<div class="ps-sections">${html}</div>`;

  document.querySelectorAll('.ps-section-header').forEach(h => {
    h.addEventListener('click', () => h.closest('.ps-section').classList.toggle('ps-section--collapsed'));
  });

  document.querySelectorAll('.ps-row').forEach(tr => {
    tr.addEventListener('click', () => showPickedPallets(tr.dataset.id, tr.dataset.dest, tr.dataset.custid));
  });
}

// ── Picksheets on Hold ─────────────────────────────────────────────────────────
// Deliveries the SAP sync found already completed in SAP outside Nexus (see
// runZdelflagMaintenance's neighbour, runSapSync's reconciliation step in
// deliverymain.js). Clicking a row opens the same Picked Pallets/Pallet
// Builder modal as Open Picksheets, so packaging can be confirmed through
// the normal flow — completeDelivery() detects fromHolding and skips the
// SAP pushes since SAP already has this delivery closed. Delete removes a
// held job outright instead of confirming it (soft-cancel server-side).
async function runPackagingHolding() {
  if (!await checkSession()) return;
  showResultPanel('Picksheets on Hold', 'Deliveries completed in SAP outside Nexus — waiting for packaging data');

  try {
    const res  = await fetch('/api/deliverymain/packaging-holding');
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load picksheets on hold list');

    const rows = json.data;
    const badge = document.getElementById('result-row-badge');
    badge.textContent = `${rows.length} held`;
    badge.classList.toggle('hidden', rows.length === 0);

    zdRenderPackagingHolding(rows);
  } catch (err) {
    document.getElementById('result-body').innerHTML =
      `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
  pollPackagingHoldingCount();
}

function zdRenderPackagingHolding(rows) {
  if (!rows.length) {
    document.getElementById('result-body').innerHTML =
      '<div class="sap-empty">Nothing waiting for packaging data.</div>';
    return;
  }

  const tbody = rows.map(r => {
    const moved = spFormatDate(r.movedToHoldingAtUtc);
    return `<tr class="ps-row" data-id="${esc(String(r.deliveryID))}" data-dest="${esc(r.destinationName ?? '')}" data-custid="${esc(String(r.customerID ?? ''))}">
      <td>${esc(String(r.deliveryID))}</td>
      <td>${esc(r.destinationName ?? '—')}</td>
      <td>${esc(r.deliveryService ?? '')}</td>
      <td>${esc(moved)}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn-secondary ph-delete" data-id="${esc(String(r.deliveryID))}" style="padding:3px 10px;font-size:11px;color:var(--error,#DC2626)">Delete</button>
      </td>
    </tr>`;
  }).join('');

  document.getElementById('result-body').innerHTML = `
    <div class="ps-sections">
      <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
        <button class="btn-secondary" id="ph-delete-all" style="padding:4px 12px;font-size:11px;color:var(--error,#DC2626)">Delete All (${rows.length})</button>
      </div>
      <table class="ps-table">
        <thead><tr><th>Delivery ID</th><th>Destination</th><th>Service</th><th>Moved to Holding</th><th></th></tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;

  document.querySelectorAll('#result-body .ps-row').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('.ph-delete')) return;
      showPickedPallets(tr.dataset.id, tr.dataset.dest, tr.dataset.custid, true);
    });
  });
  document.querySelectorAll('.ph-delete').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteHeldPicksheet(btn.dataset.id);
    });
  });
  document.getElementById('ph-delete-all').addEventListener('click', deleteAllHeldPicksheets);
}

async function deleteHeldPicksheet(deliveryId) {
  if (!await wConfirm({
    title: 'Delete Held Picksheet',
    message: `Delete Delivery #${deliveryId} instead of confirming its packaging?\nThis reverses any SAP staging it may have and cancels the delivery in Nexus.`,
    confirmText: 'Delete',
    variant: 'danger',
  })) return;
  try {
    const res  = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/packaging-holding`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Delete failed');
    runPackagingHolding();
  } catch (err) {
    wConfirm({ title: 'Error', message: err.message, confirmText: 'OK', variant: '' });
  }
}

async function deleteAllHeldPicksheets() {
  if (!await wConfirm({
    title: 'Delete All Held Picksheets',
    message: 'Delete every picksheet in the picksheets on hold area instead of confirming packaging?\nThis reverses any SAP staging and cancels each delivery in Nexus. This cannot be undone.',
    confirmText: 'Delete All',
    variant: 'danger',
  })) return;
  try {
    const res  = await fetch('/api/deliverymain/packaging-holding/all', { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Delete failed');
    if (json.failures && json.failures.length) {
      const list = json.failures.map(f => `#${f.deliveryId}: ${f.error}`).join('\n');
      await wConfirm({
        title: 'Some Deletions Failed',
        message: `Deleted ${json.deleted.length} of ${json.deleted.length + json.failures.length}. Still held:\n${list}`,
        confirmText: 'OK',
        variant: '',
      });
    }
    runPackagingHolding();
  } catch (err) {
    wConfirm({ title: 'Error', message: err.message, confirmText: 'OK', variant: '' });
  }
}

// ── Inbound Deliveries (operator-friendly Inbound Log) ────────────────────────
// Warehouse-side, read-mostly view of Logistics' Inbound Log (see
// routes/performance.js's /order-suggestions/shipments*, gated
// requireAnyPermission(['LOG_MRP','WAREHOUSE_OP'])). Same bucket format as
// the planner-facing tile (Late/Today/Upcoming/Completed/Cancelled), but the
// detail view only exposes what an operator actually needs on the goods-in
// bay: view the supplier paperwork filed against the shipment (to check
// deliveries against), confirm the quantity that showed up, enter the
// supplier's paperwork reference if missing, and Mark Arrived — which posts
// the goods receipt to SAP (order-suggestions/shipments/:id/receive) using
// those confirmed quantities. No shipment-header editing, cancel,
// undo-receive, document upload or cost lines here — those stay
// planner-only in Logistics' own Inbound Log.
let wdInboundRows = [];
let wdInboundSearchQuery = '';

// Mirrors logistics.js's osKgToOrderUnit/OS_KG_PER_UNIT — display-only
// conversion for a vendor whose delivery paperwork uses a unit other than
// the material's SAP base unit (e.g. LB for DeWAL, see log.Vendor.OrderMoqUom).
const WD_KG_PER_UNIT = { KG: 1, LB: 0.45359237 };
function wdKgToOrderUnit(qtyKg, unit) {
  const factor = WD_KG_PER_UNIT[(unit || 'KG').toUpperCase()];
  if (!factor) return qtyKg;
  return Math.round((qtyKg / factor) * 1000) / 1000;
}

const WD_IL_BUCKETS = [
  { key: 'late',      label: 'Late',      dot: 'backlog' },
  { key: 'today',     label: 'Today',     dot: 'today' },
  { key: 'upcoming',  label: 'Upcoming',  dot: 'week' },
  { key: 'completed', label: 'Completed', dot: 'month' },
  { key: 'cancelled', label: 'Cancelled', dot: 'other' },
];

// Mirrors logistics.js's ilBucketFor exactly, so the same shipment lands in
// the same bucket regardless of which page is looking at it.
function wdIlBucketFor(s) {
  if (s.CancelledAtUtc) return 'cancelled';
  if (s.ReceivedAtUtc) return 'completed';
  if (!s.ExpectedEta) return 'upcoming';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const eta = new Date(s.ExpectedEta); eta.setHours(0, 0, 0, 0);
  if (eta.getTime() < today.getTime()) return 'late';
  if (eta.getTime() === today.getTime()) return 'today';
  return 'upcoming';
}

function wdFormatDate(value) {
  return value ? new Date(value).toLocaleDateString('en-GB') : '—';
}

async function runInboundDeliveriesOp() {
  if (!await checkSession()) return;
  showResultPanel('Inbound Deliveries', 'Mark inbound shipments as arrived and confirm quantities for SAP goods receipt');
  try {
    const res  = await fetch('/api/performance/order-suggestions/shipments');
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load shipments');
    wdInboundRows = json.data || [];
    document.getElementById('result-row-badge').textContent = `${wdInboundRows.length} shipments`;
    document.getElementById('result-row-badge').classList.remove('hidden');
    wdRenderInboundDeliveries();
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

// Same fields as logistics.js's ilMatchesSearch, minus the columns
// (container/BOL/PO/supplier ref) that view fetches separately and this one
// doesn't need — just what an operator actually has in hand: the
// shipment's own reference, tracking number, and supplier/origin.
function wdInboundMatchesSearch(s, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [s.ShipmentReference, s.TrackingNumber, s.Suppliers, s.OriginName]
    .some(field => String(field || '').toLowerCase().includes(needle));
}

function wdApplyInboundSearch() {
  const input = document.getElementById('wd-inbound-search');
  wdInboundSearchQuery = input ? input.value : '';
  const caret = input ? input.selectionStart : null;
  wdRenderInboundDeliveries();
  const newInput = document.getElementById('wd-inbound-search');
  if (newInput) { newInput.focus(); if (caret != null) newInput.setSelectionRange(caret, caret); }
}

function wdRenderInboundDeliveries() {
  if (!wdInboundRows.length) {
    document.getElementById('result-body').innerHTML = '<div class="sap-empty">No inbound shipments right now.</div>';
    return;
  }

  const query = wdInboundSearchQuery.trim();
  const rows = query ? wdInboundRows.filter(s => wdInboundMatchesSearch(s, query)) : wdInboundRows;

  const badge = document.getElementById('result-row-badge');
  badge.textContent = query ? `${rows.length} of ${wdInboundRows.length} matching` : `${wdInboundRows.length} shipments`;
  badge.classList.remove('hidden');

  const toolbarHtml = `<div class="lg-actions" style="margin-bottom:10px">
    <input class="tf-input" id="wd-inbound-search" type="text"
           placeholder="Search reference, tracking, supplier…"
           value="${esc(wdInboundSearchQuery)}" oninput="wdApplyInboundSearch()" style="max-width:280px">
  </div>`;

  if (!rows.length) {
    document.getElementById('result-body').innerHTML = toolbarHtml + `<div class="sap-empty">No shipments match "${esc(query)}".</div>`;
    return;
  }

  const renderRow = s => `
    <tr class="ps-row" data-id="${esc(String(s.ShipmentId))}">
      <td><strong>${esc(s.ShipmentReference || `#${s.ShipmentId}`)}</strong></td>
      <td>${s.IsManual ? `<span style="color:var(--text-secondary,#666)">Manual — ${esc(s.OriginName || 'no origin')}</span>` : esc(s.Suppliers || '-')}</td>
      <td>${wdFormatDate(s.ExpectedEta)}</td>
      <td>${s.OrderCount}</td>
      <td>${s.CancelledAtUtc
        ? `<span style="color:var(--text-secondary,#666)">Cancelled ${wdFormatDate(s.CancelledAtUtc)}</span>`
        : (s.ReceivedAtUtc ? `Received ${wdFormatDate(s.ReceivedAtUtc)}` : '<span style="color:var(--text-secondary,#666)">Pending</span>')}</td>
    </tr>`;

  const sections = WD_IL_BUCKETS.map(bd => {
    const bucketRows = rows.filter(s => wdIlBucketFor(s) === bd.key)
      .sort((a, b) => {
        if (bd.key === 'cancelled') return new Date(b.CancelledAtUtc).getTime() - new Date(a.CancelledAtUtc).getTime();
        if (bd.key === 'completed') return new Date(b.ReceivedAtUtc).getTime() - new Date(a.ReceivedAtUtc).getTime();
        const ta = a.ExpectedEta ? new Date(a.ExpectedEta).getTime() : Infinity;
        const tb = b.ExpectedEta ? new Date(b.ExpectedEta).getTime() : Infinity;
        return ta - tb;
      });
    if (!bucketRows.length) return '';
    const collapsed = ((bd.key === 'completed' || bd.key === 'cancelled') && !query) ? ' ps-section--collapsed' : '';
    return `<div class="ps-section${collapsed}" data-group-key="${bd.key}">
      <div class="ps-section-header">
        <span class="ps-section-dot ps-section-dot--${bd.dot}"></span>
        <span class="ps-section-title">${bd.label}</span>
        <span class="ps-section-count">${bucketRows.length}</span>
        <span class="ps-chevron">v</span>
      </div>
      <div class="ps-section-body">
        <div style="overflow-x:auto"><table class="ps-table">
          <thead><tr><th>Reference</th><th>Supplier</th><th>ETA</th><th>Orders</th><th>Status</th></tr></thead>
          <tbody>${bucketRows.map(renderRow).join('')}</tbody>
        </table></div>
      </div>
    </div>`;
  }).join('');

  document.getElementById('result-body').innerHTML = toolbarHtml + `<div class="ps-sections">${sections}</div>`;

  document.querySelectorAll('#result-body .ps-section-header').forEach(h => {
    h.addEventListener('click', () => h.closest('.ps-section').classList.toggle('ps-section--collapsed'));
  });
  document.querySelectorAll('#result-body .ps-row').forEach(row => {
    row.addEventListener('click', () => wdOpenInboundDetail(Number(row.dataset.id)));
  });
}

async function wdOpenInboundDetail(shipmentId) {
  const overlay = document.getElementById('ps-modal-overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = `<div class="ps-modal" style="max-width:640px;width:94vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Loading…</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body" id="wd-isd-body"><div class="sap-loading"><div class="spinner"></div>Loading…</div></div>
    <div class="ps-modal-actions" id="wd-isd-actions"></div>
  </div>`;
  await wdRefreshInboundDetail(shipmentId);
}

async function wdRefreshInboundDetail(shipmentId) {
  const body    = document.getElementById('wd-isd-body');
  const actions = document.getElementById('wd-isd-actions');
  if (!body) return;
  try {
    const res  = await fetch(`/api/performance/order-suggestions/shipments/${shipmentId}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load shipment');
    const s = json.data;

    document.querySelector('#ps-modal-overlay .ps-modal-title').textContent = s.ShipmentReference || `Shipment #${s.ShipmentId}`;

    const canReceive = !s.CancelledAtUtc && !s.ReceivedAtUtc;

    const ordersRows = s.orders.map(o => {
      const isCancelled = o.Status === 'Cancelled';
      const receivedUnit = o.OrderMoqUom || o.Uom || 'KG';
      const qtyReceivedCell = canReceive
        ? (isCancelled
          ? '<span style="color:var(--text-secondary,#666)">—</span>'
          : `<input class="tf-input wd-received-qty" type="number" step="0.001" min="0"
                    data-suggestion-id="${o.SuggestionId}" data-material="${esc(o.Material)}"
                    value="${wdKgToOrderUnit(Number(o.OrderQty), receivedUnit)}" style="width:90px">
             <span style="font-size:11px;color:var(--text-secondary,#666)">${esc(receivedUnit)}</span>`)
        : (o.ReceivedQty != null
            ? `${wdKgToOrderUnit(Number(o.ReceivedQty), receivedUnit).toLocaleString()} ${esc(receivedUnit)}`
            : '-');

      const supplierRefCell = (canReceive && !isCancelled)
        ? (o.SupplierReference
          ? esc(o.SupplierReference)
          : `<input class="tf-input wd-supplier-ref" type="text"
                    data-suggestion-id="${o.SuggestionId}" data-material="${esc(o.Material)}"
                    placeholder="Enter paperwork ref" style="width:110px">`)
        : esc(o.SupplierReference || '-');

      const sapGrCell = canReceive ? '' : `<td>${
        isCancelled ? '<span style="color:var(--text-secondary,#666)">—</span>'
        : o.SapMaterialDocument ? `<span title="Material document">✓ ${esc(o.SapMaterialDocument)}</span>`
        : (o.SapGrSkipped && o.SapGrError) ? `<span class="sap-error">Not posted</span><div style="font-size:11px;color:var(--error,#DC2626)">${esc(o.SapGrError)}</div>`
        : o.SapGrError ? `<span class="sap-error">Failed</span><div style="font-size:11px;color:var(--error,#DC2626)">${esc(o.SapGrError)}</div>`
        : '-'
      }</td>`;

      return `
      <tr class="admin-row">
        <td><strong>${esc(o.Material)}</strong><div style="font-size:11px;color:var(--text-secondary,#666)">${esc(o.MaterialText || '')}</div></td>
        <td>${esc(o.VendorName)}</td>
        <td>${Number(o.OrderQty).toLocaleString()} ${esc(o.Uom || 'KG')}</td>
        <td>${qtyReceivedCell}</td>
        <td>${esc(o.PoNumber || '-')}</td>
        <td>${supplierRefCell}</td>
        ${sapGrCell}
      </tr>`;
    }).join('');

    body.innerHTML = `
      <div class="tf-row">
        <div class="tf-field"><label class="tf-label">Supplier</label><div>${s.IsManual ? `Manual — ${esc(s.OriginName || '—')}` : esc(s.Suppliers || '—')}</div></div>
        <div class="tf-field"><label class="tf-label">Expected ETA</label><div>${wdFormatDate(s.ExpectedEta)}</div></div>
      </div>
      <div class="tf-row">
        <div class="tf-field"><label class="tf-label">Tracking Number</label><div>${esc(s.TrackingNumber || '—')}</div></div>
        <div class="tf-field"><label class="tf-label">Status</label><div>${
          s.CancelledAtUtc ? `Cancelled ${wdFormatDate(s.CancelledAtUtc)}`
          : s.ReceivedAtUtc ? `Received ${wdFormatDate(s.ReceivedAtUtc)}`
          : 'Not yet received'
        }</div></div>
      </div>
      <div id="wd-isd-result"></div>
      ${s.orders.length ? `
      <div class="tf-section-label">Order Lines</div>
      ${canReceive ? '<div class="toolbar-hint">Qty Received defaults to what was ordered — adjust any line to confirm a short or over delivery. Only the confirmed quantity is posted as goods receipt in SAP.</div>' : ''}
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>Material</th><th>Vendor</th><th>Qty Ordered</th><th>Qty Received</th><th>PO Number</th><th>Supplier Ref</th>${canReceive ? '' : '<th>SAP GR</th>'}</tr></thead>
          <tbody>${ordersRows}</tbody>
        </table>
      </div>` : '<div class="sap-empty">No order lines on this shipment.</div>'}`;

    actions.innerHTML = `
      <button type="button" class="btn-secondary" id="wd-isd-docs-btn">View Documents</button>
      ${canReceive ? '<button type="button" class="btn-submit" id="wd-isd-receive-btn">Mark Arrived — Post to SAP</button>' : ''}`;

    document.getElementById('wd-isd-docs-btn').addEventListener('click', () => wdViewInboundDocuments(shipmentId));
    if (canReceive) {
      document.getElementById('wd-isd-receive-btn').addEventListener('click', () => wdMarkInboundReceived(shipmentId, s));
    }
  } catch (err) {
    body.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

// View-only file list against the shipment's import folder — same
// GET .../documents/folder endpoint Logistics' Order Suggestions invoice
// uploader reads (routes/performance.js, now WAREHOUSE_OP-readable
// alongside LOG_MRP), just without the upload control: this is what an
// operator checks a delivery against on the goods-in bay, not somewhere
// they file paperwork from.
async function wdViewInboundDocuments(shipmentId) {
  const overlay = document.getElementById('ps-modal-overlay');
  overlay.innerHTML = `<div class="ps-modal" style="max-width:640px;width:94vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Documents</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body" id="wd-docs-body"><div class="sap-loading"><div class="spinner"></div>Loading…</div></div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" id="wd-docs-back-btn">← Back</button>
    </div>
  </div>`;
  document.getElementById('wd-docs-back-btn').addEventListener('click', () => wdOpenInboundDetail(shipmentId));

  const body = document.getElementById('wd-docs-body');
  try {
    const res  = await fetch(`/api/performance/order-suggestions/shipments/${shipmentId}/documents/folder`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load documents.');
    const files = json.data.files || [];
    body.innerHTML = !files.length
      ? '<div class="sap-empty">No documents filed against this shipment yet.</div>'
      : `<div style="overflow-x:auto"><table class="pn-batch-table admin-table">
          <thead><tr><th>File</th><th>Size</th><th>Uploaded</th><th></th></tr></thead>
          <tbody>${files.map(f => `<tr class="admin-row">
            <td>${esc(f.fileName)}</td>
            <td>${(Number(f.sizeBytes || 0) / 1024).toFixed(1)} KB</td>
            <td>${wdFormatDate(f.modifiedAtUtc)}</td>
            <td style="text-align:right"><a href="${esc(f.downloadUrl)}" target="_blank" rel="noopener">View</a></td>
          </tr>`).join('')}</tbody>
        </table></div>`;
  } catch (err) {
    body.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function wdMarkInboundReceived(shipmentId, shipment) {
  const orderCount = shipment.orders?.length || 0;
  const result = document.getElementById('wd-isd-result');

  const receivedQuantities = {};
  for (const input of document.querySelectorAll('.wd-received-qty')) {
    const suggestionId = input.dataset.suggestionId;
    const qty = Number(input.value);
    if (input.value.trim() === '' || !Number.isFinite(qty) || qty < 0) {
      if (result) result.innerHTML = `<div class="sap-error">Enter a valid received quantity for ${esc(input.dataset.material || 'every order line')}.</div>`;
      return;
    }
    receivedQuantities[suggestionId] = qty;
  }

  const supplierReferences = {};
  for (const input of document.querySelectorAll('.wd-supplier-ref')) {
    const suggestionId = input.dataset.suggestionId;
    const ref = input.value.trim();
    if (!ref) {
      if (result) result.innerHTML = `<div class="sap-error">Enter the supplier's delivery paperwork reference for ${esc(input.dataset.material || 'every order line')}.</div>`;
      return;
    }
    supplierReferences[suggestionId] = ref;
  }

  if (!(await wConfirm({
    title: 'Mark Arrived',
    message: `Mark ${shipment.ShipmentReference || 'this shipment'} arrived? ${orderCount} order line${orderCount === 1 ? '' : 's'} will be posted as goods receipt in SAP using the confirmed quantities.`,
    confirmText: 'Mark Arrived',
  }))) return;

  const btn = document.getElementById('wd-isd-receive-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Marking…'; }
  try {
    const res = await fetch(`/api/performance/order-suggestions/shipments/${shipmentId}/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receivedQuantities, supplierReferences, skipSap: false }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to mark shipment received');
    await wdRefreshInboundDetail(shipmentId);
    runInboundDeliveriesOp();

    const sapResults = json.data?.sapResults || [];
    const noPo    = sapResults.filter(r => r.skipped && r.noPo);
    const zeroQty = sapResults.filter(r => r.skipped && r.zeroQty);
    const failed  = sapResults.filter(r => r.success === false && !r.skipped);
    const newResult = document.getElementById('wd-isd-result');
    if (newResult && (noPo.length || zeroQty.length || failed.length)) {
      const parts = [];
      if (noPo.length) parts.push(`<div class="sap-error">${noPo.length} order line${noPo.length === 1 ? '' : 's'} had no SAP PO number/item on file — nothing was posted. Ask Logistics to fix the PO before this can go through.</div>`);
      if (zeroQty.length) parts.push(`<div class="toolbar-hint">${zeroQty.length} order line${zeroQty.length === 1 ? '' : 's'} confirmed at 0 received — nothing was posted to SAP for ${zeroQty.length === 1 ? 'it' : 'them'}.</div>`);
      if (failed.length) parts.push(`<div class="sap-error">${failed.length} order line${failed.length === 1 ? '' : 's'} failed to post to SAP — see the SAP GR column for details.</div>`);
      newResult.innerHTML = parts.join('');
    }
  } catch (err) {
    if (result) result.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    if (btn) { btn.disabled = false; btn.textContent = 'Mark Arrived — Post to SAP'; }
  }
}

// ── Outbound Deliveries (operator-friendly Awaiting Collection) ───────────────
// Warehouse-side view of Logistics' Awaiting Collection tile (see
// routes/shipmentmain.js's GET /queue/awaiting-collection, POST
// /mark-collected-bulk and POST /loading-list — none of which are
// LOG_PLANNING-gated beyond requireLogin, so an operator can use them the
// same as a planner). Same grouped-by-haulier bucket layout, plus a
// select-all checkbox per haulier bucket and a Loading List button to print
// what's going out — no date changes or unbooking, which stay
// planner-only in Logistics.
let wdCollectionRows = [];
let wdSelectedCollectionIds = new Set();
let wdOutboundSearchQuery = '';

function wdOutboundMatchesSearch(row, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  const ref = String(row.shipmentID || '').padStart(8, '0');
  return [row.shipmentID, ref, row.trackingNumber, row.destinationName]
    .some(field => String(field || '').toLowerCase().includes(needle));
}

function wdApplyOutboundSearch() {
  const input = document.getElementById('wd-outbound-search');
  wdOutboundSearchQuery = input ? input.value : '';
  const caret = input ? input.selectionStart : null;
  wdRenderOutboundDeliveries();
  const newInput = document.getElementById('wd-outbound-search');
  if (newInput) { newInput.focus(); if (caret != null) newInput.setSelectionRange(caret, caret); }
}

async function runOutboundDeliveriesOp() {
  if (!await checkSession()) return;
  showResultPanel('Outbound Deliveries', 'Confirm shipments as collected when the driver leaves site');
  try {
    const res  = await fetch('/api/shipmentmain/queue/awaiting-collection');
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load shipments');
    wdCollectionRows = json.data || [];
    wdSelectedCollectionIds = new Set();
    const badge = document.getElementById('result-row-badge');
    badge.textContent = `${wdCollectionRows.length} open`;
    badge.classList.remove('hidden');
    if (!wdCollectionRows.length) {
      document.getElementById('result-body').innerHTML = '<div class="sap-empty">No shipments are currently awaiting collection.</div>';
      return;
    }
    wdRenderOutboundDeliveries();
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

function wdRenderOutboundDeliveries() {
  const query = wdOutboundSearchQuery.trim();
  const filtered = query ? wdCollectionRows.filter(row => wdOutboundMatchesSearch(row, query)) : wdCollectionRows;

  const grouped = filtered.reduce((acc, row) => {
    const key = row.forwarderName || 'Unassigned';
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  const sections = Object.keys(grouped).sort((a, b) => a.localeCompare(b)).map(name => {
    const bucketRows = grouped[name].slice().sort((a, b) => {
      const aD = new Date(a.plannedCollection || 0).getTime();
      const bD = new Date(b.plannedCollection || 0).getTime();
      return aD - bD || Number(a.shipmentID || 0) - Number(b.shipmentID || 0);
    });
    const bucketFullySelected = bucketRows.length > 0 && bucketRows.every(r => wdSelectedCollectionIds.has(Number(r.shipmentID)));
    const rows = bucketRows.map(row => {
      const ref = String(row.shipmentID || '').padStart(8, '0');
      return `<tr class="ps-row wd-collection-row" data-id="${esc(String(row.shipmentID))}">
        <td class="lg-check-cell"><input type="checkbox" class="wd-collection-check" data-id="${esc(String(row.shipmentID))}"></td>
        <td>${esc(ref)}</td>
        <td>${wdFormatDate(row.plannedCollection)}</td>
        <td>${esc(row.trackingNumber || '')}</td>
        <td>${esc(row.destinationName || '—')}</td>
      </tr>`;
    }).join('');

    return `<div class="ps-section" data-group-key="${esc(name)}"><div class="ps-section-header"><input type="checkbox" class="wd-bucket-select-all" data-bucket-key="${esc(name)}" ${bucketFullySelected ? 'checked' : ''} title="Select all in ${esc(name)}" onclick="event.stopPropagation()"><span class="ps-section-dot ps-section-dot--today"></span><span class="ps-section-title">${esc(name)}</span><span class="ps-section-count">${grouped[name].length}</span><span class="ps-chevron">v</span></div><div class="ps-section-body"><table class="ps-table"><thead><tr><th></th><th>Shipment</th><th>Planned Collection</th><th>Tracking</th><th>Destination</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }).join('');

  document.getElementById('result-body').innerHTML = `
    <div class="lg-actions">
      <div><div class="lg-selection-title">Awaiting Collection</div>
      <div class="toolbar-hint" id="wd-collection-hint">Tick shipments as they're loaded, then Mark Collected.</div></div>
      <div class="toolbar-spacer"></div>
      <input class="tf-input" id="wd-outbound-search" type="text" placeholder="Search reference, tracking, destination…" value="${esc(wdOutboundSearchQuery)}" oninput="wdApplyOutboundSearch()" style="max-width:240px">
      <button class="btn-secondary" id="wd-col-clear-btn" disabled>Clear</button>
      <button class="btn-secondary" id="wd-col-loading-btn" disabled>Loading List</button>
      <button class="btn-submit"    id="wd-col-collect-btn" disabled>Mark Collected</button>
    </div>
    <div id="wd-collection-msg" class="lg-selection-msg hidden"></div>
    ${filtered.length ? `<div class="ps-sections">${sections}</div>` : `<div class="sap-empty">No shipments match "${esc(query)}".</div>`}`;

  document.querySelectorAll('#result-body .ps-section-header').forEach(h => h.addEventListener('click', (e) => {
    if (e.target.closest('input')) return;
    h.closest('.ps-section').classList.toggle('ps-section--collapsed');
  }));
  document.querySelectorAll('.wd-collection-check').forEach(cb => cb.addEventListener('change', wdOnCollectionToggle));
  document.querySelectorAll('.wd-bucket-select-all').forEach(cb => cb.addEventListener('change', () => {
    const section = cb.closest('.ps-section');
    section.querySelectorAll('.wd-collection-check').forEach(check => {
      check.checked = cb.checked;
      const id = Number(check.dataset.id);
      if (cb.checked) wdSelectedCollectionIds.add(id); else wdSelectedCollectionIds.delete(id);
    });
    wdUpdateCollectionUI();
  }));
  document.getElementById('wd-col-clear-btn').addEventListener('click', wdClearCollectionSelection);
  document.getElementById('wd-col-loading-btn').addEventListener('click', wdDownloadLoadingList);
  document.getElementById('wd-col-collect-btn').addEventListener('click', wdMarkCollectedBulk);
}

function wdOnCollectionToggle(e) {
  const id = Number(e.target.dataset.id);
  if (e.target.checked) wdSelectedCollectionIds.add(id); else wdSelectedCollectionIds.delete(id);
  wdUpdateCollectionUI();
}

function wdClearCollectionSelection() {
  wdSelectedCollectionIds = new Set();
  document.querySelectorAll('.wd-collection-check, .wd-bucket-select-all').forEach(cb => { cb.checked = false; });
  wdUpdateCollectionUI();
}

// Keeps each bucket's "select all" checkbox reflecting reality after any
// selection change — ticking/unticking one row by hand, or the checkbox
// itself, would otherwise leave a stale checked state behind. Same pattern
// as logistics.js's osSyncSelectAllCheckboxes.
function wdSyncBucketCheckboxes() {
  document.querySelectorAll('.ps-sections > .ps-section[data-group-key]').forEach(section => {
    const cb = section.querySelector(':scope > .ps-section-header .wd-bucket-select-all');
    if (!cb) return;
    const checks = [...section.querySelectorAll('.wd-collection-check')];
    cb.checked = checks.length > 0 && checks.every(c => c.checked);
  });
}

function wdUpdateCollectionUI() {
  const count = wdSelectedCollectionIds.size;
  const hint  = document.getElementById('wd-collection-hint');
  const msg   = document.getElementById('wd-collection-msg');
  if (hint) hint.textContent = count ? `${count} shipment(s) selected.` : "Tick shipments as they're loaded, then Mark Collected.";
  if (msg && !count) msg.classList.add('hidden');
  document.getElementById('wd-col-clear-btn')?.toggleAttribute('disabled', count === 0);
  document.getElementById('wd-col-loading-btn')?.toggleAttribute('disabled', count === 0);
  document.getElementById('wd-col-collect-btn')?.toggleAttribute('disabled', count === 0);
  wdSyncBucketCheckboxes();
}

async function wdDownloadLoadingList() {
  const ids = [...wdSelectedCollectionIds];
  if (!ids.length) return;
  try {
    wdShowCollectionMsg('Generating loading list…', false);
    const res = await fetch('/api/shipmentmain/loading-list', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shipmentIDs: ids }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error || 'Failed to generate loading list');
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `loading-list-${new Date().toISOString().slice(0, 10)}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
    wdShowCollectionMsg('Loading list downloaded.', false);
  } catch (err) { wdShowCollectionMsg(err.message); }
}

function wdShowCollectionMsg(text, isError = true) {
  const msg = document.getElementById('wd-collection-msg');
  if (!msg) return;
  msg.textContent = text;
  msg.className = `lg-selection-msg${isError ? '' : ' lg-selection-msg--success'}`;
  msg.classList.remove('hidden');
}

function wdMarkCollectedBulk() {
  const rows = wdCollectionRows.filter(r => wdSelectedCollectionIds.has(Number(r.shipmentID)));
  if (!rows.length) return;

  const mixed = new Set(rows.map(r => String(r.forwarderID || r.forwarderName || 'unassigned'))).size > 1;
  const now = new Date().toLocaleString('en-GB');

  const overlay = document.getElementById('ps-modal-overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = `<div class="ps-modal">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Mark as Collected</div>
      <div class="ps-modal-sub">${rows.length} shipment(s)${mixed ? ' — <span style="color:#b45309">multiple hauliers selected</span>' : ''}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      ${mixed ? `<div class="lg-selection-msg lg-selection-msg--warning" style="margin-bottom:16px">These shipments are assigned to different hauliers. Please confirm they're being collected together on the same vehicle.</div>` : ''}
      <div class="transfer-form">
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Operator Name</label><input class="tf-input" id="wd-cl-operator" type="text" placeholder="e.g. Jim Smith" value="${esc(sessionUsername)}"></div>
          <div class="tf-field"><label class="tf-label">Driver Name</label><input class="tf-input" id="wd-cl-driver" type="text" placeholder="e.g. Dave Jones"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Vehicle Registration</label><input class="tf-input" id="wd-cl-reg" type="text" placeholder="e.g. AB12 CDE"></div>
          <div class="tf-field"><label class="tf-label">Trailer Number</label><input class="tf-input" id="wd-cl-trailer" type="text" placeholder="e.g. TRL-456"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide"><label class="tf-label">Timestamp (auto)</label><input class="tf-input" value="${esc(now)}" readonly></div>
        </div>
        <div id="wd-cl-result" style="margin-top:8px;font-size:13px;color:var(--error)"></div>
      </div>
    </div>
    <div class="ps-modal-actions">
      <button class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button class="btn-submit" id="wd-cl-submit-btn">${mixed ? 'Confirm (Mixed Hauliers)' : 'Confirm'}</button>
    </div>
  </div>`;

  document.getElementById('wd-cl-submit-btn').addEventListener('click', () => wdSubmitMarkCollected(rows, mixed));
}

async function wdSubmitMarkCollected(rows, mixed) {
  const operator = document.getElementById('wd-cl-operator').value.trim();
  const driver   = document.getElementById('wd-cl-driver').value.trim();
  const reg      = document.getElementById('wd-cl-reg').value.trim();
  const trailer  = document.getElementById('wd-cl-trailer').value.trim();
  const result   = document.getElementById('wd-cl-result');
  const btn      = document.getElementById('wd-cl-submit-btn');

  if (!operator) { result.textContent = 'Operator name is required.'; return; }

  const description = [
    mixed ? 'mixed hauliers confirmed' : null,
    `operator=${operator}`,
    driver  ? `driver=${driver}`   : null,
    reg     ? `reg=${reg}`         : null,
    trailer ? `trailer=${trailer}` : null,
  ].filter(Boolean).join(' | ');

  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const res = await fetch('/api/shipmentmain/mark-collected-bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipmentIDs: rows.map(r => r.shipmentID), description }),
    });
    const json = await res.json();
    if (!json.success && !json.data?.completed?.length) throw new Error(json.error || 'Failed to mark as collected');
    const { completed = [], failed = [] } = json.data || {};
    closePickModal();
    wdShowCollectionMsg(
      [completed.length ? `${completed.length} shipment(s) marked as collected.` : '',
       failed.length    ? `${failed.length} failed: ${failed.map(f => f.error).join('; ')}` : ''].filter(Boolean).join(' '),
      failed.length === 0
    );
    await runOutboundDeliveriesOp();
  } catch (err) {
    result.textContent = err.message;
    btn.disabled = false; btn.textContent = mixed ? 'Confirm (Mixed Hauliers)' : 'Confirm';
  }
}

// ── Pallet list modal ─────────────────────────────────────────────────────────
let _palletListCtx = null; // { deliveryId, destName, custId, fromHolding } for refresh after builder closes

async function showPickedPallets(deliveryId, destName, custId, fromHolding) {
  if (!await checkSession()) return;
  _palletListCtx = { deliveryId, destName, custId: custId || '', fromHolding: !!fromHolding };

  const overlay = document.getElementById('ps-modal-overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="ps-modal" style="max-width:760px">
      <div class="ps-modal-header">
        <div>
          <div class="ps-modal-title">Picked Pallets</div>
          <div class="ps-modal-sub">Delivery #${esc(String(deliveryId))} · ${esc(destName)}${fromHolding ? ' · <span style="color:var(--warning,#B45309)">Confirming packaging — already completed in SAP</span>' : ''}</div>
        </div>
        <button class="ps-modal-close" onclick="closePickModal()">✕</button>
      </div>
      <div class="ps-linked-section" id="ps-linked-section"></div>
      <div class="ps-modal-body" id="pallet-list-body" style="padding:0">
        <div class="sap-loading"><div class="spinner"></div>Fetching pallets…</div>
      </div>
      <div class="ps-modal-actions">
        <button class="btn-secondary" onclick="completeDelivery()">${fromHolding ? 'Confirm Packaging ✓' : 'Complete Delivery ✓'}</button>
        <button class="btn-submit" onclick="openPalletBuilder()">+ Add Pallet</button>
      </div>
    </div>`;

  await Promise.all([refreshPalletList(), refreshLinkedPicksheets()]);
}

// ── Linked picksheets — shared pallet pool ──────────────────────────────────
// See routes/deliverymain.js's "Linked picksheets" section for the backend
// half of this — linking two picksheets widens pallet-list visibility
// between them (GET /:deliveryId/pallets) without changing which delivery
// actually owns each pallet, and completing either one completes/ZDELFLAG-
// processes the whole linked group together.
async function refreshLinkedPicksheets() {
  const { deliveryId } = _palletListCtx || {};
  const el = document.getElementById('ps-linked-section');
  if (!el || !deliveryId) return;
  try {
    const res  = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/linked-picksheets`);
    const json = await res.json();
    const linked = json.success ? json.data : [];
    const chips = linked.map(l => `
      <span class="ps-linked-chip">
        Linked to #${esc(String(l.deliveryID))} — ${esc(l.destinationName ?? '—')}
        <button type="button" class="ps-linked-unlink" title="Unlink" onclick="unlinkPicksheet(${l.deliveryID})">✕</button>
      </span>`).join('');
    el.innerHTML = `${chips}<button type="button" class="btn-secondary ps-link-btn" onclick="openLinkPicksheetSearch()">${linked.length ? '+ Link Another Picksheet' : 'Link to another picksheet'}</button>`;
  } catch {
    el.innerHTML = '';
  }
}

// Small search dialog reusing wPrompt/wConfirm's overlay shell — debounced
// search-as-you-type against a new dedicated endpoint, mousedown (not
// click) on a result row so it fires before the input's blur, same pattern
// as logistics.js's destination combobox (private/js/logistics.js's
// mo-dest-search — read-only reference, not shared code).
function openLinkPicksheetSearch() {
  const { deliveryId } = _palletListCtx || {};
  if (!deliveryId) return;
  document.getElementById('w-prompt-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'w-prompt-modal';
  overlay.className = 'wc-overlay';
  overlay.innerHTML = `
    <div class="wc-modal">
      <div class="wc-title">Link to Another Picksheet</div>
      <div class="wc-message" style="text-align:left">
        <input class="pb-input" id="lp-search" type="text" placeholder="Search delivery # or destination…" autocomplete="off" style="width:100%">
        <div id="lp-results" class="lp-results"></div>
      </div>
      <div class="wc-actions"><button type="button" class="wc-btn-cancel">Close</button></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.wc-btn-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  const input   = overlay.querySelector('#lp-search');
  const results = overlay.querySelector('#lp-results');
  input.focus();

  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (!q) { results.innerHTML = ''; return; }
    debounce = setTimeout(async () => {
      try {
        const res  = await fetch(`/api/deliverymain/link-search?q=${encodeURIComponent(q)}&excludeDeliveryId=${encodeURIComponent(deliveryId)}`);
        const json = await res.json();
        const rows = json.success ? json.data : [];
        results.innerHTML = rows.length
          ? rows.map(r => `<div class="lp-row" data-id="${esc(String(r.deliveryID))}">#${esc(String(r.deliveryID))} — ${esc(r.destinationName ?? '—')}</div>`).join('')
          : `<div class="lp-empty">No matches</div>`;
        results.querySelectorAll('.lp-row').forEach(row => {
          row.addEventListener('mousedown', async e => {
            e.preventDefault();
            overlay.remove();
            await linkPicksheet(row.dataset.id);
          });
        });
      } catch {
        results.innerHTML = `<div class="sap-error">Search failed</div>`;
      }
    }, 250);
  });
}

async function linkPicksheet(otherDeliveryId) {
  const { deliveryId } = _palletListCtx || {};
  if (!deliveryId) return;
  try {
    const res  = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/link/${encodeURIComponent(otherDeliveryId)}`, { method: 'POST' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Link failed');
    await Promise.all([refreshLinkedPicksheets(), refreshPalletList()]);
  } catch (err) {
    wConfirm({ title: 'Error', message: err.message, confirmText: 'OK', variant: '' });
  }
}

async function unlinkPicksheet(otherDeliveryId) {
  const { deliveryId } = _palletListCtx || {};
  if (!deliveryId) return;
  if (!await wConfirm({
    title: 'Unlink Picksheet',
    message: `Unlink Delivery #${otherDeliveryId}?\nPallets already tied to it will no longer appear on this picksheet (and vice versa).`,
    confirmText: 'Unlink', variant: 'danger',
  })) return;
  try {
    const res  = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/link/${encodeURIComponent(otherDeliveryId)}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Unlink failed');
    await Promise.all([refreshLinkedPicksheets(), refreshPalletList()]);
  } catch (err) {
    wConfirm({ title: 'Error', message: err.message, confirmText: 'OK', variant: '' });
  }
}

async function refreshPalletList() {
  const { deliveryId, destName } = _palletListCtx || {};
  const body = document.getElementById('pallet-list-body');
  if (!body) return;

  try {
    const res  = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/pallets`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load pallets');
    const pallets = json.data;

    if (!pallets.length) {
      body.innerHTML = `<div style="padding:40px;text-align:center;
        font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text-muted)">
        No pallets built yet.<br><br>Click <strong>+ Add Pallet</strong> to start building.
      </div>`;
      return;
    }

    body.innerHTML = `<div class="ps-pcard-list">${pallets.map(p => renderPalletCard(p)).join('')}</div>`;

    body.querySelectorAll('.ps-pcard-hdr').forEach(hdr => {
      hdr.addEventListener('click', () => togglePalletCard(hdr.closest('.ps-pcard')));
    });
  } catch (err) {
    body.innerHTML = `<div class="sap-error" style="padding:24px">✕ ${esc(err.message)}</div>`;
  }
}

function renderPalletCard(p) {
  const dims   = [p.palletLength, p.palletWidth, p.palletHeight].filter(Boolean).join('×');
  const wt     = p.grossWeight != null ? `${Number(p.grossWeight).toFixed(1)} kg` : '—';
  const status = p.palletFinish
    ? `<span class="ps-pcard-badge ps-pcard-badge--done">Finished</span>`
    : `<span class="ps-pcard-badge ps-pcard-badge--wip">In Progress</span>`;
  const actions = p.palletFinish
    ? `<button class="ps-pcard-btn" title="Un-mark as finished and continue editing"
        onclick="event.stopPropagation();reopenPallet(${p.palletID})">Reopen</button>`
    : `<button class="ps-pcard-btn"
        onclick="event.stopPropagation();openPalletBuilderOnExisting(${p.palletID})">Continue</button>
      <button class="ps-pcard-btn ps-pcard-btn--finish"
        onclick="event.stopPropagation();finishExistingPallet(${p.palletID})">Finish</button>`;
  const deleteBtn = `
    <button class="ps-pcard-btn ps-pcard-btn--delete" title="Delete pallet"
      onclick="event.stopPropagation();deletePallet(${p.palletID})">Delete</button>`;

  return `
    <div class="ps-pcard" data-palletid="${p.palletID}">
      <div class="ps-pcard-hdr">
        <span class="ps-pcard-type">${esc(p.palletType ?? '—')}</span>
        ${dims ? `<span class="ps-pcard-dims">${dims} cm</span>` : ''}
        <span class="ps-pcard-wt">${wt}</span>
        ${p.palletLocation ? `<span class="ps-pcard-loc">${esc(p.palletLocation)}</span>` : ''}
        ${status}
        ${actions}
        ${deleteBtn}
        <span class="ps-pcard-chevron">▼</span>
      </div>
      <div class="ps-pcard-body" id="pcard-body-${p.palletID}" style="display:none"></div>
    </div>`;
}

async function togglePalletCard(card) {
  const palletId = card.dataset.palletid;
  const body     = document.getElementById(`pcard-body-${palletId}`);
  const isOpen   = body.style.display !== 'none';

  body.style.display = isOpen ? 'none' : 'block';
  card.querySelector('.ps-pcard-chevron').textContent = isOpen ? '▼' : '▲';

  if (!isOpen && body.dataset.loaded !== '1') {
    body.innerHTML = `<div class="ps-pcard-empty"><div class="spinner" style="width:12px;height:12px;display:inline-block;margin-right:6px"></div>Loading…</div>`;
    await loadPalletPackages(palletId, body);
    body.dataset.loaded = '1';
  }
}

async function loadPalletPackages(palletId, bodyEl) {
  try {
    const res  = await fetch(`/api/palletpackages/pallet/${encodeURIComponent(palletId)}`);
    const json = await res.json();
    const pkgs = json.data || [];

    if (!pkgs.length) {
      bodyEl.innerHTML = `<div class="ps-pcard-empty">No packages on this pallet yet.</div>`;
      return;
    }

    bodyEl.innerHTML = `
      <table class="ps-pcard-tbl">
        <thead><tr>
          <th>Layer</th><th>Pack Type</th><th>SAP Material</th>
          <th>Qty</th><th>Batch</th><th>Delivery</th><th>Del. Item</th><th>Customer</th><th></th>
        </tr></thead>
        <tbody>${pkgs.map(pkg => `<tr>
          <td>${esc(String(pkg.palletLayer ?? '—'))}</td>
          <td>${esc(pkg.packDescription || pkg.packagingID || '—')}</td>
          <td class="ps-pcard-mono">${esc(pkg.sapMaterial || '—')}</td>
          <td class="ps-pcard-mono">${pkg.sapQuantity != null ? Number(pkg.sapQuantity).toFixed(3) : '—'}</td>
          <td class="ps-pcard-mono">${esc(pkg.sapBatch || '—')}</td>
          <td class="ps-pcard-mono">${esc(pkg.sapDelivery || '—')}</td>
          <td class="ps-pcard-mono">${esc(pkg.sapDeliveryItem || '—')}</td>
          <td class="ps-pcard-mono">${esc(pkg.sapCustomer || '—')}</td>
          <td>
            <button class="ps-pcard-del" title="Remove"
              onclick="removePackage(${pkg.palletItemID}, ${palletId})">✕</button>
          </td>
        </tr>`).join('')}</tbody>
      </table>`;
  } catch (err) {
    bodyEl.innerHTML = `<div class="ps-pcard-empty" style="color:var(--error)">✕ ${esc(err.message)}</div>`;
  }
}

// If this package was staged in SAP, deleting it also reverses the
// picksheet-stage-batch transfer order server-side (routes/palletpackages.js
// DELETE handler) — the batch's stock moves back out of the picksheet's bin
// to wherever it came from, freeing it for other deliveries again. That call
// fails closed: if SAP rejects the reversal the row isn't deleted, so the
// error below can legitimately be a SAP message, not just a DB failure.
async function removePackage(palletItemId, palletId) {
  if (!await wConfirm({
    title: 'Remove Package',
    message: 'Remove this package from the pallet?\nIf it was staged in SAP, the stock will be moved back to its original location.',
    confirmText: 'Remove',
    variant: 'danger',
  })) return;
  try {
    const res  = await fetch(`/api/palletpackages/${palletItemId}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Delete failed');
    const bodyEl = document.getElementById(`pcard-body-${palletId}`);
    if (bodyEl) { bodyEl.dataset.loaded = '0'; await loadPalletPackages(palletId, bodyEl); bodyEl.dataset.loaded = '1'; }
  } catch (err) { wConfirm({ title: 'Error', message: err.message, confirmText: 'OK', variant: '' }); }
}

async function finishExistingPallet(palletId) {
  if (!await wConfirm({
    title: 'Finish Pallet',
    message: 'Mark this pallet as finished?\nNo more packages can be added.',
    confirmText: 'Finish',
    variant: 'success',
  })) return;

  // Same job-comment prompt as the full builder's Finish Pallet step (see
  // finishBuilderPallet) — offered here too since this quick-finish button
  // is the other place a pallet actually gets marked finished. Comment is
  // per-delivery (log.DeliveryMain.picksheetComment), not per-pallet — see
  // that function's own comment for why. wPrompt resolves null on Cancel,
  // which is treated as "leave it as-is", not "clear it".
  const { deliveryId } = _palletListCtx || {};
  let currentComment = '';
  if (deliveryId) {
    try {
      const rows = await fetch(`/api/deliverymain/id/${encodeURIComponent(deliveryId)}`).then(r => r.json());
      currentComment = rows?.[0]?.picksheetComment || '';
    } catch { /* best-effort — an empty starting value is fine */ }
  }
  const comment = await wPrompt({ title: 'Job Comment', label: 'Comment (optional) — shown on Create Shipment', initialValue: currentComment });

  try {
    const res  = await fetch(`/api/palletmain/${palletId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ palletFinish: 1 }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Update failed');

    if (deliveryId && comment !== null && comment !== currentComment) {
      fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/comment`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ picksheetComment: comment }),
      }).catch(() => {});
    }

    await refreshPalletList();
  } catch (err) { wConfirm({ title: 'Error', message: err.message, confirmText: 'OK', variant: '' }); }
}

// Un-marks a finished pallet so it can be edited again, instead of having
// to delete it (reversing every staged batch's SAP transfer order) and
// rebuild it from scratch. Pure DB flag flip server-side (routes/palletmain.js's
// PATCH handler) — finishing a pallet never itself triggers any SAP call,
// that only happens when the whole delivery is completed — so there's
// nothing to reverse here. Opens straight into the builder afterward so
// "reopen" and "continue editing" are one action, not two.
async function reopenPallet(palletId) {
  if (!await wConfirm({
    title: 'Reopen Pallet',
    message: 'Un-mark this pallet as finished so it can be edited again?',
    confirmText: 'Reopen',
    variant: '',
  })) return;
  try {
    const res  = await fetch(`/api/palletmain/${palletId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ palletFinish: 0 }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Update failed');
    // Refresh the list behind the builder now, not just on the way out —
    // otherwise cancelling out of the builder without re-finishing leaves
    // the card underneath still reading "Finished" until something else
    // happens to trigger a refresh.
    await refreshPalletList();
    await openPalletBuilderOnExisting(palletId);
  } catch (err) { wConfirm({ title: 'Error', message: err.message, confirmText: 'OK', variant: '' }); }
}

// Deleting a pallet reverses SAP staging for every one of its packages
// server-side (routes/palletmain.js PATCH handler, via reverseStagedPackage)
// before the pallet is actually marked removed — fails closed, so a pallet
// with stock still stuck in SAP stays visible instead of silently vanishing.
function formatReversalError(json) {
  let msg = json.error || 'Delete failed';
  if (Array.isArray(json.failures) && json.failures.length) {
    msg += '\n' + json.failures.map(f => `• ${f.sapMaterial || '?'} / ${f.sapBatch || '?'}: ${f.error}`).join('\n');
  }
  return msg;
}

async function deletePallet(palletId) {
  if (!await wConfirm({
    title: 'Delete Pallet',
    message: 'Delete this pallet and all its packages?\nAny stock staged in SAP will be moved back to its original location first.\nThis cannot be undone.',
    confirmText: 'Delete',
    variant: 'danger',
  })) return;
  try {
    const res  = await fetch(`/api/palletmain/${palletId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ palletRemoved: 1 }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(formatReversalError(json));
    await refreshPalletList();
  } catch (err) { wConfirm({ title: 'Error', message: err.message, confirmText: 'OK', variant: '' }); }
}

function closePickModal() {
  document.getElementById('ps-modal-overlay').classList.add('hidden');
}

// ── Pallet Builder ────────────────────────────────────────────────────────────
let pb = null; // active builder state

// ── Pallet builder label printing ────────────────────────────────────────────
// Two label kinds print automatically rather than through a button (see
// routes/labels.js's /pallet/scan and /pallet/finish endpoints, and the
// design rationale in that file's WH_COLOR comment): a batch-scan
// confirmation the moment a batch is staged/added onto the pallet, and a
// finish manifest once the pallet itself is marked finished. A batch is
// scanned every few seconds during a build, so a printer picker on every
// single scan would be worse than useless — instead the printer is resolved
// once when the builder opens (same user-default-then-first priority as
// production-nexus.js's labelPrint()) and can be changed via the dropdown in
// the running panel; every print after that reuses pb.printerId silently.
let _pbPrinterCache = null; // { printers: [...], userDefault: string|null }

async function loadPbPrinters() {
  if (!_pbPrinterCache) {
    const r = await fetch('/api/labels/printers').then(r => r.json());
    _pbPrinterCache = { printers: r.data || [], userDefault: r.userDefault || null };
  }
  return _pbPrinterCache;
}

function resolvePbPrinterId(printers, userDefault) {
  if (!printers.length) return null;
  return (userDefault && printers.find(p => p.id === userDefault)) ? userDefault : printers[0].id;
}

async function sendLabelPrint(path, printerId) {
  if (!printerId) throw new Error('No label printer configured');
  const res = await fetch(`/api/labels${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ printerId }),
  }).then(r => r.json());
  if (!res.success) throw new Error(res.error || 'Print failed');
}

// Fire-and-forget — a failed scan-confirmation print shouldn't interrupt the
// scan-and-add flow (the batch is already staged/added either way); a
// failure just shows up as a message in the builder rather than blocking
// anything.
function printBatchScanLabel(palletItemId) {
  if (!pb?.printerId) return;
  sendLabelPrint(`/pallet/scan/${palletItemId}/print`, pb.printerId)
    .catch(err => showPbMsg(`✕ Label not printed: ${err.message}`, 'error'));
}

function pbPrinterSelectHtml() {
  if (!pb.printers?.length) return '';
  const opts = pb.printers
    .map(p => `<option value="${esc(p.id)}"${p.id === pb.printerId ? ' selected' : ''}>${esc(p.name)}</option>`)
    .join('');
  return `<div class="pb-running-loc" style="margin-top:8px">
    <label class="pb-label" style="margin-bottom:4px">Label Printer</label>
    <select class="pb-input" id="pb-printer-select" onchange="pb.printerId=this.value">${opts}</select>
  </div>`;
}

// Profit centre 2007 materials are packed differently from everything else:
// each batch sits inside its own C2 box, and the pallet itself is a single
// outer box — SB (small), MB (medium), or LB (large), same process just
// different pallet size — holding all of those C2s. The operator still picks
// which outer box size via the normal packaging picker for the FIRST batch
// added to a layer; addPackage() below creates one container row per layer
// for whichever of SB/MB/LB was chosen (no batch/material attached — it's
// the box itself), then forces every batch added to that layer afterward
// onto C2 automatically, bypassing the picker — the operator only manages
// the SB/MB/LB choice once per layer, never the C2 split.
const CONTAINER_PACKAGING_IDS = ['SB', 'MB', 'LB'];
const INNER_PACKAGING_ID      = 'C2';

function isContainerPackagingId(packagingID) {
  return CONTAINER_PACKAGING_IDS.includes(packagingID);
}

function materialUsesContainerPacking(material) {
  return !!pb?.requiredMaterials?.find(m => m.material === material)?.usesContainerPacking;
}

// The packaging instruction (ZPRODBATCH~PALL_MATNR) also encodes which
// packaging type the batch was built for as its LAST underscore-delimited
// segment, e.g. "IB_363660_MD" -> packaging type "MD" (customer 363660 is
// the middle segment — see packagingInstructionCustomer in
// routes/deliverymain.js). Used to auto-select the matching radio in the
// packaging picker as soon as a batch is scanned/matched, so the operator
// doesn't have to hunt for the right type manually — they can still click
// a different one before adding if the packaging has changed since the
// batch was originally assigned.
const PACKAGING_TYPE_SUFFIX_RE = /_([A-Za-z0-9]+)$/;

function packagingInstructionType(packagingMaterial) {
  const match = String(packagingMaterial || '').match(PACKAGING_TYPE_SUFFIX_RE);
  return match ? match[1].toUpperCase() : null;
}

// Skipped for profit-centre-2007 (container-packing) materials — their
// picker chooses the outer SB/MB/LB box size for the layer, not a per-batch
// type, and every batch is force-set to C2 regardless (see addPackage()),
// so there's nothing useful to auto-select there.
function applySuggestedPackaging(material, packagingMaterial) {
  if (!material || materialUsesContainerPacking(material)) return;
  const suggested = packagingInstructionType(packagingMaterial);
  if (!suggested) return;
  const radio = document.querySelector(`input[name="pb-pack"][value="${CSS.escape(suggested)}"]`);
  if (!radio || radio.checked) return;
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
}

function getPbOverlay() {
  let el = document.getElementById('pb-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pb-overlay';
    el.className = 'pb-overlay hidden';
    document.body.appendChild(el);
  }
  return el;
}

async function openPalletBuilder() {
  if (!await checkSession()) return;
  const { deliveryId, destName } = _palletListCtx || {};

  const { custId } = _palletListCtx || {};
  pb = { deliveryId, destName, customerId: custId || '', palletLocation: '',
         packagingWeight: 0,
         phase: 1, palletId: null, palletType: null,
         palletTypeData: null, allPalletTypes: [],
         allPackaging: [], allowedPackaging: [], packages: [], nextLayer: 1,
         requiredMaterials: [], stockError: null,
         pendingSapMaterial: null, pendingSapDeliveryItem: null, pendingSapQuantity: null,
         pendingPackagingInstruction: null,
         layerContainers: {}, printers: [], printerId: null, picksheetComment: '' };

  const overlay = getPbOverlay();
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="pb-modal">
      <div class="pb-header">
        <div>
          <div class="pb-title">Build New Pallet</div>
          <div class="pb-sub">Delivery #${esc(String(deliveryId))} · ${esc(destName)}</div>
        </div>
        <button class="pb-close" onclick="closePalletBuilder()">✕</button>
      </div>
      <div class="pb-body" id="pb-body">
        <div class="sap-loading"><div class="spinner"></div>Loading pallet types…</div>
      </div>
    </div>`;

  try {
    const [ptRes, pkRes, stockRes, printerInfo, dmRows] = await Promise.all([
      fetch('/api/palletdata').then(r => r.json()),
      fetch('/api/packagingdata').then(r => r.json()),
      fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/picksheet-materials`)
        .then(r => r.json()).catch(err => ({ success: false, error: err.message })),
      loadPbPrinters().catch(() => ({ printers: [], userDefault: null })),
      fetch(`/api/deliverymain/id/${encodeURIComponent(deliveryId)}`).then(r => r.json()).catch(() => []),
    ]);
    pb.allPalletTypes = ptRes.data || ptRes;
    pb.allPackaging   = pkRes.data || pkRes;
    applyStockResult(stockRes);
    pb.printers  = printerInfo.printers;
    pb.printerId = resolvePbPrinterId(printerInfo.printers, printerInfo.userDefault);
    pb.picksheetComment = dmRows?.[0]?.picksheetComment || '';
    renderBuilderPhase1();
  } catch (err) {
    document.getElementById('pb-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

// Shared by openPalletBuilder / openPalletBuilderOnExisting — stores the
// picksheet-materials result (or its failure) on pb without ever blocking
// the builder itself; SAP being briefly unreachable shouldn't stop someone
// building a pallet, it just means the left-hand stock panel shows an error.
function applyStockResult(stockRes) {
  if (stockRes && stockRes.success) {
    pb.requiredMaterials = stockRes.data?.materials || [];
    pb.stockError = null;
  } else {
    pb.requiredMaterials = [];
    pb.stockError = stockRes?.error || 'Failed to load required materials from SAP.';
  }
}

async function openPalletBuilderOnExisting(palletId) {
  if (!await checkSession()) return;
  const { deliveryId, destName } = _palletListCtx || {};

  const { custId } = _palletListCtx || {};
  pb = { deliveryId, destName, customerId: custId || '', palletLocation: '',
         packagingWeight: 0,
         phase: 2, palletId, palletType: null,
         palletTypeData: null, allPalletTypes: [],
         allPackaging: [], allowedPackaging: [], packages: [], nextLayer: 1,
         requiredMaterials: [], stockError: null,
         pendingSapMaterial: null, pendingSapDeliveryItem: null, pendingSapQuantity: null,
         pendingPackagingInstruction: null,
         layerContainers: {}, printers: [], printerId: null, picksheetComment: '' };

  const overlay = getPbOverlay();
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="pb-modal">
      <div class="pb-header">
        <div>
          <div class="pb-title">Continue Building &nbsp;<span style="font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--accent)">#${palletId}</span></div>
          <div class="pb-sub">Delivery #${esc(String(deliveryId))} · ${esc(destName)}</div>
        </div>
        <button class="pb-close" onclick="closePalletBuilder()">✕</button>
      </div>
      <div class="pb-body" id="pb-body">
        <div class="sap-loading"><div class="spinner"></div>Loading…</div>
      </div>
    </div>`;

  try {
    // Need the pallet's own type before the validation lookup can be scoped
    // to it (see below), so fetch that one first rather than in the big
    // Promise.all with everything else.
    const palRes        = await fetch(`/api/palletmain/id/${palletId}`).then(r => r.json());
    const palletRecord  = (palRes.data || palRes)[0];
    const palletTypeId  = palletRecord?.palletType;

    const [ptRes, pkRes, pkgsRes, valRes, stockRes, printerInfo, dmRows] = await Promise.all([
      fetch('/api/palletdata').then(r => r.json()),
      fetch('/api/packagingdata').then(r => r.json()),
      fetch(`/api/palletpackages/pallet/${palletId}`).then(r => r.json()),
      // Same pallet-type-scoped, full-PackagingData-joined endpoint
      // createPallet() uses — GET /api/palletvalidation (no pallet ID) is
      // the bare palletID/packagingID pair table for EVERY pallet type, so
      // using it here showed every packaging option instead of just the
      // ones valid for this pallet's own type.
      palletTypeId
        ? fetch(`/api/palletvalidation/pallet/${encodeURIComponent(palletTypeId)}`).then(r => r.json())
        : Promise.resolve({ data: [] }),
      fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/picksheet-materials`)
        .then(r => r.json()).catch(err => ({ success: false, error: err.message })),
      loadPbPrinters().catch(() => ({ printers: [], userDefault: null })),
      fetch(`/api/deliverymain/id/${encodeURIComponent(deliveryId)}`).then(r => r.json()).catch(() => []),
    ]);

    pb.allPalletTypes = ptRes.data || ptRes;
    pb.allPackaging   = pkRes.data || pkRes;
    applyStockResult(stockRes);
    pb.printers  = printerInfo.printers;
    pb.printerId = resolvePbPrinterId(printerInfo.printers, printerInfo.userDefault);
    pb.picksheetComment = dmRows?.[0]?.picksheetComment || '';

    if (palletRecord) {
      pb.palletType       = palletRecord.palletType;
      pb.palletTypeData   = pb.allPalletTypes.find(t => t.palletID === pb.palletType);
      pb.palletLocation   = palletRecord.palletLocation   || '';
      pb.packagingWeight  = Number(palletRecord.packagingWeight || 0);
    }

    const existing  = pkgsRes.data || pkgsRes;
    pb.packages     = existing;
    pb.nextLayer    = existing.length
      ? Math.max(...existing.map(p => p.palletLayer || 0)) + 1
      : 1;

    // Rebuild which layers already have their outer box (SB/MB/LB) created,
    // so re-opening a pallet that already has PC2007 packages on it doesn't
    // create a duplicate container row the next time a batch is added to
    // that layer — and remembers WHICH size was used, since C2 batches added
    // later must go under the same box, not a newly-chosen one.
    existing
      .filter(p => isContainerPackagingId(p.packagingID) && !p.sapBatch)
      .forEach(p => { pb.layerContainers[p.palletLayer] = p.packagingID; });

    // Already scoped to palletTypeId above and joined to full PackagingData
    // (BIGINT packagingID included) — see the Promise.all comment.
    pb.allowedPackaging = valRes.data || valRes;

    renderBuilderPhase2();
  } catch (err) {
    document.getElementById('pb-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

// ── Stock panel (left column) — required materials + available batches ──────
// Sourced from GET /api/deliverymain/:id/picksheet-materials, which orchestrates
// SAP LIPS (required materials) → LQUA+ZPRODBATCH (batches) → LIKP (customer
// conflict check) — see routes/deliverymain.js for the full chain. A batch
// already allocated to a different customer's delivery is shown greyed out
// with a "restricted" tag instead of an Add button.
function renderStockPanel() {
  if (pb.stockError) {
    return `<div class="pb-stock-panel" id="pb-stock-panel">
      <div class="pb-section-label">Required Materials &amp; Stock</div>
      <div class="pb-stock-error">✕ ${esc(pb.stockError)}</div>
    </div>`;
  }

  if (!pb.requiredMaterials || !pb.requiredMaterials.length) {
    return `<div class="pb-stock-panel" id="pb-stock-panel">
      <div class="pb-section-label">Required Materials &amp; Stock</div>
      <div class="pb-stock-empty">No SAP line items found for this delivery.</div>
    </div>`;
  }

  const showAddBtn = pb.phase === 2;

  // Batches come from the backend pre-sorted into one of four groups (see
  // routes/deliverymain.js's picksheet-materials assembly):
  //   available    — normal, addable, shown at the top uncollapsed.
  //   unassigned   — packaging instruction (PALL_MATNR) has no parseable
  //                  customer segment, so it can't be confirmed either way;
  //                  still addable, just grouped separately for visibility.
  //   restricted   — allocated to a different customer's delivery (existing
  //                  ZPRODBATCH~VBELN / 916-bin conflict check); not addable.
  //   wrongCustomer— packaging instruction's customer segment doesn't match
  //                  this delivery's customer (e.g. "IB_363660_C2" on a
  //                  delivery for a different customer); not addable.
  // Restricted/wrongCustomer/unassigned all render inside their own
  // collapsed <details> block so they don't compete for attention with
  // what's actually usable, but stay visible rather than being hidden.
  const GROUP_LABELS = { unassigned: 'unassigned', restricted: 'restricted', wrongCustomer: 'other customer' };

  const renderBatch = (m, b) => {
    const restrictedCls = b.allowed ? '' : ' pb-stock-batch--restricted';
    const action = b.allowed
      ? (showAddBtn
          ? `<button type="button" class="pb-stock-add" title="Add this batch"
               onclick="addPackageFromFoundBatch('${escJs(m.material)}','${escJs(b.batch)}','${escJs(m.deliveryItem || '')}', ${Number(b.totalQty || 0)}, '${escJs(b.packagingMaterial || '')}')">+</button>`
          : '')
      : `<span class="pb-stock-restricted-tag" title="${esc(b.reason || 'Allocated elsewhere')}">${esc(GROUP_LABELS[b.group] || 'restricted')}</span>`;
    return `<div class="pb-stock-batch${restrictedCls}">
      <span class="pb-stock-batch-no">${esc(b.batch || '—')}</span>
      <span class="pb-stock-batch-bin">${esc(b.storageType || '')} ${esc(b.bin || '')}</span>
      <span class="pb-stock-batch-qty">${Number(b.availableQty || 0).toFixed(0)}</span>
      ${action}
    </div>`;
  };

  const groups = pb.requiredMaterials.map(m => {
    const batches       = m.batches || [];
    const available      = batches.filter(b => b.group === 'available');
    const unassigned      = batches.filter(b => b.group === 'unassigned');
    const restricted      = batches.filter(b => b.group === 'restricted');
    const wrongCustomer   = batches.filter(b => b.group === 'wrongCustomer');

    const availableSection = available.length
      ? `<div class="pb-stock-batches">${available.map(b => renderBatch(m, b)).join('')}</div>`
      : (batches.length ? `<div class="pb-stock-nobatch">No available stock (see groups below)</div>` : '');

    const collapsed = (list, label) => list.length
      ? `<details class="pb-stock-restricted-group">
           <summary class="pb-stock-restricted-summary">${list.length} ${label} batch${list.length !== 1 ? 'es' : ''}</summary>
           <div class="pb-stock-batches">${list.map(b => renderBatch(m, b)).join('')}</div>
         </details>`
      : '';

    const batchRows = batches.length
      ? `${availableSection}${collapsed(unassigned, 'unassigned')}${collapsed(restricted, 'restricted')}${collapsed(wrongCustomer, 'other-customer')}`
      : `<div class="pb-stock-nobatch">No stock found</div>`;

    // requiredQty is decremented in addPackage() as batches are staged (see
    // there) rather than SAP's original line quantity, so this reflects what
    // still needs picking, not what the order originally asked for. Once
    // nothing more is needed, collapse the whole material into a <details>
    // instead of a plain <div> so it stops taking up space among materials
    // still being picked, but stays reachable (e.g. to over-pick deliberately).
    const remaining   = Math.max(0, Number(m.requiredQty || 0));
    const isComplete  = remaining <= 0;
    const materialHdr = `<div class="pb-stock-material-hdr">
        <span class="pb-stock-material-code">${esc(m.material)}</span>
        <span class="pb-stock-material-req${isComplete ? ' pb-stock-material-req--done' : ''}">${isComplete ? '✓ done' : `req. ${remaining.toFixed(0)}`}</span>
      </div>`;

    return isComplete
      ? `<details class="pb-stock-material pb-stock-material--done">
          <summary>${materialHdr}</summary>
          ${batchRows}
        </details>`
      : `<div class="pb-stock-material">${materialHdr}${batchRows}</div>`;
  }).join('');

  return `<div class="pb-stock-panel" id="pb-stock-panel">
    <div class="pb-section-label">Required Materials &amp; Stock</div>
    <div class="pb-stock-list">${groups}</div>
  </div>`;
}

// Click handler for a found batch's "+" button — fills the batch field and
// adds it immediately, same as scanning it in. Also works as the "scan"
// half of the feature: typing/scanning a batch that matches one listed here
// (see wireBatchScanInput) sets the same pending fields before Add fires.
// packagingMaterial is the batch's raw SAP packaging instruction (e.g.
// "IB_363660_MD") — used to auto-select the matching packaging radio (see
// applySuggestedPackaging) so the operator doesn't have to pick it manually.
function addPackageFromFoundBatch(material, batch, deliveryItem, qty, packagingMaterial) {
  const batchInput = document.getElementById('pb-batch');
  if (!batchInput) return;
  batchInput.value = batch;
  pb.pendingSapMaterial     = material;
  pb.pendingSapDeliveryItem = deliveryItem || null;
  pb.pendingSapQuantity     = qty || null;
  pb.pendingPackagingInstruction = packagingMaterial || null;
  applySuggestedPackaging(material, packagingMaterial);
  addPackage();
}

// Enter/scan support on the batch field — a barcode scanner types the value
// then sends Enter, which previously did nothing (the operator had to click
// "+ Add Package" manually every time). Also auto-matches whatever's typed
// against the found-batches list so a scanned batch carries its SAP material
// through to the package record, same as clicking "+" on the left panel —
// and auto-selects its suggested packaging type (see applySuggestedPackaging),
// which the operator can still override by clicking a different radio before
// pressing Enter / Add.
function wireBatchScanInput() {
  const input = document.getElementById('pb-batch');
  if (!input) return;

  input.addEventListener('input', () => {
    const val = input.value.trim().toUpperCase();
    let match = null;
    for (const m of (pb.requiredMaterials || [])) {
      const hit = (m.batches || []).find(b => b.allowed && (b.batch || '').toUpperCase() === val);
      if (hit) { match = { material: m.material, deliveryItem: m.deliveryItem, qty: hit.totalQty, packagingMaterial: hit.packagingMaterial }; break; }
    }
    pb.pendingSapMaterial     = match?.material || null;
    pb.pendingSapDeliveryItem = match?.deliveryItem || null;
    pb.pendingSapQuantity     = match?.qty || null;
    pb.pendingPackagingInstruction = match?.packagingMaterial || null;
    if (match) applySuggestedPackaging(match.material, match.packagingMaterial);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addPackage(); }
  });
}

// ── Builder Phase 1: create pallet ───────────────────────────────────────────
function renderBuilderPhase1() {
  const typeCards = pb.allPalletTypes.map(t => {
    const dims = [t.palletLength, t.palletWidth, t.palletHeight].filter(Boolean).join('×');
    return `
      <div class="pb-type-card" data-id="${esc(t.palletID)}" onclick="selectPalletType('${esc(t.palletID)}')">
        <div class="pb-type-code">${esc(t.palletID)}</div>
        <div class="pb-type-desc">${esc(t.palletDescription || '—')}</div>
        ${dims ? `<div class="pb-type-dims">${dims} cm</div>` : ''}
        ${t.palletWeight != null ? `<div class="pb-type-wt">${t.palletWeight} kg</div>` : ''}
      </div>`;
  }).join('');

  document.getElementById('pb-body').innerHTML = `
    <div class="pb-merged">
      ${renderStockPanel()}
      <div class="pb-main">
        <div class="pb-phase1">
          <div class="pb-section-label">Select Pallet Type</div>
          <div class="pb-type-grid">
            ${typeCards || '<div style="color:var(--text-muted);font-size:13px;padding:16px 0">No pallet types configured yet.</div>'}
          </div>

          <div class="pb-row" style="margin-top:8px">
            <div class="pb-field">
              <label class="pb-label">Location <span style="opacity:.5;font-weight:400">(optional — required before finishing)</span></label>
              <input class="pb-input" id="pb-location" type="text" maxlength="50"
                placeholder="e.g. WH-A1" autocomplete="off">
            </div>
          </div>

          <div class="pb-actions">
            <button class="btn-secondary" onclick="closePalletBuilder()">Cancel</button>
            <button class="btn-submit" id="pb-create-btn" disabled onclick="createPallet()">
              Create Pallet →
            </button>
          </div>
        </div>
      </div>
    </div>`;
}

function selectPalletType(typeId) {
  pb.palletType     = typeId;
  pb.palletTypeData = pb.allPalletTypes.find(t => t.palletID === typeId);
  document.querySelectorAll('.pb-type-card').forEach(c => c.classList.toggle('selected', c.dataset.id === typeId));
  document.getElementById('pb-create-btn').disabled = false;
}

async function createPallet() {
  if (!pb.palletType) return;
  const td       = pb.palletTypeData;
  const location = document.getElementById('pb-location').value.trim();
  const btn      = document.getElementById('pb-create-btn');

  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    // 1. Create pallet record
    const palRes  = await fetch('/api/palletmain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        palletType:        pb.palletType,
        palletFinish:      0,
        packagingWeight:   Number(td?.palletWeight || 0),  // seed with pallet's own weight
        grossWeight:       0,
        // Seeded from the pallet type's own base dimensions — recalculated
        // properly against the actual stacked height in finishBuilderPallet()
        // (calcPalletVolume()) once packages have been added.
        palletVolume:      calcVolumeFromDims(td?.palletLength, td?.palletWidth, td?.palletHeight),
        palletLength:      td?.palletLength ?? null,
        palletWidth:       td?.palletWidth  ?? null,
        palletHeight:      td?.palletHeight ?? null,
        palletRemoved:     0,
        palletCategory:    null,
        palletLocation:    location || null,
        palletCreationDate: new Date().toISOString(),
        palletFinishDate:  null,
      }),
    });
    const palJson = await palRes.json();
    if (!palRes.ok) throw new Error(palJson.error || 'Failed to create pallet');
    pb.palletId = palJson.palletID;

    // 2. Link to delivery
    const linkRes  = await fetch(`/api/deliverymain/${encodeURIComponent(pb.deliveryId)}/pallets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ palletId: pb.palletId }),
    });
    const linkJson = await linkRes.json();
    if (!linkRes.ok) throw new Error(linkJson.error || 'Failed to link pallet to delivery');

    // 3. Fetch allowed packaging for this pallet type
    const valRes  = await fetch(`/api/palletvalidation/pallet/${encodeURIComponent(pb.palletType)}`);
    const valJson = await valRes.json();
    const rows    = valJson.data || valJson;

    // Validation endpoint returns full PackagingData rows (BIGINT packagingID included)
    pb.allowedPackaging = rows;
    pb.palletLocation   = location;
    pb.packagingWeight  = Number(td?.palletWeight || 0);
    pb.packages  = [];
    pb.nextLayer = 1;
    pb.phase     = 2; // was never set here — left renderStockPanel()'s
                       // showAddBtn (pb.phase === 2) permanently false for a
                       // newly-created pallet, so the found-batch "+" button
                       // never rendered. openPalletBuilderOnExisting() sets
                       // phase:2 upfront, which is why continuing an existing
                       // pallet worked but building a new one didn't.

    renderBuilderPhase2();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Create Pallet →';
    showPbMsg('✕ ' + err.message, 'error');
  }
}

// ── Builder Phase 2: add packages ────────────────────────────────────────────
function renderPackagingGroups() {
  if (!pb.allowedPackaging.length) return '';
  const groups = {};
  pb.allowedPackaging.forEach(p => {
    const mat = p.packMaterial || 'Other';
    if (!groups[mat]) groups[mat] = [];
    groups[mat].push(p);
  });
  return Object.entries(groups).map(([mat, pkgs]) => `
    <div class="pb-pkg-group">
      <div class="pb-pkg-group-label">${esc(mat)}</div>
      <div class="pb-pkg-opts-row">
        ${pkgs.map(p => `
          <label class="pb-pkg-opt">
            <input type="radio" name="pb-pack" value="${esc(p.packagingID)}">
            <span class="pb-pkg-opt-inner">
              <strong>${esc(p.packagingID)}</strong>
              <span>${esc(p.packDescription || '')}</span>
              ${p.packWeight != null ? `<span>${p.packWeight} kg</span>` : ''}
            </span>
          </label>`).join('')}
      </div>
    </div>`).join('');
}

function renderBuilderPhase2() {
  const td       = pb.palletTypeData;
  const label    = td ? `${td.palletID} · ${td.palletDescription || ''}` : `Pallet #${pb.palletId}`;
  const hasPackaging = pb.allowedPackaging.length > 0;
  const locRequired  = !pb.palletLocation;

  document.getElementById('pb-body').innerHTML = `
    <div class="pb-merged">
      ${renderStockPanel()}
      <div class="pb-main">
    <div class="pb-phase2">

      <!-- LEFT: running pallet card -->
      <div class="pb-running">
        <div class="pb-running-title">${esc(label)}</div>
        ${td ? `<div class="pb-running-dims">${[td.palletLength,td.palletWidth,td.palletHeight].filter(Boolean).join('×')} cm · ${td.palletHeight ?? 0} cm base</div>` : ''}
        <div class="pb-running-loc">
          <label class="pb-label" style="margin-bottom:4px">
            Location${locRequired ? ' <span style="color:var(--error)">*</span>' : ''}
          </label>
          <input class="pb-input${locRequired ? ' pb-input--req' : ''}" id="pb-loc-running"
            type="text" maxlength="50" value="${esc(pb.palletLocation)}"
            placeholder="Required to finish">
        </div>
        <div class="pb-running-loc" style="margin-top:8px">
          <label class="pb-label" style="margin-bottom:4px">
            Gross Weight (kg) <span style="color:var(--error)">*</span>
          </label>
          <input class="pb-input" id="pb-gross-weight" type="number"
            step="0.01" min="0.01" placeholder="Enter at finish">
        </div>
        <div class="pb-running-loc" style="margin-top:8px">
          <label class="pb-label" style="margin-bottom:4px">Job Comment</label>
          <input class="pb-input" id="pb-comment" type="text" maxlength="50"
            value="${esc(pb.picksheetComment || '')}" placeholder="Shown on Create Shipment">
        </div>
        ${pbPrinterSelectHtml()}
        <div class="pb-running-weights">
          <span>Pkg weight</span>
          <span id="pb-pkg-weight-display">${Number(pb.packagingWeight).toFixed(2)} kg</span>
        </div>
        <div class="pb-running-count" id="pb-pkg-count">${pb.packages.length} package${pb.packages.length !== 1 ? 's' : ''}</div>
        <div class="pb-running-list" id="pb-running-list">${renderRunningList()}</div>
        <div class="pb-running-actions">
          <button class="btn-secondary pb-bulk-btn" onclick="openBulkEditModal()">Bulk Edit…</button>
          <button class="btn-danger pb-delete-btn" onclick="deletePalletFromBuilder()">Delete</button>
          <button class="btn-submit pb-finish-btn" onclick="finishBuilderPallet()">Finish Pallet ✓</button>
        </div>
      </div>

      <!-- RIGHT: add package form or no-packaging message -->
      ${hasPackaging ? `
      <div class="pb-form">
        <div class="pb-section-label">Packaging Type</div>
        <div class="pb-pkg-groups">${renderPackagingGroups()}</div>

        <!-- Custom dimensions — shown when selected type has no defaults -->
        <div id="pb-custom-dims" style="display:none;margin-top:10px;
          padding:10px 12px;border-radius:8px;
          background:rgba(217,119,6,0.06);border:1px solid rgba(217,119,6,0.25)">
          <div class="pb-section-label" style="color:#D97706;margin-bottom:8px">
            Custom Dimensions (cm) — this box has no defaults
          </div>
          <div class="pb-sap-grid">
            <div class="pb-field pb-field--short">
              <label class="pb-label">Length</label>
              <input class="pb-input" id="pb-dim-l" type="number" step="1" min="1" placeholder="cm">
            </div>
            <div class="pb-field pb-field--short">
              <label class="pb-label">Width</label>
              <input class="pb-input" id="pb-dim-w" type="number" step="1" min="1" placeholder="cm">
            </div>
            <div class="pb-field pb-field--short">
              <label class="pb-label">Height <span style="color:var(--error)">*</span></label>
              <input class="pb-input pb-input--req" id="pb-dim-h" type="number" step="1" min="1"
                placeholder="cm — required">
            </div>
          </div>
        </div>

        <div class="pb-row" style="margin-top:12px">
          <div class="pb-field pb-field--short">
            <label class="pb-label">Pallet Layer</label>
            <input class="pb-input" id="pb-layer" type="number" min="1" step="1" value="${pb.nextLayer}">
          </div>
        </div>

        <div class="pb-row" style="margin-top:8px">
          <div class="pb-field">
            <label class="pb-label">Batch Number <span class="pb-scan-hint">scan / type</span></label>
            <input class="pb-input pb-scan" id="pb-batch" type="text" maxlength="10"
              placeholder="Batch number" autocomplete="off" autocorrect="off" spellcheck="false">
          </div>
        </div>

        <div class="pb-form-actions">
          <span id="pb-pkg-msg" class="pb-pkg-msg"></span>
          <button class="btn-submit" onclick="addPackage()">+ Add Package</button>
        </div>
      </div>
      ` : `
      <div class="pb-no-pkg-panel">
        <div class="pb-no-pkg-msg">
          <div style="font-size:22px;margin-bottom:8px;opacity:.3">📦</div>
          <div style="font-weight:700;margin-bottom:4px">No packaging required</div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:20px">
            This pallet type does not carry packaged items.
          </div>

          <div class="pb-section-label" style="text-align:left">Scan Batch Numbers</div>

          <div class="pb-row" style="margin-top:8px">
            <div class="pb-field pb-field--short">
              <label class="pb-label">Layer</label>
              <input class="pb-input" id="pb-layer" type="number" min="1" step="1" value="${pb.nextLayer}">
            </div>
          </div>

          <div class="pb-row" style="margin-top:8px">
            <div class="pb-field">
              <label class="pb-label">Batch Number <span class="pb-scan-hint">scan / type</span></label>
              <input class="pb-input pb-scan" id="pb-batch" type="text" maxlength="10"
                placeholder="Batch number" autocomplete="off" autocorrect="off" spellcheck="false">
            </div>
          </div>

          <div class="pb-form-actions" style="margin-top:12px">
            <span id="pb-pkg-msg" class="pb-pkg-msg"></span>
            <button class="btn-submit" onclick="addPackage()">+ Add Batch</button>
          </div>
        </div>
      </div>`}

    </div>
      </div>
    </div>`;

  wireBatchScanInput();

  if (hasPackaging) {
    // Show/hide custom dimension inputs when packaging type changes
    document.querySelectorAll('input[name="pb-pack"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const pkg        = pb.allowedPackaging.find(p => p.packagingID === radio.value);
        const needsDims  = pkg && (pkg.packHeight == null || pkg.packLength == null || pkg.packWidth == null);
        const dimsEl     = document.getElementById('pb-custom-dims');
        if (dimsEl) {
          dimsEl.style.display = needsDims ? '' : 'none';
          if (needsDims) {
            // Clear previous values each time a custom-dims type is selected
            ['pb-dim-l','pb-dim-w','pb-dim-h'].forEach(id => {
              const el = document.getElementById(id);
              if (el) el.value = '';
            });
            document.getElementById('pb-dim-l')?.focus();
          }
        }
      });
    });

    document.getElementById('pb-batch').focus();
  }
}

// Layer and packaging type are changed via right-click (see
// showPackageContextMenu) rather than an always-visible control — keeps the
// running list readable, and the "Change Packaging" option only appears
// when it's actually applicable to that row (see eligiblePackagingOptions).
function renderRunningList() {
  if (!pb.packages.length)
    return `<div class="pb-running-empty">No packages added yet</div>`;
  return pb.packages.map(p => {
    // Outer box (SB/MB/LB) rows have no batch/material of their own — they
    // represent the box itself for a PC2007 layer, not a picked item.
    const isContainer = isContainerPackagingId(p.packagingID) && !p.sapBatch;
    return `
    <div class="pb-running-item${isContainer ? ' pb-running-item--container' : ''}"
      oncontextmenu="showPackageContextMenu(event, ${p.palletItemID}); return false;" title="Right-click to edit">
      <span class="pb-running-layer">Layer ${p.palletLayer}</span>
      <span class="pb-running-pack">${esc(p.packagingID || '')}</span>
      ${isContainer
        ? `<span class="pb-running-container-tag">outer box</span>`
        : (p.sapBatch ? `<span class="pb-running-batch">${esc(p.sapBatch)}</span>` : '')}
      <button type="button" class="pb-running-remove" title="Remove this package"
        onclick="removeBuilderPackage(${p.palletItemID})">✕</button>
    </div>`;
  }).join('');
}

// Which packaging types a row can be changed to via the context menu /
// bulk-edit modal. Outer boxes (SB/MB/LB) can only swap between each other;
// everything else can pick from the pallet type's allowed packaging (or the
// full catalogue if none is configured) minus the outer-box types, which
// represent the pallet's own box, not a per-batch packaging choice.
function eligiblePackagingOptions(pkg) {
  const isContainerRow = isContainerPackagingId(pkg.packagingID) && !pkg.sapBatch;
  const source = pb.allowedPackaging.length ? pb.allowedPackaging : pb.allPackaging;
  return isContainerRow
    ? source.filter(p => CONTAINER_PACKAGING_IDS.includes(p.packagingID))
    : source.filter(p => !CONTAINER_PACKAGING_IDS.includes(p.packagingID));
}

// A C2 batch that's part of a PC2007 container layer has its packaging
// structurally fixed — every batch in that layer must be C2 so it fits
// inside the layer's SB/MB/LB outer box (see addPackage()). Changing it
// individually would break that invariant, so it's not offered as editable.
function isPackagingFixed(pkg) {
  return pkg.packagingID === INNER_PACKAGING_ID && !!pkg.sapBatch && !!pb.layerContainers[pkg.palletLayer];
}

// Moves a package to a different layer in place via PATCH — no SAP
// transfer-order reversal/re-stage needed, since only the layer number
// changes. Container-packing rows (SB/MB/LB outer box + the C2 batches
// inside it) have extra rules: a C2 batch can only move into a layer that
// already has its own outer box, and the outer box itself can't move away
// while batches are still sitting in its old layer (that would orphan
// them). Returns { success, error } rather than showing a message itself,
// so both the single-item context-menu flow and the bulk-edit flow can
// report results in whatever way suits them.
async function applyPackageLayerChange(palletItemId, newLayer) {
  const pkg = pb.packages.find(p => p.palletItemID === palletItemId);
  if (!pkg) return { success: false, error: 'Package not found' };
  const oldLayer = pkg.palletLayer;

  if (!Number.isInteger(newLayer) || newLayer < 1) {
    return { success: false, error: 'Layer must be a positive whole number' };
  }
  if (newLayer === oldLayer) return { success: true, error: null };

  const isContainerRow = isContainerPackagingId(pkg.packagingID) && !pkg.sapBatch;
  const isC2Row        = pkg.packagingID === INNER_PACKAGING_ID && !!pkg.sapBatch;

  if (isContainerRow) {
    const stillHasBatches = pb.packages.some(p => p !== pkg && p.palletLayer === oldLayer);
    if (stillHasBatches) {
      return { success: false, error: `Move or remove layer ${oldLayer}'s batches before moving its outer box` };
    }
    if (pb.layerContainers[newLayer] && pb.layerContainers[newLayer] !== pkg.packagingID) {
      return { success: false, error: `Layer ${newLayer} already has an outer box` };
    }
  } else if (isC2Row && !pb.layerContainers[newLayer]) {
    return { success: false, error: `Layer ${newLayer} has no outer box yet — add one first` };
  }

  try {
    const res  = await fetch(`/api/palletpackages/${palletItemId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ palletLayer: newLayer }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'Failed to move package');

    pkg.palletLayer = newLayer;
    if (isContainerRow) {
      delete pb.layerContainers[oldLayer];
      pb.layerContainers[newLayer] = pkg.packagingID;
    }
    document.getElementById('pb-running-list').innerHTML = renderRunningList();
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Changes a package's packaging type in place via PATCH — e.g. a batch
// scanned as the wrong code. Weight/height are tracked locally per package
// (see addPackage()) and summed into pb.packagingWeight / calcPalletHeight(),
// so the old type's weight is swapped out for the new type's here to keep
// those totals correct without a full re-fetch. Same { success, error }
// return shape as applyPackageLayerChange, for the same reason.
async function applyPackagePackagingChange(palletItemId, newPackagingID) {
  const pkg = pb.packages.find(p => p.palletItemID === palletItemId);
  if (!pkg) return { success: false, error: 'Package not found' };
  if (!newPackagingID) return { success: false, error: 'Select a packaging type' };
  if (newPackagingID === pkg.packagingID) return { success: true, error: null };

  if (isPackagingFixed(pkg)) {
    return { success: false, error: 'This batch is packed inside a PC2007 outer box — packaging is fixed to C2' };
  }
  const isContainerRow = isContainerPackagingId(pkg.packagingID) && !pkg.sapBatch;
  if (isContainerRow && !isContainerPackagingId(newPackagingID)) {
    return { success: false, error: `Outer box can only change between ${CONTAINER_PACKAGING_IDS.join('/')}` };
  }

  const newPkg = findPackagingType(newPackagingID);
  if (!newPkg) return { success: false, error: `Packaging type "${newPackagingID}" is not configured` };

  try {
    const res  = await fetch(`/api/palletpackages/${palletItemId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packagingID: newPackagingID }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'Failed to change packaging');

    pb.packagingWeight = Math.max(0, (pb.packagingWeight || 0) - (pkg.packWeight || 0) + Number(newPkg.packWeight || 0));
    pkg.packagingID = newPackagingID;
    pkg.packWeight  = Number(newPkg.packWeight || 0);
    pkg.packHeight  = Number(newPkg.packHeight || 0);
    if (isContainerRow) pb.layerContainers[pkg.palletLayer] = newPackagingID;

    document.getElementById('pb-running-list').innerHTML = renderRunningList();
    const wtEl = document.getElementById('pb-pkg-weight-display');
    if (wtEl) wtEl.textContent = `${Number(pb.packagingWeight).toFixed(2)} kg`;
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Small floating menu on right-click of a running-list card — "Change
// Layer" is always offered; "Change Packaging" only when the row isn't
// packaging-fixed (see isPackagingFixed). Built dynamically (like
// wConfirm/wPrompt) rather than reusing the page's static #ctx-menu, since
// that's a singleton owned by the SAP stock table's own right-click menu.
function closePackageContextMenu() {
  document.getElementById('pb-pkg-ctx-menu')?.remove();
  document.removeEventListener('click', closePackageContextMenu);
}

function showPackageContextMenu(event, palletItemId) {
  event.preventDefault();
  closePackageContextMenu();

  const pkg = pb.packages.find(p => p.palletItemID === palletItemId);
  if (!pkg) return;
  const canChangePackaging = !isPackagingFixed(pkg);

  const menu = document.createElement('div');
  menu.id = 'pb-pkg-ctx-menu';
  menu.className = 'pb-ctx-menu';
  // .pb-ctx-menu is position: fixed (viewport-relative), so it needs
  // clientX/clientY — pageX/pageY are document-relative (include scroll
  // offset) and made the menu drift away from the cursor as soon as the
  // page was scrolled at all.
  menu.style.left = `${Math.min(event.clientX, window.innerWidth  - 210)}px`;
  menu.style.top  = `${Math.min(event.clientY, window.innerHeight - 90)}px`;
  menu.innerHTML = `
    <div class="pb-ctx-item" data-action="layer">Change Layer…</div>
    ${canChangePackaging ? `<div class="pb-ctx-item" data-action="pack">Change Packaging…</div>` : ''}`;
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', closePackageContextMenu), 0);

  menu.querySelector('[data-action="layer"]').addEventListener('click', async () => {
    closePackageContextMenu();
    const val = await wPrompt({ title: 'Change Layer', label: 'New layer number', inputType: 'number', initialValue: pkg.palletLayer });
    if (val == null || val === '') return;
    const r = await applyPackageLayerChange(palletItemId, parseInt(val, 10));
    showPbMsg(r.success ? `✓ Moved to layer ${val}` : '✕ ' + r.error, r.success ? 'ok' : 'error');
  });

  const packBtn = menu.querySelector('[data-action="pack"]');
  if (packBtn) {
    packBtn.addEventListener('click', async () => {
      closePackageContextMenu();
      const options = eligiblePackagingOptions(pkg).map(p => ({ value: p.packagingID, label: `${p.packagingID} — ${p.packDescription || ''}` }));
      const val = await wPrompt({ title: 'Change Packaging', label: 'New packaging type', options, initialValue: pkg.packagingID });
      if (val == null) return;
      const r = await applyPackagePackagingChange(palletItemId, val);
      showPbMsg(r.success ? `✓ Packaging changed to ${val}` : '✕ ' + r.error, r.success ? 'ok' : 'error');
    });
  }
}

// Removes a single package from the pallet while still in the builder —
// e.g. undoing a wrongly-scanned batch — without deleting and rebuilding
// the whole pallet. If the package was staged in SAP, the server reverses
// that transfer order first (routes/palletpackages.js DELETE handler),
// failing closed: a rejected reversal leaves the package in place. On
// success, a staged batch's original stock-list entry (captured when it was
// added — see addPackage()) is put straight back into the "available
// batches" panel so it can be picked again.
async function removeBuilderPackage(palletItemId) {
  const idx = pb.packages.findIndex(p => p.palletItemID === palletItemId);
  if (idx === -1) return;
  const pkg = pb.packages[idx];

  const isContainerRow = isContainerPackagingId(pkg.packagingID) && !pkg.sapBatch;
  if (isContainerRow) {
    const stillHasBatches = pb.packages.some(p => p !== pkg && p.palletLayer === pkg.palletLayer);
    if (stillHasBatches) {
      showPbMsg(`Remove layer ${pkg.palletLayer}'s batches before removing its outer box`, 'error');
      return;
    }
  }

  if (!await wConfirm({
    title: 'Remove Package',
    message: 'Remove this package from the pallet?\nIf it was staged in SAP, the stock will be moved back to its original location.',
    confirmText: 'Remove',
    variant: 'danger',
  })) return;

  try {
    const res  = await fetch(`/api/palletpackages/${palletItemId}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Delete failed');

    pb.packages.splice(idx, 1);
    pb.packagingWeight = Math.max(0, (pb.packagingWeight || 0) - (pkg.packWeight || 0));
    if (isContainerRow) delete pb.layerContainers[pkg.palletLayer];

    // Restoring requiredQty must NOT depend on pkg.originalBatchEntry being
    // set — that field only exists for a package added earlier in THIS
    // builder session (see addPackage()); a package loaded by
    // openPalletBuilderOnExisting() when reopening an existing pallet never
    // has it. Gating the whole block on originalBatchEntry meant removing
    // one of those pre-existing packages silently never gave its quantity
    // back to pb.requiredMaterials — the panel kept showing "still needed"
    // as if the batch were still staged, so re-adding it (or another batch
    // of the same material) immediately after tripped the "exceeds
    // requirement" warning against a required quantity that was wrong, not
    // actually over. originalBatchEntry is still needed to restore the
    // removed batch's row into the visible "available batches" list, but
    // that's now independent of the requiredQty math below.
    if (pkg.sapMaterial) {
      const mat = pb.requiredMaterials.find(m => m.material === pkg.sapMaterial);
      if (mat) {
        if (pkg.originalBatchEntry) {
          mat.batches = (mat.batches || []).filter(b => (b.batch || '') !== pkg.originalBatchEntry.batch);
          mat.batches.push(pkg.originalBatchEntry);
        }
        // Mirror of the decrement in addPackage() — undoing a staged batch
        // means it's no longer covering any of the requirement, so add its
        // quantity back rather than leaving "req." (or a collapsed "done")
        // wrong until the next full refresh.
        const movedQty = Number(pkg.sapQuantity ?? pkg.originalBatchEntry?.totalQty ?? 0);
        mat.requiredQty = Number(mat.requiredQty || 0) + movedQty;
      }
      const stockPanelEl = document.getElementById('pb-stock-panel');
      if (stockPanelEl) stockPanelEl.outerHTML = renderStockPanel();
    }

    document.getElementById('pb-running-list').innerHTML = renderRunningList();
    document.getElementById('pb-pkg-count').textContent =
      `${pb.packages.length} package${pb.packages.length !== 1 ? 's' : ''}`;
    const wtEl = document.getElementById('pb-pkg-weight-display');
    if (wtEl) wtEl.textContent = `${Number(pb.packagingWeight).toFixed(2)} kg`;

    // Update DB packagingWeight in the background
    fetch(`/api/palletmain/${pb.palletId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packagingWeight: pb.packagingWeight }),
    }).catch(() => {});

    showPbMsg('✓ Package removed', 'ok');
  } catch (err) {
    showPbMsg('✕ ' + err.message, 'error');
  }
}

// ── Bulk edit modal ──────────────────────────────────────────────────────────
// A tickbox list of every package on the pallet, with "apply to checked"
// actions for layer and packaging type — for when several batches were
// scanned with the wrong packaging code and fixing them one at a time via
// the right-click menu would be tedious. Reuses applyPackageLayerChange /
// applyPackagePackagingChange per checked item (same validation, same
// container-layer guards), just looped and tallied.
function openBulkEditModal() {
  if (!pb?.packages?.length) return;
  document.getElementById('pb-bulk-modal')?.remove();

  const packOptions = (pb.allowedPackaging.length ? pb.allowedPackaging : pb.allPackaging)
    .filter(p => !CONTAINER_PACKAGING_IDS.includes(p.packagingID));

  const overlay = document.createElement('div');
  overlay.id        = 'pb-bulk-modal';
  overlay.className = 'pb-overlay';
  overlay.innerHTML = `
    <div class="pb-modal" style="max-width:640px">
      <div class="pb-header">
        <div class="pb-title">Bulk Edit Packages</div>
        <button class="pb-close" onclick="closeBulkEditModal()">✕</button>
      </div>
      <div class="pb-body">
        <div class="pb-section-label">Select Packages</div>
        <div class="pb-bulk-list" id="pb-bulk-list">${renderBulkList()}</div>

        <div class="pb-bulk-controls">
          <div class="pb-bulk-row">
            <label class="pb-label">Set layer to</label>
            <input class="pb-input" id="pb-bulk-layer" type="number" min="1" step="1" style="width:80px">
            <button type="button" class="btn-secondary" onclick="applyBulkLayer()">Apply to checked</button>
          </div>
          <div class="pb-bulk-row">
            <label class="pb-label">Set packaging to</label>
            <select class="pb-input" id="pb-bulk-packaging" style="width:220px">
              ${packOptions.map(p => `<option value="${esc(p.packagingID)}">${esc(p.packagingID)} — ${esc(p.packDescription || '')}</option>`).join('')}
            </select>
            <button type="button" class="btn-secondary" onclick="applyBulkPackaging()">Apply to checked</button>
          </div>
        </div>
        <div id="pb-bulk-msg" class="pb-pkg-msg" style="margin-top:8px;display:block"></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

function closeBulkEditModal() {
  document.getElementById('pb-bulk-modal')?.remove();
}

function renderBulkList() {
  return pb.packages.map(p => {
    const isContainer = isContainerPackagingId(p.packagingID) && !p.sapBatch;
    const label = isContainer ? 'outer box' : (p.sapBatch || '—');
    return `<label class="pb-bulk-item">
      <input type="checkbox" class="pb-bulk-check" value="${p.palletItemID}">
      <span class="pb-bulk-layer">L${p.palletLayer}</span>
      <span class="pb-bulk-pack">${esc(p.packagingID || '')}</span>
      <span class="pb-bulk-batch">${esc(label)}</span>
    </label>`;
  }).join('');
}

function getBulkChecked() {
  return Array.from(document.querySelectorAll('#pb-bulk-list .pb-bulk-check:checked'))
    .map(el => parseInt(el.value, 10));
}

function showBulkMsg(text, type) {
  const el = document.getElementById('pb-bulk-msg');
  if (!el) return;
  el.textContent = text;
  el.className = `pb-pkg-msg${type ? ' pb-pkg-msg--' + type : ''}`;
}

async function applyBulkLayer() {
  const ids      = getBulkChecked();
  const newLayer = parseInt(document.getElementById('pb-bulk-layer').value, 10);
  if (!ids.length) { showBulkMsg('Select at least one package', 'error'); return; }
  if (!Number.isInteger(newLayer) || newLayer < 1) { showBulkMsg('Enter a valid layer number', 'error'); return; }

  let ok = 0, fail = 0, firstError = null;
  for (const id of ids) {
    const r = await applyPackageLayerChange(id, newLayer);
    if (r.success) ok++; else { fail++; firstError = firstError || r.error; }
  }
  document.getElementById('pb-bulk-list').innerHTML = renderBulkList();
  const wtEl = document.getElementById('pb-pkg-weight-display');
  if (wtEl) wtEl.textContent = `${Number(pb.packagingWeight).toFixed(2)} kg`;
  document.getElementById('pb-pkg-count').textContent =
    `${pb.packages.length} package${pb.packages.length !== 1 ? 's' : ''}`;
  showBulkMsg(
    `${ok} moved to layer ${newLayer}${fail ? `, ${fail} failed (${firstError})` : ''}`,
    fail ? 'error' : 'ok'
  );
}

async function applyBulkPackaging() {
  const ids            = getBulkChecked();
  const newPackagingID = document.getElementById('pb-bulk-packaging').value;
  if (!ids.length) { showBulkMsg('Select at least one package', 'error'); return; }

  let ok = 0, fail = 0, skipped = 0, firstError = null;
  for (const id of ids) {
    const pkg = pb.packages.find(p => p.palletItemID === id);
    if (!pkg) continue;
    if (isPackagingFixed(pkg) || (isContainerPackagingId(pkg.packagingID) && !pkg.sapBatch)) { skipped++; continue; }
    const r = await applyPackagePackagingChange(id, newPackagingID);
    if (r.success) ok++; else { fail++; firstError = firstError || r.error; }
  }
  document.getElementById('pb-bulk-list').innerHTML = renderBulkList();
  const wtEl = document.getElementById('pb-pkg-weight-display');
  if (wtEl) wtEl.textContent = `${Number(pb.packagingWeight).toFixed(2)} kg`;
  showBulkMsg(
    `${ok} changed to ${newPackagingID}${skipped ? `, ${skipped} skipped (fixed/outer-box)` : ''}${fail ? `, ${fail} failed (${firstError})` : ''}`,
    fail ? 'error' : 'ok'
  );
}

function calcPalletHeight() {
  const baseH = Number(pb.palletTypeData?.palletHeight || 0);
  const layerMax = {};
  for (const p of pb.packages) {
    const layer = p.palletLayer || 1;
    const h = Number(p.packHeight || 0);
    if (h > (layerMax[layer] || 0)) layerMax[layer] = h;
  }
  return baseH + Object.values(layerMax).reduce((s, h) => s + h, 0);
}

// cm³ → m³, matching the convention used elsewhere for volume from L/W/H
// (e.g. shipmentmain.js's ManualCargoItem volume calc). Returns 0 rather
// than NaN/null when a dimension is missing, since palletVolume is a
// required NOT NULL-ish decimal column downstream.
function calcVolumeFromDims(length, width, height) {
  const l = Number(length || 0), w = Number(width || 0), h = Number(height || 0);
  return (l && w && h) ? Number(((l * w * h) / 1000000).toFixed(3)) : 0;
}

// Pallet footprint (length/width) is fixed from the pallet type at creation
// and never changes; only the stacked height grows as packages are added —
// so the pallet's actual volume, unlike its weight, can only be known once
// finishBuilderPallet() has the final calcPalletHeight() result.
function calcPalletVolume(height) {
  return calcVolumeFromDims(pb.palletTypeData?.palletLength, pb.palletTypeData?.palletWidth, height ?? calcPalletHeight());
}

// Looks a packaging type up first in this pallet type's allowed list, then
// falls back to the full packaging catalogue — SB/MB/LB/C2 (see
// CONTAINER_PACKAGING_IDS/INNER_PACKAGING_ID above) need to resolve correctly
// for the container-packing flow even if a given pallet type's PalletValidation
// rows haven't been set up to include them explicitly.
function findPackagingType(packagingID) {
  if (!packagingID) return null;
  return pb.allowedPackaging.find(p => p.packagingID === packagingID)
      || pb.allPackaging.find(p => p.packagingID === packagingID)
      || null;
}

async function addPackage() {
  const packInput  = document.querySelector('input[name="pb-pack"]:checked');
  const packType   = packInput?.value || null;
  const hasPackaging = pb.allowedPackaging.length > 0;

  const layer = parseInt(document.getElementById('pb-layer').value, 10) || pb.nextLayer;
  const batch = document.getElementById('pb-batch').value.trim();

  // Guard against adding the same batch twice — whether it's a leftover
  // stale entry in the "available batches" list (fixed below by pruning
  // that list as soon as a batch is added) or the operator/scanner sending
  // the same barcode a second time. SAP itself tolerates a repeat stage
  // (it just re-moves whatever's already sitting in the bin), but it would
  // create a duplicate PalletPackages row and double-count weight.
  if (batch && pb.packages.some(p => (p.sapBatch || '').toUpperCase() === batch.toUpperCase())) {
    showPbMsg(`Batch ${batch} has already been added to this pallet`, 'error');
    return;
  }

  // Staging always moves this batch's full on-hand quantity — SAP doesn't
  // split a batch across a partial stage. If that's more than what's still
  // required for this material, the delivery would go over what SAP has on
  // order for it. That's not necessarily wrong (over-picking happens), but
  // it usually means the order quantity changed and VL02N hasn't been
  // updated to match yet, so flag it and let the operator decide rather than
  // silently taking the requirement negative.
  if (pb.pendingSapMaterial && batch) {
    const reqMat = pb.requiredMaterials.find(m => m.material === pb.pendingSapMaterial);
    const pendingQty = Number(pb.pendingSapQuantity || 0);
    const stillNeeded = Number(reqMat?.requiredQty || 0);
    if (reqMat && pendingQty > stillNeeded) {
      const proceed = await wConfirm({
        title: 'Quantity exceeds requirement',
        message: `Batch ${batch} (${pendingQty} units) is more than the ${stillNeeded} unit${stillNeeded === 1 ? '' : 's'} still needed for ${reqMat.material}.\n\nIf the order quantity has changed, update it in VL02N before continuing. Otherwise, adding this batch will take the requirement below zero.`,
        confirmText: 'Add Anyway',
        variant: 'danger',
      });
      if (!proceed) { showPbMsg('Add cancelled', ''); return; }
    }
  }

  // Profit centre 2007 materials: the operator still picks the outer box
  // size (SB/MB/LB) via the normal packaging picker, but only once per
  // layer — for the FIRST batch added to a layer. Every batch after that
  // in the same layer auto-switches to C2, bypassing the picker entirely.
  const isContainerMaterial = !!pb.pendingSapMaterial && materialUsesContainerPacking(pb.pendingSapMaterial);
  const existingContainer   = pb.layerContainers[layer] || null;
  const needsContainer      = isContainerMaterial && !existingContainer;

  if (needsContainer && !isContainerPackagingId(packType)) {
    showPbMsg(`Select the outer box size (${CONTAINER_PACKAGING_IDS.join('/')}) for this layer first`, 'error');
    return;
  }
  if (!isContainerMaterial && hasPackaging && !packType) {
    showPbMsg('Select a packaging type first', 'error'); return;
  }

  const chosenContainerType  = needsContainer ? packType : existingContainer;
  const effectivePackagingID = isContainerMaterial ? INNER_PACKAGING_ID : packType;
  const selectedPkg          = findPackagingType(effectivePackagingID);
  if (isContainerMaterial && !selectedPkg) {
    showPbMsg(`Packaging type "${INNER_PACKAGING_ID}" is not configured — cannot add this batch`, 'error');
    return;
  }
  const packWeight = Number(selectedPkg?.packWeight || 0);

  // Use entered dimensions when the selected type has no defaults — not
  // applicable to the auto-determined container flow, C2/SB/MB/LB are
  // expected to already have their dimensions configured in PackagingData.
  const dimsEl        = document.getElementById('pb-custom-dims');
  const usingCustom   = !isContainerMaterial && dimsEl && dimsEl.style.display !== 'none';
  let packHeight = Number(selectedPkg?.packHeight || 0);
  if (usingCustom) {
    const enteredH = parseFloat(document.getElementById('pb-dim-h')?.value) || 0;
    if (!enteredH) {
      document.getElementById('pb-dim-h')?.classList.add('pb-input--error');
      document.getElementById('pb-dim-h')?.focus();
      showPbMsg('Enter the box height (required for height calculation)', 'error');
      return;
    }
    packHeight = enteredH;
  }

  showPbMsg('Adding…', '');

  let stagedQuantity      = null;
  let transferOrderNumber = null;
  let binWasCreated       = false;
  let sourceStorageType   = null;
  let sourceBin           = null;

  try {
    // First batch of a PC2007 material added to a layer — create the outer
    // box (whichever of SB/MB/LB the operator picked) for that layer before
    // anything else. No material/batch/quantity on this row; it represents
    // the box itself, not a SAP batch, so it's never staged in SAP. Counted
    // once per layer (not once per batch), which is also what keeps
    // pb.packagingWeight correct — each C2 batch below only adds its own
    // weight on top of this.
    if (needsContainer) {
      const containerPkg = findPackagingType(chosenContainerType);
      if (!containerPkg) {
        throw new Error(`Packaging type "${chosenContainerType}" is not configured — cannot create the outer box`);
      }
      showPbMsg(`Creating ${chosenContainerType} box for layer ${layer}…`, '');
      const boxRes  = await fetch('/api/palletpackages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          palletID:    pb.palletId,
          packagingID: chosenContainerType,
          palletLayer: layer,
          sapDelivery: String(pb.deliveryId),
          sapCustomer: pb.customerId ? String(pb.customerId) : null,
          scanTime:    new Date().toISOString(),
        }),
      });
      const boxJson = await boxRes.json();
      if (!boxRes.ok) throw new Error(boxJson.error || `Failed to create ${chosenContainerType} box`);

      pb.packages.push({
        palletItemID: boxJson.palletItemID,
        palletLayer:  layer,
        packagingID:  chosenContainerType,
        sapBatch:     null,
        sapMaterial:  null,
        originalBatchEntry: null,
        packHeight:   Number(containerPkg.packHeight || 0),
        packWeight:   Number(containerPkg.packWeight || 0),
      });
      pb.packagingWeight     = (pb.packagingWeight || 0) + Number(containerPkg.packWeight || 0);
      pb.layerContainers[layer] = chosenContainerType;
    }

    // Stage the batch in SAP first — moves its full on-hand quantity into
    // this picksheet's bin (delivery number, zero-padded to 10 digits,
    // storage type 916), creating the bin first if SAP doesn't have it yet.
    // Deliberately fails closed: only a batch matched against a SAP material
    // (via the "+" button or a scan match against the found-batches list)
    // gets staged; if the SAP call fails, we throw here and never reach the
    // /api/palletpackages POST below — an app-side "added" package that was
    // never actually moved in SAP is exactly the mismatch this bin is meant
    // to prevent.
    if (pb.pendingSapMaterial && batch) {
      showPbMsg('Staging in SAP…', '');
      const stageRes  = await fetch(`/api/deliverymain/${encodeURIComponent(pb.deliveryId)}/stage-batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ material: pb.pendingSapMaterial, batch }),
      });
      const stageJson = await stageRes.json();
      if (!stageRes.ok || !stageJson.success) {
        throw new Error(stageJson.error || 'SAP staging failed — package was not added');
      }
      stagedQuantity      = stageJson.data?.quantityMoved ?? null;
      transferOrderNumber = stageJson.data?.transferOrderNumber ?? null;
      binWasCreated        = !!stageJson.data?.binWasCreated;
      // Recorded so the transfer order can be reversed automatically if this
      // package is later removed from the pallet (see removePackage()).
      sourceStorageType    = stageJson.data?.sourceType || null;
      sourceBin             = stageJson.data?.sourceBin || null;
      showPbMsg('Adding…', '');
    }

    const res  = await fetch('/api/palletpackages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        palletID:    pb.palletId,
        packagingID: effectivePackagingID || null,
        palletLayer: layer,
        sapBatch:    batch || null,
        sapDelivery: String(pb.deliveryId),
        sapCustomer: pb.customerId ? String(pb.customerId) : null,
        sapMaterial:     pb.pendingSapMaterial || null,
        sapDeliveryItem: pb.pendingSapDeliveryItem || null,
        sapQuantity:     stagedQuantity,
        sapSourceStorageType: sourceStorageType,
        sapSourceBin:         sourceBin,
        sapStageTransferOrder: transferOrderNumber,
        sapPackagingInstruction: pb.pendingSapMaterial ? (pb.pendingPackagingInstruction || null) : null,
        scanTime:    new Date().toISOString(),
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to add package');

    // Remove the just-added batch from the "available batches" list —
    // staging moves its full on-hand quantity into this picksheet's bin, so
    // nothing of it is left to offer, and leaving the stale entry on screen
    // is exactly what let the same batch be added (and staged) twice. The
    // removed entry is kept on the package record so removeBuilderPackage()
    // can put it straight back if the operator undoes this add (e.g. a
    // wrongly-scanned batch), without a full re-fetch from SAP.
    let removedBatchEntry = null;
    // How much this batch actually reduces the requirement by — prefer the
    // real staged amount SAP moved, falling back to what the batch was
    // listed as if that response field is ever missing. Stored on the
    // package record too so removeBuilderPackage() can add it straight back
    // if the operator undoes this add, without needing a full re-fetch.
    let movedQty = 0;
    if (pb.pendingSapMaterial && batch) {
      const mat = pb.requiredMaterials.find(m => m.material === pb.pendingSapMaterial);
      if (mat) {
        const idx = (mat.batches || []).findIndex(b => (b.batch || '') === batch);
        if (idx !== -1) { removedBatchEntry = mat.batches[idx]; mat.batches.splice(idx, 1); }

        movedQty = Number(stagedQuantity ?? removedBatchEntry?.totalQty ?? pb.pendingSapQuantity ?? 0);
        // Floored at 0 so over-picking (see the VL02N warning above) shows
        // "done" rather than a negative "req." figure.
        mat.requiredQty = Math.max(0, Number(mat.requiredQty || 0) - movedQty);
      }
    }

    pb.packages.push({
      palletItemID: json.palletItemID,
      palletLayer:  layer,
      packagingID:  effectivePackagingID,
      sapBatch:     batch,
      sapMaterial:  pb.pendingSapMaterial || null,
      sapQuantity:  movedQty || null,
      originalBatchEntry: removedBatchEntry,
      packHeight,
      packWeight,
    });
    // Print the batch-scan confirmation label — only once the batch has
    // actually been staged/TO'd in SAP (transferOrderNumber set above), not
    // for a manually-typed batch that never matched a found SAP batch —
    // there's nothing to visually confirm as "assigned to this picksheet"
    // if nothing was actually assigned. Fire-and-forget: see
    // printBatchScanLabel's own comment for why a failed print here must
    // never interrupt the scan-and-add flow.
    if (transferOrderNumber) printBatchScanLabel(json.palletItemID);

    // Container-packing layers (SB/MB/LB outer box + a run of C2 batches)
    // are meant to keep collecting batches into the SAME layer until the
    // operator explicitly types a new layer number — auto-incrementing
    // here defaulted the layer field forward after every single batch,
    // forcing a manual re-type back for every batch after the first.
    // Normal (non-container) materials keep the existing sequential
    // default, one layer per batch.
    pb.nextLayer       = isContainerMaterial ? layer : layer + 1;
    pb.packagingWeight = (pb.packagingWeight || 0) + packWeight;

    const stockPanelEl = document.getElementById('pb-stock-panel');
    if (stockPanelEl) stockPanelEl.outerHTML = renderStockPanel();

    // Update DB packagingWeight in the background
    fetch(`/api/palletmain/${pb.palletId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packagingWeight: pb.packagingWeight }),
    }).catch(() => {});

    document.getElementById('pb-running-list').innerHTML = renderRunningList();
    document.getElementById('pb-pkg-count').textContent =
      `${pb.packages.length} package${pb.packages.length !== 1 ? 's' : ''}`;
    const wtEl = document.getElementById('pb-pkg-weight-display');
    if (wtEl) wtEl.textContent = `${Number(pb.packagingWeight).toFixed(2)} kg`;

    document.getElementById('pb-batch').value = '';
    document.getElementById('pb-layer').value = pb.nextLayer;
    pb.pendingSapMaterial     = null;
    pb.pendingSapDeliveryItem = null;
    pb.pendingSapQuantity     = null;
    pb.pendingPackagingInstruction = null;
    if (usingCustom) {
      ['pb-dim-l','pb-dim-w','pb-dim-h'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.value = ''; el.classList.remove('pb-input--error'); }
      });
    }

    const toNote        = transferOrderNumber ? ` · TO ${transferOrderNumber}${binWasCreated ? ' (bin created)' : ''}` : '';
    const containerNote = needsContainer ? ` · ${chosenContainerType} box created` : '';
    showPbMsg(`✓ Added (layer ${layer}, ${effectivePackagingID || 'no packaging'})${containerNote}${toNote}`, 'ok');
    document.getElementById('pb-batch')?.focus();
  } catch (err) {
    showPbMsg('✕ ' + err.message, 'error');
  }
}

function showPbMsg(text, type) {
  const el = document.getElementById('pb-pkg-msg');
  if (!el) return;
  el.textContent = text;
  el.className = `pb-pkg-msg${type ? ' pb-pkg-msg--' + type : ''}`;
  if (type === 'ok') setTimeout(() => { if (el) el.textContent = ''; }, 3000);
}

async function finishBuilderPallet() {
  if (!pb?.palletId) return;

  // Location is mandatory to finish
  const locInput = document.getElementById('pb-loc-running');
  const loc = locInput?.value.trim() || pb.palletLocation || '';
  if (!loc) {
    if (locInput) { locInput.classList.add('pb-input--error'); locInput.focus(); }
    showPbMsg('Location is required before finishing', 'error');
    return;
  }

  // Gross weight — mandatory, entered by operator
  const grossInput  = document.getElementById('pb-gross-weight');
  const grossWeight = parseFloat(grossInput?.value) || 0;
  if (!grossWeight || grossWeight <= 0) {
    if (grossInput) { grossInput.classList.add('pb-input--error'); grossInput.focus(); }
    showPbMsg('Gross weight is required before finishing', 'error');
    return;
  }

  const height = calcPalletHeight();
  const volume = calcPalletVolume(height);

  // Job comment — log.DeliveryMain.picksheetComment, not a pallet field
  // (a delivery/picksheet can have several pallets; the comment is about
  // the job as a whole, not any one of them), so it's saved via its own
  // PATCH rather than folded into the pallet's own PATCH below. Only sent
  // when it actually changed, so finishing a pallet without touching this
  // field never overwrites a comment set from elsewhere (e.g. the Add
  // Picksheet form, or another pallet's Finish step) with a stale copy.
  const commentInput = document.getElementById('pb-comment');
  const comment       = commentInput ? commentInput.value.trim() : pb.picksheetComment;
  const commentChanged = comment !== (pb.picksheetComment || '');
  const deliveryId     = pb.deliveryId;

  try {
    const res  = await fetch(`/api/palletmain/${pb.palletId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        palletFinish: 1, palletLocation: loc,
        palletHeight: height, grossWeight, palletVolume: volume,
      }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Update failed');

    if (commentChanged) {
      fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/comment`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ picksheetComment: comment }),
      }).catch(() => {});
    }

    // Print the pallet finish manifest — captured before closePalletBuilder()
    // nulls out pb. Fired after the builder closes (finishing the pallet is
    // the state change that matters; a printer being offline shouldn't trap
    // the operator in the builder) but still surfaced if it fails, via a
    // dismissible dialog rather than silently.
    const finishedPalletId = pb.palletId;
    const printerId        = pb.printerId;
    closePalletBuilder();
    if (printerId) {
      sendLabelPrint(`/pallet/finish/${finishedPalletId}/print`, printerId).catch(err => {
        wConfirm({
          title: 'Pallet Finished — Label Not Printed',
          message: `The pallet was finished, but its finish label failed to print:\n${err.message}`,
          confirmText: 'OK', variant: '',
        });
      });
    }
    await refreshPalletList();
  } catch (err) { showPbMsg('✕ ' + err.message, 'error'); }
}

async function deletePalletFromBuilder() {
  if (!pb?.palletId) return;
  if (!await wConfirm({
    title: 'Delete Pallet',
    message: 'Delete this pallet and all its packages?\nAny stock staged in SAP will be moved back to its original location first.\nThis cannot be undone.',
    confirmText: 'Delete',
    variant: 'danger',
  })) return;
  try {
    const res  = await fetch(`/api/palletmain/${pb.palletId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ palletRemoved: 1 }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(formatReversalError(json));
    closePalletBuilder();
    await refreshPalletList();
  } catch (err) { showPbMsg('✕ ' + err.message, 'error'); }
}

async function completeDelivery() {
  const { deliveryId, fromHolding } = _palletListCtx || {};
  if (!deliveryId) return;
  if (!await wConfirm({
    title: fromHolding ? 'Confirm Packaging' : 'Complete Delivery',
    message: fromHolding
      ? `Confirm packaging data for Delivery #${deliveryId}?\nThis will move it out of Picksheets on Hold and make it available for shipment creation. SAP already has this delivery marked complete, so no ZDEL/ZDELFLAG updates are sent.`
      : `Mark Delivery #${deliveryId} as complete?\nThis will remove it from the open picksheets list.`,
    confirmText: fromHolding ? 'Confirm' : 'Complete',
    variant: 'success',
  })) return;
  try {
    const res  = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/complete`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    });
    const json = await res.json();
    // Blocked — this picksheet (or, for a linked group, one of its linked
    // siblings) still has materials outstanding. See routes/deliverymain.js's
    // PATCH /:deliveryId/complete precondition.
    if (res.status === 409 && Array.isArray(json.outstanding)) {
      const detail = json.outstanding.map(o =>
        `Delivery #${o.deliveryId}: ${o.materials.map(m => `${m.material} (${m.requiredQty} outstanding)`).join(', ')}`
      ).join('\n');
      throw new Error(`${json.error}\n\n${detail}`);
    }
    if (!json.success) throw new Error(json.error || 'Update failed');
    closePickModal();
    if (fromHolding) { await runPackagingHolding(); } else { await runOpenPicksheets(); }
    pollPackagingHoldingCount();
    // sapWarning (ZDEL weight push) and goodsIssueWarning (automatic Goods
    // Issue posting, fired right after ZDELFLAG/ZDELPACK maintenance
    // succeeds) are both best-effort SAP steps that never block completion
    // itself — combined into one dialog rather than firing two independent
    // wConfirm calls back-to-back.
    const warningParts = [];
    if (json.data?.sapWarning) warningParts.push(json.data.sapWarning);
    if (json.data?.goodsIssueWarning) warningParts.push(`Goods Issue: ${json.data.goodsIssueWarning}`);

    // linkedResults is only present when this delivery was part of a linked
    // group — every member got completed in the same request (see the
    // backend route), so worth calling out since the rest of this dialog
    // only ever talks about the one delivery the operator clicked. Kept as
    // its own dialog (not folded into warningParts above) so it doesn't
    // misleadingly borrow the "SAP Not Updated" title on a run that had no
    // actual SAP problem.
    if (json.data?.linkedResults) {
      const others = Object.keys(json.data.linkedResults).filter(id => String(id) !== String(deliveryId));
      if (others.length && !warningParts.length) {
        wConfirm({
          title: 'Delivery Complete',
          message: `Also completed ${others.length} linked picksheet${others.length !== 1 ? 's' : ''}: ${others.map(id => `#${id}`).join(', ')}.`,
          confirmText: 'OK', variant: '',
        });
      } else if (others.length) {
        warningParts.unshift(`Also completed ${others.length} linked picksheet${others.length !== 1 ? 's' : ''}: ${others.map(id => `#${id}`).join(', ')}.`);
      }
    }
    if (warningParts.length) {
      wConfirm({ title: 'Delivery Complete — SAP Not Updated', message: warningParts.join('\n\n'), confirmText: 'OK', variant: '' });
    }
  } catch (err) { wConfirm({ title: 'Error', message: err.message, confirmText: 'OK', variant: '' }); }
}

function closePalletBuilder() {
  const overlay = document.getElementById('pb-overlay');
  if (overlay) overlay.classList.add('hidden');
  pb = null;
}

// ── Supervisor section ────────────────────────────────────────────────────────
function setupSupervisorSection() {
  if (sessionPermissions.includes('LOG_SUPER')) {
    document.getElementById('supervisor-section').classList.remove('hidden');
  }
}

// ── Add Picksheet form ────────────────────────────────────────────────────────
async function showAddPicksheetForm() {
  if (!await checkSession()) return;
  showResultPanel('Add Picksheet', 'Loading customers and services…');

  try {
    const [destRes, fwdRes] = await Promise.all([
      fetch('/api/destinations').then(r => r.json()),
      fetch('/api/forwarders/modes').then(r => r.json()),
    ]);

    const destinations = Array.isArray(destRes) ? destRes : [];
    const modes        = Array.isArray(fwdRes)  ? fwdRes  : [];

    destinations.sort((a, b) => (a.destinationName ?? '').localeCompare(b.destinationName ?? ''));

    // Keyed by destinationID for fast lookup in the change handler
    const destById = Object.fromEntries(destinations.map(d => [String(d.destinationID), d]));

    const destOptions = destinations.map(d =>
      `<option value="${esc(String(d.destinationID))}">${esc(d.destinationName)}</option>`
    ).join('');

    const fwdOptions = modes.map(f =>
      `<option value="${esc(f.forwarderMode)}">${esc(f.forwarderMode)}</option>`
    ).join('');

    document.getElementById('result-hint').textContent = 'Create a new delivery picksheet';
    document.getElementById('result-body').innerHTML = `
      <form class="transfer-form" id="ps-form" onsubmit="submitAddPicksheet(event)">

        <div class="tf-section-label">Delivery Details</div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">SAP Delivery No. <span class="tf-req">*</span></label>
            <input class="tf-input" id="ps-delivery-id" type="text" inputmode="numeric"
              pattern="[0-9]+" placeholder="e.g. 1234567890" required>
          </div>
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Customer <span class="tf-req">*</span></label>
            <select class="tf-input" id="ps-customer" required>
              <option value="">— Select customer —</option>
              ${destOptions}
            </select>
          </div>
          <div class="tf-field">
            <label class="tf-label">Due Date <span class="tf-req">*</span></label>
            <input class="tf-input" id="ps-due-date" type="date" required>
          </div>
        </div>

        <div class="tf-section-label">Shipping <span class="tf-optional">(optional)</span></div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Delivery Service</label>
            <select class="tf-input" id="ps-service">
              <option value="">— None —</option>
              ${fwdOptions}
            </select>
          </div>
          <div class="tf-field" style="display:flex;flex-direction:column;justify-content:flex-end;padding-bottom:4px">
            <label class="tf-label">Priority</label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;color:var(--text)">
              <input type="checkbox" id="ps-priority" style="width:16px;height:16px;cursor:pointer">
              Mark as Priority
            </label>
          </div>
        </div>

        <div class="tf-section-label">Notes <span class="tf-optional">(optional)</span></div>
        <div class="tf-row">
          <div class="tf-field" style="flex:1">
            <label class="tf-label">Comment</label>
            <textarea class="tf-input" id="ps-comment" rows="2"
              placeholder="Any picking instructions or notes…" style="resize:vertical"></textarea>
          </div>
        </div>

        <div class="tf-actions">
          <div id="ps-result"></div>
          <button type="submit" class="btn-submit" id="ps-submit">Add Picksheet</button>
        </div>
      </form>`;

    document.getElementById('ps-customer').addEventListener('change', function () {
      const dest    = destById[this.value];
      const svcSel  = document.getElementById('ps-service');
      const defSvc  = dest?.defaultDeliveryService ?? '';
      svcSel.value  = defSvc;
    });

  } catch (err) {
    document.getElementById('result-body').innerHTML =
      `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

async function submitAddPicksheet(e) {
  e.preventDefault();
  if (!await checkSession()) return;

  const deliveryID      = document.getElementById('ps-delivery-id').value.trim();
  const customerID      = document.getElementById('ps-customer').value;
  const dispatchDate    = document.getElementById('ps-due-date').value;
  const deliveryService = document.getElementById('ps-service').value || null;
  const deliveryPriority= document.getElementById('ps-priority').checked ? 1 : 0;
  const picksheetComment= document.getElementById('ps-comment').value.trim() || null;

  const submitBtn = document.getElementById('ps-submit');
  const resultEl  = document.getElementById('ps-result');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';
  resultEl.innerHTML = '';

  try {
    const res  = await fetch('/api/deliverymain/', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deliveryID:      parseInt(deliveryID, 10),
        customerID:      parseInt(customerID, 10),
        dispatchDate,
        deliveryService,
        deliveryPriority,
        picksheetComment,
        completionStatus: 0,
        deliveryCancelled: 0,
      }),
    });
    const json = await res.json();

    if (!json.success) throw new Error(json.error || 'Failed to create picksheet');

    resultEl.innerHTML = `
      <div class="tf-success">
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9
             10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
          clip-rule="evenodd"/></svg>
        <div>
          <div class="tf-success-title">Picksheet Created</div>
          <div class="tf-success-to">Delivery ${esc(deliveryID)} added to open picksheets</div>
        </div>
      </div>`;
    document.getElementById('ps-form').reset();
  } catch (err) {
    resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ ${esc(err.message)}</div>`;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Add Picksheet';
  }
}

// ── CSV Bulk Import ───────────────────────────────────────────────────────────
function showCSVUpload() {
  if (activeDT) { try { activeDT.destroy(); } catch (_) {} activeDT = null; }
  document.getElementById('tile-section').classList.add('hidden');
  document.getElementById('result-section').classList.remove('hidden');
  document.getElementById('result-title').textContent = 'Bulk CSV Import';
  document.getElementById('result-hint').textContent  = 'Upload picksheets in bulk from a CSV file';
  document.getElementById('result-row-badge').classList.add('hidden');
  document.getElementById('btn-export-csv').classList.add('hidden');

  pendingCSVRecords = [];

  document.getElementById('result-body').innerHTML = `
    <div class="transfer-form">
      <div class="tf-section-label">Expected Format</div>
      <div style="margin-bottom:16px">
        <code style="display:block;background:var(--surface2,#1e1e2e);border:1px solid var(--border,#333);
          border-radius:6px;padding:10px 14px;font-size:13px;color:var(--text-muted,#aaa);line-height:1.6">
          deliveryID,customerID,dispatchDate,deliveryService,deliveryPriority,picksheetComment<br>
          1234567890,5000,2026-05-20,DHL,0,Rush order
        </code>
        <button type="button" onclick="downloadCSVTemplate()"
          style="margin-top:8px;background:none;border:none;color:var(--accent,#7c3aed);
            cursor:pointer;font-size:13px;text-decoration:underline;padding:0">
          Download blank template
        </button>
      </div>

      <div class="tf-section-label">Select File</div>
      <div id="csv-drop-zone" style="border:2px dashed var(--border,#444);border-radius:8px;
        padding:32px;text-align:center;cursor:pointer;color:var(--text-muted,#888);
        transition:border-color .2s"
        onclick="document.getElementById('csv-file-input').click()"
        ondragover="event.preventDefault();this.style.borderColor='var(--accent,#7c3aed)'"
        ondragleave="this.style.borderColor=''"
        ondrop="handleCSVDrop(event)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
          stroke-linecap="round" stroke-linejoin="round"
          style="width:36px;height:36px;margin:0 auto 8px;display:block">
          <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
          <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/>
        </svg>
        Drop CSV here or click to browse
        <input type="file" id="csv-file-input" accept=".csv,.txt"
          style="display:none" onchange="handleCSVFile(this)">
      </div>

      <div id="csv-preview" style="margin-top:20px"></div>
    </div>`;
}

function downloadCSVTemplate() {
  const csv = 'deliveryID,customerID,dispatchDate,deliveryService,deliveryPriority,picksheetComment\r\n1234567890,5000,2026-05-20,DHL,0,Sample comment\r\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'picksheet-template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function handleCSVDrop(e) {
  e.preventDefault();
  document.getElementById('csv-drop-zone').style.borderColor = '';
  const file = e.dataTransfer?.files?.[0];
  if (file) parseCSVFile(file);
}

function handleCSVFile(input) {
  const file = input.files?.[0];
  if (file) parseCSVFile(file);
  input.value = '';
}

function parseCSVFile(file) {
  const reader = new FileReader();
  reader.onload = e => renderCSVPreview(e.target.result);
  reader.readAsText(file);
}

function parseCSVLine(line, delimiter = ',') {
  // Basic CSV parser — handles quoted fields
  const fields = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === delimiter && !inQuote) {
      fields.push(cur.trim()); cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}

// Excel on machines set to a comma-decimal locale (e.g. UK/EU regional
// settings some users have) exports "CSV" with ';' as the field separator
// instead of ','. Pick whichever delimiter is more common in the header row.
function detectCSVDelimiter(headerLine) {
  const commas = (headerLine.match(/,/g) || []).length;
  const semicolons = (headerLine.match(/;/g) || []).length;
  return semicolons > commas ? ';' : ',';
}

function renderCSVPreview(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    document.getElementById('csv-preview').innerHTML =
      '<div class="sap-error">✕ File must have a header row and at least one data row</div>';
    return;
  }

  const delimiter = detectCSVDelimiter(lines[0]);
  const EXPECTED_HEADERS = ['deliveryID','customerID','dispatchDate','deliveryService','deliveryPriority','picksheetComment'];
  const headers = parseCSVLine(lines[0], delimiter).map(h => h.toLowerCase().replace(/\s/g, ''));
  const missing = EXPECTED_HEADERS.filter(h => !headers.includes(h));
  if (missing.length) {
    document.getElementById('csv-preview').innerHTML =
      `<div class="sap-error">✕ Missing columns: ${esc(missing.join(', '))}</div>`;
    return;
  }

  const idx = {};
  EXPECTED_HEADERS.forEach(h => { idx[h] = headers.indexOf(h); });

  const records = [], rowErrors = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i], delimiter);
    const raw  = {
      deliveryID:       cols[idx.deliveryID]       ?? '',
      customerID:       cols[idx.customerID]        ?? '',
      dispatchDate:     cols[idx.dispatchDate]       ?? '',
      deliveryService:  cols[idx.deliveryService]   ?? '',
      deliveryPriority: cols[idx.deliveryPriority]  ?? '0',
      picksheetComment: cols[idx.picksheetComment]  ?? '',
    };

    const errs = [];
    if (!/^\d+$/.test(raw.deliveryID.replace(/\s/g,''))) errs.push('deliveryID must be numeric');
    if (!/^\d+$/.test(raw.customerID.replace(/\s/g,''))) errs.push('customerID must be numeric');
    if (!raw.dispatchDate || isNaN(Date.parse(raw.dispatchDate)))  errs.push('dispatchDate must be a valid date (YYYY-MM-DD)');

    if (errs.length) {
      rowErrors.push({ row: i, errors: errs, raw });
    } else {
      records.push({
        deliveryID:       parseInt(raw.deliveryID, 10),
        customerID:       parseInt(raw.customerID, 10),
        dispatchDate:     raw.dispatchDate,
        deliveryService:  raw.deliveryService || null,
        deliveryPriority: parseInt(raw.deliveryPriority, 10) || 0,
        picksheetComment: raw.picksheetComment || null,
      });
    }
  }

  pendingCSVRecords = records;

  const previewEl = document.getElementById('csv-preview');
  let html = `<div class="tf-section-label" style="margin-top:0">
    Preview — ${records.length} valid row${records.length !== 1 ? 's' : ''}, ${rowErrors.length} error${rowErrors.length !== 1 ? 's' : ''}
  </div>`;

  if (rowErrors.length) {
    html += `<div class="sap-error" style="margin-bottom:12px">
      ${rowErrors.map(e => `Row ${e.row}: ${esc(e.errors.join(', '))}`).join('<br>')}
    </div>`;
  }

  if (records.length) {
    html += `<div style="overflow-x:auto;margin-bottom:16px">
      <table class="ps-table">
        <thead><tr>
          <th>Delivery ID</th><th>Customer ID</th><th>Due Date</th>
          <th>Service</th><th>Priority</th><th>Comment</th>
        </tr></thead>
        <tbody>
          ${records.map(r => `<tr>
            <td>${esc(String(r.deliveryID))}</td>
            <td>${esc(String(r.customerID))}</td>
            <td>${esc(r.dispatchDate)}</td>
            <td>${esc(r.deliveryService ?? '—')}</td>
            <td>${r.deliveryPriority ? 'Priority' : 'Normal'}</td>
            <td>${esc(r.picksheetComment ?? '')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="tf-actions" style="padding-top:0">
      <div id="csv-submit-result"></div>
      <button type="button" class="btn-submit" id="csv-submit-btn"
        onclick="submitCSVBulk()">
        Import ${records.length} picksheet${records.length !== 1 ? 's' : ''}
      </button>
    </div>`;
  }

  previewEl.innerHTML = html;
}

async function submitCSVBulk() {
  if (!pendingCSVRecords.length) return;
  if (!await checkSession()) return;

  const btn      = document.getElementById('csv-submit-btn');
  const resultEl = document.getElementById('csv-submit-result');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  resultEl.innerHTML = '';

  try {
    const res  = await fetch('/api/deliverymain/bulk', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: pendingCSVRecords }),
    });
    const json = await res.json();

    if (!json.success) throw new Error(json.error || 'Bulk import failed');

    const errLines = (json.errors || []).map(e =>
      `Delivery ${esc(String(e.deliveryID))}: ${esc(e.error)}`
    ).join('<br>');

    resultEl.innerHTML = `
      <div class="tf-success" style="flex-direction:column;align-items:flex-start;gap:4px">
        <div style="display:flex;align-items:center;gap:8px">
          <svg viewBox="0 0 20 20" fill="currentColor" style="flex-shrink:0"><path fill-rule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9
               10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
            clip-rule="evenodd"/></svg>
          <div class="tf-success-title">Import Complete</div>
        </div>
        <div style="font-size:13px;color:var(--text-muted,#aaa);padding-left:28px">
          ${json.inserted} inserted &nbsp;·&nbsp; ${json.skipped} already existed
          ${errLines ? `<br><span style="color:var(--danger,#ef4444)">${errLines}</span>` : ''}
        </div>
      </div>`;
    pendingCSVRecords = [];
    btn.textContent = 'Import complete';
  } catch (err) {
    resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ ${esc(err.message)}</div>`;
    btn.disabled = false;
    btn.textContent = 'Retry import';
  }
}

// ── SAP Sync ──────────────────────────────────────────────────────────────────
async function runSAPSync() {
  if (!await checkSession()) return;
  showResultPanel('SAP Sync', 'Fetching open deliveries from SAP server…');

  try {
    const res  = await fetch('/api/deliverymain/sap-sync', { method: 'POST' });
    const json = await res.json();

    if (!json.success) throw new Error(json.error || 'SAP sync failed');

    const errLines = (json.errors || []).map(e =>
      `Delivery ${esc(String(e.deliveryNumber))}: ${esc(e.error)}`
    ).join('<br>');

    const missingBlock = (json.missing || []).length ? `
      <div style="margin-top:16px;background:rgba(217,119,6,0.08);border:1px solid rgba(217,119,6,0.35);
        border-radius:8px;padding:12px 16px">
        <div style="font-size:13px;font-weight:700;color:#D97706;margin-bottom:8px">
          ⚠ ${json.missing.length} delivery${json.missing.length !== 1 ? 'ies' : ''} skipped — unknown customer
        </div>
        <div style="font-size:12px;color:#D97706;line-height:1.8;font-family:'JetBrains Mono',monospace">
          ${json.missing.map(m =>
            `Delivery <strong>${esc(String(m.deliveryNumber))}</strong> — customer <strong>${esc(String(m.customerNumber))}</strong> not found in Destinations table`
          ).join('<br>')}
        </div>
        <div style="font-size:12px;color:var(--text-muted,#888);margin-top:8px">
          Add the customer to the Destinations table (Logistics → Admin → Update Destinations) then sync again.
        </div>
      </div>` : '';

    document.getElementById('result-hint').textContent =
      `SAP returned ${json.total} open deliveries`;

    document.getElementById('result-body').innerHTML = `
      <div class="transfer-form">
        <div class="tf-success" style="flex-direction:column;align-items:flex-start;gap:6px">
          <div style="display:flex;align-items:center;gap:8px">
            <svg viewBox="0 0 20 20" fill="currentColor" style="flex-shrink:0"><path fill-rule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9
                 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clip-rule="evenodd"/></svg>
            <div class="tf-success-title">Sync Complete</div>
          </div>
          <div style="font-size:14px;color:var(--text-muted,#aaa);padding-left:28px;line-height:1.8">
            <strong style="color:var(--text)">${json.total}</strong> deliveries from SAP<br>
            <strong style="color:var(--text)">${json.inserted}</strong> new picksheets added<br>
            <strong style="color:var(--text)">${json.skipped}</strong> already existed (skipped)
            ${errLines ? `<br><span style="color:var(--danger,#ef4444)">${errLines}</span>` : ''}
          </div>
        </div>
        ${missingBlock}
      </div>`;
  } catch (err) {
    document.getElementById('result-body').innerHTML =
      `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

// ── CSV export ────────────────────────────────────────────────────────────────
function exportResultCSV() {
  if (!currentResult.length) return;
  const columns = Object.keys(currentResult[0]);
  const lines   = [
    columns.join(','),
    ...currentResult.map(row =>
      columns.map(c => `"${String(row[c] ?? '').replace(/"/g, '""')}"`).join(',')
    ),
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `stock-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Custom confirm dialog ─────────────────────────────────────────────────────
// wConfirm({ title, message, confirmText, variant })
// variant: 'danger' | 'success' | '' (default = accent/purple)
// Returns Promise<boolean>

function wConfirm({ title, message, confirmText = 'Confirm', variant = '' }) {
  return new Promise(resolve => {
    document.getElementById('w-confirm-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id        = 'w-confirm-modal';
    overlay.className = 'wc-overlay';

    const icon = variant === 'danger'  ? '🗑️'
               : variant === 'success' ? '✓'
               : '?';

    const safeMsg = esc(message).replace(/\n/g, '<br>');

    overlay.innerHTML = `
      <div class="wc-modal">
        <div class="wc-icon">${icon}</div>
        <div class="wc-title">${esc(title)}</div>
        <div class="wc-message">${safeMsg}</div>
        <div class="wc-actions">
          <button class="wc-btn-cancel">Cancel</button>
          <button class="wc-btn-confirm${variant ? ' wc-btn-confirm--' + variant : ''}">
            ${esc(confirmText)}
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const close = result => { overlay.remove(); resolve(result); };
    overlay.querySelector('.wc-btn-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.wc-btn-confirm').addEventListener('click', () => close(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
  });
}

// wPrompt({ title, label, inputType, options, initialValue })
// Single-field prompt dialog, styled like wConfirm. Pass `options` (array of
// { value, label }) for a <select>; otherwise renders an <input type=inputType>.
// Returns Promise<string|null> — null if cancelled, otherwise the field's value.
function wPrompt({ title, label, inputType = 'text', options = null, initialValue = '' }) {
  return new Promise(resolve => {
    document.getElementById('w-prompt-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id        = 'w-prompt-modal';
    overlay.className = 'wc-overlay';

    const fieldHtml = options
      ? `<select class="pb-input" id="wp-field">
           ${options.map(o => `<option value="${esc(o.value)}"${String(o.value) === String(initialValue) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
         </select>`
      : `<input class="pb-input" id="wp-field" type="${esc(inputType)}" value="${esc(initialValue)}">`;

    overlay.innerHTML = `
      <div class="wc-modal">
        <div class="wc-title">${esc(title)}</div>
        <div class="wc-message" style="text-align:left">
          <label class="pb-label" style="display:block;margin-bottom:6px">${esc(label)}</label>
          ${fieldHtml}
        </div>
        <div class="wc-actions">
          <button class="wc-btn-cancel">Cancel</button>
          <button class="wc-btn-confirm">Save</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const fieldEl = overlay.querySelector('#wp-field');
    fieldEl.focus();
    if (fieldEl.select) fieldEl.select();

    const close = val => { overlay.remove(); resolve(val); };
    overlay.querySelector('.wc-btn-cancel').addEventListener('click', () => close(null));
    overlay.querySelector('.wc-btn-confirm').addEventListener('click', () => close(fieldEl.value));
    overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
    fieldEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); close(fieldEl.value); }
    });
  });
}

// ── Utility ───────────────────────────────────────────────────────────────────

// parseSapQty — convert SAP/German number format to a plain decimal string.
// SAP uses '.' as thousands separator and ',' as decimal separator.
// e.g. "10.875,000" → "10875.000",  "90,5" → "90.5",  "157,000" → "157.000"
function parseSapQty(value) {
  const str = String(value ?? '').trim();
  return str.includes(',')
    ? str.replace(/\./g, '').replace(',', '.')   // remove thousand-sep dots, swap decimal comma
    : str.replace(/\./g, '');                     // no decimal part — just remove thousand-sep dots
}

// sapPad — pad purely numeric values with leading zeros to the required SAP field length.
// Alphanumeric values (letters, slashes, hyphens, etc.) are returned unchanged.
// Examples:
//   sapPad('12345',    18) → '000000000000012345'
//   sapPad('28-0658',  18) → '28-0658'
//   sapPad('',         18) → ''
function sapPad(value, length) {
  const str = String(value ?? '').trim();
  return /^\d+$/.test(str) ? str.padStart(length, '0') : str;
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Escapes a value for safe embedding inside a single-quoted JS string literal
// within an inline onclick="..." HTML attribute (e.g. addPackageFromFoundBatch
// calls in renderStockPanel). Distinct from esc(), which only escapes for HTML
// text/attribute context, not for the JS string embedded inside it.
function escJs(str) {
  if (str == null) return '';
  return String(str)
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ══════════════════════════════════════════════════════════════════════════
// STAGING POST — Stores' side of the material-requisition workflow.
// Production raises requests from production-nexus.html's own Staging Post
// screen; this fulfils them. Backend at /api/staging (routes/staging.js) —
// see sql/migrate_staging_post.sql for the full schema + workflow writeup.
// ══════════════════════════════════════════════════════════════════════════

async function spApi(path, opts) {
  const r = await fetch('/api/staging' + path, opts);
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON body */ }
  if (json?.success === false || !r.ok) {
    throw new Error(json?.error?.message || `Request failed (HTTP ${r.status})`);
  }
  return json;
}

function spFormatDate(value) {
  return value ? new Date(value).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
}

function spDueCell(r) {
  const label = spFormatDate(r.DueAtUtc);
  if (new Date(r.DueAtUtc) < new Date()) return `<span style="color:var(--error,#DC2626);font-weight:700">${label} — Late</span>`;
  return label;
}

// ── Staging Post (open demand) ────────────────────────────────────────────────

async function runStagingFulfil() {
  if (!await checkSession()) return;
  showResultPanel('Staging Post', 'Open material requests from Production — sorted by due date');
  try {
    const json = await spApi('/requests/open');
    spRenderFulfilList(json.data || []);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

function spRenderFulfilList(requests) {
  document.getElementById('result-row-badge').textContent = `${requests.length} open`;
  document.getElementById('result-row-badge').classList.remove('hidden');

  if (!requests.length) {
    document.getElementById('result-body').innerHTML = '<div class="sap-empty">No open staging requests — Production hasn’t asked for anything right now.</div>';
    return;
  }

  const rows = requests.map(r => `
    <tr class="admin-row sp-fulfil-row" style="cursor:pointer" data-id="${r.RequestId}">
      <td>${r.IsNonSap
        ? `<strong>${esc(r.MaterialText || '')}</strong><div style="font-size:11px;color:var(--text-secondary,#666)">Non-SAP</div>`
        : `<strong>${esc(r.Material)}</strong><div style="font-size:11px;color:var(--text-secondary,#666)">${esc(r.MaterialText || '')}</div>`}</td>
      <td>${Number(r.QuantityRequested).toLocaleString()}${r.QuantityDelivered > 0 ? ` <span style="color:var(--text-secondary,#666)">(${Number(r.QuantityDelivered).toLocaleString()} so far)</span>` : ''} ${esc(r.Uom || '')}</td>
      <td>${esc(r.Location)}</td>
      <td>${r.RequestedBatch ? `<strong>${esc(r.RequestedBatch)}</strong>` : '—'}</td>
      <td>${spDueCell(r)}</td>
      <td>${esc(r.RequestedBy)}</td>
    </tr>`).join('');

  document.getElementById('result-body').innerHTML = `
    <div style="overflow-x:auto">
      <table class="pn-batch-table admin-table">
        <thead><tr><th>Material</th><th>Quantity</th><th>Location</th><th>Batch</th><th>Needed By</th><th>Requested By</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  document.querySelectorAll('.sp-fulfil-row').forEach(tr => {
    tr.addEventListener('click', () => spOpenFulfilModal(Number(tr.dataset.id)));
  });
}

// Staging Post deliveries always transfer into the same SAP destination —
// operators never need to see or enter it.
const SP_DESTINATION_TYPE = 'SA';
const SP_DESTINATION_BIN = 'PTFE';
// Holds the source location/batch data captured from whichever stock row the
// operator selected in the Mark Delivered modal (set in spRefreshFulfilModal,
// read in spSubmitDelivery).
let spSelectedStockRow = null;

async function spOpenFulfilModal(requestId) {
  const overlay = document.getElementById('ps-modal-overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="ps-modal" style="max-width:780px;width:95vw">
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Loading…</div></div>
        <button class="ps-modal-close" onclick="closePickModal()">×</button>
      </div>
      <div class="ps-modal-body" id="sp-fulfil-body"><div class="sap-loading"><div class="spinner"></div>Loading…</div></div>
    </div>`;
  await spRefreshFulfilModal(requestId);
}

async function spRefreshFulfilModal(requestId) {
  const body = document.getElementById('sp-fulfil-body');
  if (!body) return;
  body.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Loading…</div>';
  try {
    const [reqJson, stockJson] = await Promise.all([
      spApi(`/requests/${requestId}`),
      spApi(`/requests/${requestId}/stock`),
    ]);
    const request = reqJson.data;
    const titleEl = document.querySelector('#ps-modal-overlay .ps-modal-title');
    if (titleEl) titleEl.textContent = request.IsNonSap ? (request.MaterialText || '') : `${request.Material} — ${request.MaterialText || ''}`;

    const remaining = Number(request.QuantityRequested) - Number(request.QuantityDelivered);

    // Non-SAP requests (H&S equipment etc. — see routes/staging.js's POST
    // /requests) have no SAP material at all, so there's no stock to look
    // up and no LT01 transfer order to raise (POST /requests/:id/deliver
    // skips SAP entirely for these) — just confirm the hand-off happened.
    if (request.IsNonSap) {
      body.innerHTML = `
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Requested</label><div>${Number(request.QuantityRequested).toLocaleString()}</div></div>
          <div class="tf-field"><label class="tf-label">Delivered so far</label><div>${Number(request.QuantityDelivered).toLocaleString()}</div></div>
          <div class="tf-field"><label class="tf-label">Remaining</label><div><strong>${remaining.toLocaleString()}</strong></div></div>
          <div class="tf-field"><label class="tf-label">Location</label><div>${esc(request.Location)}</div></div>
        </div>
        ${request.Notes ? `<div class="toolbar-hint" style="margin:2px 0 10px">Note from Production: ${esc(request.Notes)}</div>` : ''}
        <div class="toolbar-hint" style="margin:2px 0 10px">Non-SAP request — no SAP stock movement is involved. Just confirm the item(s) have been handed over.</div>

        <div class="tf-section-label">Mark Delivered</div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Quantity <span class="tf-req">*</span></label>
            <input class="tf-input" type="number" step="0.001" min="0.001" id="sp-deliver-qty" value="${remaining > 0 ? remaining : ''}">
          </div>
        </div>
        <div id="sp-deliver-result"></div>
        <div class="ps-modal-actions" style="padding:0;margin-top:10px">
          <button type="button" class="btn-secondary" onclick="closePickModal()">Close</button>
          <button type="button" class="btn-submit" id="sp-deliver-btn">Mark Delivered</button>
        </div>`;

      spSelectedStockRow = null;
      document.getElementById('sp-deliver-btn').addEventListener('click', () => spSubmitDelivery(requestId, { isNonSap: true }));
      return;
    }

    const stock = stockJson.data.stock || [];
    const hasRestrictions = stockJson.data.hasRestrictions;
    const requestedBatch = stockJson.data.requestedBatch;

    const stockSorted = [...stock].sort((a, b) => (b.isAllowed - a.isAllowed) || (Number(b.availableQty) - Number(a.availableQty)));

    const stockRowsHtml = stockSorted.length ? stockSorted.map(s => {
      const isConsignment = s.specialStockInd === 'K';
      return `
      <tr class="pn-row sp-stock-row" style="cursor:pointer${s.isAllowed ? '' : ';opacity:0.65'}"
          data-storagetype="${esc(s.storageType)}" data-bin="${esc(s.bin)}" data-batch="${esc(s.batch || '')}" data-sloc="${esc(s.storageLocation)}"
          data-specialstockind="${esc(s.specialStockInd || '')}" data-specialstocknum="${esc(s.specialStockNum || '')}">
        <td>${esc(s.storageType)}</td>
        <td>${esc(s.bin)}</td>
        <td>${esc(s.batch || '—')}</td>
        <td>${Number(s.availableQty).toLocaleString()}</td>
        <td>${isConsignment ? '<span style="color:#B45309;font-weight:700">Consignment</span>' : ''}</td>
        <td>${hasRestrictions ? (s.isAllowed ? '<span style="color:#059669;font-weight:700">Allowed</span>' : '<span style="color:var(--text-muted)">Other bin</span>') : ''}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="6" class="sap-empty">No stock currently in SAP for this material.</td></tr>`;

    body.innerHTML = `
      <div class="tf-row">
        <div class="tf-field"><label class="tf-label">Requested</label><div>${Number(request.QuantityRequested).toLocaleString()} ${esc(request.Uom || '')}</div></div>
        <div class="tf-field"><label class="tf-label">Delivered so far</label><div>${Number(request.QuantityDelivered).toLocaleString()} ${esc(request.Uom || '')}</div></div>
        <div class="tf-field"><label class="tf-label">Remaining</label><div><strong>${remaining.toLocaleString()}</strong> ${esc(request.Uom || '')}</div></div>
        <div class="tf-field"><label class="tf-label">Location</label><div>${esc(request.Location)}</div></div>
      </div>
      ${requestedBatch ? `<div class="toolbar-hint" style="margin:2px 0 10px">Production asked for a specific batch: <strong>${esc(requestedBatch)}</strong> — its location is highlighted below.</div>` : ''}
      ${request.Notes ? `<div class="toolbar-hint" style="margin:2px 0 10px">Note from Production: ${esc(request.Notes)}</div>` : ''}

      <div class="tf-section-label">Available Stock ${hasRestrictions ? '<span class="tf-optional">(bin restrictions configured for this material — allowed bins shown first)</span>' : ''}</div>
      <div style="overflow-x:auto;max-height:220px;overflow-y:auto;margin-bottom:14px">
        <table class="pn-batch-table">
          <thead><tr><th>Storage Type</th><th>Bin</th><th>Batch</th><th>Available Qty</th><th>Stock</th><th></th></tr></thead>
          <tbody>${stockRowsHtml}</tbody>
        </table>
      </div>
      <div class="toolbar-hint" style="margin:2px 0 10px">Click a stock row below to select where to pick from.</div>

      <div class="tf-section-label">Mark Delivered</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Quantity <span class="tf-req">*</span></label>
          <input class="tf-input" type="number" step="0.001" min="0.001" id="sp-deliver-qty" value="${remaining > 0 ? remaining : ''}">
        </div>
      </div>
      <div id="sp-deliver-result"></div>
      <div class="ps-modal-actions" style="padding:0;margin-top:10px">
        <button type="button" class="btn-secondary" onclick="closePickModal()">Close</button>
        <button type="button" class="btn-submit" id="sp-deliver-btn">Create Transfer Order &amp; Mark Delivered</button>
      </div>`;

    spSelectedStockRow = null;
    document.querySelectorAll('.sp-stock-row').forEach(tr => {
      tr.addEventListener('click', () => {
        document.querySelectorAll('.sp-stock-row.selected').forEach(prev => prev.classList.remove('selected'));
        tr.classList.add('selected');
        spSelectedStockRow = {
          storageLocation: tr.dataset.sloc,
          sourceStorageType: tr.dataset.storagetype,
          sourceBin: tr.dataset.bin,
          batch: (requestedBatch || tr.dataset.batch || '') || null,
          specialStockIndicator: tr.dataset.specialstockind || null,
          specialStockNumber: tr.dataset.specialstocknum || null,
        };
      });
    });

    document.getElementById('sp-deliver-btn').addEventListener('click', () => spSubmitDelivery(requestId));
  } catch (err) {
    body.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function spSubmitDelivery(requestId, { isNonSap = false } = {}) {
  const resultEl = document.getElementById('sp-deliver-result');
  let body;

  if (isNonSap) {
    body = { quantity: Number(document.getElementById('sp-deliver-qty').value) };
  } else {
    if (!spSelectedStockRow) {
      resultEl.innerHTML = '<div class="sap-error">Click a row in the Available Stock table above to pick where to take it from.</div>';
      return;
    }
    body = {
      quantity: Number(document.getElementById('sp-deliver-qty').value),
      batch: spSelectedStockRow.batch,
      storageLocation: spSelectedStockRow.storageLocation,
      sourceStorageType: spSelectedStockRow.sourceStorageType,
      sourceBin: spSelectedStockRow.sourceBin,
      destinationStorageType: SP_DESTINATION_TYPE,
      destinationBin: SP_DESTINATION_BIN,
      specialStockIndicator: spSelectedStockRow.specialStockIndicator,
      specialStockNumber: spSelectedStockRow.specialStockNumber,
    };
    if (body.specialStockIndicator === 'K' && !body.specialStockNumber) {
      resultEl.innerHTML = '<div class="sap-error">This is consignment stock but has no vendor (special stock) number from SAP — cannot issue it automatically.</div>';
      return;
    }
  }
  if (!(body.quantity > 0)) { resultEl.innerHTML = '<div class="sap-error">Enter a quantity greater than zero.</div>'; return; }

  const btn = document.getElementById('sp-deliver-btn');
  btn.disabled = true; btn.textContent = isNonSap ? 'Marking delivered…' : 'Creating transfer order…';
  try {
    const json = await spApi(`/requests/${requestId}/deliver`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const { transferOrderNumber, metOrExceeded, withinTolerance, cumulativeDelivered, quantityRequested } = json.data;

    if (metOrExceeded) {
      // Delivered at least what was requested — auto-complete, no prompt.
      try { await spApi(`/requests/${requestId}/complete`, { method: 'POST' }); } catch (err) { alert(err.message); }
      closePickModal();
      await runStagingFulfil();
    } else if (withinTolerance) {
      spShowCompleteChoice(requestId, transferOrderNumber, cumulativeDelivered, quantityRequested);
    } else {
      closePickModal();
      await runStagingFulfil();
    }
  } catch (err) {
    resultEl.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    btn.disabled = false; btn.textContent = isNonSap ? 'Mark Delivered' : 'Create Transfer Order & Mark Delivered';
  }
}

function spShowCompleteChoice(requestId, transferOrderNumber, delivered, requested) {
  const overlay = document.getElementById('ps-modal-overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="ps-modal" style="max-width:440px">
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Transfer Order ${esc(transferOrderNumber)} Created</div><div class="ps-modal-sub">${delivered} of ${requested} delivered — within tolerance</div></div>
      </div>
      <div class="ps-modal-body">
        <p style="margin:0">Is this request now complete, or is more still coming?</p>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="btn-secondary" id="sp-leave-open-btn">Leave Open</button>
        <button type="button" class="btn-submit" id="sp-confirm-complete-btn">Confirm Complete</button>
      </div>
    </div>`;

  document.getElementById('sp-leave-open-btn').addEventListener('click', async () => {
    closePickModal();
    await runStagingFulfil();
  });
  document.getElementById('sp-confirm-complete-btn').addEventListener('click', async () => {
    try { await spApi(`/requests/${requestId}/complete`, { method: 'POST' }); } catch (err) { alert(err.message); }
    closePickModal();
    await runStagingFulfil();
  });
}

// ── Completed Requests (audit trail + KPIs) ───────────────────────────────────

async function runStagingCompleted() {
  if (!await checkSession()) return;
  showResultPanel('Completed Requests', 'Staging Post audit trail and fulfilment KPIs');
  await spRefreshCompleted();
}

async function spRefreshCompleted(from, to) {
  const body = document.getElementById('result-body');
  body.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Loading…</div>';
  try {
    const qs = [];
    if (from) qs.push(`from=${encodeURIComponent(from)}`);
    if (to)   qs.push(`to=${encodeURIComponent(to)}`);
    const query = qs.length ? `?${qs.join('&')}` : '';
    const [kpiJson, listJson] = await Promise.all([
      spApi(`/kpi${query}`),
      spApi(`/requests/completed${query}`),
    ]);
    spRenderCompleted(kpiJson.data, listJson.data || [], from, to);
  } catch (err) {
    body.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

function spRenderCompleted(kpi, requests, from, to) {
  const { overall, byMaterial } = kpi;
  const onTimePct = overall.CompletedCount ? (100 * overall.OnTimeCount / overall.CompletedCount) : 0;

  const byMaterialRows = byMaterial.map(m => {
    const pct = m.CompletedCount ? (100 * m.OnTimeCount / m.CompletedCount) : 0;
    return `<tr class="admin-row">
      <td><strong>${esc(m.Material)}</strong><div style="font-size:11px;color:var(--text-secondary,#666)">${esc(m.MaterialText || '')}</div></td>
      <td>${m.CompletedCount}</td>
      <td>${pct.toFixed(0)}%</td>
      <td>${m.AvgLeadTimeHours != null ? Number(m.AvgLeadTimeHours).toFixed(1) : '—'}</td>
    </tr>`;
  }).join('');

  const requestRows = requests.map(r => `
    <tr class="admin-row sp-audit-row" style="cursor:pointer" data-id="${r.RequestId}">
      <td>${r.IsNonSap
        ? `<strong>${esc(r.MaterialText || '')}</strong><div style="font-size:11px;color:var(--text-secondary,#666)">Non-SAP</div>`
        : `<strong>${esc(r.Material)}</strong><div style="font-size:11px;color:var(--text-secondary,#666)">${esc(r.MaterialText || '')}</div>`}</td>
      <td>${Number(r.QuantityRequested).toLocaleString()} / ${Number(r.QuantityDelivered).toLocaleString()} ${esc(r.Uom || '')}</td>
      <td>${esc(r.Location)}</td>
      <td>${r.Status === 'Completed' ? '<span style="color:#059669">Completed</span>' : '<span style="color:var(--text-muted)">Cancelled</span>'}</td>
      <td>${spFormatDate(r.RequestedAtUtc)}</td>
      <td>${spFormatDate(r.CompletedAtUtc)}</td>
      <td>${r.Status === 'Completed' ? (new Date(r.CompletedAtUtc) <= new Date(r.DueAtUtc) ? '<span style="color:#059669">Yes</span>' : '<span style="color:var(--error,#DC2626)">No</span>') : '—'}</td>
    </tr>`).join('');

  const qs = [from ? `from=${from}` : '', to ? `to=${to}` : ''].filter(Boolean).join('&');

  document.getElementById('result-body').innerHTML = `
    <div class="tf-row" style="margin-bottom:14px">
      <div class="tf-field"><label class="tf-label">From</label><input class="tf-input" type="date" id="sp-kpi-from" value="${from || ''}"></div>
      <div class="tf-field"><label class="tf-label">To</label><input class="tf-input" type="date" id="sp-kpi-to" value="${to || ''}"></div>
      <div class="tf-field" style="justify-content:flex-end"><label class="tf-label">&nbsp;</label><button type="button" class="btn-secondary" id="sp-kpi-filter-btn">Filter</button></div>
      <div class="tf-field" style="justify-content:flex-end"><label class="tf-label">&nbsp;</label><a class="btn-export" href="/api/staging/kpi/export${qs ? '?' + qs : ''}">Export to Excel</a></div>
    </div>

    <div class="rpt-kpi-row">
      <div class="rpt-kpi"><div class="rpt-kpi-label">Completed</div><div class="rpt-kpi-val">${overall.CompletedCount || 0}</div></div>
      <div class="rpt-kpi"><div class="rpt-kpi-label">On-Time %</div><div class="rpt-kpi-val">${onTimePct.toFixed(0)}%</div></div>
      <div class="rpt-kpi"><div class="rpt-kpi-label">Avg Lead Time</div><div class="rpt-kpi-val">${overall.AvgLeadTimeHours != null ? Number(overall.AvgLeadTimeHours).toFixed(1) : '—'}</div><div class="rpt-kpi-sub">hours</div></div>
    </div>

    <div class="tf-section-label">By Material</div>
    <div style="overflow-x:auto;margin-bottom:18px">
      <table class="pn-batch-table admin-table">
        <thead><tr><th>Material</th><th>Completed</th><th>On-Time %</th><th>Avg Lead (hrs)</th></tr></thead>
        <tbody>${byMaterialRows || '<tr><td colspan="4" class="sap-empty">No completed requests in range.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="tf-section-label">All Requests (Audit Trail)</div>
    <div style="overflow-x:auto">
      <table class="pn-batch-table admin-table">
        <thead><tr><th>Material</th><th>Requested / Delivered</th><th>Location</th><th>Status</th><th>Requested At</th><th>Completed At</th><th>On Time</th></tr></thead>
        <tbody>${requestRows || '<tr><td colspan="7" class="sap-empty">No requests in range.</td></tr>'}</tbody>
      </table>
    </div>`;

  document.getElementById('sp-kpi-filter-btn').addEventListener('click', () => {
    const f = document.getElementById('sp-kpi-from').value;
    const t = document.getElementById('sp-kpi-to').value;
    spRefreshCompleted(f || null, t || null);
  });
  document.querySelectorAll('.sp-audit-row').forEach(tr => {
    tr.addEventListener('click', () => spOpenAuditDetail(Number(tr.dataset.id)));
  });
}

async function spOpenAuditDetail(requestId) {
  const overlay = document.getElementById('ps-modal-overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = `<div class="ps-modal" style="max-width:640px;width:94vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Loading…</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body"><div class="sap-loading"><div class="spinner"></div>Loading…</div></div>
  </div>`;
  try {
    const json = await spApi(`/requests/${requestId}`);
    const r = json.data;
    document.querySelector('#ps-modal-overlay .ps-modal-title').textContent = `${r.IsNonSap ? (r.MaterialText || 'Non-SAP') : r.Material} — Request #${r.RequestId}`;
    const deliveryRows = (r.deliveries || []).map(d => `
      <tr class="admin-row">
        <td>${Number(d.QuantityMoved).toLocaleString()}</td>
        <td>${d.Batch ? esc(d.Batch) : '—'}</td>
        <td>${esc(d.SourceStorageType || '')}/${esc(d.SourceBin || '')} &rarr; ${esc(d.DestinationStorageType || '')}/${esc(d.DestinationBin || '')}</td>
        <td>${d.TransferOrderNumber ? esc(d.TransferOrderNumber) : '—'}</td>
        <td>${esc(d.DeliveredBy)}</td>
        <td>${spFormatDate(d.DeliveredAtUtc)}</td>
      </tr>`).join('');
    document.querySelector('#ps-modal-overlay .ps-modal-body').innerHTML = `
      <div class="tf-row">
        <div class="tf-field"><label class="tf-label">Requested</label><div>${Number(r.QuantityRequested).toLocaleString()} ${esc(r.Uom || '')}</div></div>
        <div class="tf-field"><label class="tf-label">Delivered</label><div>${Number(r.QuantityDelivered).toLocaleString()} ${esc(r.Uom || '')}</div></div>
        <div class="tf-field"><label class="tf-label">Location</label><div>${esc(r.Location)}</div></div>
        <div class="tf-field"><label class="tf-label">Status</label><div>${esc(r.Status)}</div></div>
      </div>
      <div class="tf-row">
        <div class="tf-field"><label class="tf-label">Requested By</label><div>${esc(r.RequestedBy)} — ${spFormatDate(r.RequestedAtUtc)}</div></div>
        <div class="tf-field"><label class="tf-label">Needed By</label><div>${spFormatDate(r.DueAtUtc)}</div></div>
      </div>
      ${r.Notes ? `<div class="toolbar-hint">Note: ${esc(r.Notes)}</div>` : ''}
      <div class="tf-section-label" style="margin-top:12px">Deliveries</div>
      <div style="overflow-x:auto">
        <table class="pn-batch-table">
          <thead><tr><th>Qty</th><th>Batch</th><th>Source &rarr; Dest</th><th>Transfer Order</th><th>By</th><th>When</th></tr></thead>
          <tbody>${deliveryRows || '<tr><td colspan="6" class="sap-empty">No deliveries recorded.</td></tr>'}</tbody>
        </table>
      </div>`;
  } catch (err) {
    document.querySelector('#ps-modal-overlay .ps-modal-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

// ── Bin Restrictions (Warehouse Supervisor config) ────────────────────────────

async function runStagingBinRestrictions() {
  if (!await checkSession()) return;
  showResultPanel('Bin Restrictions', 'Configure which bins/bin types Staging Post deliveries must be picked from, per material');
  try {
    const json = await spApi('/bin-restrictions');
    spRenderBinRestrictions(json.data || []);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

function spRenderBinRestrictions(restrictions) {
  const rows = restrictions.map(r => `
    <tr class="admin-row">
      <td><strong>${esc(r.Material)}</strong></td>
      <td>${esc(r.StorageType)}</td>
      <td>${r.Bin ? esc(r.Bin) : '<span style="color:var(--text-muted)">Any bin in this type</span>'}</td>
      <td>${esc(r.Notes || '—')}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn-secondary sp-br-edit" data-id="${r.RestrictionId}" style="padding:3px 10px;font-size:11px">Edit</button>
        <button class="btn-secondary sp-br-delete" data-id="${r.RestrictionId}" style="padding:3px 10px;font-size:11px;color:var(--error,#DC2626)">Delete</button>
      </td>
    </tr>`).join('');

  document.getElementById('result-body').innerHTML = `
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:10px">
      <button class="btn-secondary" id="sp-br-import-btn">Import CSV</button>
      <button class="btn-submit" id="sp-br-add-btn">+ Add Restriction</button>
    </div>
    ${restrictions.length ? `
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>Material</th><th>Storage Type</th><th>Bin</th><th>Notes</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : '<div class="sap-empty">No bin restrictions configured — every material can be picked from anywhere in stock.</div>'}
  `;

  document.getElementById('sp-br-add-btn').addEventListener('click', () => spOpenBinRestrictionModal(null));
  document.getElementById('sp-br-import-btn').addEventListener('click', () => spOpenBinRestrictionImportModal());
  document.querySelectorAll('.sp-br-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = restrictions.find(x => String(x.RestrictionId) === btn.dataset.id);
      if (r) spOpenBinRestrictionModal(r);
    });
  });
  document.querySelectorAll('.sp-br-delete').forEach(btn => {
    btn.addEventListener('click', () => spDeleteBinRestriction(btn.dataset.id));
  });
}

function spOpenBinRestrictionModal(restriction) {
  const isEdit = !!restriction;
  const overlay = document.getElementById('ps-modal-overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = `<div class="ps-modal" style="max-width:480px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">${isEdit ? 'Edit' : 'Add'} Bin Restriction</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Material <span class="tf-req">*</span></label>
          <input class="tf-input" type="text" id="sp-br-material" value="${esc(restriction?.Material || '')}" placeholder="Search by material number or description…" ${isEdit ? 'readonly' : ''}>
          <input type="hidden" id="sp-br-material-value" value="${esc(restriction?.Material || '')}">
          <div id="sp-br-material-results"></div>
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Storage Type <span class="tf-req">*</span></label>
          <input class="tf-input" type="text" id="sp-br-storage-type" value="${esc(restriction?.StorageType || '')}" placeholder="e.g. 001">
        </div>
        <div class="tf-field">
          <label class="tf-label">Bin <span class="tf-optional">(optional)</span></label>
          <input class="tf-input" type="text" id="sp-br-bin" value="${esc(restriction?.Bin || '')}" placeholder="Leave blank for any bin in this type">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Notes <span class="tf-optional">(optional)</span></label>
          <input class="tf-input" type="text" id="sp-br-notes" value="${esc(restriction?.Notes || '')}" placeholder="e.g. Manual FIFO placement">
        </div>
      </div>
      <div id="sp-br-result"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="sp-br-save-btn">${isEdit ? 'Save Changes' : 'Add Restriction'}</button>
    </div>
  </div>`;

  if (!isEdit) {
    let searchTimer = null;
    document.getElementById('sp-br-material').addEventListener('input', function () {
      document.getElementById('sp-br-material-value').value = '';
      clearTimeout(searchTimer);
      const q = this.value.trim();
      const results = document.getElementById('sp-br-material-results');
      if (!q) { results.innerHTML = ''; return; }
      searchTimer = setTimeout(() => spSearchBinRestrictionMaterials(q), 250);
    });
  }

  document.getElementById('sp-br-save-btn').addEventListener('click', async () => {
    const material = isEdit ? restriction.Material : document.getElementById('sp-br-material-value').value;
    const body = {
      material,
      storageType: document.getElementById('sp-br-storage-type').value.trim(),
      bin: document.getElementById('sp-br-bin').value.trim() || null,
      notes: document.getElementById('sp-br-notes').value.trim() || null,
    };
    const resultEl = document.getElementById('sp-br-result');
    if (!body.material) { resultEl.innerHTML = '<div class="sap-error">Pick a material from the search results.</div>'; return; }
    if (!body.storageType) { resultEl.innerHTML = '<div class="sap-error">Storage type is required.</div>'; return; }

    const btn = document.getElementById('sp-br-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await spApi(isEdit ? `/bin-restrictions/${restriction.RestrictionId}` : '/bin-restrictions', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      closePickModal();
      runStagingBinRestrictions();
    } catch (err) {
      resultEl.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = isEdit ? 'Save Changes' : 'Add Restriction';
    }
  });
}

async function spSearchBinRestrictionMaterials(q) {
  const results = document.getElementById('sp-br-material-results');
  if (!results) return;
  results.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Searching…</div>';
  try {
    const json = await spApi(`/materials?search=${encodeURIComponent(q)}`);
    const rows = json.data || [];
    if (!rows.length) { results.innerHTML = '<div class="sap-empty">No materials matched.</div>'; return; }
    results.innerHTML = `
      <div style="overflow-x:auto;max-height:220px;overflow-y:auto;margin-top:6px">
        <table class="pn-batch-table">
          <thead><tr><th>Material</th><th>Description</th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr class="pn-row sp-br-material-pick" style="cursor:pointer" data-material="${esc(r.material)}">
                <td style="font-family:'JetBrains Mono',monospace;font-weight:700">${esc(r.material)}</td>
                <td>${esc(r.materialText || '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    document.querySelectorAll('.sp-br-material-pick').forEach(tr => {
      tr.addEventListener('click', () => {
        document.getElementById('sp-br-material').value = tr.dataset.material;
        document.getElementById('sp-br-material-value').value = tr.dataset.material;
        results.innerHTML = '';
      });
    });
  } catch (err) {
    results.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function spDeleteBinRestriction(restrictionId) {
  if (!confirm('Delete this bin restriction?')) return;
  try {
    await spApi(`/bin-restrictions/${restrictionId}`, { method: 'DELETE' });
    runStagingBinRestrictions();
  } catch (err) {
    alert(err.message);
  }
}

// ── Bin Restrictions — CSV Bulk Import ────────────────────────────────────────
let pendingBinRestrictionCsvRecords = [];

function spOpenBinRestrictionImportModal() {
  pendingBinRestrictionCsvRecords = [];
  const overlay = document.getElementById('ps-modal-overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = `<div class="ps-modal" style="max-width:600px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Import Bin Restrictions (CSV)</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-section-label" style="margin-top:0">Expected Format</div>
      <div style="margin-bottom:16px">
        <code style="display:block;background:var(--surface2,#1e1e2e);border:1px solid var(--border,#333);
          border-radius:6px;padding:10px 14px;font-size:13px;color:var(--text-muted,#aaa);line-height:1.6">
          material,storageType,bin,notes<br>
          30005R,SA,BIN-001,Manual FIFO placement
        </code>
        <div style="font-size:12px;color:var(--text-muted,#888);margin-top:6px">
          bin and notes are optional — leave blank to restrict to any bin in that storage type.
          Rows matching an existing Material + Storage Type + Bin combination are skipped.
          Comma- or semicolon-separated files are both accepted (semicolon-delimited is what Excel
          exports on a UK-regional PC).
        </div>
        <button type="button" onclick="spDownloadBinRestrictionCsvTemplate()"
          style="margin-top:8px;background:none;border:none;color:var(--accent,#7c3aed);
            cursor:pointer;font-size:13px;text-decoration:underline;padding:0">
          Download blank template
        </button>
      </div>

      <div class="tf-section-label">Select File</div>
      <div id="sp-br-csv-drop-zone" style="border:2px dashed var(--border,#444);border-radius:8px;
        padding:32px;text-align:center;cursor:pointer;color:var(--text-muted,#888);
        transition:border-color .2s"
        onclick="document.getElementById('sp-br-csv-file-input').click()"
        ondragover="event.preventDefault();this.style.borderColor='var(--accent,#7c3aed)'"
        ondragleave="this.style.borderColor=''"
        ondrop="spHandleBinRestrictionCsvDrop(event)">
        Drop CSV here or click to browse
        <input type="file" id="sp-br-csv-file-input" accept=".csv,.txt"
          style="display:none" onchange="spHandleBinRestrictionCsvFile(this)">
      </div>

      <div id="sp-br-csv-preview" style="margin-top:20px"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Close</button>
    </div>
  </div>`;
}

function spDownloadBinRestrictionCsvTemplate() {
  const csv = 'material,storageType,bin,notes\r\n30005R,SA,BIN-001,Manual FIFO placement\r\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'bin-restrictions-template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function spHandleBinRestrictionCsvDrop(e) {
  e.preventDefault();
  document.getElementById('sp-br-csv-drop-zone').style.borderColor = '';
  const file = e.dataTransfer?.files?.[0];
  if (file) spParseBinRestrictionCsvFile(file);
}

function spHandleBinRestrictionCsvFile(input) {
  const file = input.files?.[0];
  if (file) spParseBinRestrictionCsvFile(file);
  input.value = '';
}

function spParseBinRestrictionCsvFile(file) {
  const reader = new FileReader();
  reader.onload = e => spRenderBinRestrictionCsvPreview(e.target.result);
  reader.readAsText(file);
}

function spRenderBinRestrictionCsvPreview(text) {
  const previewEl = document.getElementById('sp-br-csv-preview');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    previewEl.innerHTML = '<div class="sap-error">✕ File must have a header row and at least one data row</div>';
    return;
  }

  const delimiter = detectCSVDelimiter(lines[0]);
  const headers = parseCSVLine(lines[0], delimiter).map(h => h.toLowerCase().replace(/\s/g, ''));
  const missing = ['material', 'storagetype'].filter(h => !headers.includes(h));
  if (missing.length) {
    previewEl.innerHTML = `<div class="sap-error">✕ Missing columns: ${esc(missing.join(', '))}</div>`;
    return;
  }

  const idx = {
    material:    headers.indexOf('material'),
    storageType: headers.indexOf('storagetype'),
    bin:         headers.indexOf('bin'),
    notes:       headers.indexOf('notes'),
  };

  const records = [], rowErrors = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i], delimiter);
    const raw = {
      material:    cols[idx.material] ?? '',
      storageType: cols[idx.storageType] ?? '',
      bin:         idx.bin   >= 0 ? (cols[idx.bin]   ?? '') : '',
      notes:       idx.notes >= 0 ? (cols[idx.notes] ?? '') : '',
    };

    const errs = [];
    if (!raw.material) errs.push('material is required');
    if (!raw.storageType) errs.push('storageType is required');

    if (errs.length) {
      rowErrors.push({ row: i, errors: errs });
    } else {
      records.push({
        material:    raw.material,
        storageType: raw.storageType,
        bin:         raw.bin || null,
        notes:       raw.notes || null,
      });
    }
  }

  pendingBinRestrictionCsvRecords = records;

  let html = `<div class="tf-section-label" style="margin-top:0">
    Preview — ${records.length} valid row${records.length !== 1 ? 's' : ''}, ${rowErrors.length} error${rowErrors.length !== 1 ? 's' : ''}
  </div>`;

  if (rowErrors.length) {
    html += `<div class="sap-error" style="margin-bottom:12px">
      ${rowErrors.map(e => `Row ${e.row}: ${esc(e.errors.join(', '))}`).join('<br>')}
    </div>`;
  }

  if (records.length) {
    html += `<div style="overflow-x:auto;margin-bottom:16px;max-height:260px;overflow-y:auto">
      <table class="pn-batch-table">
        <thead><tr><th>Material</th><th>Storage Type</th><th>Bin</th><th>Notes</th></tr></thead>
        <tbody>
          ${records.map(r => `<tr>
            <td>${esc(r.material)}</td>
            <td>${esc(r.storageType)}</td>
            <td>${r.bin ? esc(r.bin) : '<span style="color:var(--text-muted)">Any</span>'}</td>
            <td>${esc(r.notes || '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="tf-actions" style="padding-top:0">
      <div id="sp-br-csv-submit-result"></div>
      <button type="button" class="btn-submit" id="sp-br-csv-submit-btn"
        onclick="spSubmitBinRestrictionCsvBulk()">
        Import ${records.length} restriction${records.length !== 1 ? 's' : ''}
      </button>
    </div>`;
  }

  previewEl.innerHTML = html;
}

async function spSubmitBinRestrictionCsvBulk() {
  if (!pendingBinRestrictionCsvRecords.length) return;
  if (!await checkSession()) return;

  const btn      = document.getElementById('sp-br-csv-submit-btn');
  const resultEl = document.getElementById('sp-br-csv-submit-result');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  resultEl.innerHTML = '';

  try {
    const json = await spApi('/bin-restrictions/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: pendingBinRestrictionCsvRecords }),
    });

    const errLines = (json.errors || []).map(e => `${esc(e.material ?? '')}: ${esc(e.error)}`).join('<br>');

    resultEl.innerHTML = `
      <div class="tf-success" style="flex-direction:column;align-items:flex-start;gap:4px">
        <div class="tf-success-title">Import Complete</div>
        <div style="font-size:13px;color:var(--text-muted,#aaa)">
          ${json.inserted} inserted &nbsp;·&nbsp; ${json.skipped} already existed
          ${errLines ? `<br><span style="color:var(--danger,#ef4444)">${errLines}</span>` : ''}
        </div>
      </div>`;
    pendingBinRestrictionCsvRecords = [];
    btn.textContent = 'Import complete';
    runStagingBinRestrictions();
  } catch (err) {
    resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ ${esc(err.message)}</div>`;
    btn.disabled = false;
    btn.textContent = 'Retry import';
  }
}

// ── ZDELFLAG/ZDELPACK Warnings ───────────────────────────────────────────────
// Lists deliveries whose latest transaction-ZPIL9 maintenance run (see
// deliverymain.js's runZdelflagMaintenance, fired on delivery complete)
// came back Failed or Warning, with a Reprocess action so someone can fix
// the underlying SAP issue and retry before the delivery ships. A delivery
// drops off this list the moment a reprocess attempt records Success.
async function runZdelflagWarnings() {
  if (!await checkSession()) return;
  showResultPanel('ZDELFLAG Warnings', 'Deliveries where ZDELFLAG/ZDELPACK maintenance (ZPIL9) failed or warned');
  try {
    const r = await fetch('/api/deliverymain/zdelflag/warnings');
    const json = await r.json();
    if (json.success === false) throw new Error(json.error || 'Failed to load ZDELFLAG warnings');
    zdRenderWarnings(json.data || []);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
  pollZdelflagWarnCount();
}

function zdRenderWarnings(warnings) {
  const canResolve = sessionRole === 'superadmin' || sessionPermissions.includes('LOG_SUPER');
  const rows = warnings.map(w => {
    // Always show the SAP message TYPE alongside the text, and fall back to
    // an explicit "(no message text)" note per line rather than dropping it
    // silently — a run can land here with a real message object whose TYPE
    // is set but MESSAGE text came back blank from SAP, which previously
    // rendered as a bare "—" with no way to tell what actually happened.
    const msgText = (w.messages || []).length
      ? w.messages.map(m => {
          const type = esc(String(m.type || '').trim());
          const text = esc(String(m.message || '').trim());
          return type
            ? `<span style="color:var(--text-muted);font-family:'JetBrains Mono',monospace;font-size:10px">[${type}]</span> ${text || '<span style="color:var(--text-muted)">(no message text)</span>'}`
            : (text || '<span style="color:var(--text-muted)">(no message text)</span>');
        }).join('<br>')
      : '<span style="color:var(--text-muted)">—</span>';
    return `
    <tr class="admin-row">
      <td><strong>${esc(String(w.deliveryID))}</strong></td>
      <td><span class="tile-badge ${w.status === 'Failed' ? 'tile-badge--overdue' : ''}" style="position:static;display:inline-block">${esc(w.status)}</span></td>
      <td style="max-width:420px">${msgText}</td>
      <td>${spFormatDate(w.ranAtUtc)}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn-secondary zd-reprocess" data-id="${esc(String(w.deliveryID))}" style="padding:3px 10px;font-size:11px">Reprocess</button>
        ${canResolve ? `<button class="btn-secondary zd-resolve" data-id="${esc(String(w.deliveryID))}" style="padding:3px 10px;font-size:11px;margin-left:6px">Mark Resolved</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  document.getElementById('result-body').innerHTML = `
    ${warnings.length ? `
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>Delivery</th><th>Status</th><th>Messages</th><th>Last Run</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : '<div class="sap-empty">No deliveries currently have a failed or warning ZDELFLAG/ZDELPACK run.</div>'}
  `;

  document.querySelectorAll('.zd-reprocess').forEach(btn => {
    btn.addEventListener('click', () => zdReprocess(btn.dataset.id, btn));
  });
  document.querySelectorAll('.zd-resolve').forEach(btn => {
    btn.addEventListener('click', () => zdResolve(btn.dataset.id, btn));
  });
}

async function zdReprocess(deliveryId, btn) {
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Reprocessing…';
  try {
    const r = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/zdelflag/reprocess`, { method: 'POST' });
    const json = await r.json();
    if (!r.ok || json.success === false) {
      throw new Error(json.error || 'Reprocess failed');
    }
    runZdelflagWarnings();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function zdResolve(deliveryId, btn) {
  if (!await wConfirm({
    title: 'Mark as Resolved',
    message: `Mark Delivery #${deliveryId}'s ZDELFLAG/ZDELPACK warning as manually resolved?\nThis removes it from the warnings list without re-attempting the SAP call — only do this if the issue was already fixed directly in SAP.`,
    confirmText: 'Mark Resolved',
    variant: 'success',
  })) return;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Resolving…';
  try {
    const r = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/zdelflag/resolve`, { method: 'POST' });
    const json = await r.json();
    if (!r.ok || json.success === false) {
      throw new Error(json.error || 'Resolve failed');
    }
    runZdelflagWarnings();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ── Goods Issue Warnings ─────────────────────────────────────────────────────
// Lists deliveries whose latest Goods Issue posting (BAPI_DELIVERYPROCESSING_
// EXEC, fired automatically in deliverymain.js's runGoodsIssueApproval right
// after ZDELFLAG/ZDELPACK maintenance succeeds — no manual approval step)
// came back Failed, with a Reprocess action. A delivery drops off this list
// the moment a reprocess attempt records Success. Mirrors the ZDELFLAG
// Warnings panel above exactly.
async function runGoodsIssueWarnings() {
  if (!await checkSession()) return;
  showResultPanel('Goods Issue Warnings', 'Deliveries where automatic Goods Issue posting failed');
  try {
    const r = await fetch('/api/deliverymain/goods-issue/warnings');
    const json = await r.json();
    if (json.success === false) throw new Error(json.error || 'Failed to load Goods Issue warnings');
    giRenderWarnings(json.data || []);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
  pollGoodsIssueWarnCount();
}

function giRenderWarnings(warnings) {
  const canResolve = sessionRole === 'superadmin' || sessionPermissions.includes('LOG_SUPER');
  const rows = warnings.map(w => {
    const msgText = (w.messages || []).length
      ? w.messages.map(m => {
          const type = esc(String(m.type || '').trim());
          const text = esc(String(m.message || '').trim());
          return type
            ? `<span style="color:var(--text-muted);font-family:'JetBrains Mono',monospace;font-size:10px">[${type}]</span> ${text || '<span style="color:var(--text-muted)">(no message text)</span>'}`
            : (text || '<span style="color:var(--text-muted)">(no message text)</span>');
        }).join('<br>')
      : '<span style="color:var(--text-muted)">—</span>';
    return `
    <tr class="admin-row">
      <td><strong>${esc(String(w.deliveryID))}</strong></td>
      <td><span class="tile-badge tile-badge--overdue" style="position:static;display:inline-block">${esc(w.status)}</span></td>
      <td style="max-width:420px">${msgText}</td>
      <td>${spFormatDate(w.ranAtUtc)}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn-secondary gi-reprocess" data-id="${esc(String(w.deliveryID))}" style="padding:3px 10px;font-size:11px">Reprocess</button>
        ${canResolve ? `<button class="btn-secondary gi-resolve" data-id="${esc(String(w.deliveryID))}" style="padding:3px 10px;font-size:11px;margin-left:6px">Mark Resolved</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  document.getElementById('result-body').innerHTML = `
    ${warnings.length ? `
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>Delivery</th><th>Status</th><th>Messages</th><th>Last Run</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : '<div class="sap-empty">No deliveries currently have a failed Goods Issue posting.</div>'}
  `;

  document.querySelectorAll('.gi-reprocess').forEach(btn => {
    btn.addEventListener('click', () => giReprocess(btn.dataset.id, btn));
  });
  document.querySelectorAll('.gi-resolve').forEach(btn => {
    btn.addEventListener('click', () => giResolve(btn.dataset.id, btn));
  });
}

async function giReprocess(deliveryId, btn) {
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Reprocessing…';
  try {
    const r = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/goods-issue/reprocess`, { method: 'POST' });
    const json = await r.json();
    if (!r.ok || json.success === false) {
      throw new Error(json.error || 'Reprocess failed');
    }
    runGoodsIssueWarnings();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function giResolve(deliveryId, btn) {
  if (!await wConfirm({
    title: 'Mark as Resolved',
    message: `Mark Delivery #${deliveryId}'s Goods Issue warning as manually resolved?\nThis removes it from the warnings list without re-attempting the SAP call — only do this if Goods Issue was already posted directly in SAP.`,
    confirmText: 'Mark Resolved',
    variant: 'success',
  })) return;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Resolving…';
  try {
    const r = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/goods-issue/resolve`, { method: 'POST' });
    const json = await r.json();
    if (!r.ok || json.success === false) {
      throw new Error(json.error || 'Resolve failed');
    }
    runGoodsIssueWarnings();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ── Stock Count (Weekly PTFE Cycle Count / Full Warehouse Raw Material Scan /
// Production Count) ──────────────────────────────────────────────────────────
//
// Shared entry-form + line-table renderer across the three document-backed
// count types (PTFE_WEEKLY/RAW_MATERIAL/PRODUCTION) — they differ only in
// which location fields the entry form shows and whether "Start New Count"/
// bin-completion are available. Finished Goods Count is a separate guided-
// scan pipeline with no approval/posting, built in its own stage. See
// routes/stockcount.js for the backing API.
//
// The same render functions back two different homes: the operator-facing
// tiles (Full Warehouse Raw Material Scan / Production Count / Finished
// Goods Count — pure entry/scanning, no start/close/reopen controls) and
// the supervisor-only "Stock Count Administration" tile (start/close/reopen
// counts and Finished Goods sessions — see runStockCountAdmin below).
// scContainerId/scIsAdmin are set once by whichever entry point is called
// and read by every render/handler in between, rather than threading a
// container id and an admin flag through every function signature — safe
// because only one Stock Count view is ever mounted in the DOM at a time.
let scContainerId = 'result-body';
let scIsAdmin     = false;
function scResultBody() { return document.getElementById(scContainerId); }

async function scApi(path, opts) {
  const r = await fetch('/api/stockcount' + path, opts);
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON body */ }
  if (json?.success === false || !r.ok) {
    throw new Error(json?.error || `Request failed (HTTP ${r.status})`);
  }
  return json;
}

function scFormatDate(value) {
  return value ? new Date(value).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
}

const SC_STATUS_LABEL = {
  Open: 'Open', PendingApproval: 'Pending Approval', Approved: 'Approved',
  Rejected: 'Rejected', Posted: 'Posted', Cancelled: 'Cancelled', Closed: 'Closed',
};
const SC_STATUS_COLOR = {
  Open: '#2563EB', PendingApproval: '#B45309', Approved: '#059669',
  Rejected: '#DC2626', Posted: '#059669', Cancelled: '#6B7280', Closed: '#6B7280',
};
function scStatusBadge(status) {
  return `<span style="color:${SC_STATUS_COLOR[status] || '#6B7280'};font-weight:700">${esc(SC_STATUS_LABEL[status] || status)}</span>`;
}

// Finished Goods (LQUA storage location 1711) storage-type → friendly area
// label, confirmed by the warehouse supervisor — anything not in this map is
// a system-generated/misconfigured storage type, not a real FG area, so it's
// deliberately labelled "Discrepancy" rather than left as a bare SAP code.
const FG_STORAGE_TYPE_LABEL = { '916': 'Picked', 'RO': 'Warehouse', 'FR': 'Cut Piece Boxes', '901': 'Production' };
function fgStorageTypeLabel(code) {
  if (!code) return '—';
  return FG_STORAGE_TYPE_LABEL[code] || 'Discrepancy';
}
function fgAreaCell(storageType, bin) {
  if (!storageType && !bin) return '—';
  const label = fgStorageTypeLabel(storageType);
  const isDiscrepancy = storageType && !FG_STORAGE_TYPE_LABEL[storageType];
  return `${esc([storageType, bin].filter(Boolean).join('/'))} <span style="color:${isDiscrepancy ? '#DC2626' : 'var(--text-secondary,#666)'};font-size:11px">(${esc(label)})</span>`;
}

// ── Weekly PTFE Cycle Count ────────────────────────────────────────────────────

async function runPtfeCycleCount() {
  if (!await checkSession()) return;
  scContainerId = 'result-body'; scIsAdmin = false;
  showResultPanel('Weekly PTFE Cycle Count', 'This week’s cycle count — enter material, quantity & location');
  try {
    const json = await scApi('/counts/current-ptfe');
    scRenderCountDetail(json.data, 'runPtfeCycleCount');
  } catch (err) {
    scResultBody().innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

// ── Full Warehouse Raw Material Scan ──────────────────────────────────────────
//
// Operator-facing — entry only (pick an open count, add lines). Starting a
// new count and closing (submitting) it are supervisor actions, moved to
// the "Stock Count Administration" tile — see runStockCountAdmin below.

async function runRawMaterialCount() {
  if (!await checkSession()) return;
  scContainerId = 'result-body'; scIsAdmin = false;
  showResultPanel('Full Warehouse Raw Material Scan', 'Storage Location 1710 — enter material, quantity & bin against an open count');
  await scRenderCountList('RAW_MATERIAL', '1710', 'runRawMaterialCount');
}

// ── Production Count ───────────────────────────────────────────────────────────

async function runProductionCount() {
  if (!await checkSession()) return;
  scContainerId = 'result-body'; scIsAdmin = false;
  showResultPanel('Production Count', 'Storage Location 1716 — enter material & quantity against an open count (non-batch-managed materials only)');
  await scRenderCountList('PRODUCTION', '1716', 'runProductionCount');
}

async function scRenderCountList(countType, defaultStorageLocation, backFn) {
  const body = scResultBody();
  try {
    // Operators only ever need to see counts they can currently add lines
    // to; the admin view (scIsAdmin) lists every status so a supervisor can
    // see what's pending/closed too.
    const json = await scApi(`/counts?type=${countType}${scIsAdmin ? '' : '&status=Open'}`);
    const counts = json.data || [];

    const startForm = scIsAdmin ? `
      <div class="tf-section-label">Start New Count</div>
      <form class="tf-row" id="sc-start-form" data-storage-location="${esc(defaultStorageLocation)}" data-count-type="${esc(countType)}" data-back-fn="${esc(backFn)}">
        <div class="tf-field">
          <label class="tf-label">Storage Location <span class="tf-req">*</span></label>
          <input class="tf-input" name="storageLocation" value="${esc(defaultStorageLocation)}" required>
        </div>
        <div class="tf-field" style="align-self:flex-end">
          <button class="btn-submit" type="submit">Start Count</button>
        </div>
      </form>
      <div id="sc-start-result"></div>
    ` : '';

    const rows = counts.length ? counts.map(c => `
      <tr class="admin-row sc-count-row" style="cursor:pointer" data-id="${c.CountId}">
        <td>#${c.CountId}</td>
        <td>${scStatusBadge(c.Status)}</td>
        <td>${esc(c.CreatedBy || '—')}</td>
        <td>${scFormatDate(c.CreatedAtUtc)}</td>
      </tr>`).join('') : `<tr><td colspan="4" class="sap-empty">${scIsAdmin ? 'No counts yet.' : 'No open counts right now — ask a supervisor to start one.'}</td></tr>`;

    body.innerHTML = `
      ${startForm}
      <div class="tf-section-label">Counts</div>
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>Count</th><th>Status</th><th>Started By</th><th>Started</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    const startFormEl = document.getElementById('sc-start-form');
    if (startFormEl) startFormEl.addEventListener('submit', scSubmitStartCount);

    body.querySelectorAll('.sc-count-row').forEach(tr => {
      tr.addEventListener('click', async () => {
        try {
          const detailJson = await scApi(`/counts/${tr.dataset.id}`);
          scRenderCountDetail(detailJson.data, backFn);
        } catch (err) {
          alert(err.message);
        }
      });
    });
  } catch (err) {
    body.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function scSubmitStartCount(e) {
  e.preventDefault();
  const form = e.target;
  const countType = form.dataset.countType;
  const backFn = form.dataset.backFn;
  const storageLocation = form.storageLocation.value.trim();
  const resultEl = document.getElementById('sc-start-result');

  try {
    await scApi('/counts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ countType, storageLocation }),
    });
    window[backFn]?.();
  } catch (err) {
    if (resultEl) resultEl.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

// ── Count detail (entry form + lines) — shared across all three types ─────────

async function scReloadCountDetail(countId, backFn) {
  const json = await scApi(backFn === 'runPtfeCycleCount' ? '/counts/current-ptfe' : `/counts/${countId}`);
  scRenderCountDetail(json.data, backFn);
}

function scRenderCountDetail(doc, backFn) {
  const isOpen = doc.Status === 'Open';
  const lines = doc.lines || [];
  const invalidCount = lines.filter(l => l.IsInvalidMaterial).length;

  // PTFE and Raw Material both take a free-typed storage type/bin — PTFE's
  // is validated live against SAP LAGP server-side (POST .../lines), no
  // supervisor-maintained mapping involved.
  const locationField = (doc.CountType === 'PTFE_WEEKLY' || doc.CountType === 'RAW_MATERIAL')
    ? `<div class="tf-field"><label class="tf-label">Storage Type <span class="tf-req">*</span></label><input class="tf-input" name="storageType" maxlength="3" required></div>
       <div class="tf-field"><label class="tf-label">Bin <span class="tf-req">*</span></label><input class="tf-input" name="bin" maxlength="10" required></div>`
    : '';

  // Per-LINE, not per-count — every physical lot counted on paper gets its
  // own ticket + label, so this is entered alongside each line, not once at
  // count start. RAW_MATERIAL/PRODUCTION only, matches the original spec.
  const hasTicketPerLine = doc.CountType === 'RAW_MATERIAL' || doc.CountType === 'PRODUCTION';
  const ticketField = hasTicketPerLine
    ? `<div class="tf-field"><label class="tf-label">Ticket Number <span class="tf-optional">(optional — paper lot reference)</span></label><input class="tf-input" name="ticketNumber" placeholder="e.g. TKT-1042"></div>`
    : '';

  const entryForm = isOpen ? `
    <div class="tf-section-label">Add Line</div>
    <form class="tf-row" id="sc-line-form">
      <div class="tf-field"><label class="tf-label">Material <span class="tf-req">*</span></label><input class="tf-input" name="material" required></div>
      ${locationField}
      ${ticketField}
      <div class="tf-field"><label class="tf-label">Counted Qty <span class="tf-req">*</span></label><input class="tf-input" type="number" step="any" min="0" name="countedQty" required></div>
      <div class="tf-field" style="align-self:flex-end"><button class="btn-submit" type="submit">+ Add Line</button></div>
    </form>
    <div id="sc-line-result"></div>
  ` : '';

  const linesRows = lines.length ? lines.map(l => `
    <tr class="pn-row${l.IsInvalidMaterial ? ' sc-invalid-row' : ''}">
      <td><strong>${esc(l.Material)}</strong>${l.MaterialText ? `<div style="font-size:11px;color:var(--text-secondary,#666)">${esc(l.MaterialText)}</div>` : ''}${l.IsInvalidMaterial ? '<div style="font-size:11px;color:#DC2626;font-weight:700">Invalid material</div>' : ''}</td>
      <td>${esc(l.NamedLocation || [l.StorageType, l.Bin].filter(Boolean).join('/') || '—')}</td>
      ${hasTicketPerLine ? `<td>${esc(l.TicketNumber || '—')}</td>` : ''}
      <td>${Number(l.CountedQty).toLocaleString()} ${esc(l.Uom || '')}</td>
      <td>${l.SapQty != null ? Number(l.SapQty).toLocaleString() : '—'}</td>
      <td>${l.VarianceQty != null ? `<span style="color:${Number(l.VarianceQty) === 0 ? 'inherit' : (Number(l.VarianceQty) > 0 ? '#059669' : '#DC2626')};font-weight:${Number(l.VarianceQty) === 0 ? 400 : 700}">${Number(l.VarianceQty) > 0 ? '+' : ''}${Number(l.VarianceQty).toLocaleString()}</span>` : '—'}</td>
    </tr>`).join('') : `<tr><td colspan="${hasTicketPerLine ? 6 : 5}" class="sap-empty">No lines entered yet.</td></tr>`;

  // Reopen (like Submit below) is a Stock Count Administration action —
  // only rendered when reached via that tile (scIsAdmin), not the
  // operator-facing entry tile, even for a supervisor who happens to be
  // browsing there. Server-side permission enforcement (POST
  // /counts/:id/reopen is LOG_SUPER-gated) is the real backstop either way.
  const rejectionNotice = doc.Status === 'Rejected' ? `
    <div class="sap-error" style="margin-bottom:12px">
      Rejected by finance: ${esc(doc.RejectionReason || '')}
      ${scIsAdmin ? `<button class="btn-submit" type="button" id="sc-reopen-btn" style="margin-left:12px">Reopen for correction</button>` : ''}
    </div>` : '';

  // Accuracy stat — warehouse-facing (was stock in the right place/quantity),
  // deliberately separate from finance's value-of-variance framing on the
  // Stock Adjustments tile (routes/stockcountsql.js's getCountReportByMaterial
  // feeds that one instead).
  const comparedLines = lines.filter(l => l.VarianceQty !== null && l.VarianceQty !== undefined);
  const accurateLines = comparedLines.filter(l => Number(l.VarianceQty) === 0);
  const accuracyPct = comparedLines.length ? Math.round((accurateLines.length / comparedLines.length) * 100) : null;

  // Submitting (closing) RAW_MATERIAL/PRODUCTION is a supervisor action —
  // only shown via the Stock Count Administration tile (scIsAdmin). PTFE
  // stays open to any operator (cron-created, not supervisor-initiated —
  // see routes/stockcount.js's POST /counts/:id/submit comment).
  const canSubmitHere = doc.CountType === 'PTFE_WEEKLY' || scIsAdmin;

  scResultBody().innerHTML = `
    <div class="tf-row" style="margin-bottom:10px">
      <div class="tf-field"><label class="tf-label">Count</label><div>#${doc.CountId}</div></div>
      <div class="tf-field"><label class="tf-label">Status</label><div>${scStatusBadge(doc.Status)}</div></div>
      ${doc.StorageLocation ? `<div class="tf-field"><label class="tf-label">Storage Location</label><div>${esc(doc.StorageLocation)}</div></div>` : ''}
      ${doc.WeekStartDate ? `<div class="tf-field"><label class="tf-label">Week</label><div>${scFormatDate(doc.WeekStartDate)}</div></div>` : ''}
      ${accuracyPct !== null ? `<div class="tf-field"><label class="tf-label">Stock Accuracy</label><div style="color:${accuracyPct === 100 ? '#059669' : (accuracyPct >= 90 ? '#B45309' : '#DC2626')};font-weight:700">${accuracyPct}% <span style="font-weight:400;color:var(--text-secondary,#666)">(${accurateLines.length}/${comparedLines.length} lines matched SAP)</span></div></div>` : ''}
    </div>
    ${rejectionNotice}
    ${entryForm}
    <div class="tf-section-label">Lines ${invalidCount ? `<span style="color:#DC2626">— ${invalidCount} invalid material line${invalidCount === 1 ? '' : 's'} must be corrected before submission</span>` : ''}</div>
    <div style="overflow-x:auto;margin-bottom:14px">
      <table class="pn-batch-table admin-table">
        <thead><tr><th>Material</th><th>Location</th>${hasTicketPerLine ? '<th>Ticket</th>' : ''}<th>Counted</th><th>SAP Qty</th><th>Variance</th></tr></thead>
        <tbody>${linesRows}</tbody>
      </table>
    </div>
    ${invalidCount ? `<div id="sc-invalid-materials"></div>` : ''}
    ${isOpen && canSubmitHere ? `<button class="btn-submit" type="button" id="sc-submit-btn">Submit for Approval</button>` : ''}
    ${(scIsAdmin || doc.CountType === 'PTFE_WEEKLY') && sessionPermissions.includes('LOG_SUPER') && lines.length ? `<button class="btn-back-tiles" type="button" id="sc-recompute-btn" style="margin-left:8px" title="Re-derives every line's variance from what's already stored — fixes counts with lines entered before the group-variance fix, no live SAP calls">Recompute Variances</button>` : ''}
    <div id="sc-recompute-result" style="margin-top:10px"></div>
  `;

  const lineForm = document.getElementById('sc-line-form');
  if (lineForm) lineForm.addEventListener('submit', (e) => scSubmitLine(e, doc, backFn));

  const submitBtn = document.getElementById('sc-submit-btn');
  if (submitBtn) submitBtn.addEventListener('click', () => scSubmitCountForApproval(doc, backFn));

  const reopenBtn = document.getElementById('sc-reopen-btn');
  if (reopenBtn) reopenBtn.addEventListener('click', () => scReopenCount(doc, backFn));

  const recomputeBtn = document.getElementById('sc-recompute-btn');
  if (recomputeBtn) recomputeBtn.addEventListener('click', () => scRecomputeVariances(doc, backFn));

  if (invalidCount) scRenderInvalidMaterials(doc, backFn);
}

// Multiple lines for the same material/bin used to each get compared
// independently against the same full SAP quantity — see addCountLine's
// header comment in stockcountsql.js. This re-derives every line's
// variance from what's already stored (no live SAP calls), for counts that
// have lines entered before that fix went in.
async function scRecomputeVariances(doc, backFn) {
  const resultEl = document.getElementById('sc-recompute-result');
  try {
    const json = await scApi(`/counts/${doc.CountId}/recompute`, { method: 'POST' });
    // Reload first (scReloadCountDetail replaces the whole panel, including
    // this message's own container), then show the result — the reverse
    // order would flash the message for a moment before it's wiped out.
    await scReloadCountDetail(doc.CountId, backFn);
    alert(`Recomputed ${json.data.lineCount} line(s) across ${json.data.groupCount} material/location group(s).`);
  } catch (err) {
    if (resultEl) resultEl.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function scSubmitLine(e, doc, backFn) {
  e.preventDefault();
  const form = e.target;
  const resultEl = document.getElementById('sc-line-result');
  const body = {
    material: form.material.value.trim(),
    countedQty: form.countedQty.value,
  };
  if (form.storageType)  body.storageType  = form.storageType.value.trim();
  if (form.bin)           body.bin           = form.bin.value.trim();
  if (form.ticketNumber)   body.ticketNumber   = form.ticketNumber.value.trim() || undefined;

  try {
    const json = await scApi(`/counts/${doc.CountId}/lines`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (json.data.redirectToFinishedGoodsCount) {
      alert(`${body.material} is batch-managed — this material should be entered via Finished Goods Count instead. The line has still been saved here for the record.`);
    } else if (json.data.isInvalidMaterial) {
      alert(`"${body.material}" did not validate against the material master — it has been saved but will need correcting in the Invalid Materials section below before this count can be submitted.`);
    }
    await scReloadCountDetail(doc.CountId, backFn);
  } catch (err) {
    if (resultEl) resultEl.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function scSubmitCountForApproval(doc, backFn) {
  if (!confirm('Submit this count for finance approval? No more lines can be added once submitted.')) return;
  try {
    await scApi(`/counts/${doc.CountId}/submit`, { method: 'POST' });
    await scReloadCountDetail(doc.CountId, backFn);
  } catch (err) {
    alert(err.message);
  }
}

async function scReopenCount(doc, backFn) {
  try {
    await scApi(`/counts/${doc.CountId}/reopen`, { method: 'POST' });
    await scReloadCountDetail(doc.CountId, backFn);
  } catch (err) {
    alert(err.message);
  }
}

// ── Invalid Materials — fuzzy-match correction ────────────────────────────────

async function scRenderInvalidMaterials(doc, backFn) {
  const container = document.getElementById('sc-invalid-materials');
  if (!container) return;
  try {
    const json = await scApi(`/counts/${doc.CountId}/invalid-lines`);
    const lines = json.data || [];

    container.innerHTML = `
      <div class="tf-section-label">Invalid Materials</div>
      <div style="overflow-x:auto;margin-bottom:14px">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>Entered As</th><th>Counted Qty</th><th>Suggestions</th><th>Correct To</th></tr></thead>
          <tbody>
            ${lines.map(l => `
              <tr class="pn-row" data-line-id="${l.LineId}">
                <td><strong>${esc(l.Material)}</strong></td>
                <td>${Number(l.CountedQty).toLocaleString()}</td>
                <td>${(l.suggestions || []).map(s => `<button type="button" class="btn-back-tiles sc-suggestion-btn" data-line-id="${l.LineId}" data-material="${esc(s.material)}" style="margin:2px">${esc(s.material)}${s.materialText ? ` — ${esc(s.materialText)}` : ''}</button>`).join('') || '<span class="toolbar-hint">No close matches found</span>'}</td>
                <td>
                  <input class="tf-input sc-correct-input" data-line-id="${l.LineId}" style="width:120px" placeholder="Correct material">
                  <button type="button" class="btn-submit sc-correct-btn" data-line-id="${l.LineId}">Save</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    container.querySelectorAll('.sc-suggestion-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = container.querySelector(`.sc-correct-input[data-line-id="${btn.dataset.lineId}"]`);
        if (input) input.value = btn.dataset.material;
      });
    });

    container.querySelectorAll('.sc-correct-btn').forEach(btn => {
      btn.addEventListener('click', () => scCorrectInvalidLine(doc, backFn, btn.dataset.lineId, container));
    });
  } catch (err) {
    container.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function scCorrectInvalidLine(doc, backFn, lineId, container) {
  const input = container.querySelector(`.sc-correct-input[data-line-id="${lineId}"]`);
  const material = input?.value.trim();
  if (!material) { alert('Enter the correct material code first.'); return; }
  try {
    await scApi(`/counts/${doc.CountId}/invalid-lines/${lineId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ material }),
    });
    await scReloadCountDetail(doc.CountId, backFn);
  } catch (err) {
    alert(err.message);
  }
}

// ── Finished Goods Count (guided batch/bin scan) ──────────────────────────────
//
// Separate pipeline from the PTFE/Raw Material/Production counts above — no
// document/line/approval flow, no SAP posting. Mismatches are recorded as
// discrepancies resolved via Transfer Order from the Stock Investigations
// tile's new "Stock Count Discrepancies" panel, below.

let fgBatchMap    = {};   // batch -> material, downloaded once per session load
let fgScanStep    = 'batch';
let fgPendingBatch = null;
let fgToastTimer   = null;

async function runFinishedGoodsCount() {
  if (!await checkSession()) return;
  showResultPanel('Finished Goods Count', 'Guided batch & bin scan against SAP warehouse management');
  try {
    const sessionJson = await scApi('/fg/session/current');
    if (!sessionJson.data) { fgRenderNoSession(); return; }
    await fgLoadBatches();
    fgRenderScanUI(sessionJson.data);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

// Starting a session is a Stock Count Administration action (see
// scaRenderFgSessionAdmin) — this operator-facing tile just reports there
// isn't one open yet, it never offers to start one itself.
function fgRenderNoSession() {
  document.getElementById('result-body').innerHTML = `
    <div class="sap-empty">No Finished Goods Count session is currently open.</div>
    <div class="toolbar-hint">Ask a warehouse supervisor to start one from Stock Count Administration.</div>
  `;
}

let fgBatchRows = []; // raw downloaded rows, kept alongside fgBatchMap for the by-area summary below

async function fgLoadBatches() {
  const json = await scApi('/fg/batches');
  fgBatchRows = json.data || [];
  fgBatchMap = {};
  fgBatchRows.forEach(row => {
    if (row.batch && !fgBatchMap[row.batch]) fgBatchMap[row.batch] = row.material;
  });
}

// "Reports" breakdown by storage type — see FG_STORAGE_TYPE_LABEL above.
// Anything outside the four known areas is flagged as a Discrepancy so it's
// visible before the operator even starts scanning, not just after.
function fgRenderAreaSummary() {
  const byType = {};
  fgBatchRows.forEach(row => {
    const key = row.storageType || '—';
    byType[key] = byType[key] || { count: 0, qty: 0 };
    byType[key].count += 1;
    byType[key].qty += Number(row.availableQty) || 0;
  });
  const rows = Object.entries(byType).sort(([a], [b]) => a.localeCompare(b)).map(([type, stats]) => `
    <tr class="pn-row">
      <td>${fgAreaCell(type, '')}</td>
      <td>${stats.count.toLocaleString()}</td>
      <td>${stats.qty.toLocaleString()}</td>
    </tr>`).join('');

  return `
    <div class="tf-section-label" style="margin-top:24px">Downloaded Stock by Area</div>
    <div style="overflow-x:auto;margin-bottom:14px">
      <table class="pn-batch-table admin-table">
        <thead><tr><th>Storage Type</th><th>Batches</th><th>Total Qty</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" class="sap-empty">No batch-managed stock downloaded.</td></tr>'}</tbody>
      </table>
    </div>`;
}

function fgRenderScanUI(session) {
  fgScanStep = 'batch';
  fgPendingBatch = null;

  // Ending the session is a Stock Count Administration action (see
  // scaRenderFgSessionAdmin) — not offered from this operator-facing scan
  // screen, even for a supervisor who happens to be scanning here too.
  document.getElementById('result-body').innerHTML = `
    <div class="tf-row" style="margin-bottom:14px">
      <div class="tf-field"><label class="tf-label">Session</label><div>#${session.CountId} — Storage Location ${esc(session.StorageLocation)} (${Object.keys(fgBatchMap).length} batches downloaded)</div></div>
    </div>
    ${fgRenderAreaSummary()}

    <div class="tf-section-label" id="fg-scan-label">Scan Batch Number</div>
    <form id="fg-scan-form" class="tf-row" autocomplete="off">
      <div class="tf-field"><input class="tf-input" id="fg-scan-input" autocomplete="off" placeholder="Scan or type…"></div>
    </form>
    <div id="fg-scan-toast"></div>

    <div class="tf-section-label" style="margin-top:24px">Confirm Bin Fully Scanned</div>
    <div class="toolbar-hint" style="margin-bottom:8px">Once every batch physically in a bin has been scanned, confirm it here — anything SAP still shows in that bin that was never scanned gets sent to Stock Investigations as missing.</div>
    <form id="fg-confirm-form" class="tf-row">
      <div class="tf-field"><label class="tf-label">Storage Type</label><input class="tf-input" name="storageType" maxlength="3" required></div>
      <div class="tf-field"><label class="tf-label">Bin</label><input class="tf-input" name="bin" maxlength="10" required></div>
      <div class="tf-field" style="align-self:flex-end"><button class="btn-submit" type="submit">Confirm Bin</button></div>
    </form>
    <div id="fg-confirm-result"></div>
  `;

  document.getElementById('fg-scan-form').addEventListener('submit', fgHandleScanStep);
  document.getElementById('fg-confirm-form').addEventListener('submit', fgHandleConfirmBin);
  fgFocusScanInput();
}

function fgFocusScanInput() {
  const input = document.getElementById('fg-scan-input');
  if (input) { input.value = ''; input.focus(); }
}

// Two-step scan cycle (batch, then bin) — a single focused input per step,
// keyboard-wedge-scanner friendly (submits on Enter). Auto-advances back to
// the batch step after every scan, correct or not, so the operator never
// has to click anything mid-run.
function fgHandleScanStep(e) {
  e.preventDefault();
  const input = document.getElementById('fg-scan-input');
  const value = input.value.trim();
  if (!value) return;

  if (fgScanStep === 'batch') {
    const material = fgBatchMap[value];
    if (!material) {
      fgShowToast(`Batch "${value}" isn't in the downloaded batch list for this session — check it's a valid finished-goods batch.`, false);
      fgFocusScanInput();
      return;
    }
    fgPendingBatch = { batch: value, material };
    fgScanStep = 'bin';
    document.getElementById('fg-scan-label').textContent = `Batch ${value} — Scan Bin`;
    fgFocusScanInput();
    return;
  }

  fgSubmitScan(fgPendingBatch.material, fgPendingBatch.batch, value);
}

async function fgSubmitScan(material, batch, binValue) {
  // Accepts "STORAGETYPE BIN" / "STORAGETYPE/BIN" / "STORAGETYPE-BIN" — same
  // separators a warehouse bin label barcode would encode.
  const parts = binValue.split(/[\s/-]+/).filter(Boolean);
  const scannedStorageType = parts.length > 1 ? parts[0] : '';
  const scannedBin = parts.length > 1 ? parts.slice(1).join('') : parts[0];

  const resetToStep1 = () => {
    fgScanStep = 'batch';
    fgPendingBatch = null;
    document.getElementById('fg-scan-label').textContent = 'Scan Batch Number';
    fgFocusScanInput();
  };

  if (!scannedStorageType || !scannedBin) {
    fgShowToast('Enter both storage type and bin, e.g. "FG1 B01".', false);
    resetToStep1();
    return;
  }

  try {
    const json = await scApi('/fg/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ material, batch, scannedStorageType, scannedBin }),
    });
    const { outcome, expectedStorageType, expectedBin } = json.data;
    if (outcome === 'CorrectBin') {
      fgShowToast(`✓ ${batch} confirmed in ${scannedStorageType}/${scannedBin}`, true);
    } else {
      fgShowToast(`✕ ${batch} scanned in ${scannedStorageType}/${scannedBin} — SAP expects ${expectedBin ? `${expectedStorageType}/${expectedBin}` : 'a different bin'}. Sent to Stock Investigations.`, false);
    }
  } catch (err) {
    fgShowToast(err.message, false);
  }

  resetToStep1();
}

// Non-modal toast — a blocking alert()/modal here would break the
// scan-scan-scan rhythm the auto-advance is built for.
function fgShowToast(message, success) {
  const el = document.getElementById('fg-scan-toast');
  if (!el) return;
  el.innerHTML = `<div style="margin-top:10px;padding:10px 14px;border-radius:6px;font-weight:600;background:${success ? '#DCFCE7' : '#FEE2E2'};color:${success ? '#166534' : '#991B1B'}">${esc(message)}</div>`;
  clearTimeout(fgToastTimer);
  fgToastTimer = setTimeout(() => { el.innerHTML = ''; }, 4000);
}

async function fgHandleConfirmBin(e) {
  e.preventDefault();
  const form = e.target;
  const storageType = form.storageType.value.trim();
  const bin = form.bin.value.trim();
  const resultEl = document.getElementById('fg-confirm-result');
  try {
    const json = await scApi(`/fg/bins/${encodeURIComponent(storageType)}/${encodeURIComponent(bin)}/confirm`, { method: 'POST' });
    resultEl.innerHTML = `<div class="toolbar-hint">Bin confirmed — ${json.data.missingCount} batch(es) not scanned here were sent to Stock Investigations as missing.</div>`;
  } catch (err) {
    resultEl.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

// ── Stock Count Administration (supervisor-only tile) ─────────────────────────
//
// Everything an operator's entry tile deliberately doesn't show: starting
// and closing (submitting) Raw Material/Production counts, starting/ending
// Finished Goods sessions, and the warehouse-facing Stock Count Accuracy
// report. Lives in #supervisor-section (LOG_SUPER-only, same as Stock
// Investigations) — see setupSupervisorSection. Reuses scRenderCountList/
// scRenderCountDetail with scContainerId='sca-subview'/scIsAdmin=true so a
// supervisor gets the Start/Submit/Reopen controls those functions hide
// from the operator tiles.

async function runStockCountAdmin() {
  if (!await checkSession()) return;
  showResultPanel('Stock Count Administration', 'Start and close counts, manage Finished Goods sessions, and view the accuracy report — supervisor only');
  scaRenderHome();
}

function scaRenderHome() {
  document.getElementById('result-body').innerHTML = `
    <div class="tf-row" style="flex-wrap:wrap;margin-bottom:20px">
      <button type="button" class="btn-submit" id="sca-raw-material-btn">Raw Material Counts</button>
      <button type="button" class="btn-submit" id="sca-production-btn">Production Counts</button>
      <button type="button" class="btn-submit" id="sca-fg-btn">Finished Goods Sessions</button>
      <button type="button" class="btn-submit" id="sca-reports-btn">Stock Count Accuracy Report</button>
    </div>
    <div id="sca-subview"></div>
  `;
  document.getElementById('sca-raw-material-btn').addEventListener('click', scaRenderRawMaterialAdmin);
  document.getElementById('sca-production-btn').addEventListener('click', scaRenderProductionAdmin);
  document.getElementById('sca-fg-btn').addEventListener('click', scaRenderFgSessionAdmin);
  document.getElementById('sca-reports-btn').addEventListener('click', scaRenderAccuracyReport);
}

async function scaRenderRawMaterialAdmin() {
  document.getElementById('sca-subview').innerHTML = '<div class="sap-loading"><div class="spinner"></div>Loading…</div>';
  scContainerId = 'sca-subview'; scIsAdmin = true;
  await scRenderCountList('RAW_MATERIAL', '1710', 'scaRenderRawMaterialAdmin');
}

async function scaRenderProductionAdmin() {
  document.getElementById('sca-subview').innerHTML = '<div class="sap-loading"><div class="spinner"></div>Loading…</div>';
  scContainerId = 'sca-subview'; scIsAdmin = true;
  await scRenderCountList('PRODUCTION', '1716', 'scaRenderProductionAdmin');
}

async function scaRenderFgSessionAdmin() {
  const container = document.getElementById('sca-subview');
  container.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Loading…</div>';
  try {
    const json = await scApi('/fg/session/current');
    scaRenderFgSessionAdminView(json.data);
  } catch (err) {
    container.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

function scaRenderFgSessionAdminView(session) {
  const container = document.getElementById('sca-subview');

  if (!session) {
    container.innerHTML = `
      <div class="sap-empty">No Finished Goods Count session is currently open.</div>
      <div class="tf-section-label">Start Count Session</div>
      <form class="tf-row" id="sca-fg-start-form">
        <div class="tf-field"><label class="tf-label">Storage Location <span class="tf-req">*</span></label><input class="tf-input" name="storageLocation" value="1711" required></div>
        <div class="tf-field" style="align-self:flex-end"><button class="btn-submit" type="submit">Start Session</button></div>
      </form>
      <div id="sca-fg-start-result"></div>
    `;
    document.getElementById('sca-fg-start-form').addEventListener('submit', scaSubmitFgStartSession);
    return;
  }

  container.innerHTML = `
    <div class="tf-row" style="margin-bottom:14px">
      <div class="tf-field"><label class="tf-label">Session</label><div>#${session.CountId} — Storage Location ${esc(session.StorageLocation)}</div></div>
      <div class="tf-field"><label class="tf-label">Started</label><div>${scFormatDate(session.CreatedAtUtc)} by ${esc(session.CreatedBy || '—')}</div></div>
    </div>
    <button class="btn-back-tiles" type="button" id="sca-fg-end-btn">End Count Session</button>
    <div id="sca-fg-end-result" style="margin-top:10px"></div>
  `;
  document.getElementById('sca-fg-end-btn').addEventListener('click', () => scaEndFgSession(session.CountId));
}

async function scaSubmitFgStartSession(e) {
  e.preventDefault();
  const storageLocation = e.target.storageLocation.value.trim();
  const resultEl = document.getElementById('sca-fg-start-result');
  try {
    await scApi('/fg/session/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storageLocation }),
    });
    scaRenderFgSessionAdmin();
  } catch (err) {
    if (resultEl) resultEl.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function scaEndFgSession(countId) {
  if (!confirm('End this Finished Goods Count session? This lifts the transfer-request block for its storage location.')) return;
  const resultEl = document.getElementById('sca-fg-end-result');
  try {
    await scApi(`/fg/session/${countId}/end`, { method: 'POST' });
    scaRenderFgSessionAdmin();
  } catch (err) {
    if (resultEl) resultEl.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

// ── Stock Count Accuracy Report (warehouse-facing — was stock in the right
// place/quantity, separate from finance's value-of-variance framing on the
// Stock Adjustments tile) ──────────────────────────────────────────────────

async function scaRenderAccuracyReport() {
  const container = document.getElementById('sca-subview');
  container.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Loading…</div>';
  try {
    const json = await scApi('/reports/warehouse-accuracy');
    scaRenderAccuracyReportView(json.data);
  } catch (err) {
    container.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

function scaAccuracyColor(pct) {
  if (pct === null) return 'inherit';
  return pct === 100 ? '#059669' : (pct >= 90 ? '#B45309' : '#DC2626');
}

function scaRenderAccuracyReportView(data) {
  const container = document.getElementById('sca-subview');
  const { overall, counts, byLocation } = data;
  const overallPct = overall.TotalLines ? Math.round((overall.AccurateLines / overall.TotalLines) * 100) : null;

  const countsRows = counts.length ? counts.map(c => {
    const pct = c.TotalLines ? Math.round((c.AccurateLines / c.TotalLines) * 100) : null;
    return `
      <tr class="pn-row">
        <td>#${c.CountId}</td>
        <td>${esc(c.CountType.replace('_', ' '))}</td>
        <td>${esc(c.StorageLocation || '—')}</td>
        <td>${scStatusBadge(c.Status)}</td>
        <td>${scFormatDate(c.SubmittedAtUtc)}</td>
        <td style="color:${scaAccuracyColor(pct)};font-weight:700">${pct !== null ? pct + '%' : '—'} <span style="font-weight:400;color:var(--text-secondary,#666)">(${c.AccurateLines}/${c.TotalLines})</span></td>
      </tr>`;
  }).join('') : `<tr><td colspan="6" class="sap-empty">No submitted counts yet.</td></tr>`;

  const locationRows = byLocation.length ? byLocation.slice(0, 20).map(l => {
    const discPct = l.TotalLines ? Math.round((l.DiscrepancyLines / l.TotalLines) * 100) : 0;
    return `
      <tr class="pn-row">
        <td>${esc([l.StorageType, l.Bin].filter(Boolean).join('/') || '—')}</td>
        <td>${l.TotalLines}</td>
        <td>${l.DiscrepancyLines}</td>
        <td style="color:${discPct > 0 ? '#DC2626' : 'inherit'};font-weight:${discPct > 0 ? 700 : 400}">${discPct}%</td>
      </tr>`;
  }).join('') : `<tr><td colspan="4" class="sap-empty">No data yet.</td></tr>`;

  container.innerHTML = `
    <div class="tf-row" style="margin-bottom:14px">
      <div class="tf-field"><label class="tf-label">Overall Accuracy</label><div style="color:${scaAccuracyColor(overallPct)};font-weight:700;font-size:18px">${overallPct !== null ? overallPct + '%' : '—'}</div></div>
      <div class="tf-field"><label class="tf-label">Lines Compared</label><div>${overall.TotalLines}</div></div>
    </div>
    <div class="tf-section-label">Accuracy by Count</div>
    <div style="overflow-x:auto;margin-bottom:20px">
      <table class="pn-batch-table admin-table">
        <thead><tr><th>Count</th><th>Type</th><th>Location</th><th>Status</th><th>Submitted</th><th>Accuracy</th></tr></thead>
        <tbody>${countsRows}</tbody>
      </table>
    </div>
    <div class="tf-section-label">Worst Locations (highest discrepancy rate)</div>
    <div style="overflow-x:auto">
      <table class="pn-batch-table admin-table">
        <thead><tr><th>Location</th><th>Lines</th><th>Discrepancies</th><th>Discrepancy Rate</th></tr></thead>
        <tbody>${locationRows}</tbody>
      </table>
    </div>
  `;
}

