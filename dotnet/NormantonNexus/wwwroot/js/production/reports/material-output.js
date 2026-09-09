// Material Throughput report — port of runReportMaterial in production-nexus.js.
(function () {
  const R = window.ProductionReports;
  const filtersEl = document.getElementById("rpt-filters");
  const msgEl = document.getElementById("rpt-msg");
  const outputEl = document.getElementById("rpt-output");

  async function run(filters) {
    msgEl.textContent = "";
    outputEl.textContent = "Loading…";
    try {
      const { data } = await R.api(`/reports/material-output?${R.buildQuery(filters)}`);

      outputEl.innerHTML = "";
      outputEl.appendChild(R.exportButton(() => data, `material-throughput-${new Date().toISOString().slice(0, 10)}.csv`));
      outputEl.appendChild(
        R.buildTable(["Material", "Process", "UoM", "Batches", "Total Output", "Avg / Batch"], data, (row) => {
          const tr = document.createElement("tr");
          for (const val of [row.material, R.PROCESS_LABELS[row.processCode] || row.processCode, row.uom, row.batchCount, R.fmtNum(row.totalOutput), R.fmtNum(row.avgPerBatch)]) {
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
