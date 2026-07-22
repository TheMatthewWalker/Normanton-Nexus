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

// ── Collapsible sections (same pattern as production-nexus.js/sales.js) ───────
document.querySelectorAll('.pn-section-hdr').forEach(hdr => {
  const section = hdr.closest('.pn-section');
  const key = `engineering-collapsed:${hdr.textContent.trim()}`;
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
  massUpdate:         ['Mass Packaging Update', 'Bulk-update the default (plant-level) packaging instruction assignment for a list of part numbers'],
  newPackaging:       ['New Packaging Creation', 'Create the material masters & BOMs needed for a part’s packaging set-up'],
  instructionDetail:  ['Packaging Instruction Detail', 'Detailed changes to a material’s packaging instruction'],
};

const FNS = {
  massUpdate:        () => renderMassUpdate(),
  newPackaging:       () => renderNewPackaging(),
  instructionDetail:  () => renderInstructionDetail(),
};

function openFunction(fn) {
  document.getElementById('tile-section').classList.add('hidden');
  document.getElementById('result-section').classList.remove('hidden');

  const [title, hint] = TITLES[fn] || [fn, ''];
  document.getElementById('result-title').textContent = title;
  document.getElementById('result-hint').textContent  = hint;

  if (FNS[fn]) FNS[fn]();
}

// ── Shared helpers ──────────────────────────────────────────────────────────

async function pkgApi(path, opts) {
  const r = await fetch('/api/packaging' + path, opts);
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON body */ }
  if (json?.success === false || !r.ok) throw new Error(json?.error?.message || `Request failed (HTTP ${r.status})`);
  return json;
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const PACKAGING_CODES = ['SD','MD','LD','XD','SB','MB','LB','XB','C1','C2'];

// ═══════════════════════════════════════════════════════════════════════════
// 1. MASS PACKAGING UPDATE
// ═══════════════════════════════════════════════════════════════════════════

function renderMassUpdate() {
  const body = document.getElementById('result-body');
  body.innerHTML = `
    <div style="padding:20px;max-width:760px">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.6">
        Tick the materials to update below, then enter the packaging material to assign to all of
        them and run the update. Each material must already have a plant-default packaging
        instruction — this only changes the assigned packaging material, quantities and flags
        already set are left untouched.
      </div>
      <div style="margin-bottom:8px">
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Search Materials</label>
        <input id="mu-search" type="text" placeholder="Filter by part number or description…"
          style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box">
      </div>
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:6px">
        <span id="mu-list-status" style="font-size:11px;color:var(--text-muted)"></span>
        <span style="flex:1"></span>
        <button id="mu-select-all" style="cursor:pointer;background:none;border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:11px">Select All Visible</button>
        <button id="mu-clear" style="cursor:pointer;background:none;border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:11px">Clear Selection</button>
      </div>
      <div id="mu-list" style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;background:var(--surface)"></div>
      <div style="margin:14px 0;font-size:12px;color:var(--text-muted)"><span id="mu-selected-count">0</span> material(s) selected</div>
      <div style="margin-bottom:12px">
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">New Packaging Material</label>
        <input id="mu-packmat" placeholder="e.g. IB_TSHV3-4B01/S_C2"
          style="width:280px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box;font-family:'JetBrains Mono',monospace">
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button id="mu-run" class="btn-back" style="border:none;cursor:pointer">Run Update</button>
        <span id="mu-status" style="font-size:12px;color:var(--text-muted)"></span>
      </div>
      <div id="mu-results" style="margin-top:16px"></div>
    </div>`;

  // material -> materialText, persists across search refreshes so selections
  // survive as the visible/filtered list changes.
  const selected = new Map();

  function renderCheckboxRow(m) {
    const checked = selected.has(m.material);
    return `
      <label class="mu-row" data-material="${esc(m.material)}" data-text="${esc(m.materialText || '')}"
        style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--border);cursor:pointer;font-size:12px">
        <input type="checkbox" class="mu-check" ${checked ? 'checked' : ''} style="cursor:pointer">
        <span style="font-family:'JetBrains Mono',monospace;font-weight:600;min-width:110px">${esc(m.material)}</span>
        <span style="color:var(--text-muted)">${esc(m.materialText || '')}</span>
      </label>`;
  }

  function updateSelectedCount() {
    document.getElementById('mu-selected-count').textContent = selected.size;
  }

  async function loadList(search) {
    const listEl = document.getElementById('mu-list');
    const statusEl = document.getElementById('mu-list-status');
    statusEl.textContent = 'Loading…';
    try {
      const json = await pkgApi(`/materials?search=${encodeURIComponent(search || '')}`);
      const rows = json.data || [];
      listEl.innerHTML = rows.length
        ? rows.map(renderCheckboxRow).join('')
        : '<div style="padding:16px;color:var(--text-muted);font-size:12px">No materials match.</div>';
      statusEl.textContent = rows.length >= 200 ? `Showing first ${rows.length} — refine your search` : `${rows.length} shown`;

      listEl.querySelectorAll('.mu-row').forEach(row => {
        const checkbox = row.querySelector('.mu-check');
        row.addEventListener('click', e => {
          if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
          const material = row.dataset.material;
          if (checkbox.checked) selected.set(material, row.dataset.text);
          else selected.delete(material);
          updateSelectedCount();
        });
      });
    } catch (err) {
      listEl.innerHTML = `<div style="padding:16px;color:var(--error);font-size:12px">${esc(err.message)}</div>`;
      statusEl.textContent = '';
    }
  }

  let searchTimer = null;
  document.getElementById('mu-search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadList(e.target.value.trim()), 250);
  });

  document.getElementById('mu-select-all').addEventListener('click', () => {
    document.querySelectorAll('#mu-list .mu-row').forEach(row => {
      row.querySelector('.mu-check').checked = true;
      selected.set(row.dataset.material, row.dataset.text);
    });
    updateSelectedCount();
  });

  document.getElementById('mu-clear').addEventListener('click', () => {
    selected.clear();
    document.querySelectorAll('#mu-list .mu-check').forEach(cb => { cb.checked = false; });
    updateSelectedCount();
  });

  document.getElementById('mu-run').addEventListener('click', async () => {
    const statusEl = document.getElementById('mu-status');
    const resultsEl = document.getElementById('mu-results');
    const packMaterial = document.getElementById('mu-packmat').value.trim();

    if (selected.size === 0) { statusEl.textContent = 'Select at least one material.'; return; }
    if (!packMaterial) { statusEl.textContent = 'New Packaging Material is required.'; return; }

    const rows = [...selected.keys()].map(material => ({ material, packMaterial }));

    statusEl.textContent = `Updating ${rows.length} material(s)…`;
    resultsEl.innerHTML = '';
    try {
      const json = await pkgApi('/mass-update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      statusEl.textContent = '';
      const results = json.data || [];
      resultsEl.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <thead><tr style="text-align:left;background:var(--surface2);font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.03em">
            <th style="padding:8px 12px">Material</th><th style="padding:8px 12px">Result</th><th style="padding:8px 12px">Message</th>
          </tr></thead>
          <tbody>
            ${results.map(r => `
              <tr style="border-top:1px solid var(--border)">
                <td style="padding:8px 12px;font-family:'JetBrains Mono',monospace">${esc(r.material)}</td>
                <td style="padding:8px 12px;font-weight:700;color:${r.success ? 'var(--success)' : 'var(--error)'}">${r.success ? 'OK' : 'FAILED'}</td>
                <td style="padding:8px 12px;color:var(--text-muted)">${esc(r.message)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });

  loadList('');
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. NEW PACKAGING CREATION
// ═══════════════════════════════════════════════════════════════════════════

function renderNewPackaging() {
  const body = document.getElementById('result-body');
  body.innerHTML = `
    <div style="padding:20px;max-width:720px">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.6">
        Enter a part number, then choose which packaging types to create. Each selected
        code creates material <code>IB_&lt;part&gt;_&lt;code&gt;</code> (copied from the standard
        <code>IB_363800_&lt;code&gt;</code> reference material) plus its BOM (the physical drum/box/carton
        component). Codes whose material already exists are skipped, not overwritten.
      </div>
      <div style="margin-bottom:12px">
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Part Number</label>
        <input id="np-part" placeholder="e.g. TSHV3-4B01/S"
          style="width:280px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box;font-family:'JetBrains Mono',monospace">
      </div>
      <div style="margin-bottom:14px">
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px">Packaging Types</label>
        <div style="display:flex;flex-wrap:wrap;gap:10px">
          ${PACKAGING_CODES.map(c => `
            <label style="display:flex;align-items:center;gap:5px;font-family:'JetBrains Mono',monospace;font-size:12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:5px 10px;cursor:pointer">
              <input type="checkbox" class="np-code" value="${c}" checked style="cursor:pointer"> ${c}
            </label>`).join('')}
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button id="np-run" class="btn-back" style="border:none;cursor:pointer">Create Selected</button>
        <span id="np-status" style="font-size:12px;color:var(--text-muted)"></span>
      </div>
      <div id="np-results" style="margin-top:16px"></div>
    </div>`;

  document.getElementById('np-run').addEventListener('click', async () => {
    const statusEl = document.getElementById('np-status');
    const resultsEl = document.getElementById('np-results');
    const customerPart = document.getElementById('np-part').value.trim();
    const codes = [...document.querySelectorAll('.np-code:checked')].map(cb => cb.value);

    if (!customerPart) { statusEl.textContent = 'Part number is required.'; return; }
    if (codes.length === 0) { statusEl.textContent = 'Select at least one packaging type.'; return; }

    statusEl.textContent = `Creating ${codes.length} packaging type(s) — this calls SAP MM01/CS01 and can take a while…`;
    resultsEl.innerHTML = '';
    try {
      const json = await pkgApi('/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerPart, codes }),
      });
      statusEl.textContent = '';
      const results = json.data || [];
      resultsEl.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <thead><tr style="text-align:left;background:var(--surface2);font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.03em">
            <th style="padding:8px 12px">Code</th><th style="padding:8px 12px">Material</th><th style="padding:8px 12px">Result</th><th style="padding:8px 12px">Message</th>
          </tr></thead>
          <tbody>
            ${results.map(r => {
              const ok = r.materialCreated ? r.bomCreated : r.alreadyExisted;
              return `
              <tr style="border-top:1px solid var(--border)">
                <td style="padding:8px 12px;font-family:'JetBrains Mono',monospace;font-weight:700">${esc(r.code)}</td>
                <td style="padding:8px 12px;font-family:'JetBrains Mono',monospace">${esc(r.material)}</td>
                <td style="padding:8px 12px;font-weight:700;color:${ok ? 'var(--success)' : 'var(--error)'}">${r.alreadyExisted ? 'SKIPPED' : (ok ? 'CREATED' : 'FAILED')}</td>
                <td style="padding:8px 12px;color:var(--text-muted)">${esc(r.message)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. PACKAGING INSTRUCTION DETAIL ("Dialog")
// ═══════════════════════════════════════════════════════════════════════════

function renderInstructionDetail() {
  const body = document.getElementById('result-body');
  body.innerHTML = `
    <div style="padding:20px;max-width:820px">
      <div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:16px">
        <div>
          <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Material</label>
          <input id="pi-material" placeholder="e.g. TSHV3-4B01/S"
            style="width:220px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box;font-family:'JetBrains Mono',monospace">
        </div>
        <button id="pi-load" class="btn-back" style="border:none;cursor:pointer;height:35px">Load</button>
      </div>
      <div id="pi-body"></div>
    </div>`;

  document.getElementById('pi-load').addEventListener('click', () => loadMaterial());
  document.getElementById('pi-material').addEventListener('keydown', e => { if (e.key === 'Enter') loadMaterial(); });

  async function loadMaterial() {
    const material = document.getElementById('pi-material').value.trim();
    const piBody = document.getElementById('pi-body');
    if (!material) { piBody.innerHTML = ''; return; }

    piBody.innerHTML = '<div style="padding:20px 0;color:var(--text-muted);font-size:13px">Loading…</div>';
    try {
      const [descJson, customersJson] = await Promise.all([
        pkgApi(`/material/${encodeURIComponent(material)}/description`),
        pkgApi(`/material/${encodeURIComponent(material)}/customers`),
      ]);
      renderScopePicker(material, descJson.data, customersJson.data || []);
    } catch (err) {
      piBody.innerHTML = `<div style="padding:20px 0;color:var(--error);font-size:13px">${esc(err.message)}</div>`;
    }
  }

  function renderScopePicker(material, description, customers) {
    const piBody = document.getElementById('pi-body');
    piBody.innerHTML = `
      <div style="margin-bottom:16px;font-size:13px">
        <span style="font-weight:700">${esc(material)}</span>
        ${description ? `<span style="color:var(--text-muted)"> — ${esc(description)}</span>` : ''}
      </div>
      <div style="margin-bottom:16px">
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Scope</label>
        <select id="pi-scope" style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);min-width:280px">
          <option value="">Plant Default (all customers)</option>
          ${customers.map(c => `<option value="${esc(c.customer)}">${esc(c.customer)} — ${esc(c.name || c.customerGroup || '')}</option>`).join('')}
        </select>
      </div>
      <div id="pi-form"></div>`;

    document.getElementById('pi-scope').addEventListener('change', e => loadInstruction(material, e.target.value));
    loadInstruction(material, '');
  }

  async function loadInstruction(material, customer) {
    const formEl = document.getElementById('pi-form');
    formEl.innerHTML = '<div style="padding:20px 0;color:var(--text-muted);font-size:13px">Loading instruction…</div>';
    try {
      const json = await pkgApi(`/material/${encodeURIComponent(material)}/instruction${customer ? `?customer=${encodeURIComponent(customer)}` : ''}`);
      renderForm(material, customer, json.data);
    } catch (err) {
      formEl.innerHTML = `<div style="padding:20px 0;color:var(--error);font-size:13px">${esc(err.message)}</div>`;
    }
  }

  function renderForm(material, customer, row) {
    const isPlant = !customer;
    const v = row || {
      packMaterial: '', palletQty: 0, smallBoxQty: 0,
      packProd: false, boxGen: false, batchSpread: false, partMix: false,
      chargeReq: false, techStatReq: false, pNumReq: false,
    };
    const formEl = document.getElementById('pi-form');

    const chk = (id, label, checked, extraNote) => `
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:6px 0">
        <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} style="cursor:pointer">
        ${esc(label)}${extraNote ? ` <span style="color:var(--text-muted);font-size:11px">${extraNote}</span>` : ''}
      </label>`;

    formEl.innerHTML = `
      ${!row ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">No instruction saved yet for this scope — fill in the form below to create one.</div>` : ''}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;max-width:600px">
        <div>
          <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Packaging Material</label>
          <input id="pi-packmat" value="${esc(v.packMaterial)}" placeholder="e.g. IB_TSHV3-4B01/S_SB"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box;font-family:'JetBrains Mono',monospace">
        </div>
        <div></div>
        <div>
          <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Qty per Pallet / Handling Unit</label>
          <input id="pi-pallqty" type="number" step="0.001" value="${v.palletQty}"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box">
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px">Qty per Small Box</label>
          <input id="pi-sbqty" type="number" step="0.001" value="${v.smallBoxQty}"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box">
        </div>
      </div>
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:2px">Flags</div>
        ${chk('pi-packprod', 'Packed in Production', v.packProd)}
        ${chk('pi-partmix', 'Allow mixed pallets', v.partMix)}
        ${chk('pi-batchspread', 'Allow batch spread', v.batchSpread)}
        ${chk('pi-boxgen', 'Generate boxes within batch', v.boxGen)}
      </div>
      <div style="margin-bottom:16px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--surface2)">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:2px">Trace Flags — plant-default only</div>
        ${chk('pi-chargereq', 'Trace Charge ID Required', v.chargeReq, 'needed for material customisation')}
        ${chk('pi-techstatreq', 'Tech Status Required', v.techStatReq)}
        ${chk('pi-pnumreq', 'Trace P-Number', v.pNumReq)}
        ${!isPlant ? '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">These only take effect when saved against the plant default (no customer selected) — SAP ignores them on a customer-specific row.</div>' : ''}
      </div>
      <div id="pi-msg" style="font-size:12px;color:var(--error);margin-bottom:10px"></div>
      <div style="display:flex;gap:8px">
        <button id="pi-save" class="btn-back" style="border:none;cursor:pointer">Save</button>
        ${row ? `<button id="pi-delete" style="cursor:pointer;background:none;border:1px solid var(--error);color:var(--error);border-radius:6px;padding:8px 16px;font-size:13px">Delete</button>` : ''}
      </div>`;

    document.getElementById('pi-save').addEventListener('click', () => saveInstruction(material, customer, !!row));
    document.getElementById('pi-delete')?.addEventListener('click', () => deleteInstruction(material, customer));
  }

  async function saveInstruction(material, customer, exists) {
    const msgEl = document.getElementById('pi-msg');
    const packMaterial = document.getElementById('pi-packmat').value.trim();
    if (!packMaterial) { msgEl.textContent = 'Packaging Material is required.'; return; }

    msgEl.style.color = 'var(--text-muted)';
    msgEl.textContent = 'Saving…';
    try {
      await pkgApi('/instruction', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          material, customer: customer || null,
          sqlAction: exists ? 'U' : 'I',
          packMaterial,
          palletQty: Number(document.getElementById('pi-pallqty').value) || 0,
          smallBoxQty: Number(document.getElementById('pi-sbqty').value) || 0,
          packProd: document.getElementById('pi-packprod').checked,
          boxGen: document.getElementById('pi-boxgen').checked,
          batchSpread: document.getElementById('pi-batchspread').checked,
          partMix: document.getElementById('pi-partmix').checked,
          chargeReq: document.getElementById('pi-chargereq').checked,
          techStatReq: document.getElementById('pi-techstatreq').checked,
          pNumReq: document.getElementById('pi-pnumreq').checked,
        }),
      });
      msgEl.style.color = 'var(--success)';
      msgEl.textContent = 'Saved.';
      loadInstruction(material, customer);
    } catch (err) {
      msgEl.style.color = 'var(--error)';
      msgEl.textContent = err.message;
    }
  }

  async function deleteInstruction(material, customer) {
    if (!confirm(`Delete the packaging instruction for ${material}${customer ? ` / ${customer}` : ' (plant default)'}?`)) return;
    const msgEl = document.getElementById('pi-msg');
    try {
      await pkgApi('/instruction', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ material, customer: customer || null }),
      });
      loadInstruction(material, customer);
    } catch (err) {
      msgEl.style.color = 'var(--error)';
      msgEl.textContent = err.message;
    }
  }
}
