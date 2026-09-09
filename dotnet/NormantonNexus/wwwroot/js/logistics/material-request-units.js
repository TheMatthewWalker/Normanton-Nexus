// Material Request Units tile — log.MaterialRequestUnits CRUD
// (GET/POST/PUT/DELETE /api/material-request-units) + bulk CSV import
// (POST /api/material-request-units/bulk), split out of the old combined
// Reference Data page into its own tile with a real NexusModal add/edit
// form and a bulk-import modal (matching the paste-CSV-textarea convention
// established on Order Suggestions' own bulk import).
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api");
  const listEl = document.getElementById("mru-list");
  let rows = [];

  async function load() {
    listEl.textContent = "Loading…";
    try {
      const { data } = await api("/material-request-units");
      rows = data || [];
      render();
    } catch (err) {
      listEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function render() {
    if (rows.length === 0) { listEl.innerHTML = '<div class="nx-empty">No request units.</div>'; return; }
    listEl.innerHTML = `
      <table>
        <thead><tr><th>Material</th><th>Unit</th><th>Conversion Qty</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td>${esc(r.material)}</td><td>${esc(r.unit)}</td><td>${esc(r.conversionQty)}</td>
            <td>
              <button type="button" class="secondary" data-edit="${r.requestUnitId}" style="padding:3px 8px;font-size:11px">Edit</button>
              <button type="button" class="secondary" data-delete="${r.requestUnitId}" style="padding:3px 8px;font-size:11px;color:var(--error)">Delete</button>
            </td>
          </tr>`).join("")}</tbody>
      </table>`;
    listEl.querySelectorAll("button[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => openModal(rows.find((x) => String(x.requestUnitId) === btn.dataset.edit)));
    });
    listEl.querySelectorAll("button[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!(await NexusModal.confirm("Delete this request unit?", { danger: true, confirmLabel: "Delete" }))) return;
        try { await api(`/material-request-units/${btn.dataset.delete}`, { method: "DELETE" }); await load(); } catch (err) { await NexusModal.alert(err.message); }
      });
    });
  }

  document.getElementById("mru-add-btn").addEventListener("click", () => openModal(null));

  function openModal(existing) {
    const isEdit = !!existing;
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">${isEdit ? "Edit Request Unit" : "Add Request Unit"}</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Material</label><input class="tf-input" type="text" id="mru-material" value="${isEdit ? esc(existing.material || "") : ""}"></div>
          <div class="tf-field"><label class="tf-label">Unit</label><input class="tf-input" type="text" id="mru-unit" value="${isEdit ? esc(existing.unit || "") : ""}"></div>
          <div class="tf-field"><label class="tf-label">Conversion Qty (to KG)</label><input class="tf-input" type="number" step="0.0001" id="mru-qty" value="${isEdit ? esc(existing.conversionQty) : ""}"></div>
        </div>
        <div id="mru-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="mru-cancel">Cancel</button>
        <button type="button" class="btn" id="mru-save-btn">${isEdit ? "Save" : "Add Request Unit"}</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#mru-cancel").addEventListener("click", () => NexusModal.close());

    card.querySelector("#mru-save-btn").addEventListener("click", async () => {
      const btn = card.querySelector("#mru-save-btn");
      const result = card.querySelector("#mru-result");
      result.innerHTML = "";
      const material = card.querySelector("#mru-material").value.trim();
      const unit = card.querySelector("#mru-unit").value.trim();
      const qty = card.querySelector("#mru-qty").value;
      if (!material || !unit || !qty || Number(qty) <= 0) { result.innerHTML = '<div class="tf-inline-error">Material, unit and a positive conversion quantity are all required.</div>'; return; }
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        const body = { material, unit, conversionQty: Number(qty) };
        if (isEdit) await api(`/material-request-units/${existing.requestUnitId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        else await api("/material-request-units", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        NexusModal.close();
        await load();
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = isEdit ? "Save" : "Add Request Unit";
      }
    });
  }

  document.getElementById("mru-bulk-btn").addEventListener("click", openBulkModal);

  function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];
    const headers = lines[0].split(",").map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const cols = line.split(",").map((c) => c.trim());
      const raw = {};
      headers.forEach((h, i) => { raw[h] = cols[i] ?? ""; });
      return { material: raw.Material || "", unit: raw.Unit || "", conversionQty: Number(raw.ConversionQty) || 0 };
    });
  }

  function openBulkModal() {
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Bulk Import Request Units (CSV)</div><div class="ps-modal-sub">Paste rows with a header line — an existing Material+Unit pair is updated, a new one is inserted</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <p style="font-size:12px;color:var(--text-muted)">Header row: <code>Material,Unit,ConversionQty</code></p>
        <textarea class="tf-input" id="mru-csv" rows="8" style="width:100%;font-family:monospace;font-size:12px" placeholder="Material,Unit,ConversionQty
30007R,SPOOL,22.5"></textarea>
        <div id="mru-bulk-body" style="margin-top:10px"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="mru-bulk-cancel">Close</button>
        <button type="button" class="secondary" id="mru-bulk-preview">Preview</button>
        <button type="button" class="btn" id="mru-bulk-submit" style="display:none">Import</button>
      </div>`, { wide: true });

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#mru-bulk-cancel").addEventListener("click", () => NexusModal.close());

    const bodyEl = card.querySelector("#mru-bulk-body");
    const submitBtn = card.querySelector("#mru-bulk-submit");
    let records = [];

    card.querySelector("#mru-bulk-preview").addEventListener("click", () => {
      records = parseCsv(card.querySelector("#mru-csv").value);
      if (records.length === 0) {
        bodyEl.innerHTML = '<div class="tf-inline-error">No valid rows found.</div>';
        submitBtn.style.display = "none";
        return;
      }
      bodyEl.innerHTML = `
        <p>${records.length} row(s) parsed</p>
        <table><thead><tr><th>Material</th><th>Unit</th><th>Conversion Qty</th></tr></thead>
        <tbody>${records.map((r) => `<tr><td>${esc(r.material)}</td><td>${esc(r.unit)}</td><td>${esc(r.conversionQty)}</td></tr>`).join("")}</tbody></table>`;
      submitBtn.style.display = "";
    });

    submitBtn.addEventListener("click", async () => {
      submitBtn.disabled = true; submitBtn.textContent = "Importing…";
      try {
        const { data } = await api("/material-request-units/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records }) });
        const errLines = (data.errors || []).map((e) => `${esc(e.material || "?")} / ${esc(e.unit || "?")}: ${esc(e.error)}`).join("<br>");
        bodyEl.innerHTML = `<p>Inserted ${data.inserted}, updated ${data.updated}.</p>${errLines ? `<div class="tf-inline-error">${errLines}</div>` : ""}`;
        submitBtn.style.display = "none";
        await load();
      } catch (err) {
        bodyEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
      } finally {
        submitBtn.disabled = false; submitBtn.textContent = "Import";
      }
    });
  }

  load();
})();
