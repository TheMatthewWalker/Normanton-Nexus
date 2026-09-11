// Unprocessed Costs tile — GET /api/shipmentcost/unprocessed, bulk
// POST .../post-migo, PATCH/DELETE a line, POST .../manual, split out of the
// old combined Freight Costs page into its own tile with real modals.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/shipmentcost");
  const refApi = NexusApi.make("/api");
  const bodyEl = document.getElementById("uc-body");
  const postBtn = document.getElementById("uc-post-migo-btn");
  let rows = [];
  const selected = new Set();

  async function load() {
    bodyEl.innerHTML = '<div class="nx-toolbar-hint">Loading…</div>';
    selected.clear();
    updatePostBtn();
    try {
      const { data } = await api("/unprocessed");
      rows = data || [];
      render();
    } catch (err) {
      bodyEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function updatePostBtn() {
    postBtn.disabled = selected.size === 0;
    document.getElementById("uc-hint").textContent = selected.size
      ? `${selected.size} line(s) selected`
      : `${rows.length} unprocessed line(s)`;
  }

  function directionBadge(direction) {
    const cls = direction === "outbound" ? "badge--accent" : "badge";
    return `<span class="badge ${cls}">${esc(direction)}</span>`;
  }

  function render() {
    if (rows.length === 0) { bodyEl.innerHTML = '<div class="nx-empty">No unprocessed cost lines.</div>'; updatePostBtn(); return; }
    const total = rows.reduce((sum, r) => sum + (Number(r.expectedCost) || 0), 0);
    bodyEl.innerHTML = `
      <p style="font-size:12px;color:var(--text-muted)">Total expected cost £${total.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th></th><th>Shipment</th><th>Direction</th><th>Forwarder</th><th>Cost Centre</th><th>Cost Element</th><th>Expected</th><th>Actual</th><th>PO</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td><input type="checkbox" class="uc-check" data-id="${r.costId}"></td>
            <td>${esc(r.shipmentRef || `#${r.costId}`)}</td>
            <td>${directionBadge(r.direction)}</td>
            <td>${esc(r.forwarderName || "—")}</td>
            <td>${esc(r.costCenter || "—")}</td>
            <td>${esc(r.costElement || "—")}</td>
            <td>£${esc(r.expectedCost)}</td>
            <td>${r.actualCost != null ? "£" + esc(r.actualCost) : "—"}</td>
            <td>${esc(r.purchaseOrder || "—")}</td>
            <td>
              <button type="button" class="secondary uc-edit-btn" data-id="${r.costId}" style="padding:3px 8px;font-size:11px">Edit</button>
              <button type="button" class="secondary uc-delete-btn" data-id="${r.costId}" style="padding:3px 8px;font-size:11px;color:var(--error)">Delete</button>
            </td>
          </tr>`).join("")}</tbody>
      </table>
      </div>`;

    bodyEl.querySelectorAll(".uc-check").forEach((cb) => cb.addEventListener("change", (e) => {
      const id = Number(e.target.dataset.id);
      if (e.target.checked) selected.add(id); else selected.delete(id);
      updatePostBtn();
    }));
    bodyEl.querySelectorAll(".uc-edit-btn").forEach((btn) => btn.addEventListener("click", () => openEditModal(rows.find((r) => String(r.costId) === btn.dataset.id))));
    bodyEl.querySelectorAll(".uc-delete-btn").forEach((btn) => btn.addEventListener("click", async () => {
      if (!(await NexusModal.confirm("Delete this cost line?", { danger: true, confirmLabel: "Delete" }))) return;
      try { await api(`/${btn.dataset.id}`, { method: "DELETE" }); await load(); } catch (err) { await NexusModal.alert(err.message); }
    }));
    updatePostBtn();
  }

  function openEditModal(row) {
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Edit Cost Line</div><div class="ps-modal-sub">${esc(row.shipmentRef || `#${row.costId}`)}</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Cost Element</label><input class="tf-input" type="text" id="uce-element" value="${esc(row.costElement || "")}"></div>
          <div class="tf-field"><label class="tf-label">Cost Centre</label><input class="tf-input" type="text" id="uce-centre" value="${esc(row.costCenter || "")}"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Cost Type</label><input class="tf-input" type="text" id="uce-type" value="${esc(row.costType || "")}"></div>
          <div class="tf-field"><label class="tf-label">Expected Cost</label><input class="tf-input" type="number" step="0.01" id="uce-expected" value="${esc(row.expectedCost)}"></div>
        </div>
        <div id="uce-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="uce-cancel">Cancel</button>
        <button type="button" class="btn" id="uce-save-btn">Save</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#uce-cancel").addEventListener("click", () => NexusModal.close());
    card.querySelector("#uce-save-btn").addEventListener("click", async () => {
      const btn = card.querySelector("#uce-save-btn");
      const result = card.querySelector("#uce-result");
      const expectedCost = Number(card.querySelector("#uce-expected").value);
      if (!(expectedCost > 0)) { result.innerHTML = '<div class="tf-inline-error">Expected cost must be greater than 0.</div>'; return; }
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        await api(`/${row.costId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedCost,
            costElement: card.querySelector("#uce-element").value.trim() || null,
            costCenter: card.querySelector("#uce-centre").value.trim() || null,
            costType: card.querySelector("#uce-type").value.trim() || null,
          }),
        });
        NexusModal.close();
        await load();
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = "Save";
      }
    });
  }

  document.getElementById("uc-post-migo-btn").addEventListener("click", async () => {
    if (selected.size === 0) return;
    if (!(await NexusModal.confirm(`Post ${selected.size} cost line(s) to SAP (MIGO)? This creates a real goods receipt.`, { confirmLabel: "Post to MIGO" }))) return;
    const btn = document.getElementById("uc-post-migo-btn");
    btn.disabled = true; btn.textContent = "Posting…";
    try {
      const { data } = await api("/post-migo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ costIds: [...selected] }) });
      const failed = (data.results || []).filter((r) => !r.success);
      const blocked = data.blockedCostIds || [];
      let msg = `Posted ${( data.results || []).filter((r) => r.success).length} of ${(data.results || []).length} line(s).`;
      if (failed.length) msg += "\n" + failed.map((f) => `Cost ${f.costId}: ${f.error || "failed"}`).join("\n");
      if (blocked.length) msg += `\n${blocked.length} line(s) blocked: ${data.error || ""}`;
      await NexusModal.alert(msg);
      await load();
    } catch (err) {
      await NexusModal.alert(err.message);
    } finally {
      btn.disabled = false; btn.textContent = "Post to MIGO";
    }
  });

  document.getElementById("uc-add-manual-btn").addEventListener("click", openManualModal);

  function openManualModal() {
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Add Manual Cost Line</div><div class="ps-modal-sub">Not linked to a tracked shipment</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Direction</label>
            <select class="tf-input" id="ucm-direction"><option value="outbound">Outbound</option><option value="inbound">Inbound</option></select>
          </div>
          <div class="tf-field"><label class="tf-label">GL Tier</label>
            <select class="tf-input" id="ucm-tier"><option value="standard">Standard</option><option value="premium">Premium</option></select>
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Cost Type</label><input class="tf-input" type="text" id="ucm-type"></div>
          <div class="tf-field"><label class="tf-label">Cost Centre</label><input class="tf-input" type="text" id="ucm-centre"></div>
          <div class="tf-field"><label class="tf-label">Expected Cost</label><input class="tf-input" type="number" step="0.01" id="ucm-expected"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Forwarder</label><select class="tf-input" id="ucm-forwarder"><option value="">Loading…</option></select></div>
          <div class="tf-field"><label class="tf-label">Mode of Transport</label><input class="tf-input" type="text" id="ucm-mode"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Incurred Date</label><input class="tf-input" type="date" id="ucm-date"></div>
          <div class="tf-field"><label class="tf-label">Reference</label><input class="tf-input" type="text" id="ucm-reference"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Country</label><input class="tf-input" type="text" id="ucm-country"></div>
          <div class="tf-field"><label class="tf-label">Postcode</label><input class="tf-input" type="text" id="ucm-postcode"></div>
          <div class="tf-field"><label class="tf-label">Tracking Number</label><input class="tf-input" type="text" id="ucm-tracking"></div>
        </div>
        <div id="ucm-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="ucm-cancel">Cancel</button>
        <button type="button" class="btn" id="ucm-save-btn">Add Cost Line</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#ucm-cancel").addEventListener("click", () => NexusModal.close());

    refApi("/forwarders/approved").then(({ data }) => {
      const sel = card.querySelector("#ucm-forwarder");
      sel.innerHTML = '<option value="">Select a forwarder…</option>' + (data || []).map((f) => `<option value="${f.forwarderId}">${esc(f.forwarderName)}</option>`).join("");
    }).catch(() => { card.querySelector("#ucm-forwarder").innerHTML = '<option value="">Failed to load</option>'; });

    card.querySelector("#ucm-save-btn").addEventListener("click", async () => {
      const btn = card.querySelector("#ucm-save-btn");
      const result = card.querySelector("#ucm-result");
      result.innerHTML = "";
      const forwarderId = card.querySelector("#ucm-forwarder").value;
      const expectedCost = Number(card.querySelector("#ucm-expected").value);
      if (!forwarderId || !(expectedCost > 0) || !card.querySelector("#ucm-type").value.trim() || !card.querySelector("#ucm-centre").value.trim()) {
        result.innerHTML = '<div class="tf-inline-error">Forwarder, cost type, cost centre and a positive expected cost are all required.</div>';
        return;
      }
      btn.disabled = true; btn.textContent = "Adding…";
      try {
        await api("/manual", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            direction: card.querySelector("#ucm-direction").value,
            tier: card.querySelector("#ucm-tier").value,
            costType: card.querySelector("#ucm-type").value.trim(),
            costCenter: card.querySelector("#ucm-centre").value.trim(),
            expectedCost,
            forwarderId: Number(forwarderId),
            modeOfTransport: card.querySelector("#ucm-mode").value.trim() || null,
            incurredDate: card.querySelector("#ucm-date").value || new Date().toISOString().slice(0, 10),
            reference: card.querySelector("#ucm-reference").value.trim() || "",
            country: card.querySelector("#ucm-country").value.trim() || "",
            postcode: card.querySelector("#ucm-postcode").value.trim() || "",
            trackingNumber: card.querySelector("#ucm-tracking").value.trim() || null,
          }),
        });
        NexusModal.close();
        await load();
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = "Add Cost Line";
      }
    });
  }

  load();
})();
