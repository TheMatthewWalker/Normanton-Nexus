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
};

const FNS = {
  productionSchedule:   () => window.ProductionScheduleReport.mount(),
  customerInstructions: () => renderCustomerInstructions(),
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
        ${canEdit ? `<button class="btn-back" id="ci-add" style="margin-bottom:14px;border:none;cursor:pointer">+ Add Customer</button>` : ''}
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
