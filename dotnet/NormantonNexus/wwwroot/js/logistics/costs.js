// Freight Costs tile — port of Unprocessed/Processed Costs in private/js/logistics.js.
// Combined "Freight Spend" analytics (GET /analytics) is a real, unbuilt
// gap — not wired into this page, see dotnet/CLAUDE.md's Phase 10 notes.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/shipmentcost");
  const bodyEl = document.getElementById("co-body");

  async function load() {
    const mode = document.getElementById("co-mode").value;
    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api(`/${mode}`);
      render(data || []);
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  }

  function render(rows) {
    if (rows.length === 0) {
      bodyEl.textContent = "No cost lines.";
      return;
    }
    const total = rows.reduce((sum, r) => sum + (Number(r.expectedCost) || 0), 0);
    bodyEl.innerHTML = `
      <p>${rows.length} line(s) — total expected cost £${total.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
      <table>
        <thead><tr><th>Shipment</th><th>Direction</th><th>Forwarder</th><th>Cost Centre</th><th>Cost Element</th><th>Expected</th><th>Actual</th><th>PO</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.shipmentRef)}</td>
              <td>${esc(r.direction)}</td>
              <td>${esc(r.forwarderName)}</td>
              <td>${esc(r.costCenter)}</td>
              <td>${esc(r.costElement)}</td>
              <td>${esc(r.expectedCost)}</td>
              <td>${esc(r.actualCost)}</td>
              <td>${esc(r.purchaseOrder)}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  }

  document.getElementById("co-mode").addEventListener("change", load);
  load();
})();
