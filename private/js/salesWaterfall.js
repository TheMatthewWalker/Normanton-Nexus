// private/js/salesWaterfall.js
//
// "Schedule Agreement Waterfall" tile — a rebuild of
// N:\Config\Office\Templates\AT_46c\sd_waterfall.xltm inside the Sales page.
// Filter form -> GET /api/sales/schedule-waterfall (routes/sales.js ->
// routes/salessap.js -> SapServer's SalesController) -> client-side pivot
// via buildWaterfallPivot (salesWaterfallPivot.js), rendered as a table with
// sticky label columns/header — the closest DOM equivalent of the source
// tool's frozen-pane PivotTable sheet.
//
// A type="module" script (unlike sales.js, a classic script) so it can
// import the pivot builder directly and so Jest can import it too. Exposes
// itself as window.SalesWaterfallReport.mount(), the same convention
// production-schedule.js uses for its own tile (window.ProductionScheduleReport.mount()).

import { buildWaterfallPivot } from './salesWaterfallPivot.js';

const LABEL_COLS = [
  { key: 'shipToParty', label: 'Ship-to' },
  { key: 'material', label: 'Material' },
  { key: 'idocWeek', label: 'Idoc Week' },
  { key: 'idocCreationDate', label: 'Idoc Date' },
  { key: 'idocNumber', label: 'Release' },
];
const LABEL_COL_WIDTH = 110;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function salesApi(path) {
  const r = await fetch('/api/sales' + path, { headers: { Accept: 'application/json' } });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON body */ }
  if (json?.success === false || !r.ok) throw new Error(json?.error || `Request failed (HTTP ${r.status})`);
  return json;
}

function buildQuery(filters) {
  const p = new URLSearchParams();
  p.set('salesOrg', filters.salesOrg);
  filters.shipToParties.forEach(v => p.append('shipToParties', v));
  filters.materials.forEach(v => p.append('materials', v));
  p.set('scheduleDateFrom', filters.scheduleDateFrom);
  p.set('scheduleDateTo', filters.scheduleDateTo);
  p.set('includeForecast', String(filters.includeForecast));
  p.set('includeJit', String(filters.includeJit));
  p.set('includeZeroQty', String(filters.includeZeroQty));
  if (filters.idocCreatedAfter) p.set('idocCreatedAfter', filters.idocCreatedAfter);
  return p.toString();
}

