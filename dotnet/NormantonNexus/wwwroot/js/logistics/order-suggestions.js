// MRP System tile — view-only port of order suggestions + tracked orders.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/performance");

  (async () => {
    const el = document.getElementById("os-suggestions");
    try {
      const { data } = await api("/order-suggestions");
      el.innerHTML = (data || []).length === 0 ? "<p>No suggestions.</p>" : data.map((g) => `
        <h4>${esc(g.vendorName)} — combined ${esc(g.combinedQty)} ${esc(g.orderMoqUom)} ${g.moqMet ? "(MOQ met)" : "(below MOQ)"}</h4>
        <table>
          <thead><tr><th>Material</th><th>Current Stock</th><th>Suggested Qty</th><th>Urgency</th><th>Order By</th></tr></thead>
          <tbody>${g.materials.map((m) => `<tr><td>${esc(m.material)} ${esc(m.materialText)}</td><td>${esc(m.currentStock)}</td><td>${esc(m.suggestedQty)}</td><td>${esc(m.urgency)}</td><td>${esc(m.orderByDate)}</td></tr>`).join("")}</tbody>
        </table>`).join("");
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  })();

  (async () => {
    const el = document.getElementById("os-tracked");
    try {
      const { data } = await api("/order-suggestions/tracked");
      el.innerHTML = (data || []).length === 0 ? "<p>No tracked orders.</p>" : `
        <table>
          <thead><tr><th>Vendor</th><th>Material</th><th>Status</th><th>Qty</th><th>Order Date</th><th>Delivery Date</th><th>PO</th></tr></thead>
          <tbody>${data.map((r) => `<tr><td>${esc(r.vendorName)}</td><td>${esc(r.material)}</td><td>${esc(r.status)}</td><td>${esc(r.orderQty)}</td><td>${new Date(r.orderDate).toLocaleDateString("en-GB")}</td><td>${r.deliveryDate ? new Date(r.deliveryDate).toLocaleDateString("en-GB") : ""}</td><td>${esc(r.poNumber)}</td></tr>`).join("")}</tbody>
        </table>`;
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  })();
})();
