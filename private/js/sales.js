'use strict';

// ── Initialise ────────────────────────────────────────────────────────────────
(async () => {
  try {
    const session = await fetch('/session-check').then(r => r.json());
    if (!session.loggedIn) { window.location.href = '/'; return; }
    document.getElementById('session-user').textContent = session.username;
  } catch { window.location.href = '/'; }
})();

// ── Navigation ────────────────────────────────────────────────────────────────
document.querySelectorAll('.sap-tile[data-fn]').forEach(tile => {
  tile.addEventListener('click', () => openFunction(tile.dataset.fn));
});

document.getElementById('btn-back-tiles').addEventListener('click', backToTiles);

// ── Collapsible sections (same pattern as production-nexus.js) ────────────────
document.querySelectorAll('.pn-section-hdr').forEach(hdr => {
  const section = hdr.closest('.pn-section');
  const key = `sales-collapsed:${hdr.textContent.trim()}`;
  if (localStorage.getItem(key) === '1') section.classList.add('pn-section--collapsed');
  hdr.addEventListener('click', () => {
    section.classList.toggle('pn-section--collapsed');
    localStorage.setItem(key, section.classList.contains('pn-section--collapsed') ? '1' : '0');
  });
});

function backToTiles() {
  document.getElementById('result-section').classList.add('hidden');
  document.getElementById('tile-section').classList.remove('hidden');
  document.getElementById('result-row-badge').classList.add('hidden');
}

const TITLES = {
  productionSchedule:    ['Production Schedule', 'Open PTFE order lines due in the next 5 working days — comments, ETA and OTIF KPI'],
  customerInstructions:  ['Customer Standard Instructions', 'Standing instructions printed on every Drumming Ticket for a customer'],
  scheduleWaterfall:     ['Schedule Agreement Waterfall', 'History of past schedule agreement releases — compare cumulative totals and required orders release-over-release'],
};

const FNS = {
  productionSchedule:   () => window.ProductionScheduleReport.mount(),
  customerInstructions: () => renderCustomerInstructions(),
  scheduleWaterfall:    () => window.SalesWaterfallReport.mount(),
};

// ── Customer Standard Instructions ──────────────────────────────────────────
// Simple list + add/edit/delete modal. Self-contained inline styles rather
// than reusing production-nexus.css's bm-section/tf-* classes — this page
// doesn't load that stylesheet (see sales.html's <head> comment on why:
// logistics.css supplies the shared tile-grid/result-section base instead).

async function salesApi(path, opts) {
  const r = await fetch('/api/sales' + path, opts);
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON body */ }
  if (json?.success === false || !r.ok) throw new Error(json?.error || `Request failed (HTTP ${r.status})`);
  return json;
}

function esc2(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Minimal RFC4180-style parser: handles quoted fields (embedded delimiters,
// embedded newlines, "" for an escaped quote) and both CRLF and LF row
// endings — same approach as logistics.js's parseCsvText, but tab-delimited
// (pasting straight from Excel/a spreadsheet produces TSV on the clipboard,
// not comma/semicolon CSV) and duplicated here rather than shared since
// there's no cross-file JS module loading in this app (see sales.html's
// plain <script> tags).
function parseTsvText(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; } }
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === '\t') {
      pushField();
    } else if (c === '\n') {
      pushRow();
    } else if (c === '\r') {
      // skip — the following \n (or EOF) ends the row
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) pushRow();
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

// Parses a pasted Account Code / Company Name / Special Instructions list
// into { customer, customerName, instructions } rows, ready to post to
// /customer-instructions/bulk-import. A header row is auto-detected (rather
// than requiring the user to strip it) by checking whether the first row's
// first cell looks like an account code — SAP customer numbers are always
// numeric, so a non-numeric first cell ("ACCOUNT CODE") means it's a header.
function parseCustomerInstructionsImport(text) {
  const rawRows = parseTsvText(text);
  if (!rawRows.length) return { rows: [], duplicates: [] };

  const first = (rawRows[0][0] || '').trim();
  const dataRows = /^\d+$/.test(first) ? rawRows : rawRows.slice(1);

  const seen = new Map(); // customer -> count, to flag duplicate account codes in the pasted list
  const rows = dataRows.map(cols => {
    const customer     = (cols[0] || '').trim();
    const customerName = (cols[1] || '').trim();
    const instructions = (cols[2] || '').trim();
    if (customer) seen.set(customer, (seen.get(customer) || 0) + 1);
    return { customer, customerName, instructions };
  }).filter(r => r.customer || r.instructions);

  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c);
  return { rows, duplicates };
}

