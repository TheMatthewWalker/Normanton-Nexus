'use strict';

let lastRows = [];

function exportCsv() {
  if (!lastRows.length) return;
  const cols  = Object.keys(lastRows[0]);
  const lines = [
    cols.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','),
    ...lastRows.map(row =>
      cols.map(c => `"${String(row[c] ?? '').replace(/"/g, '""')}"`).join(',')
    ),
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `rawsql-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
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

    const rows = data.recordset || [];

    if (rows.length > 0) {
      lastRows = rows;
      resultEl.innerHTML = buildTableHTML(rows, 'rawsql-dt');
      try {
        new DataTable('#rawsql-dt', { pageLength: 25, scrollX: true });
      } catch (_) {}
      const exportBtn = document.getElementById('rawsql-export');
      const countEl  = document.getElementById('rawsql-row-count');
      if (exportBtn) exportBtn.style.display = '';
      if (countEl)  { countEl.textContent = `${rows.length} row(s)`; countEl.style.display = ''; }
      updateBadge(`${rows.length} row(s)`);
    } else {
      const affected = Array.isArray(data.rowsAffected)
        ? data.rowsAffected.reduce((sum, v) => sum + (v || 0), 0)
        : (data.rowsAffected || 0);
      resultEl.innerHTML = `<div class="report-empty">Query executed successfully. ${affected} row(s) affected.</div>`;
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

  if (inputEl) {
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        runRawSql();
      }
    });
  }
  if (runBtn)    runBtn.addEventListener('click', () => runRawSql());
  if (exportBtn) exportBtn.addEventListener('click', exportCsv);
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      inputEl.value = '';
      lastRows = [];
      const resultEl  = document.getElementById('rawsql-result');
      const countEl   = document.getElementById('rawsql-row-count');
      if (resultEl)  resultEl.innerHTML = '<div class="report-empty">No query executed yet.</div>';
      if (exportBtn) exportBtn.style.display = 'none';
      if (countEl)   countEl.style.display   = 'none';
      updateBadge('Idle');
    });
  }
});

