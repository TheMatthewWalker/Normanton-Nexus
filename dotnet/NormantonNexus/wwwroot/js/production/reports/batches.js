// Batch Summary report — port of runReportBatches in production-nexus.js.
(function () {
  const R = window.ProductionReports;
  const filtersEl = document.getElementById("rpt-filters");
  const msgEl = document.getElementById("rpt-msg");
  const outputEl = document.getElementById("rpt-output");

  async function run(filters) {
    msgEl.textContent = "";
    outputEl.textContent = "Loading…";
    try {
      const { data } = await R.api(`/reports/batches?${R.buildQuery(filters)}`);

      outputEl.innerHTML = "";
      outputEl.appendChild(R.exportButton(() => data, `batch-summary-${new Date().toISOString().slice(0, 10)}.csv`));
      outputEl.appendChild(
        R.buildTable(["Process", "Complete", "SAP Failed", "Cancelled", "Reversed", "Total"], data, (row) => {
          const tr = document.createElement("tr");
          for (const val of [R.PROCESS_LABELS[row.processCode] || row.processCode, row.complete, row.sapFailed, row.cancelled, row.reversed, row.total]) {
            const td = document.createElement("td");
            td.textContent = val;
            tr.appendChild(td);
          }
          return tr;
        })
      );
    } catch (err) {
      outputEl.textContent = "";
      msgEl.textContent = err.message;
    }
  }

  R.mountFilterBar(filtersEl, run);
})();
