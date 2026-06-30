'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let currentTable   = null;   // table name currently displayed
let currentPK      = null;   // PK column for the current table
let currentRows    = [];     // current recordset (filtered or unfiltered)
let currentColumns = [];     // column names for the current table
let contextRowIdx  = null;   // row index for right-click context
let activeDT       = null;   // live DataTable instance
let activeFilter   = null;   // { col, mode, val } or null

// ── Drill-down relationship map ───────────────────────────────────────────────
// pkCol  — column in the PARENT row to read the value from
// fkCol  — column in the CHILD table to filter on
const DRILLDOWN = {
  Batches: [
    { table: 'Coils',   pkCol: 'Drum',    fkCol: 'Batch'  },
    // { table: 'Trace',   pkCol: 'Drum',    fkCol: 'Batch'  },
    { table: 'Waste',   pkCol: 'Drum',    fkCol: 'Batch'  },
    { table: 'Messages', pkCol: 'Drum',    fkCol: 'Batch'  },
  ],
  Ewald: [
    { table: 'EwaldBoxes',     pkCol: 'ID', fkCol: 'EwaldID' },
    { table: 'EwaldMessages',  pkCol: 'ID', fkCol: 'Batch'   },
    //{ table: 'EwaldScrapDocs', pkCol: 'ID', fkCol: 'EwaldID' },
    { table: 'EwaldWaste',     pkCol: 'ID', fkCol: 'EwaldID' },
  ],
  Mixing: [
    { table: 'MixingMatDocs',  pkCol: 'MixingID', fkCol: 'MixingBatch' },
    { table: 'MixingMessages', pkCol: 'MixingID', fkCol: 'Batch'       },
    // { table: 'MixingWaste',    pkCol: 'MixingID', fkCol: 'MixingID'    },
  ],
  Extrusion: [
    { table: 'ExtrusionMessages', pkCol: 'ExtBatch', fkCol: 'Batch'    },
    { table: 'ExtrusionTrace',    pkCol: 'ExtBatch', fkCol: 'ExtBatch' },
    { table: 'ExtrusionWaste',    pkCol: 'ExtBatch', fkCol: 'ExtBatch' },
  ],
  Convo: [
    { table: 'ConvoMessages', pkCol: 'ConvoID', fkCol: 'Batch'      },
    { table: 'ConvoTrace',    pkCol: 'ConvoID', fkCol: 'ConvoID'    },
    { table: 'ConvoWaste',    pkCol: 'ConvoID', fkCol: 'convobatch' },
  ],
  Firewall: [
    { table: 'FirewallMessages', pkCol: 'SAPBatch', fkCol: 'SAPBatch' },
  ],
  Staging: [
    { table: 'StagingItems', pkCol: 'StagingID', fkCol: 'StagingID' },
  ],
};

// ── Session management ────────────────────────────────────────────────────────
setInterval(async () => {
  const d = await fetch('/session-check').then(r => r.json());
  if (!d.loggedIn) { alert('Session expired. Please log in again.'); window.location.href = '/'; }
}, 300_000);

async function sessionOk() {
  const d = await fetch('/session-check').then(r => r.json());
  if (!d.loggedIn) { window.location.href = '/'; return false; }
  return true;
}

// ── Sidebar — table items only (report items handled separately below) ──────
document.querySelectorAll('.tbl-item:not(.report-item)').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.tbl-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    // Switching table always resets the filter and hides the report panel
    activeFilter = null;
    currentReport = null;
    if (typeof reportChart  !== 'undefined' && reportChart)  { reportChart.destroy();  reportChart  = null; }
    if (typeof reportChart2 !== 'undefined' && reportChart2) { reportChart2.destroy(); reportChart2 = null; }
    if (typeof reportChart3 !== 'undefined' && reportChart3) { reportChart3.destroy(); reportChart3 = null; }
    if (typeof reportChart4 !== 'undefined' && reportChart4) { reportChart4.destroy(); reportChart4 = null; }
    document.getElementById('report-panel').style.display = 'none';
    document.getElementById('data-panel').style.display   = '';
    loadTable(item.dataset.table, item.dataset.pk || null);
  });
});

