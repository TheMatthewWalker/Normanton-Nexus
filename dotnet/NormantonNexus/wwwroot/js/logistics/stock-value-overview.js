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
        <div class="nx-toolbar" style="margin-bottom:14px">
          <span class="nx-toolbar-title">${esc(data.totals.materialCount)} materials</span>
          <span class="nx-toolbar-spacer"></span>
          <span class="nx-toolbar-hint">Stock Value ${fmtGbp(data.totals.totalStockValue)} · Book Value ${fmtGbp(data.totals.totalBookValue)} · Avg Turns ${esc(data.totals.avgStockTurns)} · Avg Days in Stock ${esc(data.totals.avgDaysInStock)}</span>
          ${Number(data.totals.warningCount) > 0 ? `<span class="badge badge--warn">${esc(data.totals.warningCount)} warning${Number(data.totals.warningCount) === 1 ? "" : "s"}</span>` : '<span class="badge badge--success">No warnings</span>'}
        </div>`;

      const byTurnover = data.byTurnoverCategory || [];
      document.getElementById("svo-turnover").innerHTML = byTurnover.length === 0 ? '<div class="nx-empty">No turnover-category data.</div>' : `
        <table>
          <thead><tr><th>Category</th><th>Materials</th><th>Stock Value</th></tr></thead>
          <tbody>${byTurnover.map((c) => `<tr><td>${esc(c.category)}</td><td>${esc(c.materialCount)}</td><td>${fmtGbp(c.stockValue)}</td></tr>`).join("")}</tbody>
        </table>`;

      const byProfitCentre = data.byProfitCentre || [];
      document.getElementById("svo-profit-centre").innerHTML = byProfitCentre.length === 0 ? '<div class="nx-empty">No profit-centre data.</div>' : `
        <table>
          <thead><tr><th>Profit Centre</th><th>Materials</th><th>Stock Value</th><th>Book Value</th></tr></thead>
          <tbody>${byProfitCentre.map((c) => `<tr><td>${esc(c.profitCentre || "—")}</td><td>${esc(c.materialCount)}</td><td>${fmtGbp(c.stockValue)}</td><td>${fmtGbp(c.bookValue)}</td></tr>`).join("")}</tbody>
        </table>`;

      const byMaterialType = data.byMaterialType || [];
      document.getElementById("svo-material-type").innerHTML = byMaterialType.length === 0 ? '<div class="nx-empty">No material-type data.</div>' : `
        <table>
          <thead><tr><th>Material Type</th><th>Materials</th><th>Stock Value</th></tr></thead>
          <tbody>${byMaterialType.map((c) => `<tr><td>${esc(c.materialType || "—")}</td><td>${esc(c.materialCount)}</td><td>${fmtGbp(c.stockValue)}</td></tr>`).join("")}</tbody>
        </table>`;
    } catch (err) {
      document.getElementById("svo-totals").innerHTML = `<div class="nx-empty">Error: ${esc(err.message)}</div>`;
    }
  })();
})();
