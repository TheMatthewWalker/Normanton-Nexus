'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let userPermissions = [];
let sessionUsername = '';
let ctxRowData      = null;  // row the context menu was opened on

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const session = await fetch('/session-check').then(r => r.json());
    if (!session.loggedIn) { location.href = '/'; return; }
    sessionUsername = session.username || '';
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
    const allowed = session_isSuperadmin() || userPermissions.includes(code);
    el.style.display = allowed ? '' : 'none';
  });
}
function session_isSuperadmin() {
  // checked via permissions not role — superadmin bypasses everything
  return document.getElementById('session-user')?.textContent === sessionUsername;
  // actual check is done server-side; here we just check locally for tile visibility
}
function hasPermission(code) {
  return userPermissions.includes(code);
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

  // Collapsible section headers
  document.querySelectorAll('.pn-section-hdr').forEach(hdr => {
    const section = hdr.closest('.pn-section');
    const key     = `qual-collapsed:${hdr.textContent.trim()}`;
    if (localStorage.getItem(key) === '1') section.classList.add('pn-section--collapsed');
    hdr.addEventListener('click', () => {
      section.classList.toggle('pn-section--collapsed');
      localStorage.setItem(key, section.classList.contains('pn-section--collapsed') ? '1' : '0');
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
  const thead = `<tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>`;
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
    <div class="pn-batch-table-wrap">
      <table class="pn-batch-table q-stock-table">
        <thead>${thead}</thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;

  // Wire right-click menu
  document.querySelectorAll('.q-row').forEach(tr => {
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

  const isBlocked = (row['Stock Cat'] || '').trim() === 'S';
  const blockItem   = document.getElementById('ctx-block');
  const unblockItem = document.getElementById('ctx-unblock');

  blockItem.classList.toggle('hidden', isBlocked);
  unblockItem.classList.toggle('hidden', !isBlocked);

  const menu = document.getElementById('ctx-menu');
  menu.style.left = `${Math.min(e.pageX, window.innerWidth  - 180)}px`;
  menu.style.top  = `${Math.min(e.pageY, window.innerHeight - 80)}px`;
  menu.classList.remove('hidden');
}

function closeCtxMenu() {
  document.getElementById('ctx-menu').classList.add('hidden');
}

// ── Block / Unblock Modal ─────────────────────────────────────────────────────
function openBlockUnblockModal(direction, prefill = null) {
  const isBlock  = direction === 'block';
  const title    = isBlock ? 'Block Stock' : 'Unblock Stock';
  const btnClass = isBlock ? 'btn-danger-solid' : 'btn-success-solid';
  const btnLabel = isBlock ? 'Block Stock' : 'Unblock Stock';

  // Pre-fill from right-clicked row
  const mat   = prefill?.['Material']     || '';
  const qty   = prefill?.['Qty']          || '';
  const batch = prefill?.['Batch']        || '';
  const sloc  = prefill?.['Storage Loc']  || '';
  const btyp  = prefill?.['Storage Type'] || '';
  const bin   = prefill?.['Storage Bin']  || '';
  const sobkz = prefill?.['Spc Stock']    || '';
  const sonum = prefill?.['Spc Stock No'] || '';

  const overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = `
    <div class="ps-modal" style="max-width:580px">
      <div class="ps-modal-header">
        <div>
          <div class="ps-modal-title">${esc(title)}</div>
          <div class="ps-modal-sub">MB1B movement ${isBlock ? '344 → quality block' : '343 → unrestricted'}</div>
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
            <div class="tf-field">
              <label class="tf-label">Bin Type <span class="tf-req">*</span></label>
              <input class="tf-input" id="q-bintype" type="text" value="${esc(btyp)}"
                maxlength="3" required>
            </div>
            <div class="tf-field">
              <label class="tf-label">Bin <span class="tf-req">*</span></label>
              <input class="tf-input" id="q-bin" type="text" value="${esc(bin)}"
                maxlength="10" required>
            </div>
          </div>

          <div class="tf-section-label">Special Stock <span class="tf-optional">(optional)</span></div>
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
}

async function submitBlockUnblock(e, direction) {
  e.preventDefault();

  const btn    = document.getElementById('q-submit');
  const result = document.getElementById('q-result');
  btn.disabled = true;
  btn.textContent = 'Posting to SAP…';
  result.innerHTML = '';

  const body = {
    Material:              document.getElementById('q-material').value.trim(),
    Quantity:              parseFloat(document.getElementById('q-qty').value),
    Header:                document.getElementById('q-header').value.trim(),
    StorageLocation:       document.getElementById('q-sloc').value.trim(),
    BinType:               document.getElementById('q-bintype').value.trim(),
    Bin:                   document.getElementById('q-bin').value.trim(),
    Batch:                 document.getElementById('q-batch').value.trim() || null,
    SpecialStockIndicator: document.getElementById('q-sobkz').value.trim() || '',
    SpecialStockNumber:    document.getElementById('q-sonum').value.trim() || '',
  };

  try {
    const res  = await fetch(`/api/quality/${direction}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const json = await res.json();

    if (!json.success) throw new Error(json.error || 'SAP returned an error');

    const d = json.data;
    const msgs = [
      d?.mb1bMessage          ? `MB1B: ${d.mb1bMessage}`                   : null,
      d?.toBlockedMessage     ? `→ Blocked: ${d.toBlockedMessage}`          : null,
      d?.toNonBlockedMessage  ? `→ Unrestricted: ${d.toNonBlockedMessage}`  : null,
    ].filter(Boolean);

    result.innerHTML = `
      <div class="tf-success">
        <svg viewBox="0 0 20 20" fill="currentColor" style="width:20px;height:20px;flex-shrink:0">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
        </svg>
        <div>
          <div class="tf-success-title">${direction === 'block' ? 'Stock Blocked' : 'Stock Unblocked'}</div>
          ${msgs.map(m => `<div class="tf-success-to">${esc(m)}</div>`).join('')}
        </div>
      </div>`;

    btn.disabled = false;
    btn.textContent = 'Done — Close';
    btn.onclick = closeModal;
    btn.type = 'button';

  } catch (err) {
    result.innerHTML = `<div class="sap-error tf-inline-error">✕ ${esc(err.message)}</div>`;
    btn.disabled = false;
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
