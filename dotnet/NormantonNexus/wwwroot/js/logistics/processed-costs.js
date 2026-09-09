// Processed Costs tile — GET /api/shipmentcost/processed, POST
// {costId}/reverse, split out of the old combined Freight Costs page into
// its own tile.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/shipmentcost");
  const bodyEl = document.getElementById("pc-body");

  async function load() {
    bodyEl.innerHTML = '<div class="nx-toolbar-hint">Loading…</div>';
    try {
      const { data } = await api("/processed");
      render(data || []);
    } catch (err) {
      bodyEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function render(rows) {
    if (rows.length === 0) { bodyEl.innerHTML = '<div class="nx-empty">No processed cost lines.</div>'; return; }
    const total = rows.reduce((sum, r) => sum + (Number(r.actualCost ?? r.expectedCost) || 0), 0);
    bodyEl.innerHTML = `
      <p style="font-size:12px;color:var(--text-muted)">${rows.length} line(s) — total posted £${total.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th>Shipment</th><th>Direction</th><th>Forwarder</th><th>Cost Centre</th><th>Cost Element</th><th>Expected</th><th>Actual</th><th>PO</th><th>Material Doc.</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td>${esc(r.shipmentRef || `#${r.costId}`)}</td>
            <td>${esc(r.direction)}</td>
            <td>${esc(r.forwarderName || "—")}</td>
            <td>${esc(r.costCenter || "—")}</td>
            <td>${esc(r.costElement || "—")}</td>
            <td>£${esc(r.expectedCost)}</td>
            <td>${r.actualCost != null ? "£" + esc(r.actualCost) : "—"}</td>
            <td>${esc(r.purchaseOrder || "—")}</td>
            <td>${esc(r.materialDocument || "—")}</td>
            <td><button type="button" class="secondary pc-reverse-btn" data-id="${r.costId}" style="padding:3px 8px;font-size:11px;color:var(--error)">Reverse</button></td>
          </tr>`).join("")}</tbody>
      </table>
      </div>`;

    bodyEl.querySelectorAll(".pc-reverse-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!(await NexusModal.confirm("Reverse this goods receipt in SAP? This posts a real reversal.", { danger: true, confirmLabel: "Reverse" }))) return;
        btn.disabled = true; btn.textContent = "Reversing…";
        try {
          await api(`/${btn.dataset.id}/reverse`, { method: "POST" });
          await load();
        } catch (err) {
          await NexusModal.alert(err.message);
          btn.disabled = false; btn.textContent = "Reverse";
        }
      });
    });
  }

  load();
})();
