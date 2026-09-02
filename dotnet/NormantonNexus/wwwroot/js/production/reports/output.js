// Production Output report — port of runReportOutput/renderReportOutput in
// private/js/production-nexus.js.
(function () {
  const R = window.ProductionReports;
  const filtersEl = document.getElementById("rpt-filters");
  const msgEl = document.getElementById("rpt-msg");
  const outputEl = document.getElementById("rpt-output");

  async function run(filters) {
    msgEl.textContent = "";
    outputEl.textContent = "Loading…";
    try {
      const { data } = await R.api(`/reports/output?${R.buildQuery(filters)}`);

      outputEl.innerHTML = "";
      outputEl.appendChild(R.exportButton(() => data.timeSeries, `production-output-${new Date().toISOString().slice(0, 10)}.csv`));

      const summaryHeading = document.createElement("h3");
      summaryHeading.textContent = "Summary";
      outputEl.appendChild(summaryHeading);
      outputEl.appendChild(
        R.buildTable(["Process", "UoM", "Batches", "Total Output", "Avg / Batch"], data.summary, (row) => {
          const tr = document.createElement("tr");
          for (const val of [R.PROCESS_LABELS[row.processCode] || row.processCode, row.uom, row.batchCount, R.fmtNum(row.totalOutput), R.fmtNum(row.avgPerBatch)]) {
            const td = document.createElement("td");
            td.textContent = val;
            tr.appendChild(td);
          }
          return tr;
        })
      );

      const seriesHeading = document.createElement("h3");
      seriesHeading.textContent = "By Period";
      outputEl.appendChild(seriesHeading);
      outputEl.appendChild(
        R.buildTable(["Period", "Process", "UoM", "Batches", "Total Output"], data.timeSeries, (row) => {
          const tr = document.createElement("tr");
          for (const val of [row.period, R.PROCESS_LABELS[row.processCode] || row.processCode, row.uom, row.batchCount, R.fmtNum(row.totalOutput)]) {
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
