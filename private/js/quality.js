'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let userPermissions = [];
let sessionUsername = '';
let sessionRole     = '';
let ctxRowData      = null;

// WM-managed storage locations that require Bin Type + Bin
const WM_LOCATIONS = new Set(['1710', '1711']);

// Pagination state for the stock table
let qAllRows      = [];
let qFilteredRows = [];
let qCurrentPage  = 1;
let qPageSize     = 25;

// Selection state
let qSelectedKeys = new Set();   // rowKey strings of selected rows
let qStockCols    = [];          // column list — kept for re-renders

function rowKey(row) {
  return [
    row['Material'],
    row['Storage Loc'],
    row['Storage Type'],
    row['Storage Bin'],
    row['Batch'],
    row['Stock Cat'],
    row['Spc Stock'],
    row['Spc Stock No'],
    row['Qty'],
  ].map(v => String(v ?? '').trim()).join('|');
}

function pruneSelectionToFilteredRows() {
  const visibleKeys = new Set(qFilteredRows.map(rowKey));
  qSelectedKeys.forEach(key => {
    if (!visibleKeys.has(key)) qSelectedKeys.delete(key);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const session = await fetch('/session-check').then(r => r.json());
    if (!session.loggedIn) { location.href = '/'; return; }
    sessionUsername = session.username    || '';
    sessionRole     = session.role        || '';
    userPermissions = session.permissions || [];
    document.getElementById('session-user').textContent = sessionUsername;
    applyPermissionVisibility();
    setupTiles();
    setupContextMenu();
  } catch { location.href = '/'; }
})();

function applyPermissionVisibility() {
  document.querySelectorAll('[data-permission]').forEach(el => {
    const code    = el.dataset.permission;
    const allowed = sessionRole === 'superadmin' || userPermissions.includes(code);
    el.style.display = allowed ? '' : 'none';
  });
}

function hasPermission(code) {
  return sessionRole === 'superadmin' || userPermissions.includes(code);
}

// ── Tile navigation ───────────────────────────────────────────────────────────
function setupTiles() {
  document.querySelectorAll('.sap-tile--live[data-fn]').forEach(tile => {
    tile.addEventListener('click', () => {
      const fn = tile.dataset.fn;
      if (fn === 'displayStock') displayStock();
      if (fn === 'blockStock')   openBlockUnblockModal('block');
      if (fn === 'unblockStock') openBlockUnblockModal('unblock');
    });
  });

  // Collapsible section headers — always start expanded, no localStorage restore
  document.querySelectorAll('.pn-section-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => {
      hdr.closest('.pn-section').classList.toggle('pn-section--collapsed');
    });
  });
}

function showResultSection(title, hint) {
  document.getElementById('tile-section').classList.add('hidden');
  document.getElementById('result-section').classList.remove('hidden');
  document.getElementById('result-title').textContent = title;
  document.getElementById('result-hint').textContent  = hint;
  document.getElementById('result-body').innerHTML =
    '<div class="sap-loading"><div class="spinner"></div>Loading…</div>';
  const badge = document.getElementById('result-row-badge');
  badge.textContent = '';
  badge.classList.add('hidden');
}

function backToTiles() {
  document.getElementById('result-section').classList.add('hidden');
  document.getElementById('tile-section').classList.remove('hidden');
  closeCtxMenu();
}

