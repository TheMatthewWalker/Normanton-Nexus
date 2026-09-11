// Batch Summary report — port of runReportBatches in production-nexus.js.
(function () {
  const R = window.ProductionReports;
  const filtersEl = document.getElementById("rpt-filters");
  const msgEl = document.getElementById("rpt-msg");
  const outputEl = document.getElementById("rpt-output");

  async function run(filters) {
    msgEl.classList.add("hidden");
    msgEl.textContent = "";
    outputEl.innerHTML = `<div class="nx-empty">Loading…</div>`;
    try {
      const { data } = await R.api(`/reports/batches?${R.buildQuery(filters)}`);

      outputEl.innerHTML = "";
      outputEl.appendChild(R.exportButton(() => data, `batch-summary-${new Date().toISOString().slice(0, 10)}.csv`));
      outputEl.appendChild(
        R.buildTable(["Process", "Complete", "SAP Failed", "Cancelled", "Reversed", "Total"], data, (row) => {
          const tr = document.createElement("tr");
          const tdProcess = document.createElement("td");
          tdProcess.textContent = R.PROCESS_LABELS[row.processCode] || row.processCode;
          const tdComplete = document.createElement("td");
          tdComplete.appendChild(R.badgeEl(row.complete, row.complete > 0 ? "success" : undefined));
          const tdFailed = document.createElement("td");
          tdFailed.appendChild(R.badgeEl(row.sapFailed, row.sapFailed > 0 ? "error" : undefined));
          const tdCancelled = document.createElement("td");
          tdCancelled.appendChild(R.badgeEl(row.cancelled, row.cancelled > 0 ? "warn" : undefined));
          const tdReversed = document.createElement("td");
          tdReversed.appendChild(R.badgeEl(row.reversed, row.reversed > 0 ? "accent" : undefined));
          const tdTotal = document.createElement("td");
          tdTotal.textContent = row.total;
          tr.append(tdProcess, tdComplete, tdFailed, tdCancelled, tdReversed, tdTotal);
          return tr;
        })
      );
    } catch (err) {
      outputEl.innerHTML = "";
      msgEl.textContent = err.message;
      msgEl.classList.remove("hidden");
    }
  }

  outputEl.innerHTML = `<div class="nx-empty">Choose filters and click Run Report to see results.</div>`;
  R.mountFilterBar(filtersEl, run);
})();
