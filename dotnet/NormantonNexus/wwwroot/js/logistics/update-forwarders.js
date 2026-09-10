// Update Forwarders tile — log.Forwarders CRUD (GET/POST/PUT
// /api/forwarders), split out of the old combined Reference Data page into
// its own tile with a real NexusModal add/edit form. forwarderID is NOT
// unique on its own — a vendor with several shipping modes gets one row per
// mode, all sharing the same forwarderID — so editing needs the row's
// CURRENT mode (originalMode) to pin down exactly one row.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api");
  const listEl = document.getElementById("uf-list");
  const countEl = document.getElementById("uf-count");
  let rows = [];

  async function load() {
    listEl.innerHTML = '<div class="nx-empty">Loading…</div>';
    try {
      const { data } = await api("/forwarders");
      rows = data || [];
      render();
    } catch (err) {
      listEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function approvalBadge(approved) {
    return approved ? '<span class="badge badge--success">Approved</span>' : '<span class="badge badge--warn">Pending</span>';
  }

  function render() {
    countEl.textContent = `${rows.length} forwarder${rows.length === 1 ? "" : "s"}`;
    if (rows.length === 0) { listEl.innerHTML = '<div class="nx-empty">No forwarders.</div>'; return; }
    listEl.innerHTML = `
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th>ID</th><th>Name</th><th>Mode</th><th>Approval</th><th></th></tr></thead>
        <tbody>${rows.map((r, i) => `
          <tr>
            <td>${esc(r.forwarderId)}</td><td>${esc(r.forwarderName)}</td><td>${esc(r.forwarderMode || "—")}</td><td>${approvalBadge(r.forwarderApproval)}</td>
            <td><button type="button" class="secondary" data-edit="${i}" style="padding:3px 8px;font-size:11px">Edit</button></td>
          </tr>`).join("")}</tbody>
      </table>
      </div>`;
    listEl.querySelectorAll("button[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => openModal(rows[Number(btn.dataset.edit)]));
    });
  }

  document.getElementById("uf-add-btn").addEventListener("click", () => openModal(null));

  function openModal(existing) {
    const isEdit = !!existing;
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">${isEdit ? "Edit Forwarder" : "Add Forwarder"}</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Forwarder ID (SAP vendor code)</label><input class="tf-input" type="number" id="uf-id" ${isEdit ? "disabled" : ""} value="${isEdit ? esc(existing.forwarderId) : ""}"></div>
          <div class="tf-field tf-field--wide"><label class="tf-label">Name</label><input class="tf-input" type="text" id="uf-name" value="${isEdit ? esc(existing.forwarderName || "") : ""}"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Mode</label><input class="tf-input" type="text" id="uf-mode" value="${isEdit ? esc(existing.forwarderMode || "") : ""}"></div>
          <div class="tf-field" style="align-items:center;flex-direction:row;gap:8px;padding-top:22px">
            <input type="checkbox" id="uf-approved" ${isEdit && existing.forwarderApproval ? "checked" : ""}> <label class="tf-label" style="margin:0" for="uf-approved">Approved</label>
          </div>
        </div>
        <div id="uf-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="uf-cancel">Cancel</button>
        <button type="button" class="btn" id="uf-save-btn">${isEdit ? "Save" : "Add Forwarder"}</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#uf-cancel").addEventListener("click", () => NexusModal.close());

    card.querySelector("#uf-save-btn").addEventListener("click", async () => {
      const btn = card.querySelector("#uf-save-btn");
      const result = card.querySelector("#uf-result");
      result.innerHTML = "";
      const forwarderName = card.querySelector("#uf-name").value.trim();
      if (!forwarderName) { result.innerHTML = '<div class="tf-inline-error">Name is required.</div>'; return; }
      const forwarderMode = card.querySelector("#uf-mode").value.trim() || null;
      const forwarderApproval = card.querySelector("#uf-approved").checked;
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        if (isEdit) {
          await api(`/forwarders/${existing.forwarderId}`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ forwarderName, forwarderApproval, forwarderMode, originalMode: existing.forwarderMode || null }),
          });
        } else {
          const idVal = card.querySelector("#uf-id").value;
          if (!idVal) { result.innerHTML = '<div class="tf-inline-error">Forwarder ID is required.</div>'; btn.disabled = false; btn.textContent = "Add Forwarder"; return; }
          await api("/forwarders", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ forwarderId: Number(idVal), forwarderName, forwarderApproval, forwarderMode }),
          });
        }
        NexusModal.close();
        await load();
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = isEdit ? "Save" : "Add Forwarder";
      }
    });
  }

  load();
})();
