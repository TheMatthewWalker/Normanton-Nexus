// Awaiting Collection tile — GET /api/shipmentmain/queue/awaiting-collection,
// POST .../mark-collected-bulk, .../unbook, .../update-planned-collection,
// split out of the old combined shipment-queue.js. Mark Collected reproduces
// Node's real modal (Operator/Driver/Vehicle Reg/Trailer, mixed-haulier
// warning) — the four fields are folded into one description string, same
// as private/js/logistics.js's submitMarkCollected.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/shipmentmain");
  const bodyEl = document.getElementById("ac-body");
  const noticeEl = document.getElementById("ac-notice");
  const collectBtn = document.getElementById("ac-collect-btn");
  const dateBtn = document.getElementById("ac-date-btn");
  const unbookBtn = document.getElementById("ac-unbook-btn");
  let rows = [];
  const selected = new Set();

  async function load() {
    bodyEl.innerHTML = '<div class="nx-toolbar-hint">Loading…</div>';
    selected.clear();
    updateHint();
    try {
      const { data } = await api("/queue/awaiting-collection");
      rows = data || [];
      render();
    } catch (err) {
      bodyEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function selectedRows() { return rows.filter((r) => selected.has(r.shipmentId)); }
  function hauliersMixed(sel) { return new Set(sel.map((r) => r.forwarderName || "Unassigned")).size > 1; }

  function updateHint() {
    const count = selected.size;
    collectBtn.disabled = count === 0;
    dateBtn.disabled = count === 0;
    unbookBtn.disabled = count === 0;
    document.getElementById("ac-hint").textContent = count
      ? `${count} shipment(s) selected.`
      : `${rows.length} shipment(s) awaiting collection.`;
  }

  function render() {
    if (rows.length === 0) { bodyEl.innerHTML = '<div class="nx-empty">No shipments are currently awaiting collection.</div>'; updateHint(); return; }
    bodyEl.innerHTML = `
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th></th><th>Shipment</th><th>Destination</th><th>Haulier</th><th>Tracking</th><th>Planned Collection</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td><input type="checkbox" class="ac-check" data-id="${r.shipmentId}"></td>
            <td>${esc(String(r.shipmentId).padStart(8, "0"))}</td>
            <td>${esc(r.destinationName || "")}, ${esc(r.destinationCountry || "")}</td>
            <td>${esc(r.forwarderName || "Unassigned")}</td>
            <td>${esc(r.trackingNumber || "—")}</td>
            <td>${r.plannedCollection ? new Date(r.plannedCollection).toLocaleDateString("en-GB") : "—"}</td>
          </tr>`).join("")}</tbody>
      </table>
      </div>`;

    bodyEl.querySelectorAll(".ac-check").forEach((cb) => cb.addEventListener("change", (e) => {
      const id = Number(e.target.dataset.id);
      if (e.target.checked) selected.add(id); else selected.delete(id);
      updateHint();
    }));
    updateHint();
  }

  function showNotice(type, text) {
    const color = type === "success" ? "var(--success,#16A34A)" : type === "warning" ? "#b45309" : "var(--error)";
    noticeEl.innerHTML = `<div style="margin-bottom:10px;padding:8px 12px;border-radius:6px;background:color-mix(in srgb, ${color} 12%, transparent);color:${color};font-size:12.5px">${esc(text)}</div>`;
  }

  collectBtn.addEventListener("click", () => {
    const sel = selectedRows();
    if (!sel.length) return;
    const mixed = hauliersMixed(sel);
    const now = new Date().toLocaleString("en-GB");
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Mark as Collected</div><div class="ps-modal-sub">${sel.length} shipment(s)${mixed ? " — multiple hauliers selected" : ""}</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        ${mixed ? '<div style="margin-bottom:12px;padding:8px 12px;border-radius:6px;background:color-mix(in srgb, #b45309 12%, transparent);color:#b45309;font-size:12.5px">These shipments are assigned to different hauliers. Please confirm they are being collected together on the same vehicle.</div>' : ""}
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Operator Name</label><input class="tf-input" id="cl-operator" type="text" placeholder="e.g. Jim Smith"></div>
          <div class="tf-field"><label class="tf-label">Driver Name</label><input class="tf-input" id="cl-driver" type="text" placeholder="e.g. Dave Jones"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Vehicle Registration</label><input class="tf-input" id="cl-reg" type="text" placeholder="e.g. AB12 CDE"></div>
          <div class="tf-field"><label class="tf-label">Trailer Number</label><input class="tf-input" id="cl-trailer" type="text" placeholder="e.g. TRL-456"></div>
        </div>
        <div class="tf-row"><div class="tf-field tf-field--wide"><label class="tf-label">Timestamp (auto)</label><input class="tf-input" value="${esc(now)}" readonly></div></div>
        <div id="cl-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="cl-cancel">Cancel</button>
        <button type="button" class="btn" id="cl-submit">${mixed ? "Confirm (Mixed Hauliers)" : "Confirm"}</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#cl-cancel").addEventListener("click", () => NexusModal.close());
    card.querySelector("#cl-submit").addEventListener("click", async () => {
      const operator_ = card.querySelector("#cl-operator").value.trim();
      const driver = card.querySelector("#cl-driver").value.trim();
      const reg = card.querySelector("#cl-reg").value.trim();
      const trailer = card.querySelector("#cl-trailer").value.trim();
      const result = card.querySelector("#cl-result");
      const btn = card.querySelector("#cl-submit");
      if (!operator_) { result.innerHTML = '<div class="tf-inline-error">Operator name is required.</div>'; return; }

      const description = [`operator=${operator_}`, driver ? `driver=${driver}` : null, reg ? `reg=${reg}` : null, trailer ? `trailer=${trailer}` : null].filter(Boolean).join(" | ");
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        if (mixed) {
          const haulierNames = [...new Set(sel.map((r) => r.forwarderName || "Unassigned"))].join(", ");
          await api("/events", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ events: sel.map((r) => ({ shipmentId: r.shipmentId, category: "WARNING", description: `Multi-haulier collection confirmed. Hauliers: ${haulierNames}` })) }),
          });
        }
        const { data } = await api("/mark-collected-bulk", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shipmentIds: sel.map((r) => r.shipmentId), description }),
        });
        const completed = data?.completed || [];
        const failed = data?.failed || [];
        NexusModal.close();
        showNotice(failed.length ? "warning" : "success",
          [completed.length ? `${completed.length} shipment(s) marked as collected.` : "", failed.length ? `${failed.length} failed: ${failed.map((f) => f.error).join("; ")}` : ""].filter(Boolean).join(" "));
        await load();
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = mixed ? "Confirm (Mixed Hauliers)" : "Confirm";
      }
    });
  });

  dateBtn.addEventListener("click", () => {
    const sel = selectedRows();
    if (!sel.length) return;
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Update Planned Collection</div><div class="ps-modal-sub">${sel.length} shipment(s)</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-field tf-field--wide"><label class="tf-label">New Planned Collection Date</label><input class="tf-input" type="date" id="cd-date" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div id="cd-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="cd-cancel">Cancel</button>
        <button type="button" class="btn" id="cd-submit">Update</button>
      </div>`);
    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#cd-cancel").addEventListener("click", () => NexusModal.close());
    card.querySelector("#cd-submit").addEventListener("click", async () => {
      const date = card.querySelector("#cd-date").value;
      const result = card.querySelector("#cd-result");
      const btn = card.querySelector("#cd-submit");
      if (!date) { result.innerHTML = '<div class="tf-inline-error">Please select a date.</div>'; return; }
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        await api("/update-planned-collection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shipmentIds: sel.map((r) => r.shipmentId), date }) });
        NexusModal.close();
        await load();
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = "Update";
      }
    });
  });

  unbookBtn.addEventListener("click", async () => {
    const sel = selectedRows();
    if (!sel.length) return;
    if (!(await NexusModal.confirm(`Unbook ${sel.length} shipment(s)? This clears their expected freight cost, planned collection date and tracking number, and moves them back to Awaiting Booking.`, { danger: true, confirmLabel: "Unbook" }))) return;
    try {
      const { data } = await api("/unbook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shipmentIds: sel.map((r) => r.shipmentId) }) });
      const completed = data?.completed || [];
      const failed = data?.failed || [];
      showNotice(failed.length ? "warning" : "success",
        [completed.length ? `${completed.length} shipment(s) unbooked.` : "", failed.length ? `${failed.length} failed: ${failed.map((f) => f.error).join("; ")}` : ""].filter(Boolean).join(" "));
      await load();
    } catch (err) {
      showNotice("error", err.message);
    }
  });

  load();
})();
