// In Transit tile — GET /api/shipmentmain/queue/in-transit, POST
// .../mark-delivered (single, per-row) and .../mark-delivered-bulk, split
// out of the old combined shipment-queue.js. Both modals are the same real
// Node modal (Actual Delivery Date, defaulting to today) — bulk just applies
// one date to every selected shipment.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/shipmentmain");
  const bodyEl = document.getElementById("it-body");
  const noticeEl = document.getElementById("it-notice");
  const deliverBtn = document.getElementById("it-deliver-btn");
  let rows = [];
  const selected = new Set();

  async function load() {
    bodyEl.innerHTML = '<div class="nx-toolbar-hint">Loading…</div>';
    selected.clear();
    updateHint();
    try {
      const { data } = await api("/queue/in-transit");
      rows = data || [];
      render();
    } catch (err) {
      bodyEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function updateHint() {
    deliverBtn.disabled = selected.size === 0;
    document.getElementById("it-hint").textContent = selected.size
      ? `${selected.size} shipment(s) selected.`
      : `${rows.length} shipment(s) in transit.`;
  }

  function render() {
    if (rows.length === 0) { bodyEl.innerHTML = '<div class="nx-empty">No outbound shipments are currently in transit.</div>'; updateHint(); return; }
    bodyEl.innerHTML = `
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th></th><th>Shipment</th><th>Destination</th><th>Haulier</th><th>Tracking</th><th>Planned Delivery</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td><input type="checkbox" class="it-check" data-id="${r.shipmentId}"></td>
            <td><a href="#" class="it-open" data-id="${r.shipmentId}">${esc(String(r.shipmentId).padStart(8, "0"))}</a></td>
            <td>${esc(r.destinationName || "")}, ${esc(r.destinationCountry || "")}</td>
            <td>${esc(r.forwarderName || "Unassigned")}</td>
            <td>${esc(r.trackingNumber || "—")}</td>
            <td>${r.plannedMovement ? new Date(r.plannedMovement).toLocaleDateString("en-GB") : "—"}</td>
            <td><button type="button" class="secondary it-deliver-one" data-id="${r.shipmentId}" style="padding:3px 8px;font-size:11px">Mark Delivered</button></td>
          </tr>`).join("")}</tbody>
      </table>
      </div>`;

    bodyEl.querySelectorAll(".it-check").forEach((cb) => cb.addEventListener("change", (e) => {
      const id = Number(e.target.dataset.id);
      if (e.target.checked) selected.add(id); else selected.delete(id);
      updateHint();
    }));
    bodyEl.querySelectorAll(".it-deliver-one").forEach((btn) => btn.addEventListener("click", () => openMarkDeliveredModal([Number(btn.dataset.id)])));
    bodyEl.querySelectorAll(".it-open").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      OutboundShipmentDetail.open(Number(a.dataset.id), load);
    }));
    updateHint();
  }

  function showNotice(type, text) {
    const color = type === "success" ? "var(--success,#16A34A)" : type === "warning" ? "#b45309" : "var(--error)";
    noticeEl.innerHTML = `<div style="margin-bottom:10px;padding:8px 12px;border-radius:6px;background:color-mix(in srgb, ${color} 12%, transparent);color:${color};font-size:12.5px">${esc(text)}</div>`;
  }

  function openMarkDeliveredModal(shipmentIds) {
    const today = new Date().toISOString().slice(0, 10);
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div><div class="ps-modal-title">Mark as Delivered</div><div class="ps-modal-sub">${shipmentIds.length === 1 ? `Shipment #${esc(String(shipmentIds[0]).padStart(8, "0"))}` : `${shipmentIds.length} shipment(s)`}</div></div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <div class="tf-field tf-field--wide"><label class="tf-label">Actual Delivery Date</label><input class="tf-input" type="date" id="md-date" value="${today}"></div>
        <div id="md-result"></div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="secondary" id="md-cancel">Cancel</button>
        <button type="button" class="btn" id="md-confirm">Confirm Delivered</button>
      </div>`);

    card.querySelector(".ps-modal-close").addEventListener("click", () => NexusModal.close());
    card.querySelector("#md-cancel").addEventListener("click", () => NexusModal.close());
    card.querySelector("#md-confirm").addEventListener("click", async () => {
      const date = card.querySelector("#md-date").value;
      const result = card.querySelector("#md-result");
      const btn = card.querySelector("#md-confirm");
      if (!date) { result.innerHTML = '<div class="tf-inline-error">Please select a date.</div>'; return; }
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        if (shipmentIds.length === 1) {
          await api(`/${shipmentIds[0]}/mark-delivered`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actualDelivery: date }) });
          NexusModal.close();
          await load();
        } else {
          const { data } = await api("/mark-delivered-bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shipmentIds, actualDelivery: date }) });
          const completed = data?.completed || [];
          const failed = data?.failed || [];
          NexusModal.close();
          showNotice(failed.length ? "warning" : "success",
            [completed.length ? `${completed.length} shipment(s) marked as delivered.` : "", failed.length ? `${failed.length} failed: ${failed.map((f) => f.error).join("; ")}` : ""].filter(Boolean).join(" "));
          await load();
        }
      } catch (err) {
        result.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = "Confirm Delivered";
      }
    });
  }

  deliverBtn.addEventListener("click", () => {
    if (!selected.size) return;
    openMarkDeliveredModal([...selected]);
  });

  load();
})();