// ── Build SQL for the current table + optional filter ─────────────────────────
// All filtering is done SERVER-SIDE via parameterised queries so it searches
// the full table, not just the rows already in memory.
//
// We send the query through the existing /query endpoint.  Because the column
// name comes from a whitelist (columns returned by SQL Server itself) and the
// table name was already vetted by the sidebar, the only truly "user" value
// is the filter string — which we embed safely using SQL LIKE / = patterns
// controlled entirely here.  The value never touches the SQL string; it is
// passed as a separate parameter via the /api/filter-records endpoint below.
function buildQuery(tableName, filter) {
  if (!filter) {
    return { sql: `SELECT * FROM dbo.${tableName}`, parameterised: false };
  }
  return { tableName, col: filter.col, mode: filter.mode, val: filter.val, parameterised: true };
}

// ── Load (or reload) the main data panel ─────────────────────────────────────
async function loadTable(tableName, pkCol, filter = null) {
  if (!(await sessionOk())) return;

  currentTable  = tableName;
  currentPK     = pkCol;
  currentRows   = [];
  contextRowIdx = null;

  // Toolbar
  document.getElementById('toolbar').style.display = 'flex';
  document.getElementById('toolbar-title').textContent = tableName;
  document.getElementById('row-badge').textContent = '…';
  document.getElementById('toolbar-hint').textContent = DRILLDOWN[tableName]
    ? 'Right-click any row to drill into related sub-tables'
    : 'No drill-down configured for this table';

  // Destroy existing DataTable
  if (activeDT) { try { activeDT.destroy(); } catch (_) {} activeDT = null; }

  // Spinner
  document.getElementById('data-panel').innerHTML =
    '<div class="loading-wrap"><div class="spinner"></div>Loading data…</div>';

  try {
    let records;

    if (!filter) {
      // ── Unfiltered: plain TOP 500 via existing /query endpoint ──
      const res  = await fetch('/sql/query', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ query: `SELECT * FROM dbo.${tableName}` }),
      });
      const data = await res.json();
      if (!data.success) { showError(data.error || 'Query failed'); return; }
      records = data.recordset || [];
    } else {
      // ── Filtered: dedicated parameterised endpoint ──
      const res  = await fetch('/api/filter-records', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          tableName: tableName,
          col:       filter.col,
          mode:      filter.mode,
          val:       filter.val,
        }),
      });
      const data = await res.json();
      if (!data.success) { showError(data.error || 'Filter query failed'); return; }
      records = data.recordset || [];
    }

    if (records.length === 0) {
      document.getElementById('data-panel').innerHTML = emptyBlock();
      document.getElementById('row-badge').textContent = '0 rows';
      return;
    }

    currentRows    = records;
    currentColumns = Object.keys(records[0]);

    document.getElementById('row-badge').textContent = `${records.length} rows`;

    // Render table with per-column filter inputs
    document.getElementById('data-panel').innerHTML = buildTableHTML(records, 'main-dt', true);
    activeDT = new DataTable('#main-dt', {
      pageLength:    10,
      scrollX:       true,
      orderCellsTop: true,
      initComplete:  function () {
        const api = this.api();
        // Wire each column filter input — every column has one so idx === column index
        api.table().header().querySelectorAll('.col-filter-input').forEach((input, idx) => {
          input.addEventListener('input', function () {
            api.column(idx).search(this.value).draw();
          });
        });
      },
    });

    // Right-click via delegation on the tbody so it works across all pages.
    // DataTables re-renders rows on page change; attaching to individual <tr>
    // elements would lose the listeners. One delegated listener on the static
    // table element survives all page changes.
    document.querySelector('#main-dt tbody').addEventListener('contextmenu', e => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      e.preventDefault();

      // DataTables tracks each row with an internal index that corresponds
      // directly to the order rows were added — which matches currentRows.
      const dtRow = activeDT.row(tr);
      if (!dtRow || dtRow.index() === undefined) return;
      contextRowIdx = dtRow.index();

      showCtx(e, tableName);
    });

  } catch (err) {
    showError(err.message);
  }
}

