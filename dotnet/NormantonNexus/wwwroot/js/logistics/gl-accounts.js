// GL Accounts tile — log.CostElements CRUD (GET/POST/PUT/DELETE
// /api/costelements), split out of the old combined Reference Data page
// into its own tile with a real NexusModal add/edit form.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api");
  const listEl = document.getElementById("ga-list");
  const countEl = document.getElementById("ga-count");
  let rows = [];

  async function load() {
    listEl.innerHTML = '<div class="nx-empty">Loading…</div>';
    try {
      const { data } = await api("/costelements");
      rows = data || [];
      render();
    } catch (err) {
      listEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function render() {
    countEl.textContent = `${rows.length} GL account${rows.length === 1 ? "" : "s"}`;
    if (rows.length === 0) { listEl.innerHTML = '<div class="nx-empty">No GL accounts.</div>'; return; }
    listEl.innerHTML = `
      <table>
        <thead><tr><th>Code</th><th>Description</th><th>Direction</th><th>Tier</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td>${esc(r.elementCode)}</td><td>${esc(r.elementDescription)}</td><td>${esc(r.direction || "—")}</td><td>${esc(r.tier || "—")}</td>
            <td>
              <button type="button" class="secondary" data-edit="${r.elementId}" style="padding:3px 8px;font-size:11px">Edit</button>
              <button type="button" class="secondary" data-delete="${r.elementId}" style="padding:3px 8px;font-size:11px;color:var(--error)">Delete</button>
            </td>
          </tr>`).join("")}</tbody>
      </table>`;
    listEl.querySelectorAll("button[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => openModal(rows.find((x) => String(x.elementId) === btn.dataset.edit)));
    });
    listEl.querySelectorAll("button[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!(await NexusModal.confirm("Delete this GL account?", { danger: true, confirmLabel: "Delete" }))) return;
        try { await api(`/costelements/${btn.dataset.delete}`, { method: "DELETE" }); await load(); } catch (err) { await NexusModal.alert(err.message); }
      });
    });
  }

  document.getElementById("ga-add-btn").addEventListener("click", () => openModal(null));

  function openModal(existing) {
    const isEdit = !!existing;
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">${isEdit ? "Edit GL Account" : "Add GL Account"}</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Code</label><input class="tf-input" type="text" id="ga-code" value="${isEdit ? esc(existing.elementCode || "") : ""}"></div>
          <div class="tf-field tf-field--wide"><label class="tf-label">Description</label><input class="tf-input" type="text" id="ga-desc" value="${isEdit ? esc(existing.elementDescription || "") : ""}"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Direction</label><input class="tf-input" type="text" id="ga-direction" placeholder="inbound / outbound" value="${isEdit ? esc(existing.direction || "") : ""}"></div>
          <div class="tf-field"><label class="tf-label">Tier</label><input class="tf-input" type="text" id="ga-tier" placeholder="standard / premium" value="${isEdit ? esc(existing.tier || "") : ""}"></div>
        </div>
        <div id="ga-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="ga-cancel">Cancel</button>
        <button type="button" class="btn" id="ga-save-btn">${isEdit ? "Save" : "Add GL Account"}</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#ga-cancel").addEventListener("click", () => NexusModal.close());

    card.querySelector("#ga-save-btn").addEventListener("click", async () => {
      const btn = card.querySelector("#ga-save-btn");
      const result = card.querySelector("#ga-result");
      result.innerHTML = "";
      const elementCode = card.querySelector("#ga-code").value.trim();
      const elementDescription = card.querySelector("#ga-desc").value.trim();
      if (!elementCode || !elementDescription) { result.innerHTML = '<div class="tf-inline-error">Code and description are both required.</div>'; return; }
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        const body = {
          elementCode, elementDescription,
          direction: card.querySelector("#ga-direction").value.trim() || null,
          tier: card.querySelector("#ga-tier").value.trim() || null,
        };
        if (isEdit) await api(`/costelements/${existing.elementId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        else await api("/costelements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        NexusModal.close();
        await load();
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = isEdit ? "Save" : "Add GL Account";
      }
    });
  }

  load();
})();
