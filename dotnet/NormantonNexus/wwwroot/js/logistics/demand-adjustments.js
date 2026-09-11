// Demand Adjustments tile — CRUD over log.DemandAdjustment. Two mutually
// exclusive planning modes per row: a percentage scale of the material's
// normal predicted usage (the original behavior), or a fixed total quantity
// to plan for across the whole window, spread evenly per day (OverrideQty —
// a deliberate enhancement beyond the ported Node feature, see
// VendorMasterDataHelper.ValidateDemandAdjustment's own comment).
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/performance");
  const bodyEl = document.getElementById("da-body");
  const modeSelect = document.getElementById("da-mode");
  const usageField = document.getElementById("da-usage-field");
  const overrideField = document.getElementById("da-override-field");

  function applyMode() {
    const isOverride = modeSelect.value === "override";
    usageField.classList.toggle("hidden", isOverride);
    overrideField.classList.toggle("hidden", !isOverride);
  }
  modeSelect.addEventListener("change", applyMode);
  applyMode();

  async function load() {
    bodyEl.innerHTML = '<div class="nx-toolbar-hint">Loading…</div>';
    try {
      const { data } = await api("/demand-adjustments");
      render(data || []);
    } catch (err) {
      bodyEl.innerHTML = `<div class="nx-empty">Error: ${esc(err.message)}</div>`;
    }
  }

  function render(rows) {
    bodyEl.innerHTML = rows.length === 0 ? '<div class="nx-empty">No demand adjustments.</div>' : `
      <table>
        <thead><tr><th>Material</th><th>Start</th><th>End</th><th>Plan</th><th>Reason</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.material)} ${esc(r.materialText)}</td>
              <td>${r.startDate ? new Date(r.startDate).toLocaleDateString("en-GB") : "—"}</td>
              <td>${r.endDate ? new Date(r.endDate).toLocaleDateString("en-GB") : "—"}</td>
              <td>${r.overrideQty != null ? `${Number(r.overrideQty).toLocaleString()} total (fixed)` : `${esc(r.usagePercent)}%`}</td>
              <td>${esc(r.reason || "")}</td>
              <td><button type="button" class="secondary" data-id="${r.adjustmentId}">Delete</button></td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    bodyEl.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!(await NexusModal.confirm("Delete this adjustment?", { danger: true, confirmLabel: "Delete" }))) return;
        await api(`/demand-adjustments/${btn.dataset.id}`, { method: "DELETE" });
        await load();
      });
    });
  }

  document.getElementById("da-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("da-form-error");
    errorEl.innerHTML = "";

    const isOverride = modeSelect.value === "override";
    const startDate = document.getElementById("da-start").value || null;
    const endDate = document.getElementById("da-end").value || null;

    if (isOverride && (!startDate || !endDate)) {
      errorEl.innerHTML = '<div class="tf-inline-error">A fixed override quantity needs both a start and end date.</div>';
      return;
    }

    const body = {
      material: document.getElementById("da-material").value.trim(),
      startDate,
      endDate,
      reason: document.getElementById("da-reason").value || null,
      usagePercent: isOverride ? null : Number(document.getElementById("da-usage").value),
      overrideQty: isOverride ? Number(document.getElementById("da-override").value) : null,
    };

    try {
      await api("/demand-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      e.target.reset();
      applyMode();
      await load();
    } catch (err) {
      errorEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  });

  // Deep-link from Stock History & Forecast's "+ Add Demand Adjustment" link.
  if (window.__daInitialMaterial) {
    document.getElementById("da-material").value = window.__daInitialMaterial;
  }

  load();
})();
