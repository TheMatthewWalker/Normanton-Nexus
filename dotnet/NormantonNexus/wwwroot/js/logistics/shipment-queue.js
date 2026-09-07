// Shipment Queue tile — port of Awaiting Booking/Awaiting Collection/In
// Transit in private/js/logistics.js, combined into one page with a mode
// selector (GET /api/shipmentmain/queue/{mode}).
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/shipmentmain");
  const bodyEl = document.getElementById("sq-body");

  async function load() {
    const mode = document.getElementById("sq-mode").value;
    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api(`/queue/${mode}`);
      render(data || []);
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  }

  function render(rows) {
    if (rows.length === 0) {
      bodyEl.textContent = "Nothing in this queue.";
      return;
    }
    bodyEl.innerHTML = `
      <p>${rows.length} shipment(s)</p>
      <table>
        <thead><tr><th>Shipment</th><th>Destination</th><th>Forwarder</th><th>Tracking</th><th>Planned</th><th>Incoterms</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.shipmentId)}</td>
              <td>${esc(r.destinationName)}, ${esc(r.destinationCountry)}</td>
              <td>${esc(r.forwarderName)}</td>
              <td>${esc(r.trackingNumber)}</td>
              <td>${r.plannedMovement ? new Date(r.plannedMovement).toLocaleDateString("en-GB") : ""}</td>
              <td>${esc(r.incoTerms)}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  }

  document.getElementById("sq-mode").addEventListener("change", load);
  load();
})();
