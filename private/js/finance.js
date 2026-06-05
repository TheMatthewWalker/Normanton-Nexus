'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let activeDT      = null;
let currentResult = [];
let rawRows       = {};  // keyed by material for breakdown lookup

// ── Session check on load ─────────────────────────────────────────────────────
(async () => {
  const d = await fetch('/session-check').then(r => r.json());
  if (!d.loggedIn) { window.location.href = '/'; return; }
  document.getElementById('session-user').textContent = d.username;
})();

// ── Tile click handlers ───────────────────────────────────────────────────────
document.querySelectorAll('.sap-tile--live').forEach(tile => {
  tile.addEventListener('click', () => {
    if (tile.dataset.fn === 'materialCosting') showCostingForm();
    if (tile.dataset.fn === 'actualCosts')     showActualCostsForm();
    if (tile.dataset.fn === 'glGroupConfig')    showGlGroupConfig();
    if (tile.dataset.fn === 'profitCenterData') showProfitCenterForm();
  });
});

// ── Show result panel, hide tiles ─────────────────────────────────────────────
function showResultPanel(title, hint) {
  if (activeDT) { try { activeDT.destroy(); } catch (_) {} activeDT = null; }
  document.getElementById('tile-section').classList.add('hidden');
  document.getElementById('result-section').classList.remove('hidden');
  document.getElementById('result-title').textContent = title;
  document.getElementById('result-hint').textContent  = hint;
  document.getElementById('result-row-badge').classList.add('hidden');
  document.getElementById('btn-export-csv').classList.add('hidden');
}

// ── Back to tiles ─────────────────────────────────────────────────────────────
function backToTiles() {
  if (activeDT) { try { activeDT.destroy(); } catch (_) {} activeDT = null; }
  currentResult = [];
  document.getElementById('result-section').classList.add('hidden');
  document.getElementById('tile-section').classList.remove('hidden');
}

// ── Material Costing form ─────────────────────────────────────────────────────
function showCostingForm() {
  showResultPanel('Material Costing', 'SAP standard cost sheet via costing BAPI');

  document.getElementById('result-body').innerHTML = `
    <form class="cost-form" id="cost-form">
      <table class="cf-table" id="cf-table">
        <thead>
          <tr>
            <th class="cf-th">Material</th>
            <th class="cf-th">Quantity</th>
            <th class="cf-th">Incoterms</th>
            <th class="cf-th">Country</th>
            <th class="cf-th"></th>
          </tr>
        </thead>
        <tbody id="cf-tbody"></tbody>
      </table>
      <div class="cf-actions">
        <button type="button" class="btn-add-row" onclick="addCostingRow()">+ Add Row</button>
        <button class="btn-run" type="submit" id="cf-submit">Run</button>
      </div>
    </form>`;

  addCostingRow();
  document.getElementById('cost-form').addEventListener('submit', runMaterialCosting);
}

function addCostingRow() {
  const tbody = document.getElementById('cf-tbody');
  const tr = document.createElement('tr');
  tr.className = 'cf-data-row';
  tr.innerHTML = `
    <td><input class="cf-input" type="text" name="material" placeholder="000000000100012345"></td>
    <td><input class="cf-input" type="number" name="quantity" placeholder="100" min="0" step="any"></td>
    <td><input class="cf-input" type="text" name="incoterms" placeholder="DDP" maxlength="10"></td>
    <td><input class="cf-input" type="text" name="country" placeholder="GB" maxlength="3"></td>
    <td><button type="button" class="btn-remove-row" onclick="removeCostingRow(this)">✕</button></td>`;
  tbody.appendChild(tr);
  updateRemoveButtons();
}

function removeCostingRow(btn) {
  btn.closest('tr').remove();
  updateRemoveButtons();
}

