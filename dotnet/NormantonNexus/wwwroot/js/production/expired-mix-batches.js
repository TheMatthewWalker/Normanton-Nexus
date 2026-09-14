// Expired Mix Batches — mix tubs produced but never staged into Billet,
// now over the 96h expiry window. Port of the "Expired Mix Batches"
// section of production-nexus.js (GET /mixing/expired + the two
// supervisor actions). A genuinely missing tile/backend this migration
// never built until a later gap audit found it — see
// BilletStagingHelper.cs's own header comments on the three methods this
// page calls.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/productionnexus");
  const bodyEl = document.getElementById("emb-body");

  async function load() {
    bodyEl.innerHTML = '<div class="nx-empty">Loading…</div>';
    try {
      const { data } = await api("/mixing/expired");
      render(data || []);
    } catch (err) {
      bodyEl.innerHTML = `<div class="nx-empty">Error: ${esc(err.message)}</div>`;
    }
  }

  function render(rows) {
    if (rows.length === 0) {
      bodyEl.innerHTML = '<div class="nx-empty" style="color:var(--accent)">✓ No expired mix batches.</div>';
      return;
    }

    bodyEl.innerHTML = `
      <p>${rows.length} expired tub(s)</p>
      <table>
        <thead><tr><th>Mix Ref</th><th>Tub</th><th>Material</th><th>Weight (KG)</th><th>Supplier Tub</th><th>Completed</th><th>Age (h)</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.mixRef || `MX${String(r.mixingId).padStart(8, "0")}`)}</td>
              <td>${esc(r.tubSeq)}</td>
              <td>${esc(r.material)} ${esc(r.mixCode)}</td>
              <td>${Number(r.tubWeightKg).toFixed(3)}</td>
              <td>${esc(r.supplierTubNo || "—")}</td>
              <td>${r.completedAt ? new Date(r.completedAt).toLocaleString("en-GB") : "—"}</td>
              <td>${Number(r.ageHours).toFixed(1)}</td>
              <td>
                <button type="button" class="btn secondary" data-action="scrap" data-id="${r.tubId}">Approve Scrap</button>
                <button type="button" class="btn secondary" data-action="override" data-id="${r.tubId}">Override &amp; Stage</button>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>`;

    bodyEl.querySelectorAll("button[data-action='scrap']").forEach((btn) => {
      btn.addEventListener("click", () => scrapTub(Number(btn.dataset.id)));
    });
    bodyEl.querySelectorAll("button[data-action='override']").forEach((btn) => {
      btn.addEventListener("click", () => openOverrideForm(Number(btn.dataset.id)));
    });
  }

  async function scrapTub(tubId) {
    if (!(await NexusModal.confirm(
      "Scrap this tub? This posts a real SAP scrap movement against the mix material and cannot be undone from here.",
      { danger: true, confirmLabel: "Approve Scrap" }
    ))) return;
    try {
      const { data } = await api(`/mixing/tubs/${tubId}/expiry/scrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      alert(`Scrapped — Material Document: ${data.materialDocument || "(none returned)"}`);
      await load();
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  function openOverrideForm(tubId) {
    const fields = [
      { key: "reason", label: "Reason", multiline: true, wide: true },
    ];
    AdminEditModal.open("Override Expiry & Stage", "Moves this tub into Billet anyway, unblocking backflush for anything linked to it.", fields, { reason: "" }, async (values) => {
      const reason = values.reason.trim();
      if (!reason) throw new Error("A reason is required to override expiry.");
      await api(`/mixing/tubs/${tubId}/expiry/override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      await load();
    });
  }

  load();
})();
