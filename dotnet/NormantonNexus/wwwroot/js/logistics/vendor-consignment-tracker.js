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
    vendorsEl.innerHTML = '<div class="nx-empty">Loading…</div>';
    try {
      const { data } = await api("/vendors");
      const rows = data || [];
      if (rows.length === 0) { vendorsEl.innerHTML = '<div class="nx-empty">No consignment vendors configured.</div>'; return; }
      vendorsEl.innerHTML = `
        <div class="nx-toolbar" style="margin-bottom:10px">
          <span class="nx-toolbar-title">${rows.length} vendor${rows.length === 1 ? "" : "s"}</span>
        </div>
        <table>
          <thead><tr><th>Vendor</th><th>SAP #</th><th>Currency</th><th>Allocation</th><th>Active</th><th></th></tr></thead>
          <tbody>
            ${rows.map((v) => `
              <tr>
                <td>${esc(v.vendorName)}</td>
                <td>${esc(v.sapVendorNumber)}</td>
                <td>${esc(v.currency)}</td>
                <td>${esc(v.defaultAllocationMethod)}</td>
                <td>${v.active ? '<span class="badge badge--success">Active</span>' : '<span class="badge">Inactive</span>'}</td>
                <td><button type="button" class="secondary" data-id="${v.vendorId}">View</button></td>
              </tr>`).join("")}
          </tbody>
        </table>`;
      vendorsEl.querySelectorAll("button[data-id]").forEach((btn) => {
        btn.addEventListener("click", () => loadDetail(btn.dataset.id));
      });
    } catch (err) {
      vendorsEl.innerHTML = `<div class="nx-empty">Error: ${esc(err.message)}</div>`;
    }
  }

  function declStatusBadge(status) {
    const cls = status === "Confirmed" || status === "Settled" ? "badge--success"
      : status === "Proposed" ? "badge--accent"
      : status === "Cancelled" ? "badge--error"
      : "";
    return `<span class="badge ${cls}">${esc(status)}</span>`;
  }

  async function loadDetail(vendorId) {
    detailEl.innerHTML = '<div class="nx-empty">Loading…</div>';
    try {
      const [balance, deliveries, declarations] = await Promise.all([
        api(`/vendors/${vendorId}/balance`).then((r) => r.data),
        api(`/vendors/${vendorId}/deliveries`).then((r) => r.data),
        api(`/vendors/${vendorId}/declarations`).then((r) => r.data),
      ]);

      const materials = balance.materials || [];
      const delivRows = deliveries || [];
      const declRows = declarations || [];

      detailEl.innerHTML = `
        <h3>Balance — ${esc(balance.vendor.vendorName)}</h3>
        ${materials.length === 0 ? '<div class="nx-empty">No material balances for this vendor.</div>' : `
        <table>
          <thead><tr><th>Material</th><th>Delivered</th><th>Current Stock</th><th>Declared</th><th>Undeclared</th></tr></thead>
          <tbody>${materials.map((m) => `<tr><td>${esc(m.material)}</td><td>${esc(m.delivered)}</td><td>${esc(m.currentStock)}</td><td>${esc(m.declared)}</td><td>${esc(m.undeclared)}</td></tr>`).join("")}</tbody>
        </table>`}

        <h3 style="margin-top:1rem;">Deliveries</h3>
        ${delivRows.length === 0 ? '<div class="nx-empty">No deliveries recorded.</div>' : `
        <table>
          <thead><tr><th>Material</th><th>Qty</th><th>Remaining</th><th>Doc</th><th>Posting Date</th></tr></thead>
          <tbody>${delivRows.map((d) => `<tr><td>${esc(d.material)}</td><td>${esc(d.quantity)}</td><td>${esc(d.remainingQty)}</td><td>${esc(d.materialDocument)}</td><td>${d.postingDate ? new Date(d.postingDate).toLocaleDateString("en-GB") : ""}</td></tr>`).join("")}</tbody>
        </table>`}

        <h3 style="margin-top:1rem;">Declarations</h3>
        ${declRows.length === 0 ? '<div class="nx-empty">No declarations yet.</div>' : `
        <table>
          <thead><tr><th>#</th><th>Status</th><th>Method</th><th>Total Qty</th><th>Created</th><th></th></tr></thead>
          <tbody>${declRows.map((d) => `
            <tr>
              <td>${esc(d.declarationId)}</td>
              <td>${declStatusBadge(d.status)}</td>
              <td>${esc(d.allocationMethod)}</td>
              <td>${esc(d.totalQty)}</td>
              <td>${new Date(d.createdAtUtc).toLocaleDateString("en-GB")}</td>
              <td>
                ${d.status === "Draft" || d.status === "Proposed" ? `<button type="button" class="secondary" data-decl="${d.declarationId}" data-action="confirm">Confirm</button> <button type="button" class="secondary" data-decl="${d.declarationId}" data-action="cancel" style="color:var(--error)">Cancel</button>` : ""}
                <a href="/api/consignment/declarations/${d.declarationId}/pdf" target="_blank">PDF</a>
              </td>
            </tr>`).join("")}</tbody>
        </table>`}`;

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
          if (!(await NexusModal.confirm("Cancel this declaration?", { danger: true, confirmLabel: "Cancel Declaration", cancelLabel: "Back" }))) return;
          try {
            await api(`/declarations/${btn.dataset.decl}/cancel`, { method: "POST" });
            await loadDetail(vendorId);
          } catch (err) { alert("Error: " + err.message); }
        });
      });
    } catch (err) {
      detailEl.innerHTML = `<div class="nx-empty">Error: ${esc(err.message)}</div>`;
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
