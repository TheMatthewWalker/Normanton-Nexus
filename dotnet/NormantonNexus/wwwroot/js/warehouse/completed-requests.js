// Completed Requests tile — port of runStagingCompleted() in private/js/warehouse.js.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/staging");
  const bodyEl = document.getElementById("cr-body");

  async function load() {
    const from = document.getElementById("cr-from").value;
    const to = document.getElementById("cr-to").value;
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);

    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api(`/requests/completed?${params.toString()}`);
      render(data || []);
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  }

  function render(rows) {
    if (rows.length === 0) {
      bodyEl.textContent = "No completed requests in range.";
      return;
    }
    bodyEl.innerHTML = `
      <p>${rows.length} completed request(s)</p>
      <table>
        <thead><tr><th>#</th><th>Material</th><th>Qty</th><th>Location</th><th>Completed By</th><th>Completed At</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.requestId)}</td>
              <td>${esc(r.material)} ${esc(r.materialText)}</td>
              <td>${esc(r.quantityDelivered)} / ${esc(r.quantityRequested)} ${esc(r.uom)}</td>
              <td>${esc(r.location)}</td>
              <td>${esc(r.completedBy)}</td>
              <td>${r.completedAtUtc ? new Date(r.completedAtUtc).toLocaleString("en-GB") : ""}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  }

  document.getElementById("cr-filter").addEventListener("submit", (e) => { e.preventDefault(); load(); });
  load();
})();