// ── Context menu ──────────────────────────────────────────────────────────────
function showCtx(e, tableName) {
  const menu = document.getElementById('ctx-menu');
  document.getElementById('ctx-label').textContent = `dbo.${tableName}`;
  document.getElementById('ctx-drill').classList.toggle('disabled', !DRILLDOWN[tableName]);
  menu.style.display = 'block';
  const x = Math.min(e.clientX, window.innerWidth  - 240);
  const y = Math.min(e.clientY, window.innerHeight - 140);
  menu.style.left = `${x}px`;
  menu.style.top  = `${y}px`;
}

function closeCtx() { document.getElementById('ctx-menu').style.display = 'none'; }

document.addEventListener('click',   closeCtx);
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeCtx(); closeDrilldown(); } });

function copyRow() {
  closeCtx();
  if (contextRowIdx === null || !currentRows[contextRowIdx]) return;
  const text = Object.entries(currentRows[contextRowIdx])
    .map(([k, v]) => `${k}: ${v ?? ''}`)
    .join('\n');
  navigator.clipboard.writeText(text).catch(() => {});
}

// ── Drill-down ────────────────────────────────────────────────────────────────
async function openDrilldown() {
  closeCtx();
  if (!(await sessionOk())) return;

  if (contextRowIdx === null) return;
  const relations = DRILLDOWN[currentTable];
  if (!relations) return;
  const parentRow = currentRows[contextRowIdx];

  const overlay = document.getElementById('dd-overlay');
  const body    = document.getElementById('dd-body');
  overlay.classList.add('open');
  document.getElementById('dd-title').textContent = `Related Records — ${currentTable}`;
  document.getElementById('dd-subtitle').textContent = '';
  body.innerHTML = '<div class="loading-wrap"><div class="spinner"></div>Fetching related data…</div>';

  const results = await Promise.all(
    relations.map(rel =>
      fetch('/api/related-records', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ tableName: rel.table, fkCol: rel.fkCol, fkValue: parentRow[rel.pkCol] }),
      })
      .then(r => r.json())
      .then(data => ({ rel, data }))
      .catch(err => ({ rel, data: { success: false, error: err.message } }))
    )
  );

  let html = '';
  for (const { rel, data } of results) {
    const pkVal = parentRow[rel.pkCol];
    html += `<div class="dd-section">${rel.table}
      <span style="color:var(--text-dim);font-size:9px;margin-left:8px;letter-spacing:1px">
        ${rel.fkCol} = ${esc(String(pkVal ?? ''))}
      </span>
    </div>`;
    if (!data.success || !data.recordset || data.recordset.length === 0) {
      html += `<div class="dd-empty">No related records found in ${rel.table}.</div>`;
    } else {
      html += buildTableHTML(data.recordset, `dd-${rel.table}`);
    }
  }

  body.innerHTML = html || '<div class="loading-wrap">No related data configured.</div>';

  results.forEach(({ rel, data }) => {
    if (data.recordset && data.recordset.length > 0) {
      try { new DataTable(`#dd-${rel.table}`, { pageLength: 10, scrollX: true }); } catch (_) {}
    }
  });
}

function closeDrilldown() { document.getElementById('dd-overlay').classList.remove('open'); }

document.getElementById('dd-overlay').addEventListener('click', function (e) {
  if (e.target === this) closeDrilldown();
});

