// Stock Turns & Valuation tile — aggregates + value-by-price only (see
// TurnsValClassModel's own comment for what's deliberately not built here).
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/performance");

  (async () => {
    const el = document.getElementById("tv-totals");
    try {
      const { data } = await api("/turns-valclass/aggregates");
      el.innerHTML = `
        <p>Materials: ${esc(data.totals.materialCount)} — Stock Value: £${Number(data.totals.totalStockValue || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} — Book Value: £${Number(data.totals.totalBookValue || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} — Warnings: ${esc(data.totals.warningCount)} — Avg Turns: ${esc(data.totals.avgStockTurns)} — Avg Days in Stock: ${esc(data.totals.avgDaysInStock)}</p>`;

      const turnoverEl = document.getElementById("tv-turnover");
      turnoverEl.innerHTML = `
        <table>
          <thead><tr><th>Category</th><th>Materials</th><th>Stock Value</th></tr></thead>
          <tbody>${(data.byTurnoverCategory || []).map((c) => `<tr><td>${esc(c.category)}</td><td>${esc(c.materialCount)}</td><td>£${Number(c.stockValue || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td></tr>`).join("")}</tbody>
        </table>`;
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  })();

  (async () => {
    const el = document.getElementById("tv-price-band");
    try {
      const { data } = await api("/turns-valclass/value-by-price");
      el.innerHTML = `
        <table>
          <thead><tr><th>Price Band</th><th>Materials</th><th>Total Qty</th><th>Total Value</th></tr></thead>
          <tbody>${(data || []).map((b) => `<tr><td>${esc(b.priceBand)}</td><td>${esc(b.materialCount)}</td><td>${esc(b.totalStockQty)}</td><td>£${Number(b.totalStockValue || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td></tr>`).join("")}</tbody>
        </table>`;
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  })();
})();
