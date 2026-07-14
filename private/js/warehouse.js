'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let activeDT          = null;
let currentResult     = [];
let sessionPermissions = [];
let pendingCSVRecords  = [];

// ── Session check on load ─────────────────────────────────────────────────────
(async () => {
  const d = await fetch('/session-check').then(r => r.json());
  if (!d.loggedIn) { window.location.href = '/'; return; }
  document.getElementById('session-user').textContent = d.username;
  sessionPermissions = d.permissions || [];
  setupTiles();
  setupSupervisorSection();
})();

function setupTiles() {
  document.querySelectorAll('.sap-tile--live[data-fn]').forEach(tile => {
    tile.addEventListener('click', () => {
      const fn = tile.dataset.fn;
      if (fn === 'displayStock')   runDisplayStock();
      if (fn === 'transferOrders') showTransferForm();
      if (fn === 'openPicksheets') runOpenPicksheets();
      if (fn === 'addPicksheet')   showAddPicksheetForm();
      if (fn === 'csvUpload')      showCSVUpload();
      if (fn === 'sapSync')        runSAPSync();
    });
  });

  document.querySelectorAll('.pn-section-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => {
      hdr.closest('.pn-section').classList.toggle('pn-section--collapsed');
    });
  });
}

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
    pageLength:    20,
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
        <button type="button" class="btn-secondary" onclick="runDisplayStock()">&larr; Back to Stock</button>
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
  try {
    const res  = await fetch(`/api/palletmain/${palletId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ palletFinish: 1 }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Update failed');
    await refreshPalletList();
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
         layerContainers: {} };

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
    const [ptRes, pkRes, stockRes] = await Promise.all([
      fetch('/api/palletdata').then(r => r.json()),
      fetch('/api/packagingdata').then(r => r.json()),
      fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/picksheet-materials`)
        .then(r => r.json()).catch(err => ({ success: false, error: err.message })),
    ]);
    pb.allPalletTypes = ptRes.data || ptRes;
    pb.allPackaging   = pkRes.data || pkRes;
    applyStockResult(stockRes);
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
         layerContainers: {} };

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
    const [ptRes, pkRes, palRes, pkgsRes, valRes, stockRes] = await Promise.all([
      fetch('/api/palletdata').then(r => r.json()),
      fetch('/api/packagingdata').then(r => r.json()),
      fetch(`/api/palletmain/id/${palletId}`).then(r => r.json()),
      fetch(`/api/palletpackages/pallet/${palletId}`).then(r => r.json()),
      fetch('/api/palletvalidation').then(r => r.json()),
      fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/picksheet-materials`)
        .then(r => r.json()).catch(err => ({ success: false, error: err.message })),
    ]);

    pb.allPalletTypes = ptRes.data || ptRes;
    pb.allPackaging   = pkRes.data || pkRes;
    applyStockResult(stockRes);

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

    // Rebuild which layers already have their outer box (SB/MB/LB) created,
    // so re-opening a pallet that already has PC2007 packages on it doesn't
    // create a duplicate container row the next time a batch is added to
    // that layer — and remembers WHICH size was used, since C2 batches added
    // later must go under the same box, not a newly-chosen one.
    existing
      .filter(p => isContainerPackagingId(p.packagingID) && !p.sapBatch)
      .forEach(p => { pb.layerContainers[p.palletLayer] = p.packagingID; });

    // Validation endpoint now returns full PackagingData rows (BIGINT packagingID included)
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

    return `<div class="pb-stock-material">
      <div class="pb-stock-material-hdr">
        <span class="pb-stock-material-code">${esc(m.material)}</span>
        <span class="pb-stock-material-req">req. ${Number(m.requiredQty || 0).toFixed(0)}</span>
      </div>
      ${batchRows}
    </div>`;
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
  menu.style.left = `${Math.min(event.pageX, window.innerWidth  - 210)}px`;
  menu.style.top  = `${Math.min(event.pageY, window.innerHeight - 90)}px`;
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

    if (pkg.sapMaterial && pkg.originalBatchEntry) {
      const mat = pb.requiredMaterials.find(m => m.material === pkg.sapMaterial);
      if (mat) {
        mat.batches = (mat.batches || []).filter(b => (b.batch || '') !== pkg.originalBatchEntry.batch);
        mat.batches.push(pkg.originalBatchEntry);
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
    if (pb.pendingSapMaterial && batch) {
      const mat = pb.requiredMaterials.find(m => m.material === pb.pendingSapMaterial);
      if (mat) {
        const idx = (mat.batches || []).findIndex(b => (b.batch || '') === batch);
        if (idx !== -1) { removedBatchEntry = mat.batches[idx]; mat.batches.splice(idx, 1); }
      }
    }

    pb.packages.push({
      palletItemID: json.palletItemID,
      palletLayer:  layer,
      packagingID:  effectivePackagingID,
      sapBatch:     batch,
      sapMaterial:  pb.pendingSapMaterial || null,
      originalBatchEntry: removedBatchEntry,
      packHeight,
      packWeight,
    });
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
  const { deliveryId } = _palletListCtx || {};
  if (!deliveryId) return;
  if (!await wConfirm({
    title: 'Complete Delivery',
    message: `Mark Delivery #${deliveryId} as complete?\nThis will remove it from the open picksheets list.`,
    confirmText: 'Complete',
    variant: 'success',
  })) return;
  try {
    const res  = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/complete`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Update failed');
    closePickModal();
    await runOpenPicksheets();
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

function parseCSVLine(line) {
  // Basic CSV parser — handles quoted fields
  const fields = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      fields.push(cur.trim()); cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}

function renderCSVPreview(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    document.getElementById('csv-preview').innerHTML =
      '<div class="sap-error">✕ File must have a header row and at least one data row</div>';
    return;
  }

  const EXPECTED_HEADERS = ['deliveryID','customerID','dispatchDate','deliveryService','deliveryPriority','picksheetComment'];
  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/\s/g, ''));
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
    const cols = parseCSVLine(lines[i]);
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
