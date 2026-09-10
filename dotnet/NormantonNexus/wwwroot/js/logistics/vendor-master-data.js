// Vendor Master Data tile — port of private/js/logistics.js's vendor master
// data section. Vendor-material sub-resource shown inline per vendor (View Materials).
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/performance");
  const bodyEl = document.getElementById("vm-body");

  async function load() {
    bodyEl.innerHTML = '<div class="nx-empty">Loading…</div>';
    try {
      const { data } = await api("/vendors");
      render(data || []);
    } catch (err) {
      bodyEl.innerHTML = `<div class="nx-empty">Error: ${esc(err.message)}</div>`;
    }
  }

  function render(rows) {
    if (rows.length === 0) {
      bodyEl.innerHTML = '<div class="nx-empty">No vendors configured.</div>';
      return;
    }
    bodyEl.innerHTML = `
      <div class="nx-toolbar" style="margin-bottom:10px">
        <span class="nx-toolbar-title">${rows.length} vendor${rows.length === 1 ? "" : "s"}</span>
      </div>
      <table>
        <thead><tr><th>Name</th><th>SAP Vendor #</th><th>Currency</th><th>Incoterms</th><th>Lead Time</th><th>Materials</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.vendorName)}</td>
              <td>${esc(r.sapVendorNumber)}</td>
              <td>${esc(r.currency)}</td>
              <td>${esc(r.incoterms)}</td>
              <td>${esc(r.defaultLeadTimeDays)}</td>
              <td>${esc(r.materialCount)}</td>
              <td>
                <button type="button" class="secondary" data-id="${r.vendorId}" data-action="materials">Materials</button>
                <button type="button" class="secondary" data-id="${r.vendorId}" data-action="delete" style="color:var(--error)">Delete</button>
              </td>
            </tr>
            <tr id="vm-materials-${r.vendorId}" style="display:none;"><td colspan="7"></td></tr>`).join("")}
        </tbody>
      </table>`;

    bodyEl.querySelectorAll("button[data-action='delete']").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!(await NexusModal.confirm("Delete this vendor?", { danger: true, confirmLabel: "Delete" }))) return;
        await api(`/vendors/${btn.dataset.id}`, { method: "DELETE" });
        await load();
      });
    });
    bodyEl.querySelectorAll("button[data-action='materials']").forEach((btn) => {
      btn.addEventListener("click", () => toggleMaterials(btn.dataset.id));
    });
  }

  async function toggleMaterials(vendorId) {
    const row = document.getElementById(`vm-materials-${vendorId}`);
    const cell = row.querySelector("td");
    if (row.style.display === "none") {
      row.style.display = "";
      cell.innerHTML = '<span class="nx-toolbar-hint">Loading…</span>';
      try {
        const { data } = await api(`/vendors/${vendorId}/materials`);
        const rows = data || [];
        cell.innerHTML = rows.length === 0 ? '<div class="nx-empty">No materials configured for this vendor.</div>' : `
          <table>
            <thead><tr><th>Material</th><th>MOQ</th><th>Max</th><th>Lead Override</th><th>Sched. Agmt</th></tr></thead>
            <tbody>${rows.map((m) => `<tr><td>${esc(m.material)} ${esc(m.materialText)}</td><td>${esc(m.materialMoqQty)}</td><td>${esc(m.materialMaxQty)}</td><td>${esc(m.leadTimeDaysOverride)}</td><td>${esc(m.scheduleAgreement)}</td></tr>`).join("")}</tbody>
          </table>`;
      } catch (err) {
        cell.innerHTML = `<span class="tf-inline-error">Error: ${esc(err.message)}</span>`;
      }
    } else {
      row.style.display = "none";
    }
  }

  document.getElementById("vm-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/vendors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorName: document.getElementById("vm-name").value.trim(),
          sapVendorNumber: document.getElementById("vm-sap-number").value || null,
          currency: document.getElementById("vm-currency").value || null,
          incoterms: document.getElementById("vm-incoterms").value || null,
          defaultLeadTimeDays: document.getElementById("vm-lead-time").value ? Number(document.getElementById("vm-lead-time").value) : null,
        }),
      });
      e.target.reset();
      await load();
    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  load();
})();
