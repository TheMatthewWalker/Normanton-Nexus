// Order Lookup tile — find an open order, check stock/required, print a
// Drumming Ticket. Port of Node's renderOrderLookupScreen, as its own
// standalone tile rather than nested inside the Drumming wizard's type
// picker.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/productionnexus");

  function fmtDate(d) {
    return d ? new Date(d).toLocaleDateString("en-GB") : "";
  }

  async function search() {
    const resultsEl = document.getElementById("ol-results");
    resultsEl.textContent = "Searching…";
    const orderNumber = document.getElementById("ol-order").value.trim();
    const material = document.getElementById("ol-material").value.trim();
    const customer = document.getElementById("ol-customer").value.trim();

    try {
      let rows;
      if (orderNumber) {
        const { data } = await api(`/order-lookup/by-order/${encodeURIComponent(orderNumber)}`);
        rows = data || [];
      } else {
        const params = new URLSearchParams();
        if (material) params.set("material", material);
        if (customer) params.set("customer", customer);
        const { data } = await api(`/order-lookup?${params.toString()}`);
        rows = data || [];
      }
      render(rows);
    } catch (err) {
      resultsEl.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  function render(rows) {
    const el = document.getElementById("ol-results");
    el.innerHTML = rows.length === 0 ? "<p>No open order lines found.</p>" : `
      <p>${rows.length} line(s)</p>
      <table>
        <thead><tr><th>Customer</th><th>Order</th><th>Item</th><th>Material</th><th>Description</th><th>Cust. Material</th><th>Stream</th><th>Request Date</th><th>Order Qty</th><th>Stock</th><th>Required</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.customer)} ${esc(r.customerName)}</td>
              <td>${esc(r.referenceDocument)}</td><td>${esc(r.item)}</td>
              <td>${esc(r.material)}</td><td>${esc(r.materialText)}</td><td>${esc(r.customerMaterial)}</td>
              <td>${esc(r.valueStream)}</td><td>${fmtDate(r.requestDate)}</td>
              <td>${esc(r.orderQty)} ${esc(r.uom)}</td><td>${r.stockQty != null ? esc(r.stockQty) : "—"}</td><td>${r.requiredQty != null ? esc(r.requiredQty) : "—"}</td>
              <td><a href="/api/productionnexus/drumming/ticket/${encodeURIComponent(r.referenceDocument)}/${encodeURIComponent(r.item)}/print" target="_blank" rel="noopener">Print Ticket</a></td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  }

  document.getElementById("ol-search-btn").addEventListener("click", search);
  document.getElementById("ol-order").addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
})();
