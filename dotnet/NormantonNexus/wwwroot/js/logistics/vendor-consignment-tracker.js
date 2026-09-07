// Vendor Consignment Tracker tile — port of the vendor list + balance +
// deliveries + declarations views in private/js/logistics.js. Declaration
// proposal/confirm/cancel workflow is shown read-only with confirm/cancel
// actions; the propose-declaration wizard itself (FEFO/FIFO allocation
// preview) is not built — declarations already proposed can still be
// managed here.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/consignment");
  const vendorsEl = document.getElementById("vc-vendors");
  const detailEl = document.getElementById("vc-detail");

  async function loadVendors() {
    vendorsEl.textContent = "Loading…";
    try {
      const { data } = await api("/vendors");
      vendorsEl.innerHTML = `
        <table>
          <thead><tr><th>Vendor</th><th>SAP #</th><th>Currency</th><th>Allocation</th><th>Active</th><th></th></tr></thead>
          <tbody>
            ${(data || []).map((v) => `
              <tr>
                <td>${esc(v.vendorName)}</td>
                <td>${esc(v.sapVendorNumber)}</td>
                <td>${esc(v.currency)}</td>
                <td>${esc(v.defaultAllocationMethod)}</td>
                <td>${v.active ? "Yes" : "No"}</td>
                <td><button type="button" class="btn secondary" data-id="${v.vendorId}">View</button></td>
              </tr>`).join("")}
          </tbody>
        </table>`;
      vendorsEl.querySelectorAll("button[data-id]").forEach((btn) => {
        btn.addEventListener("click", () => loadDetail(btn.dataset.id));
      });
    } catch (err) {
      vendorsEl.textContent = "Error: " + err.message;
    }
  }

  async function loadDetail(vendorId) {
    detailEl.textContent = "Loading…";
    try {
      const [balance, deliveries, declarations] = await Promise.all([
        api(`/vendors/${vendorId}/balance`).then((r) => r.data),
        api(`/vendors/${vendorId}/deliveries`).then((r) => r.data),
        api(`/vendors/${vendorId}/declarations`).then((r) => r.data),
      ]);

      detailEl.innerHTML = `
        <h3>Balance — ${esc(balance.vendor.vendorName)}</h3>
        <table>
          <thead><tr><th>Material</th><th>Delivered</th><th>Current Stock</th><th>Declared</th><th>Undeclared</th></tr></thead>
          <tbody>${(balance.materials || []).map((m) => `<tr><td>${esc(m.material)}</td><td>${esc(m.delivered)}</td><td>${esc(m.currentStock)}</td><td>${esc(m.declared)}</td><td>${esc(m.undeclared)}</td></tr>`).join("")}</tbody>
        </table>

        <h3>Deliveries</h3>
        <table>
          <thead><tr><th>Material</th><th>Qty</th><th>Remaining</th><th>Doc</th><th>Posting Date</th></tr></thead>
          <tbody>${(deliveries || []).map((d) => `<tr><td>${esc(d.material)}</td><td>${esc(d.quantity)}</td><td>${esc(d.remainingQty)}</td><td>${esc(d.materialDocument)}</td><td>${d.postingDate ? new Date(d.postingDate).toLocaleDateString("en-GB") : ""}</td></tr>`).join("")}</tbody>
        </table>

        <h3>Declarations</h3>
        <table>
          <thead><tr><th>#</th><th>Status</th><th>Method</th><th>Total Qty</th><th>Created</th><th></th></tr></thead>
          <tbody>${(declarations || []).map((d) => `
            <tr>
              <td>${esc(d.declarationId)}</td>
              <td>${esc(d.status)}</td>
              <td>${esc(d.allocationMethod)}</td>
              <td>${esc(d.totalQty)}</td>
              <td>${new Date(d.createdAtUtc).toLocaleDateString("en-GB")}</td>
              <td>
                ${d.status === "Draft" || d.status === "Proposed" ? `<button type="button" class="btn secondary" data-decl="${d.declarationId}" data-action="confirm">Confirm</button> <button type="button" class="btn secondary" data-decl="${d.declarationId}" data-action="cancel">Cancel</button>` : ""}
                <a href="/api/consignment/declarations/${d.declarationId}/pdf" target="_blank">PDF</a>
              </td>
            </tr>`).join("")}</tbody>
        </table>`;

      detailEl.querySelectorAll("button[data-action='confirm']").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            await api(`/declarations/${btn.dataset.decl}/confirm`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
            });
            await loadDetail(vendorId);
          } catch (err) { alert("Error: " + err.message); }
        });
      });
      detailEl.querySelectorAll("button[data-action='cancel']").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("Cancel this declaration?")) return;
          try {
            await api(`/declarations/${btn.dataset.decl}/cancel`, { method: "POST" });
            await loadDetail(vendorId);
          } catch (err) { alert("Error: " + err.message); }
        });
      });
    } catch (err) {
      detailEl.textContent = "Error: " + err.message;
    }
  }

  document.getElementById("vc-refresh-stock").addEventListener("click", async () => {
    try {
      await api("/stock/refresh", { method: "POST" });
      alert("Stock snapshot refresh triggered.");
    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  loadVendors();
})();