// Splits on commas, whitespace or newlines — lets a user paste a column out
// of Excel (one value per line) or type a quick comma-separated list.
function splitList(text) {
  return String(text || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

function formatQty(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-GB', { maximumFractionDigits: 0 });
}

function labelCellHtml(col, row, mergeRows, leftOffset) {
  if (mergeRows === 0) return ''; // merged into a previous row's rowspan
  const value = col.key === 'material'
    ? `${esc(row.material)}${row.materialDescription ? ' — ' + esc(row.materialDescription) : ''}`
    : esc(row[col.key] ?? '');
  return `<td rowspan="${mergeRows}" style="position:sticky;left:${leftOffset}px;z-index:1;min-width:${LABEL_COL_WIDTH}px;padding:6px 10px;border:1px solid var(--border);white-space:nowrap;background:var(--surface2);font-size:12px">${value}</td>`;
}

// For each label column, computes how many rows a repeated run of identical
// values (given all preceding label columns are also unchanged) should span
// — the flat-table equivalent of a PivotTable's merged row-group cells (the
// source tool ships with every row field expanded, not collapsed, so this
// matches its actual default look without needing interactive
// collapse/expand).
function computeRowSpans(rows) {
  const spans = rows.map(() => LABEL_COLS.map(() => 1));
  for (let c = 0; c < LABEL_COLS.length; c++) {
    let runStart = 0;
    for (let i = 1; i <= rows.length; i++) {
      const sameAsPrev = i < rows.length && LABEL_COLS.slice(0, c + 1).every(col => rows[i][col.key] === rows[i - 1][col.key]);
      if (!sameAsPrev) {
        const runLength = i - runStart;
        spans[runStart][c] = runLength;
        for (let r = runStart + 1; r < i; r++) spans[r][c] = 0;
        runStart = i;
      }
    }
  }
  return spans;
}

function renderPivotTable(pivot) {
  if (!pivot.rows.length) {
    return `<div style="padding:20px;color:var(--text-muted);font-size:13px">No schedule agreement data for these filters.</div>`;
  }

  const spans = computeRowSpans(pivot.rows);
  const leftOffsets = LABEL_COLS.reduce((acc, col, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + LABEL_COL_WIDTH);
    return acc;
  }, []);

  const headerLabelCells = LABEL_COLS.map((col, i) => `
    <th style="position:sticky;top:0;left:${leftOffsets[i]}px;z-index:3;min-width:${LABEL_COL_WIDTH}px;padding:6px 10px;border:1px solid var(--border);background:var(--surface2);font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--text-muted)">${col.label}</th>`).join('');
  const headerWeekCells = pivot.weeks.map(w => `
    <th style="position:sticky;top:0;z-index:2;min-width:80px;padding:6px 10px;border:1px solid var(--border);background:var(--surface2);font-size:11px;color:var(--text-muted)">${String(w).slice(0, 4)}<br>wk${String(w).slice(4)}</th>`).join('');

  const bodyRows = pivot.rows.map((row, i) => {
    const labelCells = LABEL_COLS.map((col, c) => labelCellHtml(col, row, spans[i][c], leftOffsets[c])).join('');
    const weekCells = pivot.weeks.map(w => {
      const v = row.cells.get(w);
      return `<td style="padding:6px 10px;border:1px solid var(--border);text-align:right;font-family:'JetBrains Mono',monospace;font-size:12px;${row.isCurrent ? 'background:rgba(59,130,246,0.08)' : ''}">${v === undefined ? '' : formatQty(v)}</td>`;
    }).join('');
    return `<tr>${labelCells}${weekCells}</tr>`;
  }).join('');

  return `
    <div style="overflow:auto;max-height:65vh;border:1px solid var(--border);border-radius:8px">
      <table style="border-collapse:collapse;width:max-content">
        <thead><tr>${headerLabelCells}${headerWeekCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>`;
}

function filterFormHtml() {
  return `
    <form id="waterfall-filters" style="padding:16px 20px;border-bottom:1px solid var(--border);display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;align-items:end">
      <div>
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Sales Org <span style="color:var(--error)">*</span></label>
        <input id="wf-salesorg" required style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box">
      </div>
      <div>
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Ship-to Part(y/ies) <span style="color:var(--error)">*</span></label>
        <input id="wf-shipto" required placeholder="comma/space separated" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box">
      </div>
      <div>
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Material(s)</label>
        <input id="wf-material" placeholder="optional" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box">
      </div>
      <div>
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Idoc Created After</label>
        <input id="wf-idocdate" type="date" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box">
      </div>
      <div>
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Schedule Date From <span style="color:var(--error)">*</span></label>
        <input id="wf-datefrom" type="date" required style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box">
      </div>
      <div>
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Schedule Date To <span style="color:var(--error)">*</span></label>
        <input id="wf-dateto" type="date" required style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box">
      </div>
      <div style="display:flex;gap:14px;align-items:center;font-size:12px">
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="wf-forecast" checked>Forecast</label>
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="wf-jit" checked>JIT</label>
      </div>
      <div style="display:flex;gap:14px;align-items:center;font-size:12px">
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="wf-zeroqty">Show 0 Qty.</label>
      </div>
      <div>
        <button type="submit" style="cursor:pointer;background:var(--accent);border:1px solid var(--accent);color:#fff;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;width:100%">Get SAP Data</button>
      </div>
    </form>
    <div id="waterfall-msg" style="padding:0 20px;font-size:12px;color:var(--error)"></div>
    <div id="waterfall-toolbar" style="padding:10px 20px;display:none;gap:10px;align-items:center">
      <button type="button" id="wf-toggle-cumulative" style="cursor:pointer;background:none;border:1px solid var(--border);border-radius:6px;padding:6px 14px;font-size:12px;font-weight:600">Show Cumulative</button>
      <span id="wf-row-count" style="font-size:12px;color:var(--text-muted)"></span>
    </div>
    <div id="waterfall-grid" style="padding:0 20px 20px"></div>`;
}

function mount() {
  const body = document.getElementById('result-body');
  body.innerHTML = filterFormHtml();

  let lastRows = null;
  let cumulative = false;

  const msgEl = document.getElementById('waterfall-msg');
  const gridEl = document.getElementById('waterfall-grid');
  const toolbarEl = document.getElementById('waterfall-toolbar');
  const toggleBtn = document.getElementById('wf-toggle-cumulative');
  const rowCountEl = document.getElementById('wf-row-count');

  function renderGrid() {
    if (!lastRows) return;
    const pivot = buildWaterfallPivot(lastRows, { cumulative });
    gridEl.innerHTML = renderPivotTable(pivot);
    rowCountEl.textContent = `${lastRows.length} row(s) · ${pivot.rows.length} release(s) · ${pivot.weeks.length} schedule week(s)`;
    toggleBtn.textContent = cumulative ? 'Show Raw Quantity' : 'Show Cumulative';
  }

  toggleBtn.addEventListener('click', () => {
    cumulative = !cumulative;
    renderGrid();
  });

  document.getElementById('waterfall-filters').addEventListener('submit', async (e) => {
    e.preventDefault();
    msgEl.textContent = '';

    const filters = {
      salesOrg: document.getElementById('wf-salesorg').value.trim(),
      shipToParties: splitList(document.getElementById('wf-shipto').value),
      materials: splitList(document.getElementById('wf-material').value),
      idocCreatedAfter: document.getElementById('wf-idocdate').value,
      scheduleDateFrom: document.getElementById('wf-datefrom').value,
      scheduleDateTo: document.getElementById('wf-dateto').value,
      includeForecast: document.getElementById('wf-forecast').checked,
      includeJit: document.getElementById('wf-jit').checked,
      includeZeroQty: document.getElementById('wf-zeroqty').checked,
    };

    if (!filters.salesOrg || !filters.shipToParties.length || !filters.scheduleDateFrom || !filters.scheduleDateTo) {
      msgEl.textContent = 'Sales Org, Ship-to and the Schedule Date range are required.';
      return;
    }

    toolbarEl.style.display = 'none';
    gridEl.innerHTML = `<div style="padding:20px;color:var(--text-muted);font-size:13px">Querying SAP…</div>`;

    try {
      const json = await salesApi('/schedule-waterfall?' + buildQuery(filters));
      lastRows = json.data || [];
      cumulative = false;
      toolbarEl.style.display = 'flex';
      renderGrid();
    } catch (err) {
      lastRows = null;
      gridEl.innerHTML = '';
      msgEl.textContent = err.message;
    }
  });
}

window.SalesWaterfallReport = { mount };
