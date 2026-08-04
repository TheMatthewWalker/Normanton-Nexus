'use strict';

// One entry per SELECT statement in the last-run batch (see buildResultsHTML) —
// exportCsv(index) below reads whichever one the user clicked "Export" next to.
let lastRecordsets = [];

function exportCsv(index) {
  const rows = lastRecordsets[index];
  if (!rows || !rows.length) return;
  const cols  = Object.keys(rows[0]);
  const lines = [
    cols.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','),
    ...rows.map(row =>
      cols.map(c => `"${String(row[c] ?? '').replace(/"/g, '""')}"`).join(',')
    ),
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  const suffix = lastRecordsets.length > 1 ? `-result${index + 1}` : '';
  a.download = `rawsql${suffix}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Basic session check reused from portal page
async function sessionOk() {
  const d = await fetch('/session-check').then(r => r.json());
  if (!d.loggedIn) { window.location.href = '/'; return false; }
  return true;
}

// Small helpers copied from portal.js
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildTableHTML(rows, id) {
  const cols = Object.keys(rows[0]);
  let h = `<table id="${id}" style="width:100%"><thead><tr>`;
  cols.forEach(c => { h += `<th>${esc(c)}</th>`; });
  h += '</tr></thead><tbody>';
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

// Renders every non-empty recordset from a (possibly multi-statement) batch
// as its own labelled section — a query with several SELECTs separated by
// semicolons comes back as one entry per SELECT, in order. Returns the
// combined HTML; DataTable() still needs to be initialised per table by the
// caller, since each one needs its own instance.
function buildResultsHTML(recordsets) {
  const nonEmpty = recordsets
    .map((rows, i) => ({ rows, i }))
    .filter(r => r.rows && r.rows.length > 0);

  if (!nonEmpty.length) return '';

  const multi = nonEmpty.length > 1;
  let h = '';
  nonEmpty.forEach(({ rows, i }) => {
    const tableId = `rawsql-dt-${i}`;
    h += '<div class="rawsql-result-block">';
    if (multi) {
      h += `<div class="rawsql-result-heading">`
        + `<span>Result ${i + 1} — ${rows.length} row(s)</span>`
        + `<button type="button" class="btn-filter-clear" data-export-index="${i}">Export CSV</button>`
        + `</div>`;
    }
    h += buildTableHTML(rows, tableId);
    h += '</div>';
  });
  return h;
}

function updateBadge(text) {
  const badge = document.getElementById('rawsql-badge');
  if (badge) badge.textContent = text;
}

async function runRawSql() {
  if (!(await sessionOk())) return;

  const inputEl  = document.getElementById('rawsql-input');
  const resultEl = document.getElementById('rawsql-result');
  if (!inputEl || !resultEl) return;

  const sqlText = inputEl.value.trim();
  if (!sqlText) {
    alert('Please enter a SQL statement to run.');
    return;
  }

  updateBadge('Running…');
  resultEl.innerHTML =
    '<div class="loading-wrap"><div class="spinner"></div>Running query…</div>';

  try {
    const res  = await fetch('/sql/query', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query: sqlText }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.success === false) {
      const msg = (data && data.error) || `HTTP ${res.status}`;
      resultEl.innerHTML = `<div class="report-empty">✕ ${esc(msg)}</div>`;
      updateBadge('Error');
      return;
    }

    // recordsets covers every SELECT in the batch, in order; recordset
    // (older shape, still sent for back-compat) is just recordsets[0].
    const recordsets = Array.isArray(data.recordsets) && data.recordsets.length
      ? data.recordsets
      : [data.recordset || []];
    lastRecordsets = recordsets;

    const nonEmptyCount = recordsets.filter(r => r && r.length > 0).length;
    const exportBtn = document.getElementById('rawsql-export');
    const countEl   = document.getElementById('rawsql-row-count');

    if (nonEmptyCount > 0) {
      resultEl.innerHTML = buildResultsHTML(recordsets);
      recordsets.forEach((rows, i) => {
        if (!rows || !rows.length) return;
        try {
          new DataTable(`#rawsql-dt-${i}`, { pageLength: 20, scrollX: true });
        } catch (_) {}
      });

      const totalRows = recordsets.reduce((sum, r) => sum + (r ? r.length : 0), 0);
      if (nonEmptyCount === 1) {
        // Single result: keep the original single-table UX — the toolbar's
        // own Export button drives the one table directly.
        if (exportBtn) { exportBtn.style.display = ''; exportBtn.onclick = () => exportCsv(recordsets.findIndex(r => r && r.length)); }
        if (countEl)  { countEl.textContent = `${totalRows} row(s)`; countEl.style.display = ''; }
        updateBadge(`${totalRows} row(s)`);
      } else {
        // Multiple results: each block has its own Export button (wired via
        // delegation below) — the toolbar-level one doesn't map to a single
        // table, so hide it rather than have it silently export the wrong one.
        if (exportBtn) exportBtn.style.display = 'none';
        if (countEl)  { countEl.textContent = `${nonEmptyCount} result sets, ${totalRows} row(s) total`; countEl.style.display = ''; }
        updateBadge(`${nonEmptyCount} results`);
      }
    } else {
      const affected = Array.isArray(data.rowsAffected)
        ? data.rowsAffected.reduce((sum, v) => sum + (v || 0), 0)
        : (data.rowsAffected || 0);
      resultEl.innerHTML = `<div class="report-empty">Query executed successfully. ${affected} row(s) affected.</div>`;
      if (exportBtn) exportBtn.style.display = 'none';
      if (countEl)  countEl.style.display = 'none';
      updateBadge(`${affected} affected`);
    }

  } catch (err) {
    resultEl.innerHTML = `<div class="report-empty">✕ ${esc(err.message)}</div>`;
    updateBadge('Error');
  }
}

// Wire up events once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const inputEl   = document.getElementById('rawsql-input');
  const runBtn    = document.getElementById('rawsql-run');
  const clearBtn  = document.getElementById('rawsql-clear');
  const exportBtn = document.getElementById('rawsql-export');
  const resultEl  = document.getElementById('rawsql-result');

  if (inputEl) {
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        runRawSql();
      }
    });
  }
  if (runBtn) runBtn.addEventListener('click', () => runRawSql());
  // exportBtn's click handler is (re)assigned per run in runRawSql() for the
  // single-result case, since which recordset it should export changes each
  // time. Per-result-block export buttons (multi-result case) are handled
  // here via delegation, since they're recreated on every run.
  if (resultEl) {
    resultEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-export-index]');
      if (btn) exportCsv(Number(btn.dataset.exportIndex));
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      inputEl.value = '';
      lastRecordsets = [];
      const countEl = document.getElementById('rawsql-row-count');
      if (resultEl)  resultEl.innerHTML = '<div class="report-empty">No query executed yet.</div>';
      if (exportBtn) exportBtn.style.display = 'none';
      if (countEl)   countEl.style.display   = 'none';
      updateBadge('Idle');
    });
  }
});

