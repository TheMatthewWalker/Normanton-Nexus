// Picksheets on Hold tile — port of runPackagingHolding() in private/js/warehouse.js.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/deliverymain");
  const bodyEl = document.getElementById("ph-body");

  async function load() {
    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api("/packaging-holding");
      render(data || []);
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  }

  function render(rows) {
    if (rows.length === 0) {
      bodyEl.textContent = "Nothing on hold.";
      return;
    }
    bodyEl.innerHTML = `
      <p>${rows.length} on hold</p>
      <table>
        <thead><tr><th>Delivery</th><th>Customer</th><th>Destination</th><th>Dispatch Date</th><th>Service</th><th>Moved to Holding</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.deliveryId)}</td>
              <td>${esc(r.customerId)}</td>
              <td>${esc(r.destinationName)}</td>
              <td>${r.dispatchDate ? new Date(r.dispatchDate).toLocaleDateString("en-GB") : ""}</td>
              <td>${esc(r.deliveryService)}</td>
              <td>${r.movedToHoldingAtUtc ? new Date(r.movedToHoldingAtUtc).toLocaleString("en-GB") : ""}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  }

  document.getElementById("ph-refresh").addEventListener("click", load);
  load();
})();
