// Open Picksheets tile — port of runOpenPicksheets() in private/js/warehouse.js.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/deliverymain");
  const bodyEl = document.getElementById("op-body");

  async function load() {
    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api("/open-picksheets");
      render(data || []);
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  }

  function render(rows) {
    if (rows.length === 0) {
      bodyEl.textContent = "No open picksheets.";
      return;
    }
    bodyEl.innerHTML = `
      <p>${rows.length} open delivery(s)</p>
      <table>
        <thead><tr><th>Delivery</th><th>Customer</th><th>Destination</th><th>Dispatch Date</th><th>Service</th><th>Priority</th><th>Incoterms</th><th>Comment</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.deliveryId)}</td>
              <td>${esc(r.customerId)}</td>
              <td>${esc(r.destinationName)}</td>
              <td>${r.dispatchDate ? new Date(r.dispatchDate).toLocaleDateString("en-GB") : ""}</td>
              <td>${esc(r.deliveryService)}</td>
              <td>${esc(r.deliveryPriority)}</td>
              <td>${esc(r.incoterms)}</td>
              <td>${esc(r.picksheetComment)}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  }

  document.getElementById("op-refresh").addEventListener("click", load);
  load();
})();
