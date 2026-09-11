// Stock Value by Price tile — GET /turns-valclass/value-by-price, split out
// of the old combined Stock Turns & Valuation page to match Node's own
// separate-tile grouping.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/performance");

  (async () => {
    const el = document.getElementById("svp-body");
    try {
      const { data } = await api("/turns-valclass/value-by-price");
      const rows = data || [];
      if (rows.length === 0) { el.innerHTML = '<div class="nx-empty">No stock value data.</div>'; return; }
      el.innerHTML = `
        <div class="nx-toolbar" style="margin-bottom:10px">
          <span class="nx-toolbar-title">${rows.length} price band${rows.length === 1 ? "" : "s"}</span>
        </div>
        <table>
          <thead><tr><th>Price Band</th><th>Materials</th><th>Total Qty</th><th>Total Value</th></tr></thead>
          <tbody>${rows.map((b) => `<tr><td>${esc(b.priceBand)}</td><td>${esc(b.materialCount)}</td><td>${Number(b.totalStockQty || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td><td>£${Number(b.totalStockValue || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td></tr>`).join("")}</tbody>
        </table>`;
    } catch (err) {
      el.innerHTML = `<div class="nx-empty">Error: ${esc(err.message)}</div>`;
    }
  })();
})();
