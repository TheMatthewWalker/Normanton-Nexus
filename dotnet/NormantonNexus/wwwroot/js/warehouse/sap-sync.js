// SAP Sync tile — manual trigger for WarehouseSapSyncHelper.RunSapSyncAsync
// (POST /api/deliverymain/sap-sync), same action the hourly Quartz job calls.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/deliverymain");
  const bodyEl = document.getElementById("sync-body");
  const btn = document.getElementById("sync-run");

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Syncing…";
    bodyEl.textContent = "";
    try {
      const { data } = await api("/sap-sync", { method: "POST" });
      const errLines = (data.errors || []).map((e) => `Delivery ${esc(e.deliveryNumber)}: ${esc(e.error)}`).join("<br>");
      const missingLines = (data.missing || []).map((m) => `Delivery ${esc(m.deliveryNumber)} (customer ${esc(m.customerNumber)})`).join("<br>");
      const autoCreatedLines = (data.autoCreated || []).map((a) => `${esc(a.destinationName)} (${esc(a.customerNumber)})${a.needsReview ? " — needs review" : ""}`).join("<br>");
      bodyEl.innerHTML = `
        <p>Total: ${data.total}, Inserted: ${data.inserted}, Skipped: ${data.skipped}</p>
        ${data.autoCreated?.length ? `<p><strong>Auto-created destinations:</strong><br>${autoCreatedLines}</p>` : ""}
        ${data.missing?.length ? `<p><strong>Missing (no matching destination):</strong><br>${missingLines}</p>` : ""}
        ${data.errors?.length ? `<div class="login-error"><strong>Errors:</strong><br>${errLines}</div>` : ""}
        ${data.kna1Error ? `<div class="login-error">KNA1 lookup error: ${esc(data.kna1Error)}</div>` : ""}
        ${data.movedToHolding?.length ? `<p><strong>Moved to Packaging Holding:</strong> ${data.movedToHolding.join(", ")}</p>` : ""}`;
    } catch (err) {
      bodyEl.innerHTML = `<p>Error: ${esc(err.message)}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Run SAP Sync Now";
    }
  });
})();
