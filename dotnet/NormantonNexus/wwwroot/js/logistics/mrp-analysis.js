// MRP Analysis tile — refresh + consumption/GR trends + forecast run
// history. The forecast-building wizards themselves aren't built here.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/mrp-analysis");

  document.getElementById("ma-refresh").addEventListener("click", async () => {
    const el = document.getElementById("ma-refresh-status");
    el.textContent = "Refreshing…";
    try {
      const { data } = await api("/refresh", { method: "POST" });
      el.textContent = `Status: ${data.status || "done"}`;
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  });

  document.getElementById("ma-trends-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const el = document.getElementById("ma-trends");
    const materials = document.getElementById("ma-materials").value.split(",").map((s) => s.trim()).filter(Boolean);
    const params = materials.map((m) => `materials=${encodeURIComponent(m)}`).join("&");
    el.textContent = "Loading…";
    try {
      const { data } = await api(`/trends?${params}`);
      el.innerHTML = `
        <h4>Consumption by Year</h4>
        <table>
          <thead><tr><th>Material</th><th>Year</th><th>Consumed Qty</th></tr></thead>
          <tbody>${(data.consumption || []).map((r) => `<tr><td>${esc(r.material)} ${esc(r.materialText)}</td><td>${esc(r.fiscalYear)}</td><td>${esc(r.consumedQty)}</td></tr>`).join("")}</tbody>
        </table>
        <h4>Goods Receipts by Vendor</h4>
        <table>
          <thead><tr><th>Material</th><th>Vendor</th><th>Year</th><th>Received Qty</th></tr></thead>
          <tbody>${(data.receipts || []).map((r) => `<tr><td>${esc(r.material)} ${esc(r.materialText)}</td><td>${esc(r.vendorName)}</td><td>${esc(r.fiscalYear)}</td><td>${esc(r.receivedQty)} ${esc(r.uom)}</td></tr>`).join("")}</tbody>
        </table>`;
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  });

  (async () => {
    const el = document.getElementById("ma-runs");
    try {
      const { data } = await api("/forecast/runs");
      el.innerHTML = (data || []).length === 0 ? "<p>No forecast runs.</p>" : `
        <table>
          <thead><tr><th>Run</th><th>Target Year</th><th>Method</th><th>Created By</th><th>Created</th></tr></thead>
          <tbody>${data.map((r) => `<tr><td>${esc(r.runId)}</td><td>${esc(r.targetYear)}</td><td>${esc(r.method)}</td><td>${esc(r.createdBy)}</td><td>${new Date(r.createdAtUtc).toLocaleString("en-GB")}</td></tr>`).join("")}</tbody>
        </table>`;
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  })();
})();
