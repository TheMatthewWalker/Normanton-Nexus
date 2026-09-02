// Batch History tile — port of runBatchHistory in private/js/production-nexus.js.
(function () {
  const R = window.ProductionReports;
  const refInput = document.getElementById("hist-ref");
  const matInput = document.getElementById("hist-mat");
  const fromInput = document.getElementById("hist-from");
  const toInput = document.getElementById("hist-to");
  const resultsEl = document.getElementById("hist-results");

  const STATUS_LABELS = { 1: "Open", 2: "Running", 3: "On Hold", 4: "Complete", 5: "Cancelled", 6: "SAP Failed" };

  function fmt(dt) {
    if (!dt) return "—";
    return new Date(dt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  document.getElementById("hist-search-btn").addEventListener("click", async () => {
    const ref = refInput.value.trim();
    const material = matInput.value.trim();
    const params = new URLSearchParams();
    if (ref) params.set("ref", ref);
    if (material) params.set("material", material);
    if (fromInput.value) params.set("fromDate", fromInput.value);
    if (toInput.value) params.set("toDate", toInput.value);

    resultsEl.textContent = "Searching…";
    try {
      const { data } = await R.api(`/history?${params}`);
      if (data.length === 0) {
        resultsEl.textContent = "No results found.";
        return;
      }

      resultsEl.innerHTML = "";
      resultsEl.appendChild(
        R.buildTable(["Ref", "Process", "Material", "Qty", "Status", "Created", "Completed"], data, (b) => {
          const tr = document.createElement("tr");
          const refTd = document.createElement("td");
          refTd.textContent = b.batchRef;
          const pcTd = document.createElement("td");
          pcTd.textContent = R.PROCESS_LABELS[b.processCode] || b.processCode;
          const matTd = document.createElement("td");
          matTd.textContent = b.material;
          const qtyTd = document.createElement("td");
          qtyTd.textContent = `${b.quantity ?? "—"} ${b.uom || ""}`;
          const statusTd = document.createElement("td");
          statusTd.textContent = STATUS_LABELS[b.status] || String(b.status);
          const createdTd = document.createElement("td");
          createdTd.textContent = fmt(b.createdAt);
          const completedTd = document.createElement("td");
          completedTd.textContent = fmt(b.completedAt);
          tr.append(refTd, pcTd, matTd, qtyTd, statusTd, createdTd, completedTd);
          return tr;
        })
      );
    } catch (err) {
      resultsEl.textContent = err.message;
    }
  });
})();
