// Stock Value Overview tile — GET /turns-valclass/aggregates' full shape
// (Totals + ByTurnoverCategory + ByProfitCentre + ByMaterialType), split out
// of the old combined Stock Turns & Valuation page to match Node's own
// separate-tile grouping.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/performance");

  function fmtGbp(n) {
    return "£" + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  (async () => {
    try {
      const { data } = await api("/turns-valclass/aggregates");

      document.getElementById("svo-totals").innerHTML = `
        <p>Materials: ${esc(data.totals.materialCount)} — Stock Value: ${fmtGbp(data.totals.totalStockValue)} — Book Value: ${fmtGbp(data.totals.totalBookValue)} — Warnings: ${esc(data.totals.warningCount)} — Avg Turns: ${esc(data.totals.avgStockTurns)} — Avg Days in Stock: ${esc(data.totals.avgDaysInStock)}</p>`;

      document.getElementById("svo-turnover").innerHTML = `
        <table>
          <thead><tr><th>Category</th><th>Materials</th><th>Stock Value</th></tr></thead>
          <tbody>${(data.byTurnoverCategory || []).map((c) => `<tr><td>${esc(c.category)}</td><td>${esc(c.materialCount)}</td><td>${fmtGbp(c.stockValue)}</td></tr>`).join("")}</tbody>
        </table>`;

      document.getElementById("svo-profit-centre").innerHTML = `
        <table>
          <thead><tr><th>Profit Centre</th><th>Materials</th><th>Stock Value</th><th>Book Value</th></tr></thead>
          <tbody>${(data.byProfitCentre || []).map((c) => `<tr><td>${esc(c.profitCentre || "—")}</td><td>${esc(c.materialCount)}</td><td>${fmtGbp(c.stockValue)}</td><td>${fmtGbp(c.bookValue)}</td></tr>`).join("")}</tbody>
        </table>`;

      document.getElementById("svo-material-type").innerHTML = `
        <table>
          <thead><tr><th>Material Type</th><th>Materials</th><th>Stock Value</th></tr></thead>
          <tbody>${(data.byMaterialType || []).map((c) => `<tr><td>${esc(c.materialType || "—")}</td><td>${esc(c.materialCount)}</td><td>${fmtGbp(c.stockValue)}</td></tr>`).join("")}</tbody>
        </table>`;
    } catch (err) {
      document.getElementById("svo-totals").innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  })();
})();
