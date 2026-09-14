// Picksheets on Hold tile — port of runPackagingHolding() in private/js/warehouse.js.
// Clicking a row opens the same Picked Pallets modal as Open Picksheets
// (picked-pallets-modal.js's PickedPalletsModal.show) so packaging can be
// confirmed through the normal flow — completeDelivery() there detects
// fromHolding and skips the SAP pushes since SAP already has this delivery
// closed, matching Node's own runPackagingHolding/showPickedPallets(...,
// fromHolding=true) exactly.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/deliverymain");
  const bodyEl = document.getElementById("ph-body");

  async function load() {
    bodyEl.innerHTML = `<div class="sap-loading"><div class="spinner"></div>Loading…</div>`;
    try {
      const { data } = await api("/packaging-holding");
      render(data || []);
    } catch (err) {
      bodyEl.innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
    }
  }

  function render(rows) {
    if (rows.length === 0) {
      bodyEl.innerHTML = `<div class="wsm-empty">Nothing on hold.</div>`;
      return;
    }
    bodyEl.innerHTML = `
      <p>${rows.length} on hold</p>
      <table class="ps-table">
        <thead><tr><th>Delivery</th><th>Customer</th><th>Destination</th><th>Dispatch Date</th><th>Service</th><th>Moved to Holding</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr class="ps-row" data-id="${esc(String(r.deliveryId))}" data-dest="${esc(r.destinationName ?? "")}">
              <td>${esc(r.deliveryId)}</td>
              <td>${esc(r.customerId)}</td>
              <td>${esc(r.destinationName)}</td>
              <td>${r.dispatchDate ? new Date(r.dispatchDate).toLocaleDateString("en-GB") : ""}</td>
              <td>${esc(r.deliveryService)}</td>
              <td>${r.movedToHoldingAtUtc ? new Date(r.movedToHoldingAtUtc).toLocaleString("en-GB") : ""}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;

    bodyEl.querySelectorAll(".ps-row").forEach((tr) => {
      tr.addEventListener("click", () => PickedPalletsModal.show(tr.dataset.id, tr.dataset.dest, true, load));
    });
  }

  document.getElementById("ph-refresh").addEventListener("click", load);
  load();
})();
