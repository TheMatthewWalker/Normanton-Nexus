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

  function openForm(initialMaterial) {
    const card = NexusModal.open(`
      <div class="ps-modal-header">
        <div>
          <div class="ps-modal-title">Add Demand Adjustment</div>
        </div>
        <button type="button" class="ps-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ps-modal-body">
        <form id="da-modal-form">
          <div class="tf-row">
            <div class="tf-field">
              <label class="tf-label">Material</label>
              <input class="tf-input" type="text" id="da-material" required>
            </div>
            <div class="tf-field">
              <label class="tf-label">Start Date</label>
              <input class="tf-input" type="date" id="da-start">
            </div>
            <div class="tf-field">
              <label class="tf-label">End Date</label>
              <input class="tf-input" type="date" id="da-end">
            </div>
          </div>
          <div class="tf-row">
            <div class="tf-field">
              <label class="tf-label">Mode</label>
              <select class="tf-input" id="da-mode">
                <option value="percentage">Percentage increase/decrease</option>
                <option value="override">Fixed override quantity</option>
              </select>
            </div>
            <div class="tf-field" id="da-usage-field">
              <label class="tf-label">Usage % <span style="font-weight:400;color:var(--text-muted)">(100 = no change, &lt;100 decrease, &gt;100 increase)</span></label>
              <input class="tf-input" type="number" id="da-usage" value="100">
            </div>
            <div class="tf-field hidden" id="da-override-field">
              <label class="tf-label">Override Total Quantity <span style="font-weight:400;color:var(--text-muted)">(planned across the whole window, spread evenly per day — needs both dates)</span></label>
              <input class="tf-input" type="number" id="da-override" min="0">
            </div>
          </div>
          <div class="tf-row">
            <div class="tf-field tf-field--wide">
              <label class="tf-label">Reason</label>
              <input class="tf-input" type="text" id="da-reason">
            </div>
          </div>
          <div id="da-form-error"></div>
        </form>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="btn secondary" id="da-cancel">Cancel</button>
        <button type="submit" form="da-modal-form" class="btn">Add</button>
      </div>
    `, { wide: true });

    const modeSelect = card.querySelector("#da-mode");
    const usageField = card.querySelector("#da-usage-field");
    const overrideField = card.querySelector("#da-override-field");
    const errorEl = card.querySelector("#da-form-error");

    function applyMode() {
      const isOverride = modeSelect.value === "override";
      usageField.classList.toggle("hidden", isOverride);
      overrideField.classList.toggle("hidden", !isOverride);
    }
    modeSelect.addEventListener("change", applyMode);
    applyMode();

    if (initialMaterial) card.querySelector("#da-material").value = initialMaterial;

    card.querySelector("#da-cancel").addEventListener("click", () => NexusModal.close());

    card.querySelector("#da-modal-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      errorEl.innerHTML = "";

      const isOverride = modeSelect.value === "override";
      const startDate = card.querySelector("#da-start").value || null;
      const endDate = card.querySelector("#da-end").value || null;

      if (isOverride && (!startDate || !endDate)) {
        errorEl.innerHTML = '<div class="tf-inline-error">A fixed override quantity needs both a start and end date.</div>';
        return;
      }

      const body = {
        material: card.querySelector("#da-material").value.trim(),
        startDate,
        endDate,
        reason: card.querySelector("#da-reason").value || null,
        usagePercent: isOverride ? null : Number(card.querySelector("#da-usage").value),
        overrideQty: isOverride ? Number(card.querySelector("#da-override").value) : null,
      };

      try {
        await api("/demand-adjustments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        NexusModal.close();
        await load();
      } catch (err) {
        errorEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
      }
    });
  }

  document.getElementById("da-add-btn").addEventListener("click", () => openForm(null));

  // Deep-link from Stock History & Forecast's "+ Add Demand Adjustment" link.
  if (window.__daInitialMaterial) {
    openForm(window.__daInitialMaterial);
  }

  load();
})();