async function renderCustomerInstructions() {
  const body = document.getElementById('result-body');
  body.innerHTML = '<div style="padding:40px 20px;color:var(--text-muted);font-size:13px">Loading…</div>';

  let canEdit = false;
  try {
    const session = await fetch('/session-check').then(r => r.json());
    const perms = session.permissions || [];
    canEdit = session.role === 'superadmin' || perms.includes('SALES_SUPERVISOR');
  } catch { canEdit = false; }

  async function load() {
    body.innerHTML = '<div style="padding:40px 20px;color:var(--text-muted);font-size:13px">Loading…</div>';
    try {
      const json = await salesApi('/customer-instructions');
      renderList(json.data || []);
    } catch (err) {
      body.innerHTML = `<div style="padding:20px;color:var(--error);font-size:13px">${esc2(err.message)}</div>`;
    }
  }

  function renderList(rows) {
    body.innerHTML = `
      <div style="padding:20px">
        ${canEdit ? `
          <button class="btn-back" id="ci-add" style="margin-bottom:14px;border:none;cursor:pointer">+ Add Customer</button>
          <button class="btn-back" id="ci-import" style="margin-bottom:14px;margin-left:8px;border:none;cursor:pointer">Mass Import</button>
        ` : ''}
        ${rows.length ? `
          <table style="width:100%;border-collapse:collapse;font-size:13px;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
            <thead><tr style="text-align:left;background:var(--surface2);font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.03em">
              <th style="padding:8px 12px">Customer</th><th style="padding:8px 12px">Instructions</th>
              <th style="padding:8px 12px">Last Updated</th>${canEdit ? '<th></th>' : ''}
            </tr></thead>
            <tbody>
              ${rows.map(r => `
                <tr style="border-top:1px solid var(--border)">
                  <td style="padding:8px 12px;font-family:'JetBrains Mono',monospace">${esc2(r.Customer)}${r.CustomerName ? ' — '+esc2(r.CustomerName) : ''}</td>
                  <td style="padding:8px 12px;max-width:420px;white-space:pre-wrap">${esc2(r.Instructions)}</td>
                  <td style="padding:8px 12px;font-size:11px;color:var(--text-muted)">${r.LastUpdatedUtc ? new Date(r.LastUpdatedUtc).toLocaleString('en-GB') : '—'}${r.UpdatedByUsername ? ' · '+esc2(r.UpdatedByUsername) : ''}</td>
                  ${canEdit ? `<td style="padding:8px 12px;white-space:nowrap">
                    <button class="ci-edit" data-cust="${esc2(r.Customer)}" style="cursor:pointer;background:none;border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:11px">Edit</button>
                    <button class="ci-del"  data-cust="${esc2(r.Customer)}" style="cursor:pointer;background:none;border:1px solid var(--error);color:var(--error);border-radius:6px;padding:4px 10px;font-size:11px;margin-left:4px">Delete</button>
                  </td>` : ''}
                </tr>`).join('')}
            </tbody>
          </table>` : `<div style="color:var(--text-muted);font-size:13px;padding:20px 0">No customer standard instructions saved yet.</div>`}
      </div>`;

    document.getElementById('ci-add')?.addEventListener('click', () => openModal(null, rows));
    document.getElementById('ci-import')?.addEventListener('click', () => openBulkImportModal());
    document.querySelectorAll('.ci-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = rows.find(r => r.Customer === btn.dataset.cust);
        openModal(row, rows);
      });
    });
    document.querySelectorAll('.ci-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Delete standard instructions for customer ${btn.dataset.cust}?`)) return;
        try { await salesApi(`/customer-instructions/${encodeURIComponent(btn.dataset.cust)}`, { method: 'DELETE' }); load(); }
        catch (err) { alert(err.message); }
      });
    });
  }

  function openModal(existing) {
    document.getElementById('ci-modal-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'ci-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.5);display:flex;align-items:center;justify-content:center;z-index:1000';
    overlay.innerHTML = `
      <div style="background:var(--surface);border-radius:12px;padding:24px;width:420px;max-width:90vw;box-shadow:0 10px 40px rgba(0,0,0,0.2)">
        <div style="font-size:16px;font-weight:700;margin-bottom:16px">${existing ? 'Edit' : 'Add'} Customer Standard Instructions</div>
        <div style="margin-bottom:12px">
          <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Customer Number ${existing ? '' : '<span style="color:var(--error)">*</span>'}</label>
          <input id="ci-cust" value="${esc2(existing?.Customer || '')}" ${existing ? 'disabled' : ''}
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:${existing ? 'var(--surface2)' : 'var(--surface)'};color:var(--text);box-sizing:border-box">
        </div>
        <div style="margin-bottom:12px">
          <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Customer Name</label>
          <input id="ci-name" value="${esc2(existing?.CustomerName || '')}"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box">
        </div>
        <div style="margin-bottom:16px">
          <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Instructions <span style="color:var(--error)">*</span></label>
          <textarea id="ci-instr" rows="4" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box;font-family:inherit;resize:vertical">${esc2(existing?.Instructions || '')}</textarea>
        </div>
        <div id="ci-modal-msg" style="font-size:12px;color:var(--error);margin-bottom:10px"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="ci-cancel" style="cursor:pointer;background:none;border:1px solid var(--border);border-radius:6px;padding:8px 16px;font-size:13px">Cancel</button>
          <button id="ci-save" style="cursor:pointer;background:var(--accent);border:1px solid var(--accent);color:#fff;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600">Save</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    document.getElementById('ci-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    document.getElementById('ci-save').addEventListener('click', async () => {
      const customer     = document.getElementById('ci-cust').value.trim();
      const customerName = document.getElementById('ci-name').value.trim();
      const instructions = document.getElementById('ci-instr').value.trim();
      const msgEl = document.getElementById('ci-modal-msg');
      if (!customer)     { msgEl.textContent = 'Customer number is required.'; return; }
      if (!instructions) { msgEl.textContent = 'Instructions text is required.'; return; }
      try {
        await salesApi(`/customer-instructions/${encodeURIComponent(customer)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerName, instructions }),
        });
        overlay.remove();
        load();
      } catch (err) { msgEl.textContent = err.message; }
    });
  }

  // Paste-import modal: textarea -> parse/preview -> confirm -> bulk-import.
  // Kept as its own three-stage flow (paste, preview, result) rather than a
  // single "paste and go" button so a bad paste (wrong columns, empty rows)
  // is caught before anything is written — same reasoning as the manual
  // order CSV upload modal on the Logistics page.
  function openBulkImportModal() {
    document.getElementById('ci-modal-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'ci-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.5);display:flex;align-items:center;justify-content:center;z-index:1000';
    overlay.innerHTML = `
      <div style="background:var(--surface);border-radius:12px;padding:24px;width:640px;max-width:92vw;max-height:86vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,0.2)">
        <div style="font-size:16px;font-weight:700;margin-bottom:6px">Mass Import Customer Standard Instructions</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px">
          Paste directly from Excel — three columns: Account Code, Company Name, Special Instructions.
          A header row is fine, it's detected automatically. Matching rows (by Account Code) update
          the existing instructions; new Account Codes are added.
        </div>
        <textarea id="ci-import-paste" rows="10" placeholder="Paste rows here…"
          style="width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box;font-family:'JetBrains Mono',monospace;font-size:12px;resize:vertical"></textarea>
        <div id="ci-import-preview" style="margin-top:14px"></div>
        <div id="ci-import-msg" style="font-size:12px;color:var(--error);margin:10px 0"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="ci-import-cancel" style="cursor:pointer;background:none;border:1px solid var(--border);border-radius:6px;padding:8px 16px;font-size:13px">Cancel</button>
          <button id="ci-import-parse" style="cursor:pointer;background:none;border:1px solid var(--border);border-radius:6px;padding:8px 16px;font-size:13px">Preview</button>
          <button id="ci-import-go" style="cursor:pointer;background:var(--accent);border:1px solid var(--accent);color:#fff;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600" disabled>Import</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    let parsedRows = [];

    document.getElementById('ci-import-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    document.getElementById('ci-import-parse').addEventListener('click', () => {
      const text = document.getElementById('ci-import-paste').value;
      const previewEl = document.getElementById('ci-import-preview');
      const msgEl = document.getElementById('ci-import-msg');
      const goBtn = document.getElementById('ci-import-go');
      msgEl.textContent = '';

      const { rows, duplicates } = parseCustomerInstructionsImport(text);
      if (!rows.length) {
        previewEl.innerHTML = '';
        goBtn.disabled = true;
        msgEl.textContent = 'No rows found — paste Account Code / Company Name / Special Instructions, one row per line.';
        return;
      }

      const valid = rows.filter(r => r.customer && r.instructions);
      const invalid = rows.filter(r => !r.customer || !r.instructions);
      parsedRows = valid;

      previewEl.innerHTML = `
        <div style="font-size:12px;margin-bottom:8px">
          <strong>${valid.length}</strong> row${valid.length === 1 ? '' : 's'} ready to import
          ${invalid.length ? `, <span style="color:var(--error)">${invalid.length} skipped (missing account code or instructions)</span>` : ''}
          ${duplicates.length ? `, <span style="color:var(--text-muted)">${duplicates.length} account code${duplicates.length === 1 ? '' : 's'} appear more than once in the paste — last occurrence wins: ${esc2(duplicates.slice(0, 10).join(', '))}${duplicates.length > 10 ? '…' : ''}</span>` : ''}
        </div>
        <div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:8px">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="text-align:left;background:var(--surface2);position:sticky;top:0">
              <th style="padding:6px 10px">Account Code</th><th style="padding:6px 10px">Company</th><th style="padding:6px 10px">Instructions</th>
            </tr></thead>
            <tbody>
              ${valid.slice(0, 200).map(r => `
                <tr style="border-top:1px solid var(--border)">
                  <td style="padding:6px 10px;font-family:'JetBrains Mono',monospace">${esc2(r.customer)}</td>
                  <td style="padding:6px 10px">${esc2(r.customerName)}</td>
                  <td style="padding:6px 10px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc2(r.instructions)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          ${valid.length > 200 ? `<div style="padding:6px 10px;font-size:11px;color:var(--text-muted)">…and ${valid.length - 200} more</div>` : ''}
        </div>`;

      goBtn.disabled = valid.length === 0;
    });

    document.getElementById('ci-import-go').addEventListener('click', async () => {
      const msgEl = document.getElementById('ci-import-msg');
      const goBtn = document.getElementById('ci-import-go');
      if (!parsedRows.length) return;
      goBtn.disabled = true;
      goBtn.textContent = 'Importing…';
      msgEl.style.color = 'var(--text-muted)';
      msgEl.textContent = `Importing ${parsedRows.length} rows…`;
      try {
        const res = await salesApi('/customer-instructions/bulk-import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: parsedRows }),
        });
        const { created, updated, failed } = res.data;
        if (failed?.length) {
          msgEl.style.color = 'var(--error)';
          msgEl.innerHTML = `Imported ${created} new, updated ${updated}. ${failed.length} row(s) failed:<br>` +
            failed.slice(0, 15).map(f => `${esc2(f.customer)}: ${esc2(f.error)}`).join('<br>') +
            (failed.length > 15 ? `<br>…and ${failed.length - 15} more` : '');
          goBtn.textContent = 'Import';
          goBtn.disabled = false;
        } else {
          overlay.remove();
          load();
        }
      } catch (err) {
        msgEl.style.color = 'var(--error)';
        msgEl.textContent = err.message;
        goBtn.textContent = 'Import';
        goBtn.disabled = false;
      }
    });
  }

  await load();
}

function openFunction(fn) {
  document.getElementById('tile-section').classList.add('hidden');
  document.getElementById('result-section').classList.remove('hidden');

  const [title, hint] = TITLES[fn] || [fn, ''];
  document.getElementById('result-title').textContent = title;
  document.getElementById('result-hint').textContent  = hint;

  if (FNS[fn]) FNS[fn]();
}
