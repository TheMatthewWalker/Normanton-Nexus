// Stock Count Administration tile — lists every stock count via the shared
// StockCountController (GET /api/stockcount/counts). Port of the
// list-only half of runStockCountAdmin() in private/js/warehouse.js —
// reopen/discrepancy-resolution actions are real, unbuilt scope (see
// StockCountModels.cs's own scope note).
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/stockcount");
  const bodyEl = document.getElementById("sca-body");

  async function load() {
    const status = document.getElementById("sca-status").value;
    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api(`/counts${status ? "?status=" + encodeURIComponent(status) : ""}`);
      render(data || []);
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  }

  function render(rows) {
    if (rows.length === 0) {
      bodyEl.textContent = "No counts found.";
      return;
    }
    bodyEl.innerHTML = `
      <p>${rows.length} count(s)</p>
      <table>
        <thead><tr><th>#</th><th>Type</th><th>Location</th><th>Status</th><th>Created By</th><th>Created At</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.countId)}</td>
              <td>${esc(r.countType)}</td>
              <td>${esc(r.storageLocation || (r.weekStartDate ? "PTFE " + new Date(r.weekStartDate).toLocaleDateString("en-GB") : ""))}</td>
              <td>${esc(r.status)}</td>
              <td>${esc(r.createdBy)}</td>
              <td>${r.createdAtUtc ? new Date(r.createdAtUtc).toLocaleString("en-GB") : ""}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  }

  document.getElementById("sca-status").addEventListener("change", load);
  load();
})();
