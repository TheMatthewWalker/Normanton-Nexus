'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let userPermissions = [];
let sessionUsername = '';
let sessionRole     = '';
let ctxRowData      = null;

// WM-managed storage locations that require Bin Type + Bin
const WM_LOCATIONS = new Set(['1710', '1711']);

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
  const filterRow = cols.map(c =>
    `<th><input class="col-filter-input" type="text" placeholder="${esc(c)}…"
      data-col="${esc(c)}" autocomplete="off"></th>`
  ).join('');

  const tbody = rows.map(row => {
    const isBlocked = (row['Stock Cat'] || '').trim() === 'S';
    const rowClass  = isBlocked ? 'q-row q-row--blocked' : 'q-row';
    const cells     = cols.map(c => {
      if (c === 'Stock Cat') {
        return isBlocked
          ? `<td><span class="q-badge q-badge--blocked">Blocked</span></td>`
          : `<td><span class="q-badge q-badge--free">Unrestricted</span></td>`;
      }
      return `<td>${esc(row[c] ?? '')}</td>`;
    }).join('');
    return `<tr class="${rowClass}" data-row="${esc(JSON.stringify(row))}">${cells}</tr>`;
  }).join('');

  document.getElementById('result-body').innerHTML = `
    <div style="overflow-x:auto">
      <table class="pn-batch-table q-stock-table" style="width:100%">
        <thead>
          <tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>
          <tr class="col-filter-row">${filterRow}</tr>
        </thead>
        <tbody id="q-tbody">${tbody}</tbody>
      </table>
    </div>`;

  // Wire column filters
  const badge   = document.getElementById('result-row-badge');
  const allRows = [...document.querySelectorAll('#q-tbody .q-row')];

  document.querySelectorAll('.col-filter-input').forEach(input => {
    input.addEventListener('input', () => {
      const filters = {};
      document.querySelectorAll('.col-filter-input').forEach(i => {
        if (i.value.trim()) filters[i.dataset.col] = i.value.trim().toLowerCase();
      });
      let visible = 0;
      allRows.forEach(tr => {
        const row  = JSON.parse(tr.dataset.row);
        const show = Object.entries(filters).every(([col, val]) =>
          String(row[col] ?? '').toLowerCase().includes(val)
        );
        tr.style.display = show ? '' : 'none';
        if (show) visible++;
      });
      badge.textContent = `${visible} / ${allRows.length} rows`;
    });
  });

  // Wire right-click menu
  allRows.forEach(tr => {
    tr.addEventListener('contextmenu', e => {
      e.preventDefault();
      ctxRowData = JSON.parse(tr.dataset.row);
      showCtxMenu(e, ctxRowData);
    });
  });
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
    Batch:                 document.getElementById('q-batch').value.trim() || null,
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
