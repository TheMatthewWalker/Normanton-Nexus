// Operator Output report — port of runReportOperator in production-nexus.js.
(function () {
  const R = window.ProductionReports;
  const filtersEl = document.getElementById("rpt-filters");
  const msgEl = document.getElementById("rpt-msg");
  const outputEl = document.getElementById("rpt-output");

  async function run(filters) {
    msgEl.textContent = "";
    outputEl.textContent = "Loading…";
    try {
      const { data } = await R.api(`/reports/operator-output?${R.buildQuery(filters)}`);

      outputEl.innerHTML = "";
      outputEl.appendChild(R.exportButton(() => data, `operator-output-${new Date().toISOString().slice(0, 10)}.csv`));
      outputEl.appendChild(
        R.buildTable(["Operator", "Process", "UoM", "Batches", "Total Output"], data, (row) => {
          const tr = document.createElement("tr");
          for (const val of [row.username, R.PROCESS_LABELS[row.processCode] || row.processCode, row.uom, row.batchCount, R.fmtNum(row.totalOutput)]) {
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