// ── CSV export (respects active filter) ──────────────────────────────────────
async function exportCSV() {
  if (!currentTable) return;
  if (!(await sessionOk())) return;

  let query;
  if (activeFilter) {
    // Build the LIKE/= clause for the CSV export too
    // The /query-csv endpoint uses an API key rather than session, so we
    // construct the SQL here using the safe pattern (value from our own state).
    const safeVal = activeFilter.val.replace(/'/g, "''"); // escape single quotes for SQL string literal
    let pattern;
    switch (activeFilter.mode) {
      case 'exact':  pattern = `'${safeVal}'`;       break;
      case 'starts': pattern = `'${safeVal}%'`;      break;
      default:       pattern = `'%${safeVal}%'`;     break;
    }
    query = `SELECT * FROM dbo.${currentTable} WHERE ${activeFilter.col} LIKE ${pattern}`;
  } else {
    query = `SELECT * FROM dbo.${currentTable}`;
  }

  const form  = document.createElement('form');
  form.method = 'POST'; form.action = '/sql/query-csv';
  form.append(hiddenInput('query', query));
  form.append(hiddenInput('key',   'you-will-never-guess-this-ka'));
  document.body.appendChild(form);
  form.submit();
  document.body.removeChild(form);
}

function hiddenInput(name, value) {
  const el = document.createElement('input');
  el.type = 'hidden'; el.name = name; el.value = value;
  return el;
}

function exportReportCSV() {
  if (!lastReportRows || !lastReportMeta?.columns) return;
  const cols = lastReportMeta.columns;
  const csvRow = row => cols.map(c => {
    const v = row[c] != null ? String(row[c]) : '';
    return v.includes(',') || v.includes('"') || v.includes('\n')
      ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',');

  const csv  = [cols.join(','), ...lastReportRows.map(csvRow)].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${currentReport || 'report'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── XLSX export — main table + all related sub-tables as separate sheets ──────
async function exportXLSX() {
  if (!currentTable) return;
  if (!(await sessionOk())) return;

  const relations = (DRILLDOWN[currentTable] || []).map(r => ({
    table: r.table,
    pkCol: r.pkCol,
    fkCol: r.fkCol,
  }));

  const btn  = document.getElementById('btn-export-xlsx');
  const orig = btn.textContent;
  btn.textContent = 'Building…';
  btn.disabled    = true;

  try {
    const res = await fetch('/api/export-xlsx', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        tableName: currentTable,
        filter:    activeFilter || null,
        relations,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      alert('Export failed: ' + (err.error || res.statusText));
      return;
    }

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = currentTable + '_export_' + new Date().toISOString().slice(0,10) + '.xlsx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

  } catch (err) {
    alert('Export failed: ' + err.message);
  } finally {
    btn.textContent = orig;
    btn.disabled    = false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildTableHTML(rows, id, filterable = false) {
  const cols = Object.keys(rows[0]);
  let h = `<table id="${id}" style="width:100%"><thead><tr>`;
  cols.forEach(c => { h += `<th>${esc(c)}</th>`; });
  h += '</tr>';
  if (filterable) {
    h += '<tr class="col-filter-row">';
    cols.forEach(c => { h += `<th><input class="col-filter-input" type="text" placeholder="${esc(c)}…" data-col="${esc(c)}"></th>`; });
    h += '</tr>';
  }
  h += '</thead><tbody>';
  rows.forEach(row => {
    h += '<tr>';
    cols.forEach(c => {
      let v = row[c]; if (v === null || v === undefined) v = '';
      h += `<td>${esc(String(v))}</td>`;
    });
    h += '</tr>';
  });
  h += '</tbody></table>';
  return h;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showError(msg) {
  document.getElementById('data-panel').innerHTML =
    `<div class="loading-wrap" style="color:var(--error)">
       <span style="font-family:'IBM Plex Mono',monospace;font-size:12px">✕ ${esc(msg)}</span>
     </div>`;
  document.getElementById('row-badge').textContent = 'error';
}

function emptyBlock() {
  return `<div class="loading-wrap" style="flex-direction:column;gap:10px">
    <span style="font-size:36px;opacity:.15">∅</span>
    <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim)">No matching records found</span>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────────────────────────────────────────

let currentReport    = null;   // name of the active report
let reportChart      = null;   // Chart.js instance — destroyed before each redraw
let reportDT         = null;   // DataTable instance for table-type reports
let lastReportRows   = null;   // cached rows from last successful report run
let lastReportMeta   = null;   // cached meta from last successful report run

// ── Grouped reports — sidebar key maps to one or more sub-report keys ─────────
// Add new sub-reports here as they are created in routes/reports.js
const REPORT_GROUPS = {
  Firewall: [
    { key: 'Firewall_FailedByBatch', label: 'Failed Qty by Batch & Reason' },
    { key: 'Firewall_FailedByMaterial', label: 'Failed Percentage by Material' },
    { key: 'Firewall_FailedByReason', label: 'Failed Amount by Reason' },
  ],
};

// Palette — one colour per bar, cycling if more bars than colours
const CHART_COLOURS = [
  '#2563EB','#3B82F6','#059669','#D97706','#DC2626',
  '#7C3AED','#0891B2','#65A30D','#DB2777','#EA580C',
];

// ── Default date range: last 90 days ─────────────────────────────────────────
function defaultDates() {
  const to   = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 90);
  return {
    from: from.toISOString().slice(0, 10),
    to:   to.toISOString().slice(0, 10),
  };
}

// ── Sidebar — report items ────────────────────────────────────────────────────
document.querySelectorAll('.report-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.tbl-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');

    const groupKey = item.dataset.report;
    const group    = REPORT_GROUPS[groupKey];

    // Hide table UI, show report panel
    document.getElementById('toolbar').style.display      = 'none';
    document.getElementById('data-panel').style.display   = 'none';
    document.getElementById('report-panel').style.display = 'flex';

    const subnavEl = document.getElementById('report-subnav');

    if (group) {
      // Build pill buttons for each sub-report
      subnavEl.style.display = 'flex';
      subnavEl.innerHTML = group.map((s, i) =>
        `<button class="subnav-btn${i === 0 ? ' active' : ''}" data-report-key="${s.key}">${esc(s.label)}</button>`
      ).join('');

      subnavEl.querySelectorAll('.subnav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          subnavEl.querySelectorAll('.subnav-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          currentReport = btn.dataset.reportKey;
          document.getElementById('report-title').textContent = `${groupKey} — ${btn.textContent}`;
          document.getElementById('report-hint').textContent  = 'Set a date range and click Run';
          resetReportBody();
        });
      });

      // Activate first sub-report by default
      currentReport = group[0].key;
      document.getElementById('report-title').textContent = `${groupKey} — ${group[0].label}`;
      document.getElementById('report-hint').textContent  = 'Set a date range and click Run';
    } else {
      subnavEl.style.display = 'none';
      subnavEl.innerHTML     = '';
      currentReport = groupKey;
      document.getElementById('report-title').textContent = `${groupKey} — Report`;
      document.getElementById('report-hint').textContent  = 'Set a date range and click Run';
    }

    // Pre-fill date inputs with defaults if empty
    const fromEl = document.getElementById('rpt-from');
    const toEl   = document.getElementById('rpt-to');
    if (!fromEl.value || !toEl.value) {
      const d = defaultDates();
      fromEl.value = d.from;
      toEl.value   = d.to;
    }

    resetReportBody();
  });
});

function resetReportBody() {
  if (reportChart)  { reportChart.destroy();  reportChart  = null; }
  if (reportChart2) { reportChart2.destroy(); reportChart2 = null; }
  if (reportChart3) { reportChart3.destroy(); reportChart3 = null; }
  if (reportChart4) { reportChart4.destroy(); reportChart4 = null; }
  if (reportDT)     { try { reportDT.destroy(); } catch (_) {} reportDT = null; }
  lastReportRows = null; lastReportMeta = null;
  const exportBtn = document.getElementById('btn-report-export-csv');
  if (exportBtn) exportBtn.style.display = 'none';
  document.getElementById('report-body').innerHTML = `
    <div class="placeholder">
      <div class="placeholder-hex"><img src="./images/logo256.png" alt="Kongsberg Logo"></div>
      <div class="placeholder-line1">Set a date range and click Run</div>
    </div>`;
}



// ── Run report ────────────────────────────────────────────────────────────────
async function runReport() {
  if (!currentReport) return;
  if (!(await sessionOk())) return;

  const dateFrom = document.getElementById('rpt-from').value;
  const dateTo   = document.getElementById('rpt-to').value;

  if (!dateFrom || !dateTo) {
    alert('Please select both a From and To date.');
    return;
  }
  if (dateFrom > dateTo) {
    alert('From date must not be after To date.');
    return;
  }

  // Show spinner
  const body = document.getElementById('report-body');
  body.innerHTML = '<div class="loading-wrap"><div class="spinner"></div>Running report…</div>';

  try {
    const res  = await fetch('/api/reports', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ report: currentReport, dateFrom, dateTo }),
    });
    const data = await res.json();

    if (!data.success) {
      body.innerHTML = `<div class="report-empty">✕ ${esc(data.error || 'Report failed')}</div>`;
      return;
    }

    const hasRows = data.rows && data.rows.length > 0;
    const hasCharts = (data.chartRows1 && data.chartRows1.length > 0) || (data.chartRows && data.chartRows.length > 0) || (data.chartData && data.chartData.length > 0);
    if (!hasRows && !hasCharts) {
      body.innerHTML = `<div class="report-empty">No data found for this period.</div>`;
      return;
    }

    renderReport(data.rows, data.meta, dateFrom, dateTo, data.chartRows, data.chartRows1, data.chartRows2, data.chartData);

  } catch (err) {
    body.innerHTML = `<div class="report-empty">✕ ${esc(err.message)}</div>`;
  }
}

// ── Render chart + pivot table ────────────────────────────────────────────────
let reportChart2 = null;  // second Chart.js instance for double-chart type
let reportChart3 = null;  // third Chart.js instance for quad-chart type
let reportChart4 = null;  // fourth Chart.js instance for quad-chart type

function renderReport(rows, meta, dateFrom, dateTo, chartRows, chartRows1, chartRows2, chartData) {
  const body = document.getElementById('report-body');

  // Cache rows/meta for CSV export
  lastReportRows = rows  || [];
  lastReportMeta = meta  || {};
  const exportBtn = document.getElementById('btn-report-export-csv');
  if (exportBtn) exportBtn.style.display = (lastReportRows.length && lastReportMeta.columns) ? 'inline-block' : 'none';

  // Destroy old chart instances before replacing canvases
  if (reportChart)  { reportChart.destroy();  reportChart  = null; }
  if (reportChart2) { reportChart2.destroy(); reportChart2 = null; }
  if (reportChart3) { reportChart3.destroy(); reportChart3 = null; }
  if (reportChart4) { reportChart4.destroy(); reportChart4 = null; }

  // ── Multiple charts — 2×2 grid ───────────────────────────────
  if (meta.type === 'quad-chart' || meta.type === 'double-chart') {
    const charts = chartData || [];
    body.innerHTML = `
      <div class="${meta.type}-wrap">
        ${charts.map((c, i) => `
          <div class="chart-wrap">
            <div class="chart-label">${esc(c.label)}</div>
            <canvas id="qc-${i}"></canvas>
          </div>`).join('')}
      </div>`;
    
    if (meta.type === 'quad-chart')
      var instances = [null, null, null, null];
    if (meta.type === 'double-chart')
      var instances = [null, null];
    
    charts.forEach((c, i) => {
      const labels    = c.rows.map(r => r.label);
      const values    = c.rows.map(r => r.value);
      const colours   = labels.map((_, j) => CHART_COLOURS[j % CHART_COLOURS.length]);
      const isLine    = c.chartType === 'line';
      const ctx = document.getElementById(`qc-${i}`).getContext('2d');
      instances[i] = new Chart(ctx, {
        type: c.chartType || 'bar',
        data: {
          labels,
          datasets: [{
            label:           c.valueLabel,
            data:            values,
            ...(isLine ? {
              borderColor:     CHART_COLOURS[0],
              backgroundColor: CHART_COLOURS[0] + '33',
              fill:            true,
              tension:         0.3,
              pointRadius:     3,
            } : {
              backgroundColor: colours,
              borderRadius:    4,
              borderSkipped:   false,
            }),
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, layout: { padding: { bottom: 12 } },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: t => ` ${c.valueLabel}: ${formatNum(t.parsed.y)}` } },
          },
          scales: {
            x: { ticks: { font: { family: "'JetBrains Mono', monospace", size: 10 }, color: '#4D6380', maxRotation: 35 }, grid: { color: '#D0DAE8' } },
            y: { ticks: { font: { family: "'JetBrains Mono', monospace", size: 10 }, color: '#4D6380', callback: v => formatNum(v) }, grid: { color: '#D0DAE8' }, title: { display: true, text: c.valueLabel, font: { family: "'JetBrains Mono', monospace", size: 10 }, color: '#4D6380' } },
          },
        },
      });
    });
    if (meta.type === 'quad-chart')
      [reportChart, reportChart2, reportChart3, reportChart4] = instances;
    if (meta.type === 'double-chart')
        [reportChart, reportChart2] = instances;
    return;
  }

  // ── Chart + filterable table combined ────────────────────────────────────────
  if (meta.type === 'chart-filterable-table') {
    const filterCols = meta.filterColumns || [];
    const filterRow  = meta.columns.map(c =>
      filterCols.includes(c)
        ? `<th><input class="col-filter-input" type="text" placeholder="${esc(c)}…" data-col="${esc(c)}"></th>`
        : `<th></th>`
    ).join('');

    body.innerHTML = `
      <div class="chart-wrap">
        <canvas id="report-canvas"></canvas>
      </div>
      <div class="pivot-wrap">
        <table id="rpt-dt" style="width:100%">
          <thead>
            <tr>${meta.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr>
            <tr class="col-filter-row">${filterRow}</tr>
          </thead>
          <tbody>
            ${rows.map(row =>
              `<tr>${meta.columns.map(c => {
                const v = row[c];
                return `<td>${esc(v != null ? String(v) : '')}</td>`;
              }).join('')}</tr>`
            ).join('')}
          </tbody>
        </table>
      </div>`;

    // Draw bar chart from aggregated chartRows
    const cLabels  = (chartRows || []).map(r => r.label);
    const cValues  = (chartRows || []).map(r => r.value);
    const cColours = cLabels.map((_, i) => CHART_COLOURS[i % CHART_COLOURS.length]);
    const ctx = document.getElementById('report-canvas').getContext('2d');
    reportChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: cLabels,
        datasets: [{
          label:           meta.valueLabel,
          data:            cValues,
          backgroundColor: cColours,
          borderRadius:    4,
          borderSkipped:   false,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, layout: { padding: { bottom: 12 } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => ` ${meta.valueLabel}: ${formatNum(c.parsed.y)}` } },
        },
        scales: {
          x: { ticks: { font: { family: "'JetBrains Mono', monospace", size: 11 }, color: '#4D6380', maxRotation: 35 }, grid: { color: '#D0DAE8' } },
          y: { ticks: { font: { family: "'JetBrains Mono', monospace", size: 11 }, color: '#4D6380', callback: v => formatNum(v) }, grid: { color: '#D0DAE8' }, title: { display: true, text: meta.valueLabel, font: { family: "'JetBrains Mono', monospace", size: 11 }, color: '#4D6380' } },
        },
      },
    });

    // Init filterable DataTable
    reportDT = new DataTable('#rpt-dt', {
      pageLength:    10,
      scrollX:       true,
      orderCellsTop: true,
      initComplete:  function () {
        const api = this.api();
        api.table().header().querySelectorAll('.col-filter-input').forEach(input => {
          const colIdx = meta.columns.indexOf(input.dataset.col);
          if (colIdx === -1) return;
          input.addEventListener('input', function () {
            api.column(colIdx).search(this.value).draw();
          });
        });
      },
    });
    return;
  }

  // ── Filterable table — column search inputs wired to DataTables ─────────────
  if (meta.type === 'filterable-table') {
    const filterCols = meta.filterColumns || [];
    const filterRow  = meta.columns.map(c =>
      filterCols.includes(c)
        ? `<th><input class="col-filter-input" type="text" placeholder="${esc(c)}…" data-col="${esc(c)}"></th>`
        : `<th></th>`
    ).join('');

    body.innerHTML = `
      <div class="pivot-wrap">
        <table id="rpt-dt" style="width:100%">
          <thead>
            <tr>${meta.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr>
            <tr class="col-filter-row">${filterRow}</tr>
          </thead>
          <tbody>
            ${rows.map(row =>
              `<tr>${meta.columns.map(c => {
                const v = row[c];
                return `<td>${esc(v != null ? String(v) : '')}</td>`;
              }).join('')}</tr>`
            ).join('')}
          </tbody>
        </table>
      </div>`;

    reportDT = new DataTable('#rpt-dt', {
      pageLength:   10,
      scrollX:      true,
      orderCellsTop: true,
      initComplete: function () {
        const api        = this.api();
        // With scrollX, DataTables moves <thead> into a separate scroll-header
        // container — query through the API's header node so we find the inputs
        // in the actual rendered DOM, not the original (now-empty) <thead>.
        api.table().header().querySelectorAll('.col-filter-input').forEach(input => {
          const colIdx = meta.columns.indexOf(input.dataset.col);
          if (colIdx === -1) return;
          input.addEventListener('input', function () {
            api.column(colIdx).search(this.value).draw();
          });
        });
      },
    });
    return;
  }

  // ── Table report (raw columns) ────────────────────────────────────────────
  if (meta.type === 'table') {
    body.innerHTML = `
      <div class="pivot-wrap">
        <table id="rpt-dt" style="width:100%">
          <thead>
            <tr>${meta.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${rows.map(row =>
              `<tr>${meta.columns.map(c => {
                const v = row[c];
                return `<td>${esc(v != null ? String(v) : '')}</td>`;
              }).join('')}</tr>`
            ).join('')}
          </tbody>
        </table>
      </div>`;
    reportDT = new DataTable('#rpt-dt', { pageLength: 10, scrollX: true });
    return;
  }

  // ── Chart-table report (raw columns + simple chart) ────────────────────────────────────────────
  if (meta.type === 'chart-table') {
    const labels = rows.map(r => r.label);
    const values = rows.map(r => r.value);
    const total  = values.reduce((s, v) => s + v, 0);

    // Assign colours — cycle through palette
    const colours = labels.map((_, i) => CHART_COLOURS[i % CHART_COLOURS.length]);

    // Staging report shows a line chart (time series); all others use bar chart
    const isTimeSeries = currentReport === 'Staging';

    body.innerHTML = `
      <div class="chart-wrap">
        <canvas id="report-canvas"></canvas>
      </div>
      <div class="pivot-wrap">
        <table id="rpt-dt" style="width:100%">
          <thead>
            <tr>
              <th>${esc(meta.AggregateLabel || 'Breakdown')}</th>
              <th style="text-align:right">${esc(meta.valueLabel)}</th>
              <th style="text-align:right">% of Total</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => {
              const pct = total > 0 ? ((r.value / total) * 100).toFixed(1) : '—';
              return `<tr>
                <td>${esc(r.label)}</td>
                <td class="num">${formatNum(r.value)}</td>
                <td class="num">${isTimeSeries ? '—' : pct + '%'}</td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td><strong>${isTimeSeries ? `${esc(dateFrom)} → ${esc(dateTo)}` : 'Total'}</strong></td>
              <td class="num"><strong>${isTimeSeries ? (total / rows.length).toFixed(2) + ' avg' : formatNum(total)}</strong></td>
              <td class="num"><strong>${isTimeSeries ? '' : '100%'}</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>`;

    // Build Chart.js config
    const ctx = document.getElementById('report-canvas').getContext('2d');

    const chartCfg = isTimeSeries
      ? {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label:           meta.valueLabel,
              data:            values,
              borderColor:     CHART_COLOURS[0],
              backgroundColor: 'rgba(37,99,235,0.08)',
              borderWidth:     2,
              pointRadius:     4,
              pointHoverRadius: 6,
              fill:            true,
              tension:         0.35,
            }],
          },
        }
      : {
          type: 'bar',
          data: {
            labels,
            datasets: [{
              label:           meta.valueLabel,
              data:            values,
              backgroundColor: colours,
              borderRadius:    4,
              borderSkipped:   false,
            }],
          },
        };

    reportChart = new Chart(ctx, {
      ...chartCfg,
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        layout: { padding: { bottom: 12 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${meta.valueLabel}: ${formatNum(ctx.parsed.y)}`,
            },
          },
        },
        scales: {
          x: {
            ticks: {
              font:  { family: "'JetBrains Mono', monospace", size: 11 },
              color: '#4D6380',
              maxRotation: 35,
            },
            grid: { color: '#D0DAE8' },
          },
          y: {
            ticks: {
              font:  { family: "'JetBrains Mono', monospace", size: 11 },
              color: '#4D6380',
              callback: v => formatNum(v),
            },
            grid:  { color: '#D0DAE8' },
            title: {
              display: true,
              text:    meta.valueLabel,
              font:    { family: "'JetBrains Mono', monospace", size: 11 },
              color:   '#4D6380',
            },
          },
        },
      },
    });
    reportDT = new DataTable('#rpt-dt', { pageLength: 10, scrollX: true });
    return;
  }
}

// ── Number formatter — commas + up to 2 decimal places ───────────────────────
function formatNum(n) {
  if (n == null) return '—';
  const rounded = Math.round(n * 100) / 100;
  return rounded.toLocaleString('en-GB', { maximumFractionDigits: 2 });
}