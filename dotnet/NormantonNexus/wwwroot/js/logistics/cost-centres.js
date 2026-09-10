// Cost Centres tile — log.CostCenters CRUD (GET/POST/PUT/DELETE
// /api/costcenters), split out of the old combined Reference Data page into
// its own tile with a real NexusModal add/edit form.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api");
  const listEl = document.getElementById("cc-list");
  const countEl = document.getElementById("cc-count");
  let rows = [];

  async function load() {
    listEl.innerHTML = '<div class="nx-empty">Loading…</div>';
    try {
      const { data } = await api("/costcenters");
      rows = data || [];
      render();
    } catch (err) {
      listEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function render() {
    countEl.textContent = `${rows.length} cost centre${rows.length === 1 ? "" : "s"}`;
    if (rows.length === 0) { listEl.innerHTML = '<div class="nx-empty">No cost centres.</div>'; return; }
    listEl.innerHTML = `
      <table>
        <thead><tr><th>Code</th><th>Description</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td>${esc(r.centerCode)}</td><td>${esc(r.centerDescription)}</td>
            <td>
              <button type="button" class="secondary" data-edit="${r.centerId}" style="padding:3px 8px;font-size:11px">Edit</button>
              <button type="button" class="secondary" data-delete="${r.centerId}" style="padding:3px 8px;font-size:11px;color:var(--error)">Delete</button>
            </td>
          </tr>`).join("")}</tbody>
      </table>`;
    listEl.querySelectorAll("button[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => openModal(rows.find((x) => String(x.centerId) === btn.dataset.edit)));
    });
    listEl.querySelectorAll("button[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!(await NexusModal.confirm("Delete this cost centre?", { danger: true, confirmLabel: "Delete" }))) return;
        try { await api(`/costcenters/${btn.dataset.delete}`, { method: "DELETE" }); await load(); } catch (err) { await NexusModal.alert(err.message); }
      });
    });
  }

  document.getElementById("cc-add-btn").addEventListener("click", () => openModal(null));

  function openModal(existing) {
    const isEdit = !!existing;
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">${isEdit ? "Edit Cost Centre" : "Add Cost Centre"}</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Code</label><input class="tf-input" type="text" id="cc-code" value="${isEdit ? esc(existing.centerCode || "") : ""}"></div>
          <div class="tf-field tf-field--wide"><label class="tf-label">Description</label><input class="tf-input" type="text" id="cc-desc" value="${isEdit ? esc(existing.centerDescription || "") : ""}"></div>
        </div>
        <div id="cc-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="cc-cancel">Cancel</button>
        <button type="button" class="btn" id="cc-save-btn">${isEdit ? "Save" : "Add Cost Centre"}</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#cc-cancel").addEventListener("click", () => NexusModal.close());

    card.querySelector("#cc-save-btn").addEventListener("click", async () => {
      const btn = card.querySelector("#cc-save-btn");
      const result = card.querySelector("#cc-result");
      result.innerHTML = "";
      const centerCode = card.querySelector("#cc-code").value.trim();
      const centerDescription = card.querySelector("#cc-desc").value.trim();
      if (!centerCode || !centerDescription) { result.innerHTML = '<div class="tf-inline-error">Code and description are both required.</div>'; return; }
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        const body = { centerCode, centerDescription };
        if (isEdit) await api(`/costcenters/${existing.centerId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        else await api("/costcenters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        NexusModal.close();
        await load();
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = isEdit ? "Save" : "Add Cost Centre";
      }
    });
  }

  load();
})();