function updateRemoveButtons() {
  const rows = document.querySelectorAll('#cf-tbody .cf-data-row');
  rows.forEach(r => {
    r.querySelector('.btn-remove-row').style.visibility = rows.length > 1 ? 'visible' : 'hidden';
  });
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

// ── Run Material Costing ──────────────────────────────────────────────────────
async function runMaterialCosting(e) {
  e.preventDefault();
  if (!await checkSession()) return;

  const items = Array.from(document.querySelectorAll('#cf-tbody .cf-data-row')).map(tr => {
    const material  = tr.querySelector('[name=material]').value.trim();
    const qtyRaw    = tr.querySelector('[name=quantity]').value.trim();
    const incoterms = tr.querySelector('[name=incoterms]').value.trim();
    const country   = tr.querySelector('[name=country]').value.trim();
    return {
      material,
      ...(qtyRaw    ? { quantity: parseFloat(qtyRaw) } : {}),
      ...(incoterms ? { incoterms }                    : {}),
      ...(country   ? { country }                      : {}),
    };
  });

  //const date = new Date().toISOString().slice(0, 10);
  const date = '31.12.2026';

  const btn = document.getElementById('cf-submit');
  btn.disabled = true;
  btn.textContent = 'Running…';

  document.getElementById('result-body').innerHTML =
    '<div class="sap-loading"><div class="spinner"></div>Connecting to SAP…</div>';

  try {
    const res  = await fetch('/api/sap/cost-sheet', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ items, date } ),
    });
    const json = await res.json();


    if (!json.success)
      throw new Error(json.error ?? 'SAP request failed');

    const rows = json.data

    console.log('Raw rows from SAP:', rows);

    if (!Array.isArray(rows) || rows.length === 0) {
      document.getElementById('result-body').innerHTML =
        '<div class="sap-error">No costing data returned for the selected parameters.</div>';
      return;
    }

    // Store raw rows keyed by material for breakdown lookup
    rawRows = {};
    rows.forEach(r => { if (r.material) rawRows[r.material] = r; });

    // Sum all kst fields for total cost, then derive per-unit cost
    currentResult = rows.map(r => {
      const kstTotal = Object.keys(r)
        .filter(k => k.startsWith('kst'))
        .reduce((sum, k) => sum + parseSapNumber(r[k]), 0);

      const lotSize = r.lotSize;
      const unit    = r.unit ?? '';

      return {
        Material:            r.material ?? '',
        'Price (£) Per Unit': (kstTotal / lotSize).toFixed(2) || 0,
        'Unit of Measure':   unit,
      };
    });

    renderResultTable(currentResult, Object.keys(currentResult[0]));

  } catch (err) {
    document.getElementById('result-body').innerHTML =
      `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
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
    <table id="fin-dt" style="width:100%">
      <thead>
        <tr>${columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr>
        <tr class="col-filter-row">${filterRow}</tr>
      </thead>
      <tbody>${tbody}</tbody>
    </table>`;

  activeDT = new DataTable('#fin-dt', {
    pageLength:    25,
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

  const badge = document.getElementById('result-row-badge');
  badge.textContent = `${records.length} rows`;
  badge.classList.remove('hidden');
  document.getElementById('btn-export-csv').classList.remove('hidden');

  // Right-click context menu on data rows
  document.querySelector('#fin-dt tbody').addEventListener('contextmenu', e => {
    const td = e.target.closest('td');
    if (!td) return;
    e.preventDefault();
    const material = td.closest('tr').querySelector('td')?.textContent?.trim();
    if (!material) return;
    showCtxMenu(e.clientX, e.clientY, material);
  });
}

// ── Context menu ──────────────────────────────────────────────────────────────
function showCtxMenu(x, y, material) {
  hideCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'fin-ctx-menu';
  menu.innerHTML = `
    <div class="ctx-item" id="ctx-breakdown">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="8" y1="1" x2="8" y2="15"/><path d="M11 4H5.5a2.5 2.5 0 000 5h5a2.5 2.5 0 010 5H4"/>
      </svg>
      View Cost Breakdown
    </div>`;
  menu.style.left = `${x}px`;
  menu.style.top  = `${y}px`;
  document.body.appendChild(menu);
  menu.querySelector('#ctx-breakdown').addEventListener('click', () => {
    hideCtxMenu();
    showBreakdownModal(material);
  });
  document.addEventListener('click', hideCtxMenu, { once: true });
}

function hideCtxMenu() {
  document.getElementById('fin-ctx-menu')?.remove();
}

// ── Cost breakdown modal ──────────────────────────────────────────────────────
const KST_LABELS = {
  kst001: 'Direct Material', kst002: 'Inbound Freight', kst004: 'Outbound Freight',
  kst006: 'Depreciation', kst008: 'Direct Labor', kst017: 'Variable Production Overhead',
  kst019: 'Scrap', kst033: 'Tariffs',
};

function showBreakdownModal(material) {
  const r = rawRows[material];
  if (!r) return;

  const kstKeys  = Object.keys(KST_LABELS);
  const lotSize  = r.lotSize ?? 1;
  const kstTotal = kstKeys.reduce((sum, k) => sum + parseSapNumber(r[k]), 0);
  const unit     = r.unit ?? '';

  const rows = kstKeys.map(k => {
    const val = parseSapNumber(r[k]);
    return `<tr>
      <td class="bd-label">${esc(KST_LABELS[k])}</td>
      <td class="bd-value">${(val / lotSize).toFixed(2)}</td>
      <td class="bd-pct">${(kstTotal) > 0 ? ((val / kstTotal) * 100).toFixed(1) + '%' : '—'}</td>
    </tr>`;
  }).join('');

  document.getElementById('fin-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'fin-modal';
  modal.className = 'fin-modal-overlay';
  modal.innerHTML = `
    <div class="fin-modal">
      <div class="fin-modal-header">
        <div>
          <div class="fin-modal-title">Cost Breakdown</div>
          <div class="fin-modal-sub">${esc(material)}</div>
        </div>
        <button class="fin-modal-close" onclick="document.getElementById('fin-modal').remove()">✕</button>
      </div>
      <table class="fin-modal-table">
        <thead><tr><th>Component</th><th>Value (£)</th><th>%</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr class="bd-total">
            <td>Total</td>
            <td>${(kstTotal / lotSize).toFixed(2)}</td>
            <td>100%</td>
          </tr>
        </tfoot>
      </table>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
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
  a.href = url; a.download = `material-costing-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Utility ───────────────────────────────────────────────────────────────────
// Handles SAP/German number format: "1.234,56" → 1234.56
// If already a JS number, returns as-is.
function parseSapNumber(val) {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  const s = String(val).replace(/\./g, '').replace(',', '.');
  return parseFloat(s) || 0;
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTUAL COSTS
// ═══════════════════════════════════════════════════════════════════════════

const AC_COLORS = [
  '#059669','#2563EB','#D97706','#7C3AED','#DC2626',
  '#0891B2','#65A30D','#C026D3','#EA580C','#0D9488',
];

let acChart = null;
let acMode  = 'group';

async function showActualCostsForm() {
  showResultPanel('Actual Costs', 'GL account period balances from SAP · debits, credits & running balance');
  document.getElementById('result-body').innerHTML =
    '<div class="sap-loading"><div class="spinner"></div>Loading groups…</div>';

  const now  = new Date();
  const year = now.getFullYear();
  const mon  = now.getMonth() + 1;

  let groups = [];
  try {
    const res = await fetch('/api/finance/gl-groups').then(r => r.json());
    groups = res.success ? (res.data || []) : [];
  } catch (_) {}

  const groupOpts = groups.length
    ? groups.map(g => `<option value="${g.id}">${esc(g.label)}</option>`).join('')
    : '<option value="">No groups configured</option>';

  document.getElementById('result-body').innerHTML = `
    <div class="ac-form" id="ac-form">
      <div class="ac-row">
        <div class="ac-field">
          <label class="ac-label">Fiscal Year</label>
          <input class="ac-input" id="ac-year" type="number" value="${year}" min="2020" max="2035" style="width:110px">
        </div>
        <div class="ac-field">
          <label class="ac-label">Period From</label>
          <select class="ac-select" id="ac-period-from" style="width:100px">
            ${Array.from({length:12},(_,i)=>`<option value="${i+1}" ${i===0?'selected':''}>P${String(i+1).padStart(2,'0')}</option>`).join('')}
          </select>
        </div>
        <div class="ac-field">
          <label class="ac-label">Period To</label>
          <select class="ac-select" id="ac-period-to" style="width:100px">
            ${Array.from({length:12},(_,i)=>`<option value="${i+1}" ${i+1===mon?'selected':''}>P${String(i+1).padStart(2,'0')}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="ac-field">
        <label class="ac-label">GL Account Source</label>
        <div class="ac-mode-toggle">
          <button class="ac-mode-btn active" id="ac-btn-group"  type="button">Predefined Group</button>
          <button class="ac-mode-btn"        id="ac-btn-manual" type="button">Manual Entry</button>
        </div>
      </div>

      <div id="ac-group-section">
        ${groups.length ? `
        <div class="ac-field" style="max-width:280px">
          <label class="ac-label">Group</label>
          <select class="ac-select" id="ac-group">${groupOpts}</select>
        </div>
        <div class="ac-group-preview" id="ac-group-preview"></div>` : `
        <p class="ac-hint" style="color:var(--error)">
          No GL account groups are configured yet.
          Use the <strong>GL Account Groups</strong> tile to create some, or switch to Manual Entry.
        </p>`}
      </div>

      <div id="ac-manual-section" class="hidden">
        <label class="ac-label" style="display:block;margin-bottom:8px">GL Accounts</label>
        <div id="ac-gl-list"></div>
        <button type="button" class="btn-add-row" id="ac-add-gl" style="margin-top:6px">+ Add GL Account</button>
        <p class="ac-hint" style="margin-top:6px">Enter without leading zeros — e.g. 601200</p>
      </div>

      <div>
        <button class="btn-run" id="ac-run">Run Query</button>
      </div>
    </div>`;

  // Store groups in closure for preview lookup
  acMode = 'group';
  const groupMap = Object.fromEntries(groups.map(g => [String(g.id), g]));

  const updatePreview = () => {
    const id  = document.getElementById('ac-group')?.value;
    const acc = groupMap[id]?.accounts || [];
    const el  = document.getElementById('ac-group-preview');
    if (el) el.innerHTML = acc.map(a => `<span class="ac-gl-tag">${esc(a)}</span>`).join('');
  };
  document.getElementById('ac-group')?.addEventListener('change', updatePreview);
  updatePreview();

  document.getElementById('ac-btn-group').addEventListener('click', () => {
    acMode = 'group';
    document.getElementById('ac-btn-group').classList.add('active');
    document.getElementById('ac-btn-manual').classList.remove('active');
    document.getElementById('ac-group-section').classList.remove('hidden');
    document.getElementById('ac-manual-section').classList.add('hidden');
  });
  document.getElementById('ac-btn-manual').addEventListener('click', () => {
    acMode = 'manual';
    document.getElementById('ac-btn-manual').classList.add('active');
    document.getElementById('ac-btn-group').classList.remove('active');
    document.getElementById('ac-manual-section').classList.remove('hidden');
    document.getElementById('ac-group-section').classList.add('hidden');
    if (!document.querySelector('.ac-gl-row')) acAddGlRow();
  });
  document.getElementById('ac-add-gl')?.addEventListener('click', acAddGlRow);
  document.getElementById('ac-run').addEventListener('click', () => runActualCosts(groupMap));
}

function acAddGlRow() {
  const list = document.getElementById('ac-gl-list');
  const row  = document.createElement('div');
  row.className = 'ac-gl-row';
  row.innerHTML = `
    <input class="ac-input ac-gl-input" type="text" placeholder="e.g. 601200" style="max-width:200px">
    <button type="button" class="btn-remove-row" onclick="this.closest('.ac-gl-row').remove()">✕</button>`;
  list.appendChild(row);
}

async function runActualCosts(groupMap = {}) {
  if (!await checkSession()) return;

  const year   = document.getElementById('ac-year')?.value.trim();
  const pFrom  = document.getElementById('ac-period-from')?.value;
  const pTo    = document.getElementById('ac-period-to')?.value;

  let glAccounts = [];
  if (acMode === 'group') {
    const id = document.getElementById('ac-group')?.value;
    glAccounts = groupMap[id]?.accounts || [];
  } else {
    glAccounts = [...document.querySelectorAll('.ac-gl-input')]
      .map(i => i.value.trim()).filter(Boolean);
  }

  if (!year) { alert('Please enter a fiscal year.'); return; }
  if (!glAccounts.length) { alert('Please select a group or enter at least one GL account.'); return; }
  if (Number(pFrom) > Number(pTo)) { alert('Period From must be ≤ Period To.'); return; }

  const btn = document.getElementById('ac-run');
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }

  document.getElementById('result-body').innerHTML =
    '<div class="sap-loading"><div class="spinner"></div>Connecting to SAP…</div>';

  try {
    const res  = await fetch('/api/sap/costing/period-balance', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ FiscalYear: year, PeriodFrom: pFrom, PeriodTo: pTo, GlAccounts: glAccounts }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error ?? 'SAP request failed');

    const data = json.data;
    if (!Array.isArray(data) || !data.length) {
      document.getElementById('result-body').innerHTML =
        '<div class="sap-error">No data returned for the selected parameters.</div>';
      return;
    }

    renderAcResults(data);

    const badge = document.getElementById('result-row-badge');
    badge.textContent = `${data.length} rows`;
    badge.classList.remove('hidden');
    document.getElementById('btn-export-csv').classList.remove('hidden');

  } catch (err) {
    document.getElementById('result-body').innerHTML =
      `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

function renderAcResults(data) {
  const glAccounts = [...new Set(data.map(r => r.glAccount))];
  const periods    = [...new Set(data.map(r => r.period))].sort();

  // ── Calculate period net and cumulative balance per GL account ──────────
  // We ignore the SAP `balance` field (it is year-to-date, not period-range).
  // Instead: period net = debit + credit (credit is signed negative in SAP).
  // Cumulative balance = running sum of period nets, starting from zero.
  const enriched = {};
  for (const gl of glAccounts) {
    let cum = 0;
    enriched[gl] = data
      .filter(r => r.glAccount === gl)
      .sort((a, b) => a.period.localeCompare(b.period))
      .map(r => {
        const debit     = Number(r.debit)  || 0;
        const creditAbs = Math.abs(Number(r.credit) || 0);
        cum += debit - creditAbs;
        return { period: r.period, debit, creditAbs, cumBal: cum };
      });
  }

  // ── Build flat currentResult for CSV export ─────────────────────────────
  currentResult = [];
  for (const gl of glAccounts) {
    const label = gl.replace(/^0+/, '') || '0';
    for (const r of enriched[gl]) {
      currentResult.push({
        'GL Account':  label,
        'Period':      `P${r.period}`,
        'Debit (£)':  fmtGBP(r.debit),
        'Credit (£)': fmtGBP(r.creditAbs),
        'Balance (£)':fmtGBP(r.cumBal),
      });
    }
  }

  // ── Build GL bucket sections ────────────────────────────────────────────
  let sectionsHtml  = '';
  let grandDebit    = 0;
  let grandCredit   = 0;

  for (const gl of glAccounts) {
    const label  = gl.replace(/^0+/, '') || '0';
    const rows   = enriched[gl];
    const totD   = rows.reduce((s, r) => s + r.debit,     0);
    const totC   = rows.reduce((s, r) => s + r.creditAbs, 0);
    const totBal = rows.length ? rows[rows.length - 1].cumBal : 0;
    grandDebit  += totD;
    grandCredit += totC;

    sectionsHtml += `
      <div class="ac-gl-bucket">
        <div class="ac-bucket-header">GL ${esc(label)}</div>
        <table class="ac-bucket-table">
          <thead>
            <tr>
              <th>Period</th>
              <th class="ac-num">Debit (£)</th>
              <th class="ac-num">Credit (£)</th>
              <th class="ac-num">Balance (£)</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td class="ac-mono">P${esc(r.period)}</td>
                <td class="ac-num">${esc(fmtGBP(r.debit))}</td>
                <td class="ac-num">${esc(fmtGBP(r.creditAbs))}</td>
                <td class="ac-num ${r.cumBal >= 0 ? 'ac-pos' : 'ac-neg'}">${esc(fmtGBP(r.cumBal))}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr class="ac-bucket-total">
              <td>Total</td>
              <td class="ac-num">${esc(fmtGBP(totD))}</td>
              <td class="ac-num">${esc(fmtGBP(totC))}</td>
              <td class="ac-num ${totBal >= 0 ? 'ac-pos' : 'ac-neg'}">${esc(fmtGBP(totBal))}</td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  }

  const grandBal     = grandDebit - grandCredit;
  const grandBalCls  = grandBal >= 0 ? 'ac-pos' : 'ac-neg';
  const grandTotalHtml = glAccounts.length > 1 ? `
    <div class="ac-grand-total">
      <span class="ac-grand-total-label">Group Total</span>
      <span class="ac-grand-total-val">Debit &nbsp;£${esc(fmtGBP(grandDebit))}</span>
      <span class="ac-grand-total-sep">·</span>
      <span class="ac-grand-total-val">Credit &nbsp;£${esc(fmtGBP(grandCredit))}</span>
      <span class="ac-grand-total-sep">·</span>
      <span class="ac-grand-total-val ${grandBalCls}">Balance &nbsp;£${esc(fmtGBP(grandBal))}</span>
    </div>` : '';

  // ── Render ──────────────────────────────────────────────────────────────
  if (activeDT) { try { activeDT.destroy(); } catch (_) {} activeDT = null; }

  document.getElementById('result-body').innerHTML = `
    <div class="ac-results">
      <div>
        <button class="ac-back" id="ac-back-btn">&larr; Adjust Parameters</button>
      </div>
      <div class="ac-chart-wrap">
        <div class="ac-section-title">Cumulative Balance by Period</div>
        <div class="ac-chart-canvas-wrap"><canvas id="ac-chart"></canvas></div>
      </div>
      <div class="ac-table-wrap">
        <div class="ac-section-title">Period Detail by GL Account</div>
        ${sectionsHtml}
        ${grandTotalHtml}
      </div>
    </div>`;

  document.getElementById('ac-back-btn').addEventListener('click', showActualCostsForm);

  // ── Chart.js — use calculated cumBal, not SAP balance field ────────────
  if (acChart) { acChart.destroy(); acChart = null; }

  const datasets = glAccounts.map((gl, idx) => {
    const label = gl.replace(/^0+/, '') || '0';
    const col   = AC_COLORS[idx % AC_COLORS.length];
    return {
      label,
      data: periods.map(p => {
        const row = enriched[gl].find(r => r.period === p);
        return row != null ? row.cumBal : null;
      }),
      borderColor:     col,
      backgroundColor: col + '18',
      borderWidth: 2,
      pointRadius: 4,
      pointHoverRadius: 6,
      tension: 0.3,
      fill: true,
      spanGaps: true,
    };
  });

  acChart = new Chart(document.getElementById('ac-chart'), {
    type: 'line',
    data: { labels: periods.map(p => `P${p}`), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { font: { family: "'JetBrains Mono', monospace", size: 11 }, padding: 16, usePointStyle: true, pointStyleWidth: 10 },
        },
        tooltip: {
          callbacks: { label: ctx => ` ${ctx.dataset.label}: £${fmtGBP(ctx.parsed.y)}` },
        },
      },
      scales: {
        x: { grid: { color: 'rgba(208,218,232,0.5)' }, ticks: { font: { family: "'JetBrains Mono', monospace", size: 10 } } },
        y: {
          grid: { color: 'rgba(208,218,232,0.5)' },
          ticks: { font: { family: "'JetBrains Mono', monospace", size: 10 }, callback: v => '£' + v.toLocaleString('en-GB') },
        },
      },
    },
  });
}

function fmtGBP(n) {
  const num = typeof n === 'number' ? n : Number(n);
  if (isNaN(num)) return '—';
  return num.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ═══════════════════════════════════════════════════════════════════════════
// PROFIT CENTER DATA
// ═══════════════════════════════════════════════════════════════════════════

let pcMode = 'group';

async function showProfitCenterForm() {
  showResultPanel('Profit Center Data', 'GL postings by profit center, invoice & material · filtered by period');
  document.getElementById('result-body').innerHTML =
    '<div class="sap-loading"><div class="spinner"></div>Loading groups…</div>';

  const now  = new Date();
  const year = now.getFullYear();
  const mon  = now.getMonth() + 1;

  let groups = [];
  try {
    const res = await fetch('/api/finance/gl-groups').then(r => r.json());
    groups = res.success ? (res.data || []) : [];
  } catch (_) {}

  const groupOpts = groups.length
    ? groups.map(g => `<option value="${g.id}">${esc(g.label)}</option>`).join('')
    : '<option value="">No groups configured</option>';

  const monthOpts = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    return `<option value="${m}" ${m === mon ? 'selected' : ''}>${String(m).padStart(2, '0')}</option>`;
  }).join('');

  document.getElementById('result-body').innerHTML = `
    <div class="ac-form" id="pc-form">
      <div class="ac-row">
        <div class="ac-field">
          <label class="ac-label">From Period (MM.YYYY)</label>
          <div class="pc-period-wrap">
            <select class="ac-select pc-period-select" id="pc-from-m">${monthOpts}</select>
            <span class="pc-period-sep">.</span>
            <input class="ac-input pc-period-year" id="pc-from-y" type="number" min="2020" max="2035" value="${year}">
          </div>
        </div>
        <div class="ac-field">
          <label class="ac-label">To Period (MM.YYYY)</label>
          <div class="pc-period-wrap">
            <select class="ac-select pc-period-select" id="pc-to-m">${monthOpts}</select>
            <span class="pc-period-sep">.</span>
            <input class="ac-input pc-period-year" id="pc-to-y" type="number" min="2020" max="2035" value="${year}">
          </div>
        </div>
      </div>

      <div class="ac-field">
        <label class="ac-label">GL Account Source</label>
        <div class="ac-mode-toggle">
          <button class="ac-mode-btn active" id="pc-btn-group"  type="button">Predefined Group</button>
          <button class="ac-mode-btn"        id="pc-btn-manual" type="button">Manual Entry</button>
        </div>
      </div>

      <div id="pc-group-section">
        ${groups.length ? `
        <div class="ac-field" style="max-width:280px">
          <label class="ac-label">Group</label>
          <select class="ac-select" id="pc-group">${groupOpts}</select>
        </div>
        <div class="ac-group-preview" id="pc-group-preview"></div>` : `
        <p class="ac-hint" style="color:var(--error)">
          No GL account groups configured.
          Use <strong>GL Account Groups</strong> to create some, or switch to Manual Entry.
        </p>`}
      </div>

      <div id="pc-manual-section" class="hidden">
        <label class="ac-label" style="display:block;margin-bottom:8px">GL Accounts</label>
        <div id="pc-gl-list"></div>
        <button type="button" class="btn-add-row" id="pc-add-gl" style="margin-top:6px">+ Add GL Account</button>
        <p class="ac-hint" style="margin-top:6px">Enter without leading zeros — e.g. 301000</p>
      </div>

      <div>
        <button class="btn-run" id="pc-run">Run Query</button>
      </div>
    </div>`;

  pcMode = 'group';
  const groupMap = Object.fromEntries(groups.map(g => [String(g.id), g]));

  const updatePreview = () => {
    const id  = document.getElementById('pc-group')?.value;
    const acc = groupMap[id]?.accounts || [];
    const el  = document.getElementById('pc-group-preview');
    if (el) el.innerHTML = acc.map(a => `<span class="ac-gl-tag">${esc(a)}</span>`).join('');
  };
  document.getElementById('pc-group')?.addEventListener('change', updatePreview);
  updatePreview();

  document.getElementById('pc-btn-group').addEventListener('click', () => {
    pcMode = 'group';
    document.getElementById('pc-btn-group').classList.add('active');
    document.getElementById('pc-btn-manual').classList.remove('active');
    document.getElementById('pc-group-section').classList.remove('hidden');
    document.getElementById('pc-manual-section').classList.add('hidden');
  });
  document.getElementById('pc-btn-manual').addEventListener('click', () => {
    pcMode = 'manual';
    document.getElementById('pc-btn-manual').classList.add('active');
    document.getElementById('pc-btn-group').classList.remove('active');
    document.getElementById('pc-manual-section').classList.remove('hidden');
    document.getElementById('pc-group-section').classList.add('hidden');
    if (!document.querySelector('.pc-gl-row')) pcAddGlRow();
  });
  document.getElementById('pc-add-gl')?.addEventListener('click', pcAddGlRow);
  document.getElementById('pc-run').addEventListener('click', () => runProfitCenter(groupMap));
}

function pcAddGlRow() {
  const list = document.getElementById('pc-gl-list');
  const row  = document.createElement('div');
  row.className = 'ac-gl-row pc-gl-row';
  row.innerHTML = `
    <input class="ac-input pc-gl-input" type="text" placeholder="e.g. 301000" style="max-width:200px">
    <button type="button" class="btn-remove-row" onclick="this.closest('.pc-gl-row').remove()">✕</button>`;
  list.appendChild(row);
}

async function runProfitCenter(groupMap = {}) {
  if (!await checkSession()) return;

  const fromM = Number(document.getElementById('pc-from-m')?.value);
  const fromY = Number(document.getElementById('pc-from-y')?.value);
  const toM   = Number(document.getElementById('pc-to-m')?.value);
  const toY   = Number(document.getElementById('pc-to-y')?.value);

  let glAccounts = [];
  if (pcMode === 'group') {
    const id = document.getElementById('pc-group')?.value;
    glAccounts = groupMap[id]?.accounts || [];
  } else {
    glAccounts = [...document.querySelectorAll('.pc-gl-input')]
      .map(i => i.value.trim()).filter(Boolean);
  }

  if (!fromM || !fromY || !toM || !toY) { alert('Please select a period range.'); return; }
  if (fromY * 12 + fromM > toY * 12 + toM) { alert('From period must be on or before To period.'); return; }
  if (!glAccounts.length) { alert('Please select a group or enter at least one GL account.'); return; }

  const pad       = n => String(n).padStart(2, '0');
  const lastDay   = (y, m) => new Date(y, m, 0).getDate();   // day 0 of next month = last day of this month
  const DateFrom  = `01.${pad(fromM)}.${fromY}`;
  const DateTo    = `${lastDay(toY, toM)}.${pad(toM)}.${toY}`;

  const btn = document.getElementById('pc-run');
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }

  document.getElementById('result-body').innerHTML =
    '<div class="sap-loading"><div class="spinner"></div>Connecting to SAP…</div>';

  try {
    const res  = await fetch('/api/sap/costing/profit-center', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ DateFrom, DateTo, GlAccounts: glAccounts }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error ?? 'SAP request failed');

    const data = json.data;
    if (!Array.isArray(data) || !data.length) {
      document.getElementById('result-body').innerHTML =
        '<div class="sap-error">No postings found for the selected parameters.</div>';
      return;
    }

    renderProfitCenterResults(data);

    const badge = document.getElementById('result-row-badge');
    badge.textContent = `${data.length} row${data.length !== 1 ? 's' : ''}`;
    badge.classList.remove('hidden');
    document.getElementById('btn-export-csv').classList.remove('hidden');

  } catch (err) {
    document.getElementById('result-body').innerHTML =
      `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

const PC_SEGMENT_MAP = {
  PV:   new Set(['2008','2010','2011','2014','2015','2017','2018','2024','2025','2028','2029','2030']),
  PTFE: new Set(['2000','2001','2002','2003','2004','2005','2006','2007','2009','2012','2016','2021','2022','9912']),
};
const PC_SEGMENT_ORDER = ['PTFE', 'PV', 'Other'];

function getSegment(profitCenter) {
  const pc = String(profitCenter || '').trim();
  if (PC_SEGMENT_MAP.PV.has(pc))   return 'PV';
  if (PC_SEGMENT_MAP.PTFE.has(pc)) return 'PTFE';
  return 'Other';
}

function renderProfitCenterResults(data) {
  // ── Enrich each row with its segment ───────────────────────────────────
  const enriched = data.map(r => ({ ...r, _segment: getSegment(r.profitCenter) }));

  // ── Build segment → profit center → { count, total } map ───────────────
  const segMap = {};
  for (const r of enriched) {
    const seg = r._segment;
    const pc  = r.profitCenter || '—';
    if (!segMap[seg])     segMap[seg]     = { count: 0, total: 0, pcs: {} };
    if (!segMap[seg].pcs[pc]) segMap[seg].pcs[pc] = { count: 0, total: 0 };
    const val = Number(r.companyCodeValue) || 0;
    segMap[seg].count++;
    segMap[seg].total       += val;
    segMap[seg].pcs[pc].count++;
    segMap[seg].pcs[pc].total += val;
  }

  const grandTotal = enriched.reduce((s, r) => s + (Number(r.companyCodeValue) || 0), 0);

  // ── Build one bucket per segment (only segments that have data) ─────────
  const segBuckets = PC_SEGMENT_ORDER
    .filter(seg => segMap[seg])
    .map(seg => {
      const s    = segMap[seg];
      const pcRows = Object.entries(s.pcs)
        .sort(([, a], [, b]) => Math.abs(b.total) - Math.abs(a.total))
        .map(([pc, p]) => `
          <tr>
            <td class="ac-mono">${esc(pc)}</td>
            <td class="ac-num" style="color:var(--text-muted)">${p.count}</td>
            <td class="ac-num ${p.total >= 0 ? 'ac-pos' : 'ac-neg'}">${esc(fmtGBP(p.total))}</td>
          </tr>`).join('');

      return `
        <div class="ac-gl-bucket">
          <div class="ac-bucket-header">${esc(seg)}</div>
          <table class="ac-bucket-table">
            <thead>
              <tr>
                <th>Profit Center</th>
                <th class="ac-num">Transactions</th>
                <th class="ac-num">Total Value (£)</th>
              </tr>
            </thead>
            <tbody>${pcRows}</tbody>
            <tfoot>
              <tr class="ac-bucket-total">
                <td>Total ${esc(seg)}</td>
                <td class="ac-num">${s.count}</td>
                <td class="ac-num ${s.total >= 0 ? 'ac-pos' : 'ac-neg'}">${esc(fmtGBP(s.total))}</td>
              </tr>
            </tfoot>
          </table>
        </div>`;
    }).join('');

  // ── Grand total bar ─────────────────────────────────────────────────────
  const grandParts = PC_SEGMENT_ORDER
    .filter(seg => segMap[seg])
    .map(seg => {
      const t = segMap[seg].total;
      return `<span class="ac-grand-total-val ${t >= 0 ? 'ac-pos' : 'ac-neg'}">${esc(seg)}&nbsp;&nbsp;£${esc(fmtGBP(t))}</span>`;
    }).join(`<span class="ac-grand-total-sep">·</span>`);

  const grandTotalHtml = `
    <div class="ac-grand-total" style="margin-top:16px">
      <span class="ac-grand-total-label">Total</span>
      ${grandParts}
      <span class="ac-grand-total-sep">·</span>
      <span class="ac-grand-total-val ${grandTotal >= 0 ? 'ac-pos' : 'ac-neg'}">All&nbsp;&nbsp;£${esc(fmtGBP(grandTotal))}</span>
    </div>`;

  // ── Detail table — Segment column prepended ─────────────────────────────
  const cols = [
    { key: 'postingDate',      label: 'Posting Date',  cls: 'ac-mono' },
    { key: '_segment',         label: 'Segment',       cls: 'ac-mono' },
    { key: 'profitCenter',     label: 'Profit Center', cls: 'ac-mono' },
    { key: 'glAccount',        label: 'GL Account',    cls: 'ac-mono' },
    { key: 'companyCodeValue', label: 'Value (£)',      cls: 'ac-num'  },
    { key: 'materialNumber',   label: 'Material',      cls: 'ac-mono' },
    { key: 'customer',         label: 'Customer',      cls: 'ac-mono' },
    { key: 'salesOrder',       label: 'Sales Order',   cls: 'ac-mono' },
    { key: 'salesOrderItem',   label: 'SO Item',       cls: 'ac-mono' },
    { key: 'invoiceNumber',    label: 'Invoice',       cls: 'ac-mono' },
    { key: 'invoiceItem',      label: 'Inv. Item',     cls: 'ac-mono' },
    { key: 'fiscalYear',       label: 'Year',          cls: 'ac-mono' },
  ];

  const headerRow = cols.map(c => `<th>${esc(c.label)}</th>`).join('');
  const filterRow = cols.map((c, i) =>
    `<th><input class="col-filter-input" type="text" placeholder="${esc(c.label)}…" data-col="${i}"></th>`
  ).join('');

  const bodyRows = enriched.map(r => {
    const val    = Number(r.companyCodeValue) || 0;
    const valCls = val >= 0 ? 'ac-pos' : 'ac-neg';
    return `<tr>${cols.map(c => {
      if (c.key === 'companyCodeValue')
        return `<td class="${c.cls} ${valCls}">${esc(fmtGBP(val))}</td>`;
      return `<td class="${c.cls}">${esc(String(r[c.key] ?? ''))}</td>`;
    }).join('')}</tr>`;
  }).join('');

  // ── Update CSV export ────────────────────────────────────────────────────
  currentResult = enriched.map(r => ({
    'Segment':       r._segment,
    'GL Account':    r.glAccount       || '',
    'Profit Center': r.profitCenter    || '',
    'Fiscal Year':   r.fiscalYear      || '',
    'Posting Date':  r.postingDate     || '',
    'Value (£)':     fmtGBP(r.companyCodeValue),
    'Material':      r.materialNumber  || '',
    'Customer':      r.customer        || '',
    'Sales Order':   r.salesOrder      || '',
    'SO Item':       r.salesOrderItem  || '',
    'Invoice':       r.invoiceNumber   || '',
    'Inv. Item':     r.invoiceItem     || '',
  }));

  if (activeDT) { try { activeDT.destroy(); } catch (_) {} activeDT = null; }

  document.getElementById('result-body').innerHTML = `
    <div class="ac-results">
      <div>
        <button class="ac-back" id="pc-back-btn">&larr; Adjust Parameters</button>
      </div>
      <div class="ac-table-wrap">
        <div class="ac-section-title">Summary by Business Segment</div>
        ${segBuckets}
        ${grandTotalHtml}
      </div>
      <div class="ac-table-wrap">
        <div class="ac-section-title">Transaction Detail</div>
        <table id="fin-dt" style="width:100%">
          <thead>
            <tr>${headerRow}</tr>
            <tr class="col-filter-row">${filterRow}</tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>`;

  document.getElementById('pc-back-btn').addEventListener('click', showProfitCenterForm);

  activeDT = new DataTable('#fin-dt', {
    pageLength: 25, scrollX: true, orderCellsTop: true,
    order: [[0, 'asc']],
    initComplete: function () {
      const api = this.api();
      api.table().header().querySelectorAll('.col-filter-input').forEach(inp => {
        inp.addEventListener('input', function () {
          api.column(Number(this.dataset.col)).search(this.value).draw();
        });
      });
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// GL ACCOUNT GROUP CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

async function showGlGroupConfig() {
  showResultPanel('GL Account Groups', 'Create, edit and delete named GL account groups');
  document.getElementById('result-body').innerHTML =
    '<div class="sap-loading"><div class="spinner"></div>Loading…</div>';

  await renderGlGroupList();
}

async function renderGlGroupList() {
  let groups = [];
  try {
    const res = await fetch('/api/finance/gl-groups').then(r => r.json());
    groups = res.success ? (res.data || []) : [];
  } catch (_) {}

  const listHtml = groups.length ? groups.map(g => `
    <div class="glg-item" data-id="${g.id}">
      <div class="glg-item-header">
        <span class="glg-item-label">${esc(g.label)}</span>
        <div class="glg-item-actions">
          <button class="btn-glg-edit"   data-id="${g.id}">Edit</button>
          <button class="btn-glg-delete" data-id="${g.id}">Delete</button>
        </div>
      </div>
      <div class="glg-accounts">
        ${g.accounts.length
          ? g.accounts.map(a => `<span class="glg-account-chip">${esc(a)}</span>`).join('')
          : `<span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted)">No accounts added</span>`}
      </div>
    </div>`).join('')
    : `<div class="glg-empty">No groups yet — create your first one using the button above.</div>`;

  document.getElementById('result-body').innerHTML = `
    <div style="max-width:640px">
      <div class="glg-toolbar">
        <span class="glg-heading">${groups.length} group${groups.length !== 1 ? 's' : ''} configured</span>
        <button class="btn-new-group" id="glg-new">+ New Group</button>
      </div>
      <div class="glg-list">${listHtml}</div>
    </div>`;

  document.getElementById('glg-new').addEventListener('click', () => openGlGroupModal(null, groups));

  document.querySelectorAll('.btn-glg-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = groups.find(g => g.id === Number(btn.dataset.id));
      if (group) openGlGroupModal(group, groups);
    });
  });

  document.querySelectorAll('.btn-glg-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteGlGroup(Number(btn.dataset.id), groups));
  });
}

function openGlGroupModal(group, groups) {
  const isNew    = !group;
  const title    = isNew ? 'New GL Account Group' : 'Edit GL Account Group';
  const accounts = group?.accounts || [];

  document.getElementById('fin-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.id        = 'fin-modal';
  overlay.className = 'fin-modal-overlay';

  const accountRowsHtml = () => {
    const rows = overlay.querySelectorAll('.glg-account-row input');
    return [...rows].map((inp, i) => `
      <div class="glg-account-row" data-idx="${i}">
        <input type="text" placeholder="e.g. 601200" value="${esc(inp.value)}"
               style="font-family:'JetBrains Mono',monospace">
        <button type="button" class="btn-remove-row glg-remove-acc">✕</button>
      </div>`).join('');
  };

  const buildRows = (accs) => accs.map((a, i) => `
    <div class="glg-account-row">
      <input type="text" placeholder="e.g. 601200" value="${esc(a)}"
             style="font-family:'JetBrains Mono',monospace">
      <button type="button" class="btn-remove-row glg-remove-acc">✕</button>
    </div>`).join('');

  overlay.innerHTML = `
    <div class="glg-modal">
      <div class="glg-modal-header">
        <span class="glg-modal-title">${esc(title)}</span>
        <button class="fin-modal-close" id="glg-close">✕</button>
      </div>
      <div class="glg-modal-body">
        <div class="glg-modal-field">
          <label class="glg-modal-label">Group Name</label>
          <input class="ac-input" id="glg-label" type="text"
                 placeholder="e.g. Logistics" value="${esc(group?.label || '')}">
        </div>
        <div class="glg-modal-field">
          <label class="glg-modal-label">GL Accounts</label>
          <div class="glg-account-rows" id="glg-acc-rows">
            ${buildRows(accounts.length ? accounts : [''])}
          </div>
          <button type="button" class="btn-add-row" id="glg-add-acc">+ Add Account</button>
          <p class="ac-hint" style="margin-top:6px">Enter without leading zeros — e.g. 601200</p>
        </div>
      </div>
      <div class="glg-modal-footer">
        <span class="glg-modal-err" id="glg-err"></span>
        <button class="btn-glg-cancel" id="glg-cancel">Cancel</button>
        <button class="btn-glg-save"   id="glg-save">Save Group</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const closeModal = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.getElementById('glg-close').addEventListener('click',  closeModal);
  document.getElementById('glg-cancel').addEventListener('click', closeModal);

  const addRow = (val = '') => {
    const div = document.createElement('div');
    div.className = 'glg-account-row';
    div.innerHTML = `
      <input type="text" placeholder="e.g. 601200" value="${esc(val)}"
             style="font-family:'JetBrains Mono',monospace">
      <button type="button" class="btn-remove-row glg-remove-acc">✕</button>`;
    document.getElementById('glg-acc-rows').appendChild(div);
    div.querySelector('input').focus();
    updateRemoveVisibility();
  };

  const updateRemoveVisibility = () => {
    const rows = document.querySelectorAll('#glg-acc-rows .glg-account-row');
    rows.forEach(r => {
      r.querySelector('.glg-remove-acc').style.visibility = rows.length > 1 ? 'visible' : 'hidden';
    });
  };

  document.getElementById('glg-acc-rows').addEventListener('click', e => {
    if (e.target.closest('.glg-remove-acc')) {
      e.target.closest('.glg-account-row').remove();
      updateRemoveVisibility();
    }
  });

  document.getElementById('glg-add-acc').addEventListener('click', () => addRow());
  updateRemoveVisibility();

  document.getElementById('glg-save').addEventListener('click', async () => {
    const label    = document.getElementById('glg-label').value.trim();
    const accounts = [...document.querySelectorAll('#glg-acc-rows input')]
      .map(i => i.value.trim()).filter(Boolean);
    const errEl    = document.getElementById('glg-err');
    const saveBtn  = document.getElementById('glg-save');

    if (!label) { errEl.textContent = 'Group name is required.'; return; }

    errEl.textContent = '';
    saveBtn.disabled  = true;
    saveBtn.textContent = 'Saving…';

    try {
      const method = isNew ? 'POST' : 'PUT';
      const url    = isNew ? '/api/finance/gl-groups' : `/api/finance/gl-groups/${group.id}`;
      const res    = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, accounts }),
      }).then(r => r.json());

      if (!res.success) throw new Error(res.error || 'Save failed.');
      closeModal();
      renderGlGroupList();
    } catch (err) {
      errEl.textContent = err.message;
      saveBtn.disabled  = false;
      saveBtn.textContent = 'Save Group';
    }
  });
}

async function deleteGlGroup(id, groups) {
  const group = groups.find(g => g.id === id);
  if (!group) return;
  if (!confirm(`Delete group "${group.label}"? This cannot be undone.`)) return;

  try {
    const res = await fetch(`/api/finance/gl-groups/${id}`, { method: 'DELETE' }).then(r => r.json());
    if (!res.success) throw new Error(res.error || 'Delete failed.');
    renderGlGroupList();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}
