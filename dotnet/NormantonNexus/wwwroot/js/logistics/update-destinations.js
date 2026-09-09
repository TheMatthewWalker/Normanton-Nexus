// Update Destinations tile — log.Destinations CRUD (GET/POST/PUT
// /api/destinations), split out of the old combined Reference Data page
// into its own tile with a real NexusModal add/edit form.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api");
  const listEl = document.getElementById("ud-list");
  let rows = [];

  async function load() {
    listEl.textContent = "Loading…";
    try {
      const { data } = await api("/destinations");
      rows = data || [];
      render();
    } catch (err) {
      listEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function render() {
    const q = document.getElementById("ud-search").value.trim().toLowerCase();
    const filtered = q ? rows.filter((r) => (r.destinationName || "").toLowerCase().includes(q) || (r.destinationCity || "").toLowerCase().includes(q)) : rows;
    if (filtered.length === 0) { listEl.innerHTML = '<div class="nx-empty">No destinations match.</div>'; return; }
    listEl.innerHTML = `
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th>ID</th><th>Name</th><th>City</th><th>Country</th><th>Zone</th><th>Forwarder</th><th></th></tr></thead>
        <tbody>${filtered.map((r) => `
          <tr>
            <td>${esc(r.destinationId)}</td><td>${esc(r.destinationName)}</td><td>${esc(r.destinationCity)}</td>
            <td>${esc(r.destinationCountry)}</td><td>${esc(r.destinationZone)}</td><td>${esc(r.defaultForwarder)}</td>
            <td><button type="button" class="secondary" data-edit="${r.destinationId}" style="padding:3px 8px;font-size:11px">Edit</button></td>
          </tr>`).join("")}</tbody>
      </table>
      </div>`;
    listEl.querySelectorAll("button[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const r = rows.find((x) => String(x.destinationId) === btn.dataset.edit);
        if (r) openModal(r);
      });
    });
  }

  document.getElementById("ud-search").addEventListener("input", render);
  document.getElementById("ud-add-btn").addEventListener("click", () => openModal(null));

  function openModal(existing) {
    const isEdit = !!existing;
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">${isEdit ? "Edit Destination" : "Add Destination"}</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Destination ID</label><input class="tf-input" type="number" id="ud-id" ${isEdit ? "disabled" : ""} value="${isEdit ? esc(existing.destinationId) : ""}"></div>
          <div class="tf-field tf-field--wide"><label class="tf-label">Name</label><input class="tf-input" type="text" id="ud-name" value="${isEdit ? esc(existing.destinationName || "") : ""}"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide"><label class="tf-label">Street</label><input class="tf-input" type="text" id="ud-street" value="${isEdit ? esc(existing.destinationStreet || "") : ""}"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">City</label><input class="tf-input" type="text" id="ud-city" value="${isEdit ? esc(existing.destinationCity || "") : ""}"></div>
          <div class="tf-field"><label class="tf-label">Post Code</label><input class="tf-input" type="text" id="ud-postcode" value="${isEdit ? esc(existing.destinationPostCode || "") : ""}"></div>
          <div class="tf-field"><label class="tf-label">Country</label><input class="tf-input" type="text" id="ud-country" value="${isEdit ? esc(existing.destinationCountry || "") : ""}"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Default Incoterms</label><input class="tf-input" type="text" id="ud-incoterms" value="${isEdit ? esc(existing.defaultIncoterms || "") : ""}"></div>
          <div class="tf-field"><label class="tf-label">Zone</label><input class="tf-input" type="text" id="ud-zone" value="${isEdit ? esc(existing.destinationZone || "") : ""}"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Default Delivery Service</label><input class="tf-input" type="text" id="ud-service" value="${isEdit ? esc(existing.defaultDeliveryService || "") : ""}"></div>
          <div class="tf-field"><label class="tf-label">Default Forwarder</label><input class="tf-input" type="text" id="ud-forwarder" value="${isEdit ? esc(existing.defaultForwarder || "") : ""}"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide"><label class="tf-label">Comment</label><input class="tf-input" type="text" id="ud-comment" value="${isEdit ? esc(existing.destinationComment || "") : ""}"></div>
        </div>
        <div id="ud-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="ud-cancel">Cancel</button>
        <button type="button" class="btn" id="ud-save-btn">${isEdit ? "Save" : "Add Destination"}</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#ud-cancel").addEventListener("click", () => NexusModal.close());

    card.querySelector("#ud-save-btn").addEventListener("click", async () => {
      const btn = card.querySelector("#ud-save-btn");
      const result = card.querySelector("#ud-result");
      result.innerHTML = "";
      const body = {
        destinationName: card.querySelector("#ud-name").value || null,
        destinationStreet: card.querySelector("#ud-street").value || null,
        destinationCity: card.querySelector("#ud-city").value || null,
        destinationPostCode: card.querySelector("#ud-postcode").value || null,
        destinationCountry: card.querySelector("#ud-country").value || null,
        defaultIncoterms: card.querySelector("#ud-incoterms").value || null,
        destinationZone: card.querySelector("#ud-zone").value || null,
        defaultDeliveryService: card.querySelector("#ud-service").value || null,
        defaultForwarder: card.querySelector("#ud-forwarder").value || null,
        destinationComment: card.querySelector("#ud-comment").value || null,
      };
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        if (isEdit) {
          await api(`/destinations/${existing.destinationId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        } else {
          const idVal = card.querySelector("#ud-id").value;
          if (!idVal) { result.innerHTML = '<div class="tf-inline-error">Destination ID is required.</div>'; btn.disabled = false; btn.textContent = "Add Destination"; return; }
          await api("/destinations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destinationId: Number(idVal), ...body }) });
        }
        NexusModal.close();
        await load();
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = isEdit ? "Save" : "Add Destination";
      }
    });
  }

  load();
})();
