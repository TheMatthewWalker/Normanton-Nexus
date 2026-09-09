// Forwarder Mode Mapping tile — log.ForwarderModeMapping CRUD
// (GET/POST/PUT/DELETE /api/forwarder-mode-mapping, plus
// /forwarder-mode-mapping/forwarder-types for the Forwarder Type dropdown),
// split out of the old combined Reference Data page into its own tile with
// a real NexusModal add/edit form.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api");
  const listEl = document.getElementById("fmm-list");
  let rows = [];
  let types = [];

  async function load() {
    listEl.textContent = "Loading…";
    try {
      const [mappings, typesResp] = await Promise.all([api("/forwarder-mode-mapping"), api("/forwarder-mode-mapping/forwarder-types")]);
      rows = mappings.data || [];
      types = typesResp.data || [];
      render();
    } catch (err) {
      listEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function render() {
    if (rows.length === 0) { listEl.innerHTML = '<div class="nx-empty">No mappings.</div>'; return; }
    listEl.innerHTML = `
      <table>
        <thead><tr><th>Forwarder Type</th><th>Mode of Transport</th><th>Description</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td>${esc(r.forwarderMode)}</td><td>${esc(r.modeOfTransport)}</td><td>${esc(r.description || "—")}</td>
            <td>
              <button type="button" class="secondary" data-edit="${r.mappingId}" style="padding:3px 8px;font-size:11px">Edit</button>
              <button type="button" class="secondary" data-delete="${r.mappingId}" style="padding:3px 8px;font-size:11px;color:var(--error)">Delete</button>
            </td>
          </tr>`).join("")}</tbody>
      </table>`;
    listEl.querySelectorAll("button[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => openModal(rows.find((x) => String(x.mappingId) === btn.dataset.edit)));
    });
    listEl.querySelectorAll("button[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!(await NexusModal.confirm("Delete this mapping?", { danger: true, confirmLabel: "Delete" }))) return;
        try { await api(`/forwarder-mode-mapping/${btn.dataset.delete}`, { method: "DELETE" }); await load(); } catch (err) { await NexusModal.alert(err.message); }
      });
    });
  }

  document.getElementById("fmm-add-btn").addEventListener("click", () => openModal(null));

  function openModal(existing) {
    const isEdit = !!existing;
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">${isEdit ? "Edit Mapping" : "Add Mapping"}</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Forwarder Type</label>
            <select class="tf-input" id="fmm-type">${types.map((t) => `<option value="${esc(t)}" ${isEdit && existing.forwarderMode === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
          </div>
          <div class="tf-field"><label class="tf-label">Mode of Transport</label><input class="tf-input" type="text" id="fmm-mot" value="${isEdit ? esc(existing.modeOfTransport || "") : ""}"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide"><label class="tf-label">Description</label><input class="tf-input" type="text" id="fmm-desc" value="${isEdit ? esc(existing.description || "") : ""}"></div>
        </div>
        <div id="fmm-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="fmm-cancel">Cancel</button>
        <button type="button" class="btn" id="fmm-save-btn">${isEdit ? "Save" : "Add Mapping"}</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#fmm-cancel").addEventListener("click", () => NexusModal.close());

    card.querySelector("#fmm-save-btn").addEventListener("click", async () => {
      const btn = card.querySelector("#fmm-save-btn");
      const result = card.querySelector("#fmm-result");
      result.innerHTML = "";
      const modeOfTransport = card.querySelector("#fmm-mot").value.trim();
      if (!modeOfTransport) { result.innerHTML = '<div class="tf-inline-error">Mode of Transport is required.</div>'; return; }
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        const body = {
          forwarderMode: card.querySelector("#fmm-type").value,
          modeOfTransport,
          description: card.querySelector("#fmm-desc").value.trim() || null,
        };
        if (isEdit) await api(`/forwarder-mode-mapping/${existing.mappingId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        else await api("/forwarder-mode-mapping", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        NexusModal.close();
        await load();
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = isEdit ? "Save" : "Add Mapping";
      }
    });
  }

  load();
})();
