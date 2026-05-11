'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let activeDT      = null;
let currentResult = [];

// ── Session check on load ─────────────────────────────────────────────────────
(async () => {
  const d = await fetch('/session-check').then(r => r.json());
  if (!d.loggedIn) { window.location.href = '/'; return; }
  document.getElementById('session-user').textContent = d.username;
})();

// ── Tile click handlers ───────────────────────────────────────────────────────
document.querySelectorAll('.sap-tile--live').forEach(tile => {
  tile.addEventListener('click', () => {
    const fn = tile.dataset.fn;
    if (fn === 'displayStock')   runDisplayStock();
    if (fn === 'transferOrders') showTransferForm();
    if (fn === 'openPicksheets') runOpenPicksheets();
  });
});

// ── Display Stock ─────────────────────────────────────────────────────────────
async function runDisplayStock() {
  if (!await checkSession()) return;
  showResultPanel('Display Stock', 'Fetching warehouse stock from SAP LQUA…');

  try {
    const res = await fetch('/api/sap/execute-rfc', {
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
          where_clause: [
            { TEXT: 'LQUA~LGNUM EQ 312' },
          ],
        },
        exportParameters: [],
        outputTables:     { data_display: ['WA'] },
      }),
    });

    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'SAP call failed');

    // Response: { success, data: { success, data: { tables: { data_display: [...] } } } }
    // First row is the SAP field-name header — skip it
    const waRows  = (json.data?.data?.tables?.data_display || []).slice(1);
    const columns = ['Storage Location', 'Storage Type', 'Storage Bin', 'Material', 'Available Qty', 'Batch', 'Stock Category', 'Special Stock', 'Special Stock No.'];

    currentResult = waRows
      .map(r => {
        const parts = r.WA.split('|').map(s => s.trim());
        return {
          'Storage Location': parts[0] || '',
          'Storage Type':     parts[1] || '',
          'Storage Bin':      parts[2] || '',
          'Material':         parts[3] || '',
          'Available Qty':    parts[4] || '',
          'Batch':            parts[5] || '',
          'Stock Category':   parts[6] || '',
          'Special Stock':    parts[7] || '',
          'Special Stock No.':parts[8] || '',
        };
      })
      .filter(r => r.Material);

    renderResultTable(currentResult, columns);
    document.getElementById('result-hint').textContent =
      `LQUA · WH 312 · ${currentResult.length} rows`;

  } catch (err) {
    document.getElementById('result-body').innerHTML =
      `<div class="sap-error">✕ ${esc(err.message)}</div>`;
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
          <input class="tf-input" id="tf-bintype" type="text" placeholder="e.g. 001" required>
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
          <input class="tf-input" id="tf-destbintype" type="text" placeholder="e.g. 001" required>
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

// ── Render DataTable with per-column filters ──────────────────────────────────
function renderResultTable(records, columns) {
  const filterRow = columns.map(c =>
    `<th><input class="col-filter-input" type="text" placeholder="${esc(c)}…" data-col="${esc(c)}"></th>`
  ).join('');

  const tbody = records.map(row =>
    `<tr>${columns.map(c => `<td>${esc(row[c] ?? '')}</td>`).join('')}</tr>`
  ).join('');

  document.getElementById('result-body').innerHTML = `
    <table id="sap-dt" style="width:100%">
      <thead>
        <tr>${columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr>
        <tr class="col-filter-row">${filterRow}</tr>
      </thead>
      <tbody>${tbody}</tbody>
    </table>`;

  activeDT = new DataTable('#sap-dt', {
    pageLength:    10,
    scrollX:       true,
    orderCellsTop: true,
    layout:        { padding: { bottom: 12 } },
    initComplete:  function () {
      const api = this.api();
      api.table().header().querySelectorAll('.col-filter-input').forEach(input => {
        const colIdx = columns.indexOf(input.dataset.col);
        if (colIdx === -1) return;
        input.addEventListener('input', function () {
          api.column(colIdx).search(this.value).draw();
        });
      });
    },
  });

  // ── Stock Right-click context menu ────────────────────────────────────────────────
  const ctxMenu     = document.getElementById('ctx-menu');
  const ctxTransfer = document.getElementById('ctx-transfer');
  let ctxRowData    = null;

  document.getElementById('sap-dt').addEventListener('contextmenu', e => {
    const tr = e.target.closest('tbody tr');
    if (!tr) return;
    e.preventDefault();

    // Build row object directly from DOM cells — works correctly after any sort/filter
    const cells = Array.from(tr.querySelectorAll('td'));
    ctxRowData = {};
    columns.forEach((col, i) => { ctxRowData[col] = cells[i]?.textContent?.trim() || ''; });

    ctxMenu.style.left = `${Math.min(e.pageX, window.innerWidth  - 200)}px`;
    ctxMenu.style.top  = `${Math.min(e.pageY, window.innerHeight - 60)}px`;
    ctxMenu.classList.remove('hidden');
  });

  ctxTransfer.onclick = () => {
    ctxMenu.classList.add('hidden');
    if (ctxRowData) 
        showTransferFormFromRow(ctxRowData);
  };

  document.addEventListener('click',       () => ctxMenu.classList.add('hidden'), { once: false });
  document.addEventListener('contextmenu', e => { if (!e.target.closest('#ctx-menu') && !e.target.closest('#sap-dt tbody')) ctxMenu.classList.add('hidden'); });

  const badge = document.getElementById('result-row-badge');
  badge.textContent = `${records.length} rows`;
  badge.classList.remove('hidden');
  document.getElementById('btn-export-csv').classList.remove('hidden');
}

// ── Transfer form pre-filled from a stock row ─────────────────────────────────
function showTransferFormFromRow(row) {
  const hasBatch = !!row['Batch'];

  if (activeDT) { try { activeDT.destroy(); } catch (_) {} activeDT = null; }
  document.getElementById('result-title').textContent = 'Create Transfer Order';
  document.getElementById('result-hint').textContent  = `From ${row['Storage Bin']} · ${row['Material']}`;
  document.getElementById('result-row-badge').classList.add('hidden');
  document.getElementById('btn-export-csv').classList.add('hidden');

  document.getElementById('result-body').innerHTML = `
    <form class="transfer-form" id="transfer-form" onsubmit="submitTransferFormRow(event)">

      <div class="tf-section-label">Source — from stock</div>
      <div class="tf-prefill-grid">
        ${prefillItem('Storage Location', row['Storage Location'])}
        ${prefillItem('Storage Type',     row['Storage Type'])}
        ${prefillItem('Storage Bin',      row['Storage Bin'])}
        ${prefillItem('Material',         row['Material'])}
        ${prefillItem('Stock Category',   row['Stock Category']   || '—')}
        ${prefillItem('Special Stock',    row['Special Stock']    || '—')}
        ${prefillItem('Special Stock No.',row['Special Stock No.']|| '—')}
        ${hasBatch
          ? prefillItem('Batch', row['Batch'])
          : `<div class="tf-field">
               <label class="tf-label">Batch</label>
               <div class="tf-prefill-value tf-muted">None</div>
             </div>`}
      </div>

      <div class="tf-section-label">Quantity</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Quantity <span class="tf-req">*</span>${hasBatch ? ' <span class="tf-locked">locked to batch qty</span>' : ''}</label>
          <input class="tf-input" id="tf-qty" type="number" step="any" min="0.001"
            value="${esc(parseSapQty(row['Available Qty']))}"
            ${hasBatch ? 'readonly' : ''} required>
        </div>
      </div>

      <div class="tf-section-label">Destination Bin</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Dest. Bin Type <span class="tf-req">*</span></label>
          <input class="tf-input" id="tf-destbintype" type="text" placeholder="e.g. 001" required>
        </div>
        <div class="tf-field">
          <label class="tf-label">Dest. Bin <span class="tf-req">*</span></label>
          <input class="tf-input" id="tf-destbin" type="text" placeholder="e.g. B-02-03" required>
        </div>
      </div>

      <div class="tf-actions">
        <div id="tf-result"></div>
        <button type="button" class="btn-secondary" onclick="runDisplayStock()">← Back to Stock</button>
        <button type="submit" class="btn-submit" id="tf-submit">Create Transfer Order</button>
      </div>

    </form>`;

  // Store source data for submission
  document.getElementById('transfer-form').dataset.source = JSON.stringify(row);
}

function prefillItem(label, value) {
  return `
    <div class="tf-field">
      <label class="tf-label">${esc(label)}</label>
      <div class="tf-prefill-value">${esc(value)}</div>
    </div>`;
}

async function submitTransferFormRow(e) {
  e.preventDefault();
  const row = JSON.parse(e.target.dataset.source);

  const params = {
    StorageLocation:          row['Storage Location'],
    Material:      row['Material'],
    Batch:         row['Batch']            || '',
    Quantity:      parseFloat(document.getElementById('tf-qty').value.replace(',', '.')),
    SourceType:   row['Storage Type'],
    SourceBin:    row['Storage Bin'],
    DestinationType:   document.getElementById('tf-destbintype').value.trim(),
    DestinationBin:       document.getElementById('tf-destbin').value.trim(),
    StockCategory:      row['Stock Category']    || '',
    SpecialStockIndicator:       row['Special Stock']     || '',
    SpecialStockNumber: row['Special Stock No.'] || '',
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
    const key = r.deliveryPriority === 1 ? 'priority' : getDateBucket(r.dueDate);
    bucketMap[key].push(r);
  });

  const html = BUCKETS
    .filter(b => bucketMap[b.key].length > 0)
    .map(b => {
      const collapsed = b.defaultOpen ? '' : ' ps-section--collapsed';
      const thead = `<tr><th>Delivery ID</th><th>Destination</th><th>Due Date</th><th>Service</th><th>Comment</th></tr>`;
      const tbody = bucketMap[b.key].map(r => {
        const due  = r.dueDate ? new Date(r.dueDate).toLocaleDateString('en-GB') : '—';
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

// ── Pallet list modal ─────────────────────────────────────────────────────────
let _palletListCtx = null; // { deliveryId, destName, custId } for refresh after builder closes

async function showPickedPallets(deliveryId, destName, custId) {
  if (!await checkSession()) return;
  _palletListCtx = { deliveryId, destName, custId: custId || '' };

  const overlay = document.getElementById('ps-modal-overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="ps-modal" style="max-width:760px">
      <div class="ps-modal-header">
        <div>
          <div class="ps-modal-title">Picked Pallets</div>
          <div class="ps-modal-sub">Delivery #${esc(String(deliveryId))} · ${esc(destName)}</div>
        </div>
        <button class="ps-modal-close" onclick="closePickModal()">✕</button>
      </div>
      <div class="ps-modal-body" id="pallet-list-body" style="padding:0">
        <div class="sap-loading"><div class="spinner"></div>Fetching pallets…</div>
      </div>
      <div class="ps-modal-actions">
        <button class="btn-secondary" onclick="completeDelivery()">Complete Delivery ✓</button>
        <button class="btn-submit" onclick="openPalletBuilder()">+ Add Pallet</button>
      </div>
    </div>`;

  await refreshPalletList();
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
  const actions = p.palletFinish ? '' : `
    <button class="ps-pcard-btn"
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

async function removePackage(palletItemId, palletId) {
  if (!confirm('Remove this package from the pallet?')) return;
  try {
    const res  = await fetch(`/api/palletpackages/${palletItemId}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Delete failed');
    const bodyEl = document.getElementById(`pcard-body-${palletId}`);
    if (bodyEl) { bodyEl.dataset.loaded = '0'; await loadPalletPackages(palletId, bodyEl); bodyEl.dataset.loaded = '1'; }
  } catch (err) { alert('Remove failed: ' + err.message); }
}

async function finishExistingPallet(palletId) {
  if (!confirm('Mark this pallet as finished? No more packages can be added.')) return;
  try {
    const res  = await fetch(`/api/palletmain/${palletId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ palletFinish: 1 }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Update failed');
    await refreshPalletList();
  } catch (err) { alert('Error: ' + err.message); }
}

async function deletePallet(palletId) {
  if (!confirm('Delete this pallet and all its packages? This cannot be undone.')) return;
  try {
    const res  = await fetch(`/api/palletmain/${palletId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ palletRemoved: 1 }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Delete failed');
    await refreshPalletList();
  } catch (err) { alert('Error: ' + err.message); }
}

function closePickModal() {
  document.getElementById('ps-modal-overlay').classList.add('hidden');
}

// ── Pallet Builder ────────────────────────────────────────────────────────────
let pb = null; // active builder state

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
         allPackaging: [], allowedPackaging: [], packages: [], nextLayer: 1 };

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
    const [ptRes, pkRes] = await Promise.all([
      fetch('/api/palletdata').then(r => r.json()),
      fetch('/api/packagingdata').then(r => r.json()),
    ]);
    pb.allPalletTypes = ptRes.data || ptRes;
    pb.allPackaging   = pkRes.data || pkRes;
    renderBuilderPhase1();
  } catch (err) {
    document.getElementById('pb-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
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
         allPackaging: [], allowedPackaging: [], packages: [], nextLayer: 1 };

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
    const [ptRes, pkRes, palRes, pkgsRes, valRes] = await Promise.all([
      fetch('/api/palletdata').then(r => r.json()),
      fetch('/api/packagingdata').then(r => r.json()),
      fetch(`/api/palletmain/id/${palletId}`).then(r => r.json()),
      fetch(`/api/palletpackages/pallet/${palletId}`).then(r => r.json()),
      fetch('/api/palletvalidation').then(r => r.json()),
    ]);

    pb.allPalletTypes = ptRes.data || ptRes;
    pb.allPackaging   = pkRes.data || pkRes;

    const palletRecord = (palRes.data || palRes)[0];
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

    // Validation endpoint now returns full PackagingData rows (BIGINT packagingID included)
    pb.allowedPackaging = valRes.data || valRes;

    renderBuilderPhase2();
  } catch (err) {
    document.getElementById('pb-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
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
        palletVolume:      0,
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
        <div class="pb-running-weights">
          <span>Pkg weight</span>
          <span id="pb-pkg-weight-display">${Number(pb.packagingWeight).toFixed(2)} kg</span>
        </div>
        <div class="pb-running-count" id="pb-pkg-count">${pb.packages.length} package${pb.packages.length !== 1 ? 's' : ''}</div>
        <div class="pb-running-list" id="pb-running-list">${renderRunningList()}</div>
        <div class="pb-running-actions">
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

    </div>`;

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

function renderRunningList() {
  if (!pb.packages.length)
    return `<div class="pb-running-empty">No packages added yet</div>`;
  return pb.packages.map(p => `
    <div class="pb-running-item">
      <span class="pb-running-layer">Layer ${p.palletLayer}</span>
      <span class="pb-running-pack">${esc(p.packagingID || '')}</span>
      ${p.sapBatch ? `<span class="pb-running-batch">${esc(p.sapBatch)}</span>` : ''}
    </div>`).join('');
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

async function addPackage() {
  const packInput  = document.querySelector('input[name="pb-pack"]:checked');
  const packType   = packInput?.value || null;
  const hasPackaging = pb.allowedPackaging.length > 0;

  if (hasPackaging && !packType) {
    showPbMsg('Select a packaging type first', 'error'); return;
  }

  const layer = parseInt(document.getElementById('pb-layer').value, 10) || pb.nextLayer;
  const batch = document.getElementById('pb-batch').value.trim();

  const selectedPkg   = packType ? pb.allowedPackaging.find(p => p.packagingID === packType) : null;
  const packWeight    = Number(selectedPkg?.packWeight || 0);

  // Use entered dimensions when the selected type has no defaults
  const dimsEl        = document.getElementById('pb-custom-dims');
  const usingCustom   = dimsEl && dimsEl.style.display !== 'none';
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

  try {
    const res  = await fetch('/api/palletpackages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        palletID:    pb.palletId,
        packagingID: packType || null,
        palletLayer: layer,
        sapBatch:    batch || null,
        sapDelivery: String(pb.deliveryId),
        sapCustomer: pb.customerId ? String(pb.customerId) : null,
        scanTime:    new Date().toISOString(),
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to add package');

    pb.packages.push({
      palletItemID: json.palletItemID,
      palletLayer:  layer,
      packagingID:  packType,
      sapBatch:     batch,
      packHeight,
      packWeight,
    });
    pb.nextLayer       = layer + 1;
    pb.packagingWeight = (pb.packagingWeight || 0) + packWeight;

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
    if (usingCustom) {
      ['pb-dim-l','pb-dim-w','pb-dim-h'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.value = ''; el.classList.remove('pb-input--error'); }
      });
    }

    showPbMsg(`✓ Added (layer ${layer})`, 'ok');
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

  try {
    const res  = await fetch(`/api/palletmain/${pb.palletId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        palletFinish: 1, palletLocation: loc,
        palletHeight: height, grossWeight,
      }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Update failed');
    closePalletBuilder();
    await refreshPalletList();
  } catch (err) { showPbMsg('✕ ' + err.message, 'error'); }
}

async function deletePalletFromBuilder() {
  if (!pb?.palletId) return;
  if (!confirm('Delete this pallet and all its packages? This cannot be undone.')) return;
  try {
    const res  = await fetch(`/api/palletmain/${pb.palletId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ palletRemoved: 1 }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Delete failed');
    closePalletBuilder();
    await refreshPalletList();
  } catch (err) { showPbMsg('✕ ' + err.message, 'error'); }
}

async function completeDelivery() {
  const { deliveryId } = _palletListCtx || {};
  if (!deliveryId) return;
  if (!confirm(`Mark Delivery #${deliveryId} as complete?\n\nThis will remove it from the open picksheets list.`)) return;
  try {
    const res  = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/complete`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Update failed');
    closePickModal();
    await runOpenPicksheets();
  } catch (err) { alert('Error: ' + err.message); }
}

function closePalletBuilder() {
  const overlay = document.getElementById('pb-overlay');
  if (overlay) overlay.classList.add('hidden');
  pb = null;
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
