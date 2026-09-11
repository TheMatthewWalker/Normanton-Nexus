// MRP Analysis tile — refresh + consumption/GR trends + forecast run
// history. The forecast-building wizards themselves aren't built here.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/mrp-analysis");

  document.getElementById("ma-refresh").addEventListener("click", async () => {
    const el = document.getElementById("ma-refresh-status");
    el.innerHTML = '<span class="nx-toolbar-hint">Refreshing…</span>';
    try {
      const { data } = await api("/refresh", { method: "POST" });
      el.innerHTML = `<span class="badge badge--success">${esc(data.status || "done")}</span>`;
    } catch (err) {
      el.innerHTML = `<span class="tf-inline-error">Error: ${esc(err.message)}</span>`;
    }
  });

  document.getElementById("ma-trends-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const el = document.getElementById("ma-trends");
    const materials = document.getElementById("ma-materials").value.split(",").map((s) => s.trim()).filter(Boolean);
    const params = materials.map((m) => `materials=${encodeURIComponent(m)}`).join("&");
    el.innerHTML = '<div class="nx-empty">Loading…</div>';
    try {
      const { data } = await api(`/trends?${params}`);
      const consumption = data.consumption || [];
      const receipts = data.receipts || [];
      if (consumption.length === 0 && receipts.length === 0) {
        el.innerHTML = '<div class="nx-empty">No consumption or goods-receipt history for the given materials.</div>';
        return;
      }
      el.innerHTML = `
        <h4>Consumption by Year</h4>
        ${consumption.length === 0 ? '<div class="nx-empty">No consumption history.</div>' : `
        <table>
          <thead><tr><th>Material</th><th>Year</th><th>Consumed Qty</th></tr></thead>
          <tbody>${consumption.map((r) => `<tr><td>${esc(r.material)} ${esc(r.materialText)}</td><td>${esc(r.fiscalYear)}</td><td>${esc(r.consumedQty)}</td></tr>`).join("")}</tbody>
        </table>`}
        <h4>Goods Receipts by Vendor</h4>
        ${receipts.length === 0 ? '<div class="nx-empty">No goods-receipt history.</div>' : `
        <table>
          <thead><tr><th>Material</th><th>Vendor</th><th>Year</th><th>Received Qty</th></tr></thead>
          <tbody>${receipts.map((r) => `<tr><td>${esc(r.material)} ${esc(r.materialText)}</td><td>${esc(r.vendorName)}</td><td>${esc(r.fiscalYear)}</td><td>${esc(r.receivedQty)} ${esc(r.uom)}</td></tr>`).join("")}</tbody>
        </table>`}`;
    } catch (err) {
      el.innerHTML = `<div class="nx-empty">Error: ${esc(err.message)}</div>`;
    }
  });

  (async () => {
    const el = document.getElementById("ma-runs");
    el.innerHTML = '<div class="nx-empty">Loading…</div>';
    try {
      const { data } = await api("/forecast/runs");
      const rows = data || [];
      if (rows.length === 0) { el.innerHTML = '<div class="nx-empty">No forecast runs.</div>'; return; }
      el.innerHTML = `
        <div class="nx-toolbar" style="margin-bottom:10px">
          <span class="nx-toolbar-title">${rows.length} run${rows.length === 1 ? "" : "s"}</span>
        </div>
        <table>
          <thead><tr><th>Run</th><th>Target Year</th><th>Method</th><th>Created By</th><th>Created</th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td>${esc(r.runId)}</td><td>${esc(r.targetYear)}</td><td>${esc(r.method)}</td><td>${esc(r.createdBy)}</td><td>${new Date(r.createdAtUtc).toLocaleString("en-GB")}</td></tr>`).join("")}</tbody>
        </table>`;
    } catch (err) {
      el.innerHTML = `<div class="nx-empty">Error: ${esc(err.message)}</div>`;
    }
  })();
})();
