// Demand Adjustments tile — CRUD over log.DemandAdjustment.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/performance");
  const bodyEl = document.getElementById("da-body");

  async function load() {
    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api("/demand-adjustments");
      render(data || []);
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  }

  function render(rows) {
    bodyEl.innerHTML = rows.length === 0 ? "<p>No adjustments.</p>" : `
      <table>
        <thead><tr><th>Material</th><th>Start</th><th>End</th><th>Usage %</th><th>Reason</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.material)} ${esc(r.materialText)}</td>
              <td>${r.startDate ? new Date(r.startDate).toLocaleDateString("en-GB") : ""}</td>
              <td>${r.endDate ? new Date(r.endDate).toLocaleDateString("en-GB") : ""}</td>
              <td>${esc(r.usagePercent)}</td>
              <td>${esc(r.reason)}</td>
              <td><button type="button" class="btn secondary" data-id="${r.adjustmentId}">Delete</button></td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    bodyEl.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this adjustment?")) return;
        await api(`/demand-adjustments/${btn.dataset.id}`, { method: "DELETE" });
        await load();
      });
    });
  }

  document.getElementById("da-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/demand-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          material: document.getElementById("da-material").value.trim(),
          startDate: document.getElementById("da-start").value || null,
          endDate: document.getElementById("da-end").value || null,
          usagePercent: Number(document.getElementById("da-usage").value),
          reason: document.getElementById("da-reason").value || null,
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