// ── Display Stock ─────────────────────────────────────────────────────────────
async function displayStock() {
  showResultSection('Display Stock', 'LQUA WH312 · right-click a row to Block or Unblock');

  try {
    const res  = await fetch('/api/sap/execute-rfc', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        functionName:     'ZRFC_READ_TABLES',
        importParameters: { DELIMITER: '|', ROWCOUNT: '9999', NO_DATA: ' ' },
        inputTables:      { QUERY_TABLES: [{ TABNAME: 'LQUA' }] },
        inputTablesItems: {
          query_FIELDS: [
            { TABNAME: 'LQUA', FIELDNAME: 'LGORT' },
            { TABNAME: 'LQUA', FIELDNAME: 'LGTYP' },
            { TABNAME: 'LQUA', FIELDNAME: 'LGPLA' },
            { TABNAME: 'LQUA', FIELDNAME: 'MATNR' },
            { TABNAME: 'LQUA', FIELDNAME: 'VERME' },
            { TABNAME: 'LQUA', FIELDNAME: 'CHARG' },
            { TABNAME: 'LQUA', FIELDNAME: 'BESTQ' },
            { TABNAME: 'LQUA', FIELDNAME: 'SOBKZ' },
            { TABNAME: 'LQUA', FIELDNAME: 'SONUM' },
          ],
          where_clause: [{ TEXT: 'LQUA~LGNUM EQ 312' }],
        },
        exportParameters: [],
        outputTables:     { data_display: ['WA'] },
      }),
    });

    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'SAP call failed');

    const waRows = (json.data?.data?.tables?.data_display || []).slice(1);
    const COLS   = ['Storage Loc', 'Storage Type', 'Storage Bin', 'Material',
                    'Qty', 'Batch', 'Stock Cat', 'Spc Stock', 'Spc Stock No'];

    const rows = waRows
      .map(r => {
        const p = r.WA.split('|').map(s => s.trim());
        return {
          'Storage Loc':  p[0] || '',
          'Storage Type': p[1] || '',
          'Storage Bin':  p[2] || '',
          'Material':     p[3] || '',
          'Qty':          p[4] || '',
          'Batch':        p[5] || '',
          'Stock Cat':    p[6] || '',
          'Spc Stock':    p[7] || '',
          'Spc Stock No': p[8] || '',
        };
      })
      .filter(r => r.Material);

    if (!rows.length) {
      document.getElementById('result-body').innerHTML =
        '<div class="sap-error">No stock records found.</div>';
      return;
    }

    const badge = document.getElementById('result-row-badge');
    badge.textContent = `${rows.length} rows`;
    badge.classList.remove('hidden');

    renderStockTable(rows, COLS);

  } catch (err) {
    document.getElementById('result-body').innerHTML =
      `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

function renderStockTable(rows, cols) {
  qAllRows      = rows;
  qFilteredRows = rows;
  qCurrentPage  = 1;
  qStockCols    = cols;
  qSelectedKeys.clear();

  const filterRow = cols.map(c =>
    `<th><input class="col-filter-input" type="text" placeholder="${esc(c)}…"
      data-col="${esc(c)}" autocomplete="off"></th>`
  ).join('');

  document.getElementById('result-body').innerHTML = `
    <div class="q-selection-bar hidden" id="q-selection-bar">
      <span id="q-sel-info" class="q-sel-info">0 selected</span>
      <button class="btn-danger-solid  q-bulk-btn" id="q-block-sel-btn"   disabled>Block Selected</button>
      <button class="btn-success-solid q-bulk-btn" id="q-unblock-sel-btn" disabled>Unblock Selected</button>
      <button class="btn-secondary" style="font-size:12px;padding:6px 12px"
        onclick="clearSelection()">Clear</button>
    </div>
    <div style="overflow-x:auto">
      <table class="pn-batch-table q-stock-table" style="width:100%">
        <thead>
          <tr>
            <th style="width:36px;text-align:center">
              <input type="checkbox" id="q-select-all" title="Select / deselect this page">
            </th>
            ${cols.map(c => `<th>${esc(c)}</th>`).join('')}
          </tr>
          <tr class="col-filter-row">
            <th></th>${filterRow}
          </tr>
        </thead>
        <tbody id="q-tbody"></tbody>
      </table>
    </div>
    <div class="q-pagination" id="q-pagination"></div>`;

  // Column filters → re-filter + back to page 1
  document.querySelectorAll('.col-filter-input').forEach(input => {
    input.addEventListener('input', () => {
      const filters = {};
      document.querySelectorAll('.col-filter-input').forEach(i => {
        if (i.value.trim()) filters[i.dataset.col] = i.value.trim().toLowerCase();
      });
      qFilteredRows = qAllRows.filter(row =>
        Object.entries(filters).every(([col, val]) =>
          String(row[col] ?? '').toLowerCase().includes(val)
        )
      );
      pruneSelectionToFilteredRows();
      qCurrentPage = 1;
      renderPage(cols);
      updateSelectionBar();
    });
  });

  // Bulk action buttons
  document.getElementById('q-block-sel-btn').addEventListener('click',   () => startBulkOperation('block'));
  document.getElementById('q-unblock-sel-btn').addEventListener('click', () => startBulkOperation('unblock'));

  renderPage(cols);
}

function renderPage(cols) {
  const total = qFilteredRows.length;
  const pages = Math.max(1, Math.ceil(total / qPageSize));
  qCurrentPage  = Math.min(qCurrentPage, pages);

  const start = (qCurrentPage - 1) * qPageSize;
  const end   = Math.min(start + qPageSize, total);
  const slice = qFilteredRows.slice(start, end);

  // Render rows with checkboxes
  document.getElementById('q-tbody').innerHTML = slice.map(row => {
    const key       = rowKey(row);
    const isBlocked = (row['Stock Cat'] || '').trim() === 'S';
    const isChecked = qSelectedKeys.has(key);
    const rowClass  = [
      'q-row',
      isBlocked ? 'q-row--blocked' : '',
      isChecked ? 'q-row--checked' : '',
    ].filter(Boolean).join(' ');

    const cells = cols.map(c => {
      if (c === 'Stock Cat') {
        return isBlocked
          ? `<td><span class="q-badge q-badge--blocked">Blocked</span></td>`
          : `<td><span class="q-badge q-badge--free">Unrestricted</span></td>`;
      }
      return `<td>${esc(row[c] ?? '')}</td>`;
    }).join('');

    return `<tr class="${rowClass}" data-row="${esc(JSON.stringify(row))}" data-key="${esc(key)}">
      <td style="text-align:center">
        <input type="checkbox" class="q-row-check" data-key="${esc(key)}" ${isChecked ? 'checked' : ''}>
      </td>
      ${cells}
    </tr>`;
  }).join('');

  // Wire row checkboxes
  document.querySelectorAll('.q-row-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.key;
      if (cb.checked) qSelectedKeys.add(key); else qSelectedKeys.delete(key);
      cb.closest('tr').classList.toggle('q-row--checked', cb.checked);
      syncSelectAll(slice);
      updateSelectionBar();
    });
  });

  // Wire select-all header checkbox
  const selAll = document.getElementById('q-select-all');
  if (selAll) {
    syncSelectAll(slice);
    selAll.addEventListener('change', () => {
      slice.forEach(r => {
        if (selAll.checked) qSelectedKeys.add(rowKey(r));
        else                qSelectedKeys.delete(rowKey(r));
      });
      document.querySelectorAll('.q-row-check').forEach(cb => { cb.checked = selAll.checked; });
      document.querySelectorAll('#q-tbody .q-row').forEach(tr =>
        tr.classList.toggle('q-row--checked', selAll.checked)
      );
      updateSelectionBar();
    });
  }

  // Right-click context menu
  document.querySelectorAll('#q-tbody .q-row').forEach(tr => {
    tr.addEventListener('contextmenu', e => {
      e.preventDefault();
      ctxRowData = JSON.parse(tr.dataset.row);
      showCtxMenu(e, ctxRowData);
    });
  });

  // Row badge
  const badge = document.getElementById('result-row-badge');
  badge.textContent = total === qAllRows.length
    ? `${total} rows`
    : `${total} / ${qAllRows.length} rows`;
  badge.classList.remove('hidden');

  // Pagination
  document.getElementById('q-pagination').innerHTML = buildPaginationBar(start, end, total, pages, cols);
  document.getElementById('q-prev-btn')?.addEventListener('click', () => {
    if (qCurrentPage > 1) { qCurrentPage--; renderPage(cols); }
  });
  document.getElementById('q-next-btn')?.addEventListener('click', () => {
    if (qCurrentPage < pages) { qCurrentPage++; renderPage(cols); }
  });
  document.querySelectorAll('.q-page-num-btn').forEach(btn => {
    btn.addEventListener('click', () => { qCurrentPage = Number(btn.dataset.page); renderPage(cols); });
  });
  document.getElementById('q-page-size-sel')?.addEventListener('change', e => {
    qPageSize = Number(e.target.value); qCurrentPage = 1; renderPage(cols);
  });
}

function syncSelectAll(pageSlice) {
  const selAll = document.getElementById('q-select-all');
  if (!selAll) return;
  const checks   = pageSlice.map(r => qSelectedKeys.has(rowKey(r)));
  const allOn    = checks.every(Boolean);
  const someOn   = checks.some(Boolean);
  selAll.checked       = allOn;
  selAll.indeterminate = !allOn && someOn;
}

function updateSelectionBar() {
  const selected   = qFilteredRows.filter(r => qSelectedKeys.has(rowKey(r)));
  const unblocked  = selected.filter(r => (r['Stock Cat'] || '').trim() !== 'S');
  const blocked    = selected.filter(r => (r['Stock Cat'] || '').trim() === 'S');
  const total      = selected.length;

  const bar        = document.getElementById('q-selection-bar');
  if (!bar) return;

  if (total === 0) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');

  document.getElementById('q-sel-info').textContent = `${total} selected`;
  const bb = document.getElementById('q-block-sel-btn');
  const ub = document.getElementById('q-unblock-sel-btn');
  bb.textContent = `Block Selected (${unblocked.length})`;
  bb.disabled    = unblocked.length === 0;
  ub.textContent = `Unblock Selected (${blocked.length})`;
  ub.disabled    = blocked.length === 0;
}

function clearSelection() {
  qSelectedKeys.clear();
  document.querySelectorAll('.q-row-check').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('#q-tbody .q-row').forEach(tr => tr.classList.remove('q-row--checked'));
  const selAll = document.getElementById('q-select-all');
  if (selAll) { selAll.checked = false; selAll.indeterminate = false; }
  updateSelectionBar();
}

// ── Bulk Block / Unblock ──────────────────────────────────────────────────────
function startBulkOperation(direction) {
  const allSelected = qFilteredRows.filter(r => qSelectedKeys.has(rowKey(r)));
  const relevant    = direction === 'block'
    ? allSelected.filter(r => (r['Stock Cat'] || '').trim() !== 'S')
    : allSelected.filter(r => (r['Stock Cat'] || '').trim() === 'S');

  if (!relevant.length) return;

  // Step 1: collect the reference header in a small modal
  let _resolve = null;
  const promise = new Promise(res => { _resolve = res; });

  const label   = direction === 'block' ? 'Block' : 'Unblock';
  const overlay = document.getElementById('modal-overlay');

  const cancel = () => { overlay.classList.add('hidden'); overlay.innerHTML = ''; _resolve(null); };

  overlay.innerHTML = `
    <div class="ps-modal" style="max-width:420px">
      <div class="ps-modal-header">
        <div class="ps-modal-title">${label} ${relevant.length} Row${relevant.length !== 1 ? 's' : ''}</div>
        <button class="ps-modal-close" id="q-bulk-cancel">✕</button>
      </div>
      <div class="ps-modal-body" style="padding:20px">
        <div class="tf-section-label">Reference / Reason</div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Header <span class="tf-req">*</span></label>
            <input class="tf-input" id="q-bulk-hdr" type="text" maxlength="25"
              placeholder="e.g. Bulk hold — Q.Control" autofocus>
          </div>
        </div>
        <div class="tf-actions" style="margin-top:16px">
          <button class="btn-secondary" id="q-bulk-cancel-btn">Cancel</button>
          <button class="btn-submit ${direction === 'block' ? 'btn-danger-solid' : 'btn-success-solid'}"
            id="q-bulk-go">${label} ${relevant.length} Rows →</button>
        </div>
      </div>
    </div>`;
  overlay.classList.remove('hidden');
  document.getElementById('q-bulk-cancel').addEventListener('click', cancel);
  document.getElementById('q-bulk-cancel-btn').addEventListener('click', cancel);
  document.getElementById('q-bulk-hdr').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('q-bulk-go').click();
    if (e.key === 'Escape') cancel();
  });
  document.getElementById('q-bulk-go').addEventListener('click', () => {
    const h = document.getElementById('q-bulk-hdr').value.trim();
    if (!h) { document.getElementById('q-bulk-hdr').focus(); return; }
    overlay.classList.add('hidden'); overlay.innerHTML = '';
    _resolve(h);
  });

  promise.then(header => {
    if (header === null) return;
    runBulkOperation(direction, relevant, header);
  });
}

async function runBulkOperation(direction, rows, header) {
  const label   = direction === 'block' ? 'Blocking' : 'Unblocking';
  const total   = rows.length;
  const overlay = document.getElementById('modal-overlay');

  overlay.innerHTML = `
    <div class="ps-modal" style="max-width:520px">
      <div class="ps-modal-header">
        <div>
          <div class="ps-modal-title">${label} Stock</div>
          <div class="ps-modal-sub" id="q-prog-sub">${total} lines · Processing…</div>
        </div>
        <button class="ps-modal-close" id="q-prog-close" disabled>✕</button>
      </div>
      <div class="ps-modal-body" style="padding:20px">
        <div class="q-prog-header">
          <span class="q-prog-count" id="q-prog-count">0 / ${total}</span>
          <span class="q-prog-pct"  id="q-prog-pct">0%</span>
        </div>
        <div class="q-prog-bar-wrap">
          <div class="q-prog-bar${direction === 'block' ? ' q-prog-bar--block' : ''}" id="q-prog-bar"
            style="width:0%"></div>
        </div>
        <div class="q-prog-results" id="q-prog-results"></div>
        <div class="tf-actions" style="margin-top:12px;display:none" id="q-prog-actions">
          <button class="btn-submit" onclick="closeModal();clearSelection();displayStock()">
            Refresh Stock &amp; Close
          </button>
        </div>
      </div>
    </div>`;
  overlay.classList.remove('hidden');
  document.getElementById('q-prog-close').addEventListener('click', closeModal);

  try {
    const res = await fetch('/api/quality/bulk', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ rows, direction, header }),
    });

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data: ')) continue;
        try { handleBulkEvent(JSON.parse(line.slice(6)), total); } catch {}
      }
    }

  } catch (err) {
    const sub = document.getElementById('q-prog-sub');
    if (sub) sub.textContent = `Error: ${err.message}`;
  }

  // Enable close + show refresh button
  const closeBtn = document.getElementById('q-prog-close');
  if (closeBtn) closeBtn.disabled = false;
  const actions = document.getElementById('q-prog-actions');
  if (actions) actions.style.display = '';
}

function handleBulkEvent(event, total) {
  if (event.type === 'progress') {
    const pct = Math.round((event.done / total) * 100);
    const bar = document.getElementById('q-prog-bar');
    if (bar) bar.style.width = `${pct}%`;
    const cnt = document.getElementById('q-prog-count');
    if (cnt) cnt.textContent = `${event.done} / ${total}`;
    const pctEl = document.getElementById('q-prog-pct');
    if (pctEl) pctEl.textContent = `${pct}%`;

    const list = document.getElementById('q-prog-results');
    if (list) {
      const item = document.createElement('div');
      item.className = `q-prog-item q-prog-item--${event.success ? 'ok' : 'err'}`;
      item.textContent = event.success
        ? `✓ ${event.material} — ${event.message || 'Posted'}`
        : `✗ ${event.material} — ${event.error || 'Error'}`;
      list.prepend(item);
    }
  }
  if (event.type === 'complete') {
    const sub = document.getElementById('q-prog-sub');
    if (sub) sub.textContent = `${total} lines — complete`;
    const bar = document.getElementById('q-prog-bar');
    if (bar) { bar.style.width = '100%'; bar.classList.add('q-prog-bar--done'); }
  }
}

function buildPaginationBar(start, end, total, pages, cols) {
  const info = total === 0
    ? 'No rows match'
    : `Showing ${start + 1}–${end} of ${total}`;

  const pageNums = pageRange(qCurrentPage, pages).map(p =>
    p === '…'
      ? `<span class="q-page-btn q-page-btn--ellipsis">…</span>`
      : `<button class="q-page-btn q-page-num-btn${p === qCurrentPage ? ' active' : ''}"
           data-page="${p}">${p}</button>`
  ).join('');

  const sizeOpts = [25, 50, 100, 200].map(n =>
    `<option value="${n}"${n === qPageSize ? ' selected' : ''}>${n}</option>`
  ).join('');

  return `
    <span class="q-page-info">${esc(info)}</span>
    <div class="q-page-controls">
      <button class="q-page-btn" id="q-prev-btn" ${qCurrentPage <= 1 ? 'disabled' : ''}>&larr;</button>
      ${pageNums}
      <button class="q-page-btn" id="q-next-btn" ${qCurrentPage >= pages ? 'disabled' : ''}>→</button>
    </div>
    <div class="q-page-size">
      Per page: <select id="q-page-size-sel">${sizeOpts}</select>
    </div>`;
}

function pageRange(current, total) {
  if (total <= 9) return Array.from({ length: total }, (_, i) => i + 1);
  const around = new Set([1, 2, current - 1, current, current + 1, total - 1, total]
    .filter(p => p >= 1 && p <= total));
  const sorted = [...around].sort((a, b) => a - b);
  const result = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) result.push('…');
    result.push(p);
    prev = p;
  }
  return result;
}

// ── Context Menu ──────────────────────────────────────────────────────────────
function setupContextMenu() {
  document.getElementById('ctx-block').addEventListener('click', () => {
    closeCtxMenu();
    if (ctxRowData) openBlockUnblockModal('block', ctxRowData);
  });
  document.getElementById('ctx-unblock').addEventListener('click', () => {
    closeCtxMenu();
    if (ctxRowData) openBlockUnblockModal('unblock', ctxRowData);
  });
  document.addEventListener('click',       closeCtxMenu);
  document.addEventListener('contextmenu', e => {
    if (!e.target.closest('.q-row')) closeCtxMenu();
  });
}

function showCtxMenu(e, row) {
  if (!hasPermission('QUAL_BLOCKING')) return;

  const isBlocked   = (row['Stock Cat'] || '').trim() === 'S';
  const blockItem   = document.getElementById('ctx-block');
  const unblockItem = document.getElementById('ctx-unblock');

  blockItem.classList.toggle('hidden', isBlocked);
  unblockItem.classList.toggle('hidden', !isBlocked);

  const menu = document.getElementById('ctx-menu');
  menu.style.left = `${Math.min(e.clientX, window.innerWidth  - 180)}px`;
  menu.style.top  = `${Math.min(e.clientY, window.innerHeight - 80)}px`;
  menu.classList.remove('hidden');
}

function closeCtxMenu() {
  document.getElementById('ctx-menu').classList.add('hidden');
}

// ── Block / Unblock Modal ─────────────────────────────────────────────────────
// Username is injected server-side from req.session.user.username in
// routes/quality.js — operators do not enter it.

function openBlockUnblockModal(direction, prefill = null) {
  const isBlock  = direction === 'block';
  const title    = isBlock ? 'Block Stock' : 'Unblock Stock';
  const btnClass = isBlock ? 'btn-danger-solid' : 'btn-success-solid';
  const btnLabel = isBlock ? 'Block Stock' : 'Unblock Stock';

  const mat   = prefill?.['Material']     || '';
  const qty   = prefill?.['Qty']          || '';
  const batch = prefill?.['Batch']        || '';
  const sloc  = prefill?.['Storage Loc']  || '';
  const btyp  = prefill?.['Storage Type'] || '';
  const bin   = prefill?.['Storage Bin']  || '';
  const sobkz = prefill?.['Spc Stock']    || '';
  const sonum = prefill?.['Spc Stock No'] || '';

  // Only WM-managed locations need Bin Type + Bin
  const isWM    = WM_LOCATIONS.has(sloc.trim());
  const binShow = isWM ? '' : 'display:none';
  const binReq  = isWM ? 'required' : '';

  const overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = `
    <div class="ps-modal" style="max-width:580px">
      <div class="ps-modal-header">
        <div>
          <div class="ps-modal-title">${esc(title)}</div>
          <div class="ps-modal-sub">MB1B ${isBlock ? '344 → quality block' : '343 → unrestricted'}</div>
        </div>
        <button class="ps-modal-close" onclick="closeModal()">✕</button>
      </div>
      <div class="ps-modal-body" style="padding:20px">
        <form id="q-form" onsubmit="submitBlockUnblock(event,'${direction}')">

          <div class="tf-section-label">Description</div>
          <div class="tf-row">
            <div class="tf-field tf-field--wide">
              <label class="tf-label">Header / Reference <span class="tf-req">*</span></label>
              <input class="tf-input" id="q-header" type="text" maxlength="25"
                placeholder="e.g. Hold for inspection — J.Smith" required>
            </div>
          </div>

          <div class="tf-section-label">Material</div>
          <div class="tf-row">
            <div class="tf-field tf-field--wide">
              <label class="tf-label">Material <span class="tf-req">*</span></label>
              <input class="tf-input" id="q-material" type="text" value="${esc(mat)}"
                maxlength="18" required>
            </div>
            <div class="tf-field">
              <label class="tf-label">Quantity <span class="tf-req">*</span></label>
              <input class="tf-input" id="q-qty" type="number" step="any" min="0.001"
                value="${esc(parseSapQty(qty))}" required>
            </div>
            <div class="tf-field">
              <label class="tf-label">Batch</label>
              <input class="tf-input" id="q-batch" type="text" value="${esc(batch)}" maxlength="10">
            </div>
          </div>

          <div class="tf-section-label">Source Location</div>
          <div class="tf-row">
            <div class="tf-field">
              <label class="tf-label">Storage Location <span class="tf-req">*</span></label>
              <input class="tf-input" id="q-sloc" type="text" value="${esc(sloc)}"
                maxlength="4" required>
            </div>
            <div class="tf-field" id="q-bintype-wrap" style="${binShow}">
              <label class="tf-label">Bin Type${isWM ? ' <span class="tf-req">*</span>' : ''}</label>
              <input class="tf-input" id="q-bintype" type="text" value="${esc(btyp)}"
                maxlength="3" ${binReq}>
            </div>
            <div class="tf-field" id="q-bin-wrap" style="${binShow}">
              <label class="tf-label">Bin${isWM ? ' <span class="tf-req">*</span>' : ''}</label>
              <input class="tf-input" id="q-bin" type="text" value="${esc(bin)}"
                maxlength="10" ${binReq}>
            </div>
          </div>
          <div id="q-wm-hint" style="${isWM ? 'display:none' : ''};
            font-family:'JetBrains Mono',monospace;font-size:10px;
            color:var(--text-muted);margin-top:4px">
            Bin Type and Bin are only required for WM-managed locations (1710, 1711).
          </div>

          <div class="tf-section-label" style="margin-top:14px">
            Special Stock <span class="tf-optional">(optional)</span>
          </div>
          <div class="tf-row">
            <div class="tf-field">
              <label class="tf-label">Spc Stock Indicator</label>
              <input class="tf-input" id="q-sobkz" type="text" value="${esc(sobkz)}" maxlength="1">
            </div>
            <div class="tf-field tf-field--wide">
              <label class="tf-label">Spc Stock Number</label>
              <input class="tf-input" id="q-sonum" type="text" value="${esc(sonum)}" maxlength="16">
            </div>
          </div>

          <div class="tf-actions" style="margin-top:20px">
            <div id="q-result"></div>
            <button type="button" class="btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn-submit ${btnClass}" id="q-submit">${esc(btnLabel)}</button>
          </div>

        </form>
      </div>
    </div>`;

  overlay.classList.remove('hidden');
  document.getElementById('q-header').focus();

  // Toggle Bin Type / Bin visibility as operator types the storage location
  document.getElementById('q-sloc').addEventListener('input', () => {
    const loc      = document.getElementById('q-sloc').value.trim();
    const wm       = WM_LOCATIONS.has(loc);
    const btWrap   = document.getElementById('q-bintype-wrap');
    const binWrap  = document.getElementById('q-bin-wrap');
    const hint     = document.getElementById('q-wm-hint');
    const btInput  = document.getElementById('q-bintype');
    const binInput = document.getElementById('q-bin');

    btWrap.style.display  = wm ? '' : 'none';
    binWrap.style.display = wm ? '' : 'none';
    hint.style.display    = wm ? 'none' : '';

    if (wm) {
      btInput.setAttribute('required', '');
      binInput.setAttribute('required', '');
    } else {
      btInput.removeAttribute('required');
      binInput.removeAttribute('required');
    }
  });
}

async function submitBlockUnblock(e, direction) {
  e.preventDefault();

  const btn    = document.getElementById('q-submit');
  const result = document.getElementById('q-result');
  btn.disabled    = true;
  btn.textContent = 'Posting to SAP…';
  result.innerHTML = '';

  const sloc  = document.getElementById('q-sloc').value.trim();
  const isWM  = WM_LOCATIONS.has(sloc);

  const body = {
    Material:              document.getElementById('q-material').value.trim(),
    Quantity:              parseFloat(document.getElementById('q-qty').value),
    Header:                document.getElementById('q-header').value.trim(),
    StorageLocation:       sloc,
    BinType:               isWM ? document.getElementById('q-bintype').value.trim() : '',
    Bin:                   isWM ? document.getElementById('q-bin').value.trim()     : '',
    Batch:                 document.getElementById('q-batch').value.trim() || '',
    SpecialStockIndicator: document.getElementById('q-sobkz').value.trim() || '',
    SpecialStockNumber:    document.getElementById('q-sonum').value.trim() || '',
    // Username is injected server-side from req.session.user.username
  };

  try {
    const res  = await fetch(`/api/quality/${direction}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const json = await res.json();

    if (!json.success) throw new Error(json.error || 'SAP returned an error');

    const d    = json.data;
    const msgs = [
      d?.mb1bMessage         ? `MB1B: ${d.mb1bMessage}`                  : null,
      d?.toBlockedMessage    ? `→ Blocked: ${d.toBlockedMessage}`         : null,
      d?.toNonBlockedMessage ? `→ Unrestricted: ${d.toNonBlockedMessage}` : null,
    ].filter(Boolean);

    result.innerHTML = `
      <div class="tf-success">
        <svg viewBox="0 0 20 20" fill="currentColor" style="width:20px;height:20px;flex-shrink:0">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1
            0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414
            0l4-4z" clip-rule="evenodd"/>
        </svg>
        <div>
          <div class="tf-success-title">${direction === 'block' ? 'Stock Blocked' : 'Stock Unblocked'}</div>
          ${msgs.map(m => `<div class="tf-success-to">${esc(m)}</div>`).join('')}
        </div>
      </div>`;

    btn.disabled    = false;
    btn.textContent = 'Done — Close';
    btn.onclick     = closeModal;
    btn.type        = 'button';

  } catch (err) {
    result.innerHTML = `<div class="sap-error tf-inline-error">✕ ${esc(err.message)}</div>`;
    btn.disabled    = false;
    btn.textContent = direction === 'block' ? 'Block Stock' : 'Unblock Stock';
  }
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.add('hidden');
  overlay.innerHTML = '';
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function parseSapQty(value) {
  const str = String(value ?? '').trim();
  return str.includes(',')
    ? str.replace(/\./g, '').replace(',', '.')
    : str.replace(/\./g, '') || '';
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
